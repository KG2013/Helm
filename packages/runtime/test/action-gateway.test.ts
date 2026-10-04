import test from 'node:test';
import assert from 'node:assert/strict';
import { ActionGateway, InMemoryEventStore, type ActionRequest } from '../src/index.js';

function request(overrides: Partial<ActionRequest> = {}): ActionRequest {
  return {
    actionId: 'action-1',
    runId: 'run-action',
    taskId: 'task-action',
    sessionId: 'session-action',
    profile: { id: 'connector.loopback', version: 'v1' },
    target: 'loopback://records/1',
    scope: { workspaceId: 'workspace-1' },
    capabilities: ['record.write'],
    network: { mode: 'none' },
    argsHash: 'args-hash',
    idempotencyKey: 'idem-1',
    dryRun: false,
    deadline: new Date(Date.now() + 30_000).toISOString(),
    ...overrides,
  };
}

test('ActionGateway defaults to deny and keeps raw arguments out of events', async () => {
  const store = new InMemoryEventStore();
  let executed = false;
  const gateway = new ActionGateway({ store });
  const result = await gateway.execute({
    request: request({ target: 'loopback://records?token=secret-value' }),
    adapter: { id: 'loopback', execute: async () => { executed = true; return { ok: true, receipt: { sideEffect: 'known' } }; } },
  });
  assert.equal(result.status, 'denied');
  assert.equal(executed, false);
  const jsonl = await store.exportJsonl?.('run-action');
  assert.ok(jsonl);
  assert.doesNotMatch(jsonl, /secret-value/);
  assert.match(jsonl, /action\.denied/);
});

test('ActionGateway applies ask approval, emits a typed receipt, and replays idempotently', async () => {
  const store = new InMemoryEventStore();
  let executions = 0;
  const gateway = new ActionGateway({ store, policy: () => ({ decision: 'ask' as const, reason: 'write requires approval' }) });
  const adapter = { id: 'loopback', execute: async () => { executions += 1; return { ok: true, output: { id: '1' }, receipt: { sideEffect: 'known' }, evidence: [{ type: 'read-back', summary: 'record read back', uri: 'loopback://records/1' }] }; } };
  const pending = await gateway.execute({ request: request(), adapter });
  assert.equal(pending.status, 'approval_required');
  const completed = await gateway.approve({ runId: 'run-action', actionId: 'action-1', adapter });
  assert.equal(completed.status, 'executed');
  assert.equal(executions, 1);
  const replay = await gateway.executeApproved({ request: request(), adapter });
  assert.equal(replay.replayed, true);
  assert.equal(executions, 1);
  const events = await store.list('run-action');
  assert.equal(events.filter((event) => event.type === 'action.receipt').length, 1);
  assert.equal(events.filter((event) => event.type === 'action.approved').length, 1);
});

test('ActionGateway marks adapter disconnect as UNKNOWN and reconciliation required', async () => {
  const store = new InMemoryEventStore();
  const gateway = new ActionGateway({ store, policy: () => ({ decision: 'allow' as const, reason: 'fixture' }) });
  const result = await gateway.execute({
    request: request({ actionId: 'action-unknown', idempotencyKey: 'idem-unknown' }),
    adapter: { id: 'remote', execute: async () => ({ ok: false, error: 'connection lost', receipt: { sideEffect: 'unknown' } }) },
  });
  assert.equal(result.status, 'unknown');
  const events = await store.list('run-action');
  assert.ok(events.some((event) => event.type === 'run.needs_reconciliation'));
  assert.ok(events.some((event) => event.type === 'action.receipt'));
});
