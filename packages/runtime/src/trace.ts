import type { DomainEvent, Episode, ID, ReleaseGateResult, UsageRecord } from './types.js';

/** Build a redacted, replayable Episode without exposing raw provider payloads. */
export async function buildEpisode(store: { list(runId: ID): Promise<DomainEvent[]>; exportJsonl?(runId?: ID): Promise<string> }, runId: ID): Promise<Episode> {
  const events = await store.list(runId);
  if (!events.length) throw new Error(`No events found for ${runId}`);
  const first = events[0];
  const usage = events
    .filter((event) => event.type === 'usage.recorded')
    .map((event) => event.payload as unknown as UsageRecord);
  const redactedJsonl = store.exportJsonl ? await store.exportJsonl(runId) : events.map((event) => JSON.stringify({ type: event.type, sequence: event.sequence })).join('\n');
  return { runId, taskId: first.taskId, sessionId: first.sessionId, events, usage, redactedJsonl };
}

/** Deterministic release gate for fixed Run evidence. */
export function evaluateReleaseGate(episodes: readonly Episode[]): ReleaseGateResult {
  const reasons: string[] = [];
  const runIds = episodes.map((episode) => episode.runId);
  if (!episodes.length) reasons.push('No evaluation episodes were supplied.');
  for (const episode of episodes) {
    const terminal = [...episode.events].reverse().find((event) => ['run.completed', 'run.failed', 'run.cancelled', 'run.needs_reconciliation'].includes(event.type));
    if (terminal?.type !== 'run.completed') reasons.push(`${episode.runId}: run did not complete.`);
    if (episode.events.some((event) => event.type === 'run.needs_reconciliation')) reasons.push(`${episode.runId}: unreconciled side effect or recovery gap.`);
    if (episode.events.some((event) => event.type === 'verification.result' && (event.payload.verification as { result?: string } | undefined)?.result !== 'passed')) reasons.push(`${episode.runId}: verification is missing, unknown, or failed.`);
    if (/(?:api[-_ ]?key|authorization|cookie|secret|password|token)\s*[:=]/i.test(episode.redactedJsonl)) reasons.push(`${episode.runId}: redacted export still contains a credential marker.`);
  }
  return { result: reasons.length ? 'blocked' : 'passed', reasons, runIds };
}
