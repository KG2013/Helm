import test from 'node:test';
import assert from 'node:assert/strict';
import { ActionGateway, ConnectorRegistry, InMemoryEventStore } from '../src/index.js';

async function fixture() {
  const store = new InMemoryEventStore();
  const gateway = new ActionGateway({ store, policy: () => ({ decision: 'allow' as const, reason: 'connector preview policy' }) });
  const registry = new ConnectorRegistry({ store, gateway });
  await registry.register({ id: 'loopback.records', version: 'v1', connectorId: 'loopback', actions: ['record.preview', 'record.write'], allowedTargets: ['loopback://records'], allowedFields: ['name', 'status'], scope: { records: ['1', '2'], token: 'private-token' } });
  return { store, registry };
}

test('ConnectorRegistry persists versioned profiles and creates a dry-run preview without writing', async () => {
  const { store, registry } = await fixture();
  const result = await registry.preview({
    runId: 'run-connector', taskId: 'task-connector', sessionId: 'session-connector', connectorId: 'loopback', profileId: 'loopback.records', profileVersion: 'v1', action: 'record.preview', target: 'loopback://records/1', scope: { records: ['1'] }, before: { name: 'old' }, after: { name: 'new', status: 'ready' }, versionCondition: 'etag-1', impact: ['one record'], rollbackPlan: 'restore etag-1', reconciliationPlan: 'read record 1',
  });
  assert.equal(result.preview.dryRun, true);
  assert.equal(result.action.status, 'executed');
  assert.equal((result.action.receipt as { sideEffect?: string }).sideEffect, 'none');
  const events = await store.list('run-connector');
  assert.ok(events.some((event) => event.type === 'connector.preview'));
  assert.ok(events.some((event) => event.type === 'action.receipt'));
  assert.equal(registry.list().length, 1);
});

test('ConnectorRegistry rejects unregistered target, field, and scope before the Gateway', async () => {
  const { registry } = await fixture();
  await assert.rejects(() => registry.preview({
    runId: 'run-connector', taskId: 'task-connector', sessionId: 'session-connector', connectorId: 'loopback', profileId: 'loopback.records', profileVersion: 'v1', action: 'record.preview', target: 'loopback://private', scope: { records: ['1'] }, before: {}, after: {}, impact: [], rollbackPlan: '', reconciliationPlan: '',
  }), /target/i);
  await assert.rejects(() => registry.preview({
    runId: 'run-connector', taskId: 'task-connector', sessionId: 'session-connector', connectorId: 'loopback', profileId: 'loopback.records', profileVersion: 'v1', action: 'record.preview', target: 'loopback://records/1', scope: { records: ['9'] }, before: {}, after: { secret: 'x' }, impact: [], rollbackPlan: '', reconciliationPlan: '',
  }), /scope/i);
});

test('ConnectorRegistry writes through the Gateway with idempotent, hash-only receipts', async () => {
  const { store, registry } = await fixture();
  const input = {
    runId: 'run-connector-write', taskId: 'task-connector-write', sessionId: 'session-connector-write', connectorId: 'loopback', profileId: 'loopback.records', profileVersion: 'v1', action: 'record.write', target: 'loopback://records/1', scope: { records: ['1'], token: 'private-token' }, after: { name: 'new', status: 'ready' }, idempotencyKey: 'write-once', actionId: 'action-write-1', remoteRequestId: 'remote-42', postcondition: 'read back status=ready', artifactRef: 'artifact://receipt/1', traceRef: 'trace://run-connector-write/action-write-1',
  } as const;
  const first = await registry.write(input);
  const second = await registry.write(input);
  assert.equal(first.action.status, 'executed');
  assert.equal(first.receipt.replayed, false);
  assert.equal(second.receipt.replayed, true);
  assert.equal(second.receipt.version, first.receipt.version);
  assert.equal(first.receipt.remoteRequestId, 'remote-42');
  assert.equal(first.receipt.postcondition, 'read back status=ready');
  assert.equal(first.receipt.scope.token, '[redacted]');
  assert.equal(first.receipt.artifactRef, 'artifact://receipt/1');
  assert.equal(first.receipt.traceRef, 'trace://run-connector-write/action-write-1');
  assert.notEqual(first.receipt.afterHash, 'new');
  const events = await store.list(input.runId);
  const receiptEvents = events.filter((event) => event.type === 'connector.receipt');
  assert.equal(receiptEvents.length, 2);
  assert.equal(Object.hasOwn(receiptEvents[0]!.payload, 'after'), false);
  assert.ok(receiptEvents[0]!.payload.afterHash);
});

test('ConnectorRegistry rejects stale expected versions without mutating the record', async () => {
  const { registry } = await fixture();
  const result = await registry.write({ runId: 'run-connector-conflict', taskId: 'task-connector-conflict', sessionId: 'session-connector-conflict', connectorId: 'loopback', profileId: 'loopback.records', profileVersion: 'v1', action: 'record.write', target: 'loopback://records/2', scope: { records: ['2'] }, after: { name: 'new' }, expectedVersion: 'v9', idempotencyKey: 'write-conflict' });
  assert.equal(result.action.status, 'failed');
  assert.equal(result.receipt.version, 'v0');
});
