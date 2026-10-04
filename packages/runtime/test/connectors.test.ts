import test from 'node:test';
import assert from 'node:assert/strict';
import { ActionGateway, ConnectorRegistry, InMemoryEventStore } from '../src/index.js';

async function fixture() {
  const store = new InMemoryEventStore();
  const gateway = new ActionGateway({ store, policy: () => ({ decision: 'allow' as const, reason: 'connector preview policy' }) });
  const registry = new ConnectorRegistry({ store, gateway });
  await registry.register({ id: 'loopback.records', version: 'v1', connectorId: 'loopback', actions: ['record.preview'], allowedTargets: ['loopback://records'], allowedFields: ['name', 'status'], scope: { records: ['1', '2'] } });
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
