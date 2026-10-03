import type {
  DomainEvent,
  ProviderContext,
  ProviderMessage,
  Task,
  ToolProfile,
  ToolResult,
} from './types.js';

export interface ProviderContextProjection {
  context: ProviderContext;
  toolResults: ToolResult[];
}

/** Build a bounded, redacted provider context from Runtime-owned ledger facts. */
export function buildProviderContext(task: Task, events: readonly DomainEvent[], maxBytes = 24_000): ProviderContextProjection {
  const safeGoal = redactText(task.goal).slice(0, 4_000);
  const messages: ProviderMessage[] = [{ role: 'user', content: `Helm task: ${safeGoal}` }];
  const items: ProviderContext['items'] = [{ source: 'pinned', version: task.createdAt, content: `Task goal: ${safeGoal}` }];
  const toolResults: ToolResult[] = [];
  const gaps: string[] = [];

  for (const event of events.slice(-80)) {
    const payload = event.payload as Record<string, unknown>;
    if (event.type === 'tool.receipt') {
      const toolCallId = typeof payload.toolCallId === 'string' ? payload.toolCallId : `event-${event.sequence}`;
      toolResults.push({
        toolCallId,
        name: typeof payload.name === 'string' ? payload.name : 'tool',
        ok: payload.ok === true,
        output: summarizeValue(payload.output),
        error: typeof payload.error === 'string' ? redactText(payload.error).slice(0, 500) : undefined,
        receipt: summarizeRecord(payload.receipt),
      });
      messages.push({ role: 'tool', toolCallId, content: JSON.stringify({ ok: payload.ok === true, error: typeof payload.error === 'string' ? redactText(payload.error).slice(0, 500) : undefined, output: summarizeValue(payload.output) }) });
      continue;
    }
    if (event.type === 'step.proposal') {
      const proposal = payload.proposal;
      const kind = proposal && typeof proposal === 'object' && 'kind' in proposal ? String((proposal as Record<string, unknown>).kind) : 'unknown';
      items.push({ source: 'recent', version: String(event.sequence), content: `Step proposal: ${kind}` });
      continue;
    }
    if (event.type === 'run.checkpoint') {
      items.push({ source: 'cold', version: String(event.sequence), content: 'Run checkpoint available.' });
    }
  }

  const context = fitContext({ version: 'v1', items, messages, gaps, bytes: 0, truncated: false }, Math.max(0, maxBytes));
  return { context, toolResults };
}

export function toolProfileToSchema(profile: ToolProfile): {
  id: string;
  version: string;
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  scope: 'workspace';
} {
  return {
    id: profile.id,
    version: profile.version,
    name: profile.id,
    description: profile.description,
    inputSchema: profile.inputSchema ?? { type: 'object', properties: {} },
    readOnly: profile.readOnly,
    scope: profile.scope,
  };
}

function summarizeValue(value: unknown): unknown {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return redactText(value.length > 500 ? `${value.slice(0, 500)}…` : value);
  if (Array.isArray(value)) return value.slice(0, 20).map(summarizeValue);
  return summarizeRecord(value as Record<string, unknown>);
}

function summarizeRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 30).map(([key, item]) => [
    key,
    /api[-_]?key|authorization|cookie|secret|password|token|content|body|diff|private/i.test(key) ? '[redacted]' : summarizeValue(item),
  ]));
}

function redactText(value: string): string {
  return value
    .replace(/(?:api[-_ ]?key|authorization|cookie|secret|password|token)\s*[:=]\s*[^\s,;]+/gi, '[redacted]')
    .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/\/(?:Users|private|tmp)\/[^\s]+/g, '[workspace-path]');
}

function fitContext(input: ProviderContext, maxBytes: number): ProviderContext {
  let candidate: ProviderContext = { ...input, items: [...input.items], messages: [...input.messages], gaps: [...input.gaps] };
  for (let attempt = 0; attempt < 32; attempt += 1) {
    candidate.truncated = candidate.truncated || attempt > 0;
    const measured = byteLength({ ...candidate, bytes: 0 });
    candidate.bytes = measured;
    const actual = byteLength(candidate);
    if (actual <= maxBytes) {
      candidate.bytes = actual;
      if (byteLength(candidate) <= maxBytes) return candidate;
    }

    if (candidate.messages.length > 1) {
      candidate.messages = candidate.messages.slice(0, -1);
      continue;
    }
    if (candidate.items.length > 1) {
      candidate.items = candidate.items.slice(0, -1);
      continue;
    }
    const message = candidate.messages[0];
    if (message?.content) {
      candidate.messages = [{ ...message, content: shorten(message.content) }];
      continue;
    }
    const item = candidate.items[0];
    if (item?.content) {
      candidate.items = [{ ...item, content: shorten(item.content) }];
      continue;
    }
    candidate.gaps = [];
    candidate.messages = [];
    candidate.items = [];
  }

  // The default budget is large enough for the envelope metadata. Keep the
  // final value internally consistent even when a caller supplies an extreme
  // budget that cannot hold the fixed JSON envelope.
  candidate.bytes = byteLength({ ...candidate, bytes: 0 });
  return candidate;
}

function shorten(value: string): string {
  if (value.length <= 16) return '';
  return `${value.slice(0, Math.max(0, Math.floor(value.length / 2) - 1))}…`;
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
