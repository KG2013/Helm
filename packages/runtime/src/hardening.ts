import type { Budget, BudgetUsage, DomainEvent, Evidence, ID, ReconciliationRecord, Run } from './types.js';

/**
 * Derive cumulative consumption from durable events. This deliberately does
 * not use in-memory Runtime counters, so a pause, reconnect, or process
 * restart cannot reset the budget.
 */
export function summarizeBudgetUsage(run: Run, events: readonly DomainEvent[], now = Date.now()): BudgetUsage {
  const usage = events.filter((event) => event.type === 'usage.recorded').reduce<BudgetUsage>((total, event) => {
    const payload = event.payload as Record<string, unknown>;
    const tokens = typeof payload.totalTokens === 'number'
      ? payload.totalTokens
      : (typeof payload.inputTokens === 'number' ? payload.inputTokens : 0) + (typeof payload.outputTokens === 'number' ? payload.outputTokens : 0);
    return {
      ...total,
      tokens: total.tokens + tokens,
      costUsd: total.costUsd + numberValue(payload.costUsd),
      latencyMs: total.latencyMs + numberValue(payload.latencyMs),
      retries: total.retries + numberValue(payload.retries),
      cacheMisses: total.cacheMisses + (payload.cacheHit === false ? 1 : 0),
    };
  }, { steps: 0, durationMs: Math.max(0, now - Date.parse(run.createdAt)), tokens: 0, costUsd: 0, latencyMs: 0, retries: 0, cacheMisses: 0, reviewerRounds: run.reviewerRounds });
  return { ...usage, steps: run.steps, costUsd: roundMoney(usage.costUsd) };
}

export function isBudgetExceeded(budget: Budget, usage: BudgetUsage): boolean {
  return usage.steps > budget.maxSteps
    || usage.durationMs > budget.maxDurationMs
    || (budget.maxTokens !== undefined && usage.tokens > budget.maxTokens)
    || (budget.maxCostUsd !== undefined && usage.costUsd > budget.maxCostUsd)
    || (budget.maxLatencyMs !== undefined && usage.latencyMs > budget.maxLatencyMs)
    || (budget.maxRetries !== undefined && usage.retries > budget.maxRetries)
    || (budget.maxCacheMisses !== undefined && usage.cacheMisses > budget.maxCacheMisses)
    || usage.reviewerRounds > budget.maxReviewerRounds;
}

/** Find tool calls whose effect is not yet known or has not been reconciled. */
export function listReconciliationCandidates(events: readonly DomainEvent[]): Array<{ toolCallId: ID; stepId?: ID; reason: string }> {
  const calls = new Map<ID, DomainEvent>();
  const receipts = new Map<ID, DomainEvent>();
  const resolved = new Set<ID>();
  for (const event of events) {
    const payload = event.payload as Record<string, unknown>;
    if (event.type === 'tool.call' && typeof payload.id === 'string') calls.set(payload.id, event);
    if (event.type === 'tool.receipt' && typeof payload.toolCallId === 'string') {
      const receipt = asRecord(payload.receipt);
      if (receipt?.sideEffect === 'unknown') receipts.set(payload.toolCallId, event);
    }
    if (event.type === 'run.reconciled' && typeof payload.toolCallId === 'string' && (payload.outcome === 'known' || payload.outcome === 'failed')) resolved.add(payload.toolCallId);
  }
  return [...calls.entries()]
    .filter(([toolCallId]) => receipts.has(toolCallId) && !resolved.has(toolCallId))
    .map(([toolCallId, event]) => ({ toolCallId, stepId: typeof event.payload.stepId === 'string' ? event.payload.stepId : undefined, reason: 'Tool side effect is unknown and requires evidence-backed reconciliation.' }));
}

export function parseReconciliationRecord(event: DomainEvent): ReconciliationRecord | undefined {
  if (event.type !== 'run.reconciled') return undefined;
  const payload = event.payload as Record<string, unknown>;
  if (typeof payload.id !== 'string' || typeof payload.outcome !== 'string' || !['known', 'failed', 'unknown'].includes(payload.outcome)) return undefined;
  const evidence = Array.isArray(payload.evidence) ? payload.evidence.filter(isEvidence) : [];
  return {
    id: payload.id,
    runId: event.runId ?? '',
    toolCallId: typeof payload.toolCallId === 'string' ? payload.toolCallId : undefined,
    actionId: typeof payload.actionId === 'string' ? payload.actionId : undefined,
    outcome: payload.outcome as ReconciliationRecord['outcome'],
    evidence,
    reason: typeof payload.reason === 'string' ? payload.reason : undefined,
    recordedAt: event.timestamp,
  };
}

/** Validate the bounded evidence shape before it can resolve an unknown effect. */
export function isValidEvidence(value: unknown): value is Evidence {
  return isEvidence(value);
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function roundMoney(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function isEvidence(value: unknown): value is Evidence {
  if (!value || typeof value !== 'object') return false;
  const evidence = value as Partial<Evidence>;
  return typeof evidence.type === 'string' && typeof evidence.summary === 'string'
    && (evidence.uri === undefined || typeof evidence.uri === 'string')
    && (evidence.hash === undefined || typeof evidence.hash === 'string');
}
