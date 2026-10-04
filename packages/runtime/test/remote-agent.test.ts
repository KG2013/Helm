import test from 'node:test';
import assert from 'node:assert/strict';
import { A2ALoopbackTransport, ActionGateway, AgentRunCoordinator, InMemoryEventStore, MemoryArtifactStore, RemoteAgentCoordinator, type A2AIdentity, type Run } from '../src/index.js';

const rootRun: Run = {
  id: 'run-remote-root', taskId: 'task-remote', sessionId: 'session-remote', state: 'ready',
  createdAt: '2026-10-04T00:00:00.000Z', updatedAt: '2026-10-04T00:00:00.000Z', steps: 0, reviewerRounds: 0,
  budget: { maxSteps: 10, maxDurationMs: 60_000, maxReviewerRounds: 1 },
};
const sender: A2AIdentity = { id: 'remote-parent', principal: 'principal-parent', role: 'planner', capabilities: ['delegate:read'], scope: { taskId: rootRun.taskId } };
const recipient: A2AIdentity = { id: 'remote-worker', principal: 'principal-worker', role: 'worker', capabilities: ['delegate:read'], scope: { taskId: rootRun.taskId } };

async function fixture(policy: (request: Parameters<NonNullable<ConstructorParameters<typeof ActionGateway>[0]>['policy']>[0]) => { decision: 'allow' | 'ask' | 'deny'; reason: string } = () => ({ decision: 'allow', reason: 'fixture' })) {
  const store = new InMemoryEventStore();
  await store.append({ type: 'run.created', taskId: rootRun.taskId, sessionId: rootRun.sessionId, runId: rootRun.id, payload: rootRun as unknown as Record<string, unknown> });
  const gateway = new ActionGateway({ store, policy });
  const agents = new AgentRunCoordinator({ store, gateway });
  const transport = new A2ALoopbackTransport({ store });
  transport.registerIdentity(sender, 'sender-key');
  transport.registerIdentity(recipient, 'recipient-key');
  const artifactStore = new MemoryArtifactStore();
  return { store, gateway, agents, transport, artifactStore, remote: new RemoteAgentCoordinator({ store, gateway, agents, transport, artifactStore }) };
}

test('Remote Agent delegation preserves child correlation, typed result, authorized Artifact, and parent aggregation', async () => {
  const { remote, artifactStore, store } = await fixture();
  const artifact = await artifactStore.put({ runId: rootRun.id, type: 'remote-result', content: 'bounded remote result' });
  const delegated = await remote.delegate({
    parentRunId: rootRun.id, role: recipient.role, principal: recipient.principal, goal: 'Read one bounded fixture', capabilities: ['delegate:read'], scope: { taskId: rootRun.taskId }, allowedCapabilities: ['delegate:read'], allowedScope: { taskId: rootRun.taskId },
    sender, recipient, context: { goalSummary: 'Read the bounded fixture only.', summaries: ['No conversation is forwarded.'] }, artifactRefs: [artifact], idempotencyKey: 'remote-once', deadline: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.equal(delegated.delivery.state, 'queued');
  assert.equal(delegated.envelope.correlationId, delegated.child.agentRunId);
  const duplicate = await remote.delegate({
    parentRunId: rootRun.id, role: recipient.role, principal: recipient.principal, goal: 'Read one bounded fixture', capabilities: ['delegate:read'], scope: { taskId: rootRun.taskId }, allowedCapabilities: ['delegate:read'], allowedScope: { taskId: rootRun.taskId },
    sender, recipient, context: { goalSummary: 'Read the bounded fixture only.', summaries: ['No conversation is forwarded.'] }, artifactRefs: [artifact], idempotencyKey: 'remote-once', deadline: delegated.envelope.deadline,
  });
  assert.equal(duplicate.child.agentRunId, delegated.child.agentRunId);
  const result = await remote.executeWorker(delegated.envelope.messageId, async ({ envelope, child }) => ({
    status: 'success' as const,
    output: { child: child.agentRunId, correlation: envelope.correlationId },
    evidence: [{ type: 'remote.read', summary: 'Remote worker read bounded state.', uri: 'artifact://run-remote-root/evidence', hash: 'b'.repeat(64) }],
    artifacts: [artifact],
    postcondition: artifact,
  }));
  assert.equal(result.delivery.state, 'ack');
  assert.equal(result.result?.status, 'success');
  assert.equal(result.aggregate?.status, 'success');
  assert.equal(result.child.parentRunId, rootRun.id);
  let replayWorkerCalled = false;
  const replay = await remote.executeWorker(delegated.envelope.messageId, async () => {
    replayWorkerCalled = true;
    throw new Error('replay must not execute the worker');
  });
  assert.equal(replayWorkerCalled, false);
  assert.equal(replay.delivery.state, 'ack');
  assert.equal((await store.getRun(rootRun.id))?.verification?.result, 'passed');
});

test('Remote Agent rejects unauthorized context/Artifact without leaving an apparently completed child', async () => {
  const { remote, agents } = await fixture();
  await assert.rejects(() => remote.delegate({
    parentRunId: rootRun.id, role: recipient.role, principal: recipient.principal, goal: 'Read bounded fixture', capabilities: ['delegate:read'], scope: { taskId: rootRun.taskId }, allowedCapabilities: ['delegate:read'], allowedScope: { taskId: rootRun.taskId },
    sender, recipient, context: { goalSummary: 'authorization: leaked-value' }, artifactRefs: [{ uri: 'artifact://other-run/file', type: 'input', hash: 'a'.repeat(64), bytes: 1, sourceRunId: 'other-run' }], idempotencyKey: 'remote-invalid', deadline: new Date(Date.now() + 60_000).toISOString(),
  }), /Artifact/i);
  assert.equal((await agents.list(rootRun.id)).every((child) => child.state === 'failed'), true);
});

test('Remote Agent action proposals re-enter local ActionGateway and cannot self-approve', async () => {
  let executions = 0;
  const { remote } = await fixture(() => ({ decision: 'ask', reason: 'local approval required' }));
  const delegated = await remote.delegate({
    parentRunId: rootRun.id, role: recipient.role, principal: recipient.principal, goal: 'Propose one bounded action', capabilities: ['delegate:read'], scope: { taskId: rootRun.taskId }, allowedCapabilities: ['delegate:read'], allowedScope: { taskId: rootRun.taskId },
    sender, recipient, context: { goalSummary: 'Propose only; local policy decides execution.' }, idempotencyKey: 'remote-proposal', deadline: new Date(Date.now() + 60_000).toISOString(),
  });
  const proposal = await remote.proposeAction({ messageId: delegated.envelope.messageId, actionId: 'remote-action-1', profile: { id: 'remote.fixture', version: 'v1' }, target: 'fixture://record/1', capabilities: ['delegate:read'], scope: { taskId: rootRun.taskId }, argsHash: 'c'.repeat(64), adapter: { id: 'remote-fixture', execute: async () => { executions += 1; return { ok: true, receipt: { sideEffect: 'none' }, evidence: [{ type: 'remote.action', summary: 'executed locally' }] }; } } });
  assert.equal(proposal.status, 'approval_required');
  assert.equal(executions, 0);
});

test('Remote Agent rejects unallowlisted network and local capability requests with audit evidence', async () => {
  const { remote, store } = await fixture(() => ({ decision: 'allow', reason: 'fixture' }));
  const delegated = await remote.delegate({
    parentRunId: rootRun.id, role: recipient.role, principal: recipient.principal, goal: 'Propose a network action', capabilities: ['delegate:read'], scope: { taskId: rootRun.taskId }, allowedCapabilities: ['delegate:read'], allowedScope: { taskId: rootRun.taskId },
    sender, recipient, context: { goalSummary: 'Network access must be explicitly allowlisted.' }, idempotencyKey: 'remote-network-denied', deadline: new Date(Date.now() + 60_000).toISOString(),
  });
  await assert.rejects(() => remote.proposeAction({ messageId: delegated.envelope.messageId, actionId: 'remote-network-1', profile: { id: 'remote.network', version: 'v1' }, target: 'https://untrusted.example.test/resource', capabilities: ['delegate:read'], scope: { taskId: rootRun.taskId }, network: { mode: 'allowlist', hosts: ['untrusted.example.test'] }, argsHash: 'd'.repeat(64), adapter: { id: 'network-fixture', execute: async () => ({ ok: true, receipt: { sideEffect: 'known' } }) } }), /allowlisted/i);
  await assert.rejects(() => remote.proposeAction({ messageId: delegated.envelope.messageId, actionId: 'remote-local-1', profile: { id: 'remote.local', version: 'v1' }, target: 'workspace://README.md', capabilities: ['delegate:read'], scope: { taskId: rootRun.taskId }, argsHash: 'e'.repeat(64), adapter: { id: 'local-fixture', execute: async () => ({ ok: true, receipt: { sideEffect: 'known' } }) } }), /local action boundary/i);
  assert.equal((await store.list(rootRun.id)).filter((event) => event.type === 'a2a.rejected').length, 2);
});

test('Remote Agent receipt alone cannot pass the local evidence and postcondition gate', async () => {
  const { remote } = await fixture();
  const delegated = await remote.delegate({
    parentRunId: rootRun.id, role: recipient.role, principal: recipient.principal, goal: 'Return a receipt without local proof', capabilities: ['delegate:read'], scope: { taskId: rootRun.taskId }, allowedCapabilities: ['delegate:read'], allowedScope: { taskId: rootRun.taskId },
    sender, recipient, context: { goalSummary: 'A remote receipt is not local verification.' }, idempotencyKey: 'remote-unverified', deadline: new Date(Date.now() + 60_000).toISOString(),
  });
  const result = await remote.executeWorker(delegated.envelope.messageId, async () => ({ status: 'success' as const, evidence: [], artifacts: [] }));
  assert.equal(result.result?.status, 'unknown');
  assert.equal(result.delivery.state, 'unknown');
});
