import test from 'node:test';
import assert from 'node:assert/strict';
import { ActionGateway, AgentRunCoordinator, InMemoryEventStore, type Run } from '../src/index.js';

const rootRun: Run = {
  id: 'run-root', taskId: 'task-root', sessionId: 'session-root', state: 'ready',
  createdAt: '2026-10-04T00:00:00.000Z', updatedAt: '2026-10-04T00:00:00.000Z', steps: 0, reviewerRounds: 0,
  budget: { maxSteps: 10, maxDurationMs: 60_000, maxReviewerRounds: 1 },
};

async function fixture(coordinatorOptions: { clock?: { now(): Date }; maxFanOut?: number; maxConcurrent?: number } = {}) {
  const store = new InMemoryEventStore();
  await store.append({ type: 'run.created', taskId: rootRun.taskId, sessionId: rootRun.sessionId, runId: rootRun.id, payload: rootRun as unknown as Record<string, unknown> });
  const gateway = new ActionGateway({ store, clock: coordinatorOptions.clock, policy: () => ({ decision: 'allow' as const, reason: 'parent policy' }) });
  return { store, coordinator: new AgentRunCoordinator({ store, gateway, ...coordinatorOptions }) };
}

test('AgentRunCoordinator persists bounded identity, lineage, and capability scope', async () => {
  const { store, coordinator } = await fixture();
  const child = await coordinator.createChild({
    parentRunId: rootRun.id, role: 'researcher', principal: 'local-user', goal: 'Inspect one bounded resource',
    capabilities: ['workspace.read'], scope: { workspaceId: 'workspace-root', paths: ['README.md'] },
    allowedCapabilities: ['workspace.read', 'workspace.inspect'], allowedScope: { workspaceId: 'workspace-root', paths: ['README.md', 'docs/'] },
    budget: { maxSteps: 3 },
  });
  assert.equal(child.parentRunId, rootRun.id);
  assert.equal(child.rootRunId, rootRun.id);
  assert.deepEqual(child.identity.capabilities, ['workspace.read']);
  assert.equal((await coordinator.get(child.agentRunId))?.state, 'created');
  const events = await store.list(rootRun.id);
  assert.ok(events.some((event) => event.type === 'action.requested' && event.payload.parentAgentId === undefined));
  assert.ok(events.some((event) => event.type === 'agent.created'));
});

test('AgentRunCoordinator rejects capability and scope escalation before any child is created', async () => {
  const { coordinator } = await fixture({ clock: { now: () => new Date('2026-10-04T00:01:00.000Z') } });
  await assert.rejects(() => coordinator.createChild({
    parentRunId: rootRun.id, role: 'unsafe', principal: 'local-user', goal: 'escape',
    capabilities: ['shell.exec'], scope: { workspaceId: 'workspace-root', paths: ['private.txt'] },
    allowedCapabilities: ['workspace.read'], allowedScope: { workspaceId: 'workspace-root', paths: ['README.md'] },
  }), /capability/i);
});

test('child result requires typed evidence and is replayable through the parent ledger', async () => {
  const { coordinator } = await fixture();
  const child = await coordinator.createChild({
    parentRunId: rootRun.id, role: 'worker', principal: 'local-user', goal: 'bounded work',
    capabilities: ['workspace.read'], scope: { workspaceId: 'workspace-root' },
    allowedCapabilities: ['workspace.read'], allowedScope: { workspaceId: 'workspace-root' },
  });
  await assert.rejects(() => coordinator.recordResult({ agentRunId: child.agentRunId, status: 'success', evidence: [], artifacts: [] }), /evidence|Artifact/i);
  const result = await coordinator.recordResult({ agentRunId: child.agentRunId, status: 'success', output: { answer: 'ok' }, evidence: [{ type: 'workspace', summary: 'bounded read', uri: 'workspace://workspace-root/README.md' }], artifacts: [] });
  assert.equal(result.status, 'success');
  assert.equal((await coordinator.get(child.agentRunId))?.state, 'completed');
  assert.equal((await coordinator.list(rootRun.id)).length, 1);
});

test('child actions are bounded by identity scope and aggregate typed evidence', async () => {
  const { coordinator } = await fixture({ clock: { now: () => new Date('2026-10-04T00:01:00.000Z') } });
  const child = await coordinator.createChild({
    parentRunId: rootRun.id, role: 'worker', principal: 'local-user', goal: 'bounded action',
    capabilities: ['record.read'], scope: { connector: 'loopback', records: ['1'] },
    allowedCapabilities: ['record.read'], allowedScope: { connector: 'loopback', records: ['1', '2'] },
  });
  const result = await coordinator.executeChildAction({
    agentRunId: child.agentRunId, actionId: 'child-action-1', profile: { id: 'connector.read', version: 'v1' },
    target: 'loopback://records/1', capabilities: ['record.read'], scope: { connector: 'loopback', records: ['1'] },
    argsHash: 'hash', argsSummary: 'record:1', adapter: { id: 'loopback', execute: async () => ({ ok: true, output: { id: '1' }, receipt: { sideEffect: 'none' }, evidence: [{ type: 'record', summary: 'record read back', uri: 'loopback://records/1' }] }) },
  });
  assert.equal(result.status, 'success');
  assert.equal((await coordinator.aggregate(rootRun.id)).status, 'success');
  await assert.rejects(() => coordinator.executeChildAction({
    agentRunId: child.agentRunId, actionId: 'child-action-2', profile: { id: 'connector.write', version: 'v1' },
    target: 'loopback://records/2', capabilities: ['record.write'], scope: { connector: 'loopback', records: ['2'] }, argsHash: 'hash', adapter: { id: 'loopback', execute: async () => ({ ok: true }) },
  }), /capability/i);
});

test('AgentRunCoordinator enforces fan-out, records cumulative usage, and recovers unknown running children', async () => {
  const store = new InMemoryEventStore();
  await store.append({ type: 'run.created', taskId: rootRun.taskId, sessionId: rootRun.sessionId, runId: rootRun.id, payload: rootRun as unknown as Record<string, unknown> });
  const gateway = new ActionGateway({ store });
  const coordinator = new AgentRunCoordinator({ store, gateway, maxFanOut: 1, maxConcurrent: 1 });
  const input = { parentRunId: rootRun.id, role: 'worker', principal: 'local-user', goal: 'bounded', capabilities: ['read'], scope: { resource: 'one' }, allowedCapabilities: ['read'], allowedScope: { resource: 'one' } };
  const child = await coordinator.createChild(input);
  await assert.rejects(() => coordinator.createChild({ ...input, role: 'second' }), /fan-out/i);
  await coordinator.setState(child.agentRunId, 'running');
  const recovered = await coordinator.recover(rootRun.id);
  assert.equal(recovered[0]?.state, 'unknown');
  assert.ok((await coordinator.getBudgetUsage(rootRun.id)).steps >= 0);
  const cancelled = await coordinator.cancelTree(rootRun.id);
  assert.equal(cancelled.length, 0);
});
