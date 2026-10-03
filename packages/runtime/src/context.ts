import type {
  DomainEvent,
  ProviderContext,
  ProviderMessage,
  Task,
  ToolProfile,
  ToolResult,
} from './types.js';
import { redactRunEvent } from './projection.js';

export interface ProviderContextProjection {
  context: ProviderContext;
  toolResults: ToolResult[];
}

/** Bound and redact ledger events before exposing the legacy ProviderRequest.context field. */
export function boundProviderEvents(events: readonly DomainEvent[], maxEvents = 80, maxBytes = 24_000): DomainEvent[] {
  const redacted = events.map(redactRunEvent);
  let candidate = redacted.slice(-maxEvents);
  while (candidate.length > 1 && byteLength(candidate) > maxBytes) candidate = candidate.slice(1);
  if (byteLength(candidate) > maxBytes) return [];
  return candidate;
}

/** Re-apply the Runtime's redaction and budget boundary to custom projectors. */
export function normalizeProviderContextProjection(projection: ProviderContextProjection, maxBytes = 24_000): ProviderContextProjection {
  const context: ProviderContext = {
    ...projection.context,
    items: projection.context.items.map((item) => ({ ...item, content: redactText(item.content).slice(0, 12_000), gap: item.gap ? redactText(item.gap).slice(0, 500) : undefined })),
    messages: projection.context.messages.map((message) => ({
      ...message,
      content: redactText(message.content).slice(0, 12_000),
      toolCalls: message.toolCalls?.map((call) => ({ ...call, arguments: summarizeRecord(call.arguments) ?? {} })),
    })),
    gaps: projection.context.gaps.map((gap) => redactText(gap).slice(0, 500)),
    bytes: 0,
  };
  const toolResults = projection.toolResults.map((result) => ({
    ...result,
    output: summarizeValue(result.output),
    error: result.error ? redactText(result.error).slice(0, 500) : undefined,
    receipt: summarizeRecord(result.receipt),
  }));
  return { context: fitContext(context, Math.max(0, maxBytes)), toolResults };
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
    if (event.type === 'tool.call') {
      const toolCallId = typeof payload.id === 'string' ? payload.id : `event-${event.sequence}`;
      messages.push({
        role: 'assistant',
        content: '',
        toolCalls: [{
          id: toolCallId,
          name: typeof payload.name === 'string' ? payload.name : 'tool',
          arguments: payload.arguments && typeof payload.arguments === 'object' ? payload.arguments as Record<string, unknown> : {},
        }],
      });
      continue;
    }
    if (event.type === 'run.checkpoint') {
      items.push({ source: 'cold', version: String(event.sequence), content: 'Run checkpoint available.' });
    }
  }

  return normalizeProviderContextProjection({ context: { version: 'v1', items, messages, gaps, bytes: 0, truncated: false }, toolResults }, maxBytes);
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
    /api[-_]?key|authorization|cookie|secret|password|token|content|body|diff|private|oldText|newText/i.test(key) ? '[redacted]' : summarizeValue(item),
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
      const before = candidate.messages.length;
      candidate.messages = dropLastMessagePair(candidate.messages);
      if (candidate.messages.length < before) candidate.gaps = addGap(candidate.gaps, 'compaction dropped a complete ToolCall/ToolResult pair');
      continue;
    }
    if (candidate.items.length > 1) {
      candidate.items = candidate.items.slice(0, -1);
      candidate.gaps = addGap(candidate.gaps, 'compaction dropped the oldest context item');
      continue;
    }
    const message = candidate.messages[0];
    if (message?.content) {
      candidate.messages = [{ ...message, content: shorten(message.content) }];
      candidate.gaps = addGap(candidate.gaps, 'compaction shortened the pinned message');
      continue;
    }
    const item = candidate.items[0];
    if (item?.content) {
      candidate.items = [{ ...item, content: shorten(item.content) }];
      candidate.gaps = addGap(candidate.gaps, 'compaction shortened the pinned context item');
      continue;
    }
    candidate.gaps = addGap(candidate.gaps, 'compaction removed context after the bounded budget was reached');
    candidate.messages = [];
    candidate.items = [];
  }

  // The default budget is large enough for the envelope metadata. Reject an
  // impossible budget instead of silently violating the bounded-context contract.
  candidate.bytes = byteLength({ ...candidate, bytes: 0 });
  if (candidate.bytes > maxBytes) throw new Error('Provider context budget is too small for its envelope.');
  return candidate;
}

function dropLastMessagePair(messages: ProviderMessage[]): ProviderMessage[] {
  const last = messages[messages.length - 1];
  if (last?.role === 'tool' && last.toolCallId) {
    const assistantIndex = messages.findIndex((message) => message.role === 'assistant' && message.toolCalls?.some((call) => call.id === last.toolCallId));
    if (assistantIndex >= 0) return messages.filter((_message, index) => index !== assistantIndex && index !== messages.length - 1);
  }
  if (last?.role === 'assistant' && last.toolCalls?.length) {
    return messages.slice(0, -1);
  }
  return messages.slice(0, -1);
}

function addGap(gaps: string[], message: string): string[] {
  return gaps.includes(message) ? gaps : [...gaps, message].slice(-16);
}

function shorten(value: string): string {
  if (value.length <= 16) return '';
  return `${value.slice(0, Math.max(0, Math.floor(value.length / 2) - 1))}…`;
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
