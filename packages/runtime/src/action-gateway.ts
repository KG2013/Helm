import { createHash } from 'node:crypto';
import type { ActionAdapter, ActionAdapterResult, ActionExecutionResult, ActionGatewayOptions, ActionPolicyResult, ActionRequest, ActionReceipt, EventStore, ID, NewDomainEvent, RuntimeClock, RuntimeIdFactory, ToolExecutor, ToolExecutorResult, ToolProfile, ProviderRequest, ToolCall } from './types.js';

const defaultClock: RuntimeClock = { now: () => new Date() };
const defaultIds: RuntimeIdFactory = {
  next: (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
};

/**
 * One durable seam for actions that may have effects outside the model loop.
 * The Gateway stores only a bounded request summary and never the raw args.
 */
export class ActionGateway {
  private readonly store: EventStore;
  private readonly policy: NonNullable<ActionGatewayOptions['policy']>;
  private readonly clock: RuntimeClock;
  private readonly ids: RuntimeIdFactory;

  constructor(options: ActionGatewayOptions) {
    this.store = options.store;
    this.policy = options.policy ?? (() => ({ decision: 'deny' as const, reason: 'No ActionPolicy is configured; action execution is denied.' }));
    this.clock = options.clock ?? defaultClock;
    this.ids = options.ids ?? defaultIds;
  }

  async execute(input: { request: ActionRequest; adapter: ActionAdapter; markRunNeedsReconciliation?: boolean }): Promise<ActionExecutionResult> {
    const validation = validateRequest(input.request);
    await this.append('action.requested', input.request, { validation });
    if (validation) return this.denied(input.request, validation);
    const decision = await this.policy(input.request);
    if (decision.decision === 'deny') return this.denied(input.request, decision.reason);
    if (decision.decision === 'ask') {
      await this.append('action.approval_required', input.request, { reason: decision.reason, approvalId: input.request.actionId, actionHash: actionHash(input.request) });
      return { status: 'approval_required', actionId: input.request.actionId, approvalId: input.request.actionId, ok: false, error: decision.reason };
    }
    return this.executeApproved(input);
  }

  /** Record an approval-bound proposal without consulting a permissive policy. */
  async requestApproval(input: { request: ActionRequest; reason: string }): Promise<ActionExecutionResult> {
    const validation = validateRequest(input.request);
    await this.append('action.requested', input.request, { validation });
    if (validation) return this.denied(input.request, validation);
    await this.append('action.approval_required', input.request, { reason: input.reason, approvalId: input.request.actionId, actionHash: actionHash(input.request) });
    return { status: 'approval_required', actionId: input.request.actionId, approvalId: input.request.actionId, ok: false, error: input.reason };
  }

  /** Execute a request after an existing typed Runtime approval. */
  async executeApproved(input: { request: ActionRequest; adapter: ActionAdapter; markRunNeedsReconciliation?: boolean }): Promise<ActionExecutionResult> {
    const priorEvents = await this.store.list(input.request.runId);
    if (!priorEvents.some((event) => event.type === 'action.requested' && event.payload.actionId === input.request.actionId)) {
      await this.append('action.requested', input.request, { validation: undefined });
    }
    const replay = await this.findReceipt(input.request);
    if (replay?.conflict) return this.denied(input.request, replay.conflict);
    if (replay && 'result' in replay) return { ...replay.result, replayed: true };
    await this.append('action.approved', input.request, { approvalId: input.request.actionId, approvalSource: 'runtime' });
    const deadline = Date.parse(input.request.deadline);
    if (!Number.isFinite(deadline) || deadline <= this.clock.now().getTime()) {
      return this.recordUnknown(input.request, { ok: false, error: 'Action deadline expired.', receipt: { sideEffect: 'unknown', reason: 'deadline_expired' } }, input.markRunNeedsReconciliation !== false);
    }
    let result: ActionAdapterResult;
    try {
      result = await input.adapter.execute(input.request);
    } catch (error) {
      result = { ok: false, error: sanitizeDiagnostic(error), receipt: { sideEffect: 'unknown', reason: 'adapter_failure' } };
    }
    if (result.receipt?.sideEffect === 'unknown') return this.recordUnknown(input.request, result, input.markRunNeedsReconciliation !== false);
    const receipt = this.makeReceipt(input.request, result, false);
    await this.append('action.receipt', input.request, { receipt, requestHash: actionHash(input.request), evidence: result.evidence ?? [] });
    return { status: result.ok ? 'executed' : 'failed', actionId: input.request.actionId, ok: result.ok, output: result.output, error: result.error, receipt: result.receipt, evidence: result.evidence };
  }

  async approve(input: { runId: ID; actionId: ID; adapter: ActionAdapter; markRunNeedsReconciliation?: boolean }): Promise<ActionExecutionResult> {
    const events = await this.store.list(input.runId);
    const requested = [...events].reverse().find((event) => event.type === 'action.requested' && event.payload.actionId === input.actionId);
    if (!requested) throw new Error(`Unknown action: ${input.actionId}`);
    const request = requested.payload as unknown as ActionRequest;
    const expected = actionHash(request);
    const approved = events.some((event) => event.type === 'action.approved' && event.payload.actionId === input.actionId);
    if (approved) return this.executeApproved({ request, adapter: input.adapter, markRunNeedsReconciliation: input.markRunNeedsReconciliation });
    const approval = [...events].reverse().find((event) => event.type === 'action.approval_required' && event.payload.actionId === input.actionId);
    if (!approval || approval.payload.actionHash !== expected) throw new Error('Action approval binding is missing or changed.');
    return this.executeApproved({ request, adapter: input.adapter, markRunNeedsReconciliation: input.markRunNeedsReconciliation });
  }

  private async recordUnknown(request: ActionRequest, result: ActionAdapterResult, markRunNeedsReconciliation: boolean): Promise<ActionExecutionResult> {
    const receipt = this.makeReceipt(request, result, false);
    await this.append('action.receipt', request, { receipt, requestHash: actionHash(request), evidence: result.evidence ?? [], outcome: 'unknown' });
    if (markRunNeedsReconciliation) {
      await this.store.append({
        type: 'run.needs_reconciliation',
        taskId: request.taskId,
        sessionId: request.sessionId,
        runId: request.runId,
        payload: { state: 'needs_reconciliation', reason: result.error ?? 'Action effect is unknown.', actionId: request.actionId },
      });
    }
    return { status: 'unknown', actionId: request.actionId, ok: false, error: result.error ?? 'Action effect is unknown.', receipt: result.receipt, evidence: result.evidence };
  }

  private async denied(request: ActionRequest, reason: string): Promise<ActionExecutionResult> {
    await this.append('action.denied', request, { reason });
    return { status: 'denied', actionId: request.actionId, ok: false, error: reason, receipt: { sideEffect: 'none', decision: 'deny' } };
  }

  private makeReceipt(request: ActionRequest, result: ActionAdapterResult, replayed: boolean): ActionReceipt {
    return {
      actionId: request.actionId,
      runId: request.runId,
      ok: result.ok,
      effect: result.receipt?.sideEffect === 'unknown' ? 'unknown' : result.receipt?.sideEffect === 'none' ? 'none' : 'known',
      target: sanitizeDiagnostic(request.target).slice(0, 300),
      idempotencyKey: request.idempotencyKey,
      replayed,
      evidence: result.evidence ?? [],
      diagnostics: result.error ? sanitizeDiagnostic(result.error) : undefined,
    };
  }

  private async findReceipt(request: ActionRequest): Promise<{ result: ActionExecutionResult; conflict?: never } | { conflict: string } | undefined> {
    const events = await this.store.list(request.runId);
    const event = [...events].reverse().find((candidate) => candidate.type === 'action.receipt'
      && (candidate.payload.actionId === request.actionId || candidate.payload.idempotencyKey === request.idempotencyKey));
    if (!event) return undefined;
    const recordedHash = typeof event.payload.requestHash === 'string' ? event.payload.requestHash : undefined;
    if (recordedHash && recordedHash !== actionHash(request)) return { conflict: 'Action idempotency or approval binding conflicts with the recorded request.' };
    const receipt = event.payload.receipt as Partial<ActionReceipt> | undefined;
    if (!receipt) return undefined;
    const status = receipt.effect === 'unknown' ? 'unknown' : receipt.ok === true ? 'executed' : 'failed';
    return { result: { status, actionId: request.actionId, ok: receipt.ok === true, error: typeof receipt.diagnostics === 'string' ? receipt.diagnostics : undefined, receipt } };
  }

  private async append(type: 'action.requested' | 'action.approval_required' | 'action.approved' | 'action.denied' | 'action.receipt', request: ActionRequest, payload: Record<string, unknown>): Promise<void> {
    const event: NewDomainEvent = {
      type,
      taskId: request.taskId,
      sessionId: request.sessionId,
      runId: request.runId,
      timestamp: this.clock.now().toISOString(),
      payload: { ...requestSummary(request), ...payload },
    };
    await this.store.append(event);
  }
}

/**
 * Policy for the deterministic local adapters. Unknown or networked actions
 * remain denied; only the loopback/browser/agent seams are eligible for the
 * adapter-specific profile and scope checks that happen before Gateway entry.
 */
export function createLocalActionPolicy(request: ActionRequest): ActionPolicyResult {
  const localTarget = /^(?:loopback|browser|agent):/i.test(request.target)
  const localProfile = /^(?:browser\.|agent\.)/i.test(request.profile.id)
  if (request.network.mode === 'none' && (localTarget || localProfile)) return { decision: 'allow', reason: 'Bounded local adapter action is allowed after profile and scope validation.' }
  if (request.profile.id === 'browser.navigation' && request.network.mode === 'allowlist' && request.network.hosts?.length === 1) {
    try {
      const url = new URL(request.target)
      const host = request.network.hosts[0]!.toLowerCase()
      if ((url.protocol === 'https:' || url.protocol === 'http:') && url.host.toLowerCase() === host) {
        return { decision: 'allow', reason: 'Browser navigation is restricted to the validated origin allowlist.' }
      }
    } catch {
      // The request validator below emits the bounded denial for malformed URLs.
    }
  }
  return { decision: 'deny', reason: 'Action target or network capability is outside the local adapter policy.' }
}

export function createToolActionAdapter(executor: ToolExecutor, input: { call: ToolCall; request: ProviderRequest }): ActionAdapter {
  return {
    id: `tool:${input.call.name}`,
    execute: async (request) => {
      const result: ToolExecutorResult = await executor(input.call, { ...input.request, runId: request.runId });
      return { ok: result.ok, output: result.output, error: result.error, receipt: result.receipt };
    },
  };
}

export function toolActionRequest(input: { call: ToolCall; profile: ToolProfile; taskId: ID; sessionId: ID; workspaceId?: ID; parentAgentId?: ID; deadline: string }): ActionRequest {
  return {
    actionId: input.call.id,
    runId: input.call.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    parentAgentId: input.parentAgentId,
    profile: { id: input.profile.id, version: input.profile.version },
    target: `tool:${input.call.name}`,
    scope: { workspaceId: input.workspaceId ?? input.taskId },
    capabilities: [`tool:${input.call.name}`],
    network: { mode: input.profile.network === 'none' ? 'none' : 'allowlist' },
    argsHash: hashArgs(input.call.arguments),
    argsSummary: `keys:${Object.keys(input.call.arguments).sort().slice(0, 16).join(',') || 'none'}`,
    idempotencyKey: input.call.id,
    dryRun: false,
    deadline: input.deadline,
  };
}

function requestSummary(request: ActionRequest): Record<string, unknown> {
  return {
    actionId: request.actionId,
    runId: request.runId,
    taskId: request.taskId,
    sessionId: request.sessionId,
    parentAgentId: request.parentAgentId,
    profile: request.profile,
    target: sanitizeDiagnostic(request.target).slice(0, 300),
    scope: redactValue(request.scope),
    capabilities: request.capabilities.slice(0, 32),
    network: redactValue(request.network),
    argsHash: request.argsHash,
    argsSummary: request.argsSummary?.slice(0, 300) ?? '[hash-only]',
    idempotencyKey: request.idempotencyKey,
    dryRun: request.dryRun,
    deadline: request.deadline,
  };
}

function validateRequest(request: ActionRequest): string | undefined {
  if (!request.actionId || !request.runId || !request.taskId || !request.sessionId) return 'Action identity is incomplete.';
  if (!request.profile.id || !request.profile.version) return 'Action Profile version is required.';
  if (!request.target || !request.argsHash || !request.idempotencyKey) return 'Action target, argument hash, and idempotency key are required.';
  if (!request.deadline || !Number.isFinite(Date.parse(request.deadline))) return 'Action deadline is invalid.';
  if (!Array.isArray(request.capabilities) || request.capabilities.length === 0) return 'Action capabilities are required.';
  if (request.dryRun !== true && request.dryRun !== false) return 'Action dryRun must be explicit.';
  return undefined;
}

function actionHash(request: ActionRequest): string {
  // The deadline is an execution lease, not an approval scope. Excluding it
  // lets an idempotent retry reuse the same bound action while the Gateway
  // still checks the current deadline before invoking the adapter.
  const summary = requestSummary(request);
  delete summary.deadline;
  return createHash('sha256').update(JSON.stringify(summary)).digest('hex');
}

function hashArgs(args: Record<string, unknown>): string {
  return createHash('sha256').update(stableJson(args)).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 3) return '[truncated]';
  if (typeof value === 'string') return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 32).map((item) => redactValue(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 32).map(([key, item]) => [/(?:key|token|secret|password|authorization|cookie)/i.test(key) ? key : key, /(?:key|token|secret|password|authorization|cookie)/i.test(key) ? '[redacted]' : redactValue(item, depth + 1)]));
}

function sanitizeDiagnostic(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return message.replace(/(?:api[-_ ]?key|authorization|cookie|secret|password|token)\s*[:=]\s*[^\s,;]+/gi, '[redacted]').slice(0, 500);
}
