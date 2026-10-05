import type { DomainEvent, Episode, ID, ReleaseGateResult, Run, UsageRecord } from './types.js';
import { redactRunEvent } from './projection.js';
import { isBudgetExceeded, summarizeBudgetUsage } from './hardening.js';

/** Build a redacted, replayable Episode without exposing raw provider payloads. */
export async function buildEpisode(store: { list(runId: ID): Promise<DomainEvent[]>; exportJsonl?(runId?: ID): Promise<string> }, runId: ID): Promise<Episode> {
  const events = await store.list(runId);
  if (!events.length) throw new Error(`No events found for ${runId}`);
  const first = events[0];
  const usage = events
    .filter((event) => event.type === 'usage.recorded')
    .map((event) => event.payload as unknown as UsageRecord);
  const redactedJsonl = store.exportJsonl ? await store.exportJsonl(runId) : events.map((event) => JSON.stringify({ type: event.type, sequence: event.sequence })).join('\n');
  const redactedEvents = events.map(redactRunEvent);
  const trace = {
    taskId: first.taskId,
    sessionId: first.sessionId,
    providerIds: uniqueStrings(events.flatMap((event) => [event.payload.provider, event.payload.model]).filter((value): value is string => typeof value === 'string')),
    toolProfiles: uniqueStrings(events.flatMap((event) => [event.payload.toolProfile, event.payload.profile, (event.payload.receipt as Record<string, unknown> | undefined)?.profile]).filter((value): value is string => typeof value === 'string')),
    toolProfileVersions: uniqueStrings(events.flatMap((event) => {
      const profile = event.payload.toolProfile ?? event.payload.profile ?? (event.payload.receipt as Record<string, unknown> | undefined)?.profile;
      if (typeof profile === 'string') return [profile];
      if (profile && typeof profile === 'object') {
        const value = profile as Record<string, unknown>;
        return typeof value.id === 'string' && typeof value.version === 'string' ? [`${value.id}@${value.version}`] : [];
      }
      return [];
    })),
    policyVersions: uniqueStrings(events.flatMap((event) => {
      const binding = event.payload.binding;
      const direct = event.payload.policyVersion;
      const bound = binding && typeof binding === 'object' ? (binding as Record<string, unknown>).policyVersion : undefined;
      return [direct, bound].filter((value): value is string => typeof value === 'string');
    })),
    stepIds: uniqueStrings(events.map((event) => event.payload.stepId).filter((value): value is string => typeof value === 'string')),
    approvalIds: uniqueStrings(events.map((event) => event.payload.approvalId).filter((value): value is string => typeof value === 'string')),
    artifactUris: uniqueStrings(events.flatMap((event) => [
      (event.payload.receipt as Record<string, unknown> | undefined)?.artifact,
      event.payload.verification && typeof event.payload.verification === 'object' ? (event.payload.verification as Record<string, unknown>).evidence : undefined,
    ]).flatMap((value) => Array.isArray(value) ? value : [value]).map((value) => value && typeof value === 'object' ? (value as Record<string, unknown>).uri : undefined).filter((value): value is string => typeof value === 'string')),
    verifierIds: uniqueStrings(events.map((event) => event.payload.verification && typeof event.payload.verification === 'object' ? (event.payload.verification as Record<string, unknown>).verifier : undefined).filter((value): value is string => typeof value === 'string')),
    requestIds: uniqueStrings(events.map((event) => event.payload.requestId).filter((value): value is string => typeof value === 'string')),
    traceIds: uniqueStrings(events.map((event) => event.payload.traceId).filter((value): value is string => typeof value === 'string')),
  };
  const evaluation: Pick<Episode, 'evaluationCase' | 'evaluationSplit' | 'evaluationAttempt'> = first.payload.evaluationCase && typeof first.payload.evaluationCase === 'string' ? {
    evaluationCase: first.payload.evaluationCase,
    evaluationSplit: first.payload.evaluationSplit === 'dev' || first.payload.evaluationSplit === 'holdout' ? first.payload.evaluationSplit : undefined,
    evaluationAttempt: typeof first.payload.evaluationAttempt === 'number' ? first.payload.evaluationAttempt : undefined,
  } : {};
  return { runId, taskId: first.taskId, sessionId: first.sessionId, events: redactedEvents, usage, redactedJsonl, trace, ...evaluation };
}

export interface ReleaseGateOptions {
  /** Require a complete critical dev/holdout matrix instead of allowing a single episode. */
  requireFixedMatrix?: boolean;
  /** Case IDs that must each appear in both dev and holdout splits. */
  criticalCaseIds?: readonly string[];
  repetitions?: number;
}

/** Deterministic release gate for fixed Run evidence. */
export function evaluateReleaseGate(episodes: readonly Episode[], options: ReleaseGateOptions = {}): ReleaseGateResult {
  const reasons: string[] = [];
  const repetitions = options.repetitions ?? 3;
  if (options.requireFixedMatrix && repetitions < 3) reasons.push('Critical evaluation matrix must run at least three repetitions.');
  const runIds = episodes.map((episode) => episode.runId);
  if (!episodes.length) reasons.push('No evaluation episodes were supplied.');
  for (const episode of episodes) {
    const events = episode.events;
    const terminal = [...events].reverse().find((event) => ['run.completed', 'run.failed', 'run.cancelled', 'run.needs_reconciliation'].includes(event.type));
    if (terminal?.type !== 'run.completed') reasons.push(`${episode.runId}: run did not complete.`);
    const payload = (event: DomainEvent): Record<string, unknown> => event.payload as Record<string, unknown>;
    const evidence = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
    const hasEvidence = (value: unknown): boolean => evidence(value).length > 0 && evidence(value).every((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
      const record = item as Record<string, unknown>;
      return typeof record.type === 'string' && record.type.trim().length > 0
        && typeof record.summary === 'string' && record.summary.trim().length > 0
        && (record.uri === undefined || typeof record.uri === 'string')
        && (record.hash === undefined || typeof record.hash === 'string');
    });
    const reconciliations = events.filter((event) => event.type === 'run.reconciled');
    const knownReconciled = new Set(reconciliations
      .filter((event) => String(payload(event).outcome) === 'known' && hasEvidence(payload(event).evidence))
      .flatMap((event) => [payload(event).toolCallId, payload(event).actionId].filter((value): value is string => typeof value === 'string')));
    if (reconciliations.some((event) => String(payload(event).outcome) === 'unknown')) reasons.push(`${episode.runId}: reconciliation remains unknown.`);
    const unknownCalls = events.filter((event) => event.type === 'tool.receipt' && (payload(event).receipt as { sideEffect?: string } | undefined)?.sideEffect === 'unknown' && typeof payload(event).toolCallId === 'string');
    const unresolvedUnknown = unknownCalls.some((event) => !knownReconciled.has(String(payload(event).toolCallId)));
    if (unresolvedUnknown) reasons.push(`${episode.runId}: tool side effect is unknown or lacks evidence-backed reconciliation.`);
    const unresolvedRunRecovery = events.some((event) => {
      if (event.type !== 'run.needs_reconciliation') return false;
      const recovery = payload(event);
      const key = typeof recovery.toolCallId === 'string' ? recovery.toolCallId : typeof recovery.actionId === 'string' ? recovery.actionId : undefined;
      return !key || !knownReconciled.has(key);
    });
    if (unresolvedRunRecovery) reasons.push(`${episode.runId}: run requires reconciliation.`);
    if (events.some((event) => event.type === 'run.failed' || event.type === 'run.cancelled')) reasons.push(`${episode.runId}: run contains a failed or cancelled terminal event.`);
    const verificationEvents = events.filter((event) => event.type === 'verification.result');
    if (!verificationEvents.length || verificationEvents.some((event) => {
      const verification = payload(event).verification as { result?: string; evidence?: unknown } | undefined;
      return verification?.result !== 'passed' || !hasEvidence(verification?.evidence);
    })) reasons.push(`${episode.runId}: verification is missing, unknown, failed, or lacks evidence.`);

    const runCreated = [...events].reverse().find((event) => event.type === 'run.created');
    if (runCreated) {
      const run = payload(runCreated) as unknown as Run;
      try {
        const stepIndexes = events
          .filter((event) => event.type === 'step.started' || event.type === 'step.completed')
          .map((event) => Number(payload(event).index))
          .filter((value) => Number.isFinite(value));
        const currentRun = { ...run, steps: Math.max(run.steps ?? 0, ...stepIndexes) };
        const timestamps = events.map((event) => Date.parse(event.timestamp)).filter(Number.isFinite);
        const now = timestamps.length ? Math.max(...timestamps) : Date.now();
        const usage = summarizeBudgetUsage(currentRun, events, now);
        if (isBudgetExceeded(currentRun.budget, usage)) reasons.push(`${episode.runId}: durable budget usage exceeds the Run budget.`);
      } catch {
        reasons.push(`${episode.runId}: Run budget metadata is invalid.`);
      }
    }

    const actionIds = new Set(events
      .filter((event) => event.type.startsWith('action.'))
      .map((event) => payload(event).actionId)
      .filter((value): value is string => typeof value === 'string'));
    for (const actionId of actionIds) {
      const actionEvents = events.filter((event) => payload(event).actionId === actionId);
      const latest = [...actionEvents].reverse().find((event) => ['action.receipt', 'action.denied', 'action.approved', 'action.approval_required'].includes(event.type));
      const receipt = [...actionEvents].reverse().find((event) => event.type === 'action.receipt');
      const approvalRequired = actionEvents.some((event) => event.type === 'action.approval_required');
      const approved = actionEvents.some((event) => event.type === 'action.approved');
      const denied = actionEvents.some((event) => event.type === 'action.denied');
      if (approvalRequired && !approved && !denied) reasons.push(`${episode.runId}: action ${actionId} is awaiting approval.`);
      if (approved && !receipt) reasons.push(`${episode.runId}: approved action ${actionId} has no durable receipt.`);
      if (receipt) {
        const receiptPayload = payload(receipt);
        const actionReceipt = receiptPayload.receipt as Record<string, unknown> | undefined;
        const effect = actionReceipt?.effect ?? actionReceipt?.sideEffect ?? receiptPayload.outcome;
        if (effect === 'unknown') {
          if (!knownReconciled.has(actionId)) reasons.push(`${episode.runId}: action ${actionId} side effect is unknown.`);
        } else if (actionReceipt?.ok !== true || receiptPayload.outcome === 'failed') {
          reasons.push(`${episode.runId}: action ${actionId} failed.`);
        } else if (latest?.type === 'action.approval_required') {
          reasons.push(`${episode.runId}: action ${actionId} remains unapproved.`);
        }
        const target = String(receiptPayload.target ?? actionReceipt?.target ?? '');
        if (effect !== 'none' && !target.startsWith('tool:') && !hasEvidence(receiptPayload.evidence ?? actionReceipt?.evidence)) reasons.push(`${episode.runId}: action ${actionId} lacks evidence.`);
      }
    }

    const approvalIds = new Set(events
      .filter((event) => event.type === 'approval.requested' || event.type === 'approval.decided')
      .map((event) => payload(event).approvalId)
      .filter((value): value is string => typeof value === 'string'));
    for (const approvalId of approvalIds) {
      const approvalEvents = events.filter((event) => payload(event).approvalId === approvalId);
      const requested = approvalEvents.some((event) => event.type === 'approval.requested');
      const decided = [...approvalEvents].reverse().find((event) => event.type === 'approval.decided');
      if (requested && !decided) reasons.push(`${episode.runId}: approval ${approvalId} is pending.`);
      if (decided && payload(decided).decision !== 'approve') reasons.push(`${episode.runId}: approval ${approvalId} was denied.`);
    }

    const connectorReconciliations = latestReconciliation(events, 'connector.reconciliation');
    for (const event of events.filter((candidate) => candidate.type === 'connector.receipt')) {
      const actionId = typeof payload(event).actionId === 'string' ? payload(event).actionId : undefined;
      if (typeof actionId !== 'string' || !connectorReconciliations.has(actionId)) reasons.push(`${episode.runId}: Connector receipt lacks reconciliation.`);
    }
    for (const event of connectorReconciliations.values()) {
      const status = String(payload(event).status);
      const actionId = typeof payload(event).actionId === 'string' ? payload(event).actionId : undefined;
      if (status === 'unknown' && (typeof actionId !== 'string' || !knownReconciled.has(actionId))) reasons.push(`${episode.runId}: Connector reconciliation is unknown.`);
      if (status === 'failed') reasons.push(`${episode.runId}: Connector reconciliation failed.`);
      if ((status === 'known' || status === 'failed') && !hasEvidence(payload(event).evidence)) reasons.push(`${episode.runId}: Connector reconciliation lacks evidence.`);
    }
    const browserReconciliations = latestReconciliation(events, 'browser.reconciliation');
    for (const event of events.filter((candidate) => candidate.type === 'browser.action')) {
      const actionId = typeof payload(event).actionId === 'string' ? payload(event).actionId : undefined;
      if (typeof actionId !== 'string' || !browserReconciliations.has(actionId)) reasons.push(`${episode.runId}: Browser action lacks reconciliation.`);
    }
    for (const event of browserReconciliations.values()) {
      const status = String(payload(event).status);
      const actionId = typeof payload(event).actionId === 'string' ? payload(event).actionId : undefined;
      if (status === 'unknown' && (typeof actionId !== 'string' || !knownReconciled.has(actionId))) reasons.push(`${episode.runId}: Browser reconciliation is unknown.`);
      if (status === 'failed') reasons.push(`${episode.runId}: Browser reconciliation failed.`);
      if ((status === 'known' || status === 'failed') && !hasEvidence(payload(event).evidence)) reasons.push(`${episode.runId}: Browser reconciliation lacks evidence.`);
    }

    const agentIds = new Set(events
      .filter((event) => event.type === 'agent.created' || event.type === 'agent.state_changed' || event.type === 'agent.result')
      .map((event) => payload(event).agentRunId)
      .filter((value): value is string => typeof value === 'string'));
    for (const agentRunId of agentIds) {
      const agentEvents = events.filter((event) => payload(event).agentRunId === agentRunId);
      const result = [...agentEvents].reverse().find((event) => event.type === 'agent.result');
      const state = [...agentEvents].reverse().find((event) => event.type === 'agent.state_changed');
      const resultStatus = result ? String(payload(result).status) : undefined;
      const stateValue = state ? String(payload(state).state) : undefined;
      if (!result || ['created', 'running', 'paused', 'unknown'].includes(stateValue ?? '') || !['success', 'failure'].includes(resultStatus ?? '')) reasons.push(`${episode.runId}: child AgentRun ${agentRunId} is incomplete or unknown.`);
      if (resultStatus === 'failure' || stateValue === 'failed' || stateValue === 'cancelled') reasons.push(`${episode.runId}: child AgentRun ${agentRunId} failed or was cancelled.`);
      if (result && resultStatus === 'success' && !hasEvidence(payload(result).evidence) && !hasEvidence(payload(result).artifacts)) reasons.push(`${episode.runId}: child AgentRun ${agentRunId} lacks evidence.`);
    }

    const a2aReconciled = new Set(events.filter((event) => event.type === 'a2a.reconciliation' && String(payload(event).outcome) === 'known' && hasEvidence(payload(event).evidence)).map((event) => String(payload(event).messageId ?? '')));
    if (events.some((event) => event.type === 'a2a.reconciliation' && String(payload(event).outcome) === 'failed')) reasons.push(`${episode.runId}: A2A reconciliation failed.`);
    const deliveries = new Map<string, DomainEvent>();
    for (const event of events.filter((candidate) => candidate.type === 'a2a.delivery')) {
      const messageId = payload(event).messageId;
      if (typeof messageId === 'string') deliveries.set(messageId, event);
    }
    for (const [messageId, event] of deliveries) {
      const state = String(payload(event).state);
      if (state === 'queued' || state === 'sent') reasons.push(`${episode.runId}: A2A delivery ${messageId} is not acknowledged.`);
      if (state === 'unknown' && !a2aReconciled.has(messageId)) reasons.push(`${episode.runId}: A2A delivery ${messageId} is unknown.`);
      if (state === 'unknown' && events.some((candidate) => candidate.type === 'a2a.reconciliation' && payload(candidate).messageId === messageId && String(payload(candidate).outcome) === 'known' && !hasEvidence(payload(candidate).evidence))) reasons.push(`${episode.runId}: A2A reconciliation ${messageId} lacks evidence.`);
      if (state === 'failed') reasons.push(`${episode.runId}: A2A delivery ${messageId} failed.`);
      if (state === 'ack' && !/^[a-f0-9]{64}$/i.test(String(payload(event).receiptHash ?? ''))) reasons.push(`${episode.runId}: A2A delivery ${messageId} lacks a valid receipt hash.`);
    }
    const envelopeIds = new Set(events.filter((event) => event.type === 'a2a.envelope').map((event) => String((payload(event).envelope as Record<string, unknown> | undefined)?.messageId ?? '')).filter(Boolean));
    for (const messageId of envelopeIds) if (!deliveries.has(messageId)) reasons.push(`${episode.runId}: A2A envelope ${messageId} has no delivery state.`);
    if (containsCredentialMarker(episode.redactedJsonl)) reasons.push(`${episode.runId}: redacted export still contains a credential marker.`);
  }
  const evaluated = episodes.filter((episode) => episode.evaluationCase);
  const cases = new Set(evaluated.map((episode) => episode.evaluationCase).filter((value): value is string => Boolean(value)));
  const requiredCases = options.criticalCaseIds ? new Set(options.criticalCaseIds) : cases;
  if (options.requireFixedMatrix && !requiredCases.size) reasons.push('No fixed evaluation cases were supplied.');
  for (const evaluationCase of requiredCases) {
    for (const split of ['dev', 'holdout'] as const) {
      const group = evaluated.filter((episode) => episode.evaluationCase === evaluationCase && episode.evaluationSplit === split);
      if (group.length < repetitions) reasons.push(`${split}:${evaluationCase}: critical evaluation case requires ${repetitions} repeated runs.`);
      const attempts = new Set(group.map((episode) => episode.evaluationAttempt).filter((value): value is number => typeof value === 'number'));
      if (attempts.size < repetitions) reasons.push(`${split}:${evaluationCase}: repeated runs must contain ${repetitions} distinct attempts.`);
    }
  }
  return { result: reasons.length ? 'blocked' : 'passed', reasons, runIds };
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function latestReconciliation(events: readonly DomainEvent[], type: DomainEvent['type']): Map<string, DomainEvent> {
  const latest = new Map<string, DomainEvent>();
  for (const event of events) {
    if (event.type !== type) continue;
    const payload = event.payload as Record<string, unknown>;
    const key = typeof payload.actionId === 'string' ? payload.actionId : event.id;
    latest.set(key, event);
  }
  return latest;
}

function containsCredentialMarker(value: string): boolean {
  return /(?:api[-_ ]?key|authorization|cookie|secret|password|token)\s*[:=]\s*(?!\[redacted\])/i.test(value)
    || /"(?:api[-_ ]?key|authorization|cookie|secret|password|token)"\s*:\s*"(?!\[redacted\])[^"]+/i.test(value)
    || /\b(?:sk|pk)-[A-Za-z0-9_-]{8,}\b/i.test(value);
}
