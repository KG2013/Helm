import type { DomainEvent, Episode, ID, ReleaseGateResult, UsageRecord } from './types.js';
import { redactRunEvent } from './projection.js';

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
    const terminal = [...episode.events].reverse().find((event) => ['run.completed', 'run.failed', 'run.cancelled', 'run.needs_reconciliation'].includes(event.type));
    if (terminal?.type !== 'run.completed') reasons.push(`${episode.runId}: run did not complete.`);
    if (episode.events.some((event) => event.type === 'run.needs_reconciliation')) reasons.push(`${episode.runId}: unreconciled side effect or recovery gap.`);
    const verificationEvents = episode.events.filter((event) => event.type === 'verification.result');
    if (!verificationEvents.length || verificationEvents.some((event) => (event.payload.verification as { result?: string } | undefined)?.result !== 'passed')) reasons.push(`${episode.runId}: verification is missing, unknown, or failed.`);
    if (episode.events.some((event) => event.type === 'tool.receipt' && (event.payload.receipt as { sideEffect?: string } | undefined)?.sideEffect === 'unknown')) reasons.push(`${episode.runId}: tool side effect is unknown.`);
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

function containsCredentialMarker(value: string): boolean {
  return /(?:api[-_ ]?key|authorization|cookie|secret|password|token)\s*[:=]\s*(?!\[redacted\])/i.test(value)
    || /"(?:api[-_ ]?key|authorization|cookie|secret|password|token)"\s*:\s*"(?!\[redacted\])[^"]+/i.test(value)
    || /\b(?:sk|pk)-[A-Za-z0-9_-]{8,}\b/i.test(value);
}
