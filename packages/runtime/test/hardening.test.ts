import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryEventStore, MockProvider, RuntimeFacade, listReconciliationCandidates, summarizeBudgetUsage, type DomainEvent, type Run } from '../src/index.js';

function runFixture(): Run {
  return {
    id: 'run-hardening',
    taskId: 'task-hardening',
    sessionId: 'session-hardening',
    state: 'paused',
    createdAt: '2026-10-04T00:00:00.000Z',
    updatedAt: '2026-10-04T00:01:00.000Z',
    steps: 2,
    reviewerRounds: 0,
    budget: { maxSteps: 5, maxDurationMs: 120_000, maxReviewerRounds: 1 },
  };
}

function event(type: DomainEvent['type'], payload: Record<string, unknown>, sequence: number): DomainEvent {
  return { id: `event-${sequence}`, sequence, type, runId: 'run-hardening', taskId: 'task-hardening', sessionId: 'session-hardening', timestamp: `2026-10-04T00:00:0${sequence}.000Z`, payload };
}

test('budget usage is reconstructed from durable usage events after a pause or reconnect', () => {
  const run = runFixture();
  const usage = summarizeBudgetUsage(run, [
    event('usage.recorded', { totalTokens: 4, costUsd: 0.2, latencyMs: 20, retries: 1, cacheHit: false }, 1),
    event('run.paused', { reason: 'approval' }, 2),
    event('usage.recorded', { inputTokens: 2, outputTokens: 3, costUsd: 0.1, latencyMs: 10, retries: 0, cacheHit: true }, 3),
  ], Date.parse('2026-10-04T00:01:00.000Z'));
  assert.deepEqual(usage, {
    steps: 2,
    durationMs: 60_000,
    tokens: 9,
    costUsd: 0.3,
    latencyMs: 30,
    retries: 1,
    cacheMisses: 1,
    reviewerRounds: 0,
  });
});

test('reconciliation candidates disappear only after evidence-backed resolution', async () => {
  const store = new InMemoryEventStore();
  await store.append({ type: 'task.created', taskId: 'task-hardening', payload: { id: 'task-hardening', goal: 'reconcile', workspaceId: 'workspace-1', createdAt: 'now', budget: runFixture().budget } });
  await store.append({ type: 'session.created', taskId: 'task-hardening', sessionId: 'session-hardening', payload: { id: 'session-hardening', taskId: 'task-hardening', createdAt: 'now', status: 'active' } });
  await store.append({ type: 'run.created', taskId: 'task-hardening', sessionId: 'session-hardening', runId: 'run-hardening', payload: runFixture() as unknown as Record<string, unknown> });
  await store.append({ type: 'tool.call', taskId: 'task-hardening', sessionId: 'session-hardening', runId: 'run-hardening', payload: { id: 'tool-1', stepId: 'step-1', name: 'external.write', arguments: {} } });
  await store.append({ type: 'tool.receipt', taskId: 'task-hardening', sessionId: 'session-hardening', runId: 'run-hardening', payload: { toolCallId: 'tool-1', ok: true, receipt: { sideEffect: 'unknown' } } });
  assert.equal(listReconciliationCandidates(await store.list('run-hardening')).length, 1);

  const runtime = new RuntimeFacade({ store, provider: new MockProvider(), ownerId: 'hardening-owner' });
  await assert.rejects(() => runtime.recordReconciliation({ runId: 'run-hardening', toolCallId: 'tool-1', outcome: 'known' }), /requires evidence/i);
  await runtime.recordReconciliation({
    runId: 'run-hardening',
    toolCallId: 'tool-1',
    outcome: 'known',
    evidence: [{ type: 'remote-state', summary: 'Remote record was read back.', uri: 'connector://loopback/records/1', hash: 'hash-1' }],
  });
  assert.equal((await runtime.listReconciliationCandidates('run-hardening')).length, 0);
});
