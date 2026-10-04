import test from 'node:test';
import assert from 'node:assert/strict';
import { A2ALoopbackTransport, InMemoryEventStore } from '../src/index.js';
import type { A2AEnvelopeInput, A2AIdentity, ArtifactReference } from '../src/types.js';

const sender: A2AIdentity = { id: 'agent-sender', principal: 'principal-sender', role: 'planner', capabilities: ['delegate:read'], scope: { taskId: 'task-a2a', workspaceId: 'workspace-a2a' } };
const recipient: A2AIdentity = { id: 'agent-recipient', principal: 'principal-recipient', role: 'worker', capabilities: ['delegate:read'], scope: { taskId: 'task-a2a', workspaceId: 'workspace-a2a' } };

function unsigned(overrides: Partial<Omit<A2AEnvelopeInput, 'signature'>> = {}): Omit<A2AEnvelopeInput, 'signature'> {
  return {
    sender,
    recipient,
    capabilityGrant: { capabilities: ['delegate:read'], scope: { taskId: 'task-a2a' } },
    taskId: 'task-a2a',
    runId: 'run-a2a',
    correlationId: 'corr-a2a',
    idempotencyKey: 'a2a-once',
    deadline: new Date(Date.now() + 60_000).toISOString(),
    scope: { taskId: 'task-a2a' },
    context: { goalSummary: 'Read the bounded fixture state.', summaries: ['Only the task summary is shared.'] },
    ...overrides,
  };
}

function artifact(): ArtifactReference {
  return { uri: 'artifact://run-a2a/input', type: 'input', hash: 'a'.repeat(64), bytes: 12, sourceRunId: 'run-a2a' };
}

test('A2A loopback authenticates a bounded envelope and replays durable delivery state', async () => {
  const store = new InMemoryEventStore();
  const transport = new A2ALoopbackTransport({ store });
  transport.registerIdentity(sender, 'sender-fixture-key');
  transport.registerIdentity(recipient, 'recipient-fixture-key');
  const base = unsigned({ artifactRefs: [artifact()] });
  const sent = await transport.send({ ...base, signature: transport.sign(base) });
  assert.equal(sent.state, 'queued');
  const dispatched = await transport.dispatch(sent.messageId);
  assert.equal(dispatched.state, 'sent');
  assert.equal(dispatched.attempt, 1);
  const acknowledged = await transport.ack(sent.messageId, 'b'.repeat(64));
  assert.equal(acknowledged.state, 'ack');
  assert.ok(acknowledged.receiptHash);
  const events = await store.list('run-a2a');
  assert.ok(events.some((event) => event.type === 'a2a.envelope'));
  assert.ok(events.some((event) => event.type === 'a2a.delivery' && event.payload.state === 'queued'));
  assert.ok(events.some((event) => event.type === 'a2a.delivery' && event.payload.state === 'ack'));
  assert.equal(JSON.stringify(events).includes('sender-fixture-key'), false);
  const restarted = new A2ALoopbackTransport({ store });
  assert.deepEqual(await restarted.replay(), [acknowledged]);
});

test('A2A loopback rejects identity, capability, deadline, scope, artifact, signature, and duplicate violations with audit events', async () => {
  const store = new InMemoryEventStore();
  const transport = new A2ALoopbackTransport({ store });
  transport.registerIdentity(sender, 'sender-fixture-key');
  transport.registerIdentity(recipient, 'recipient-fixture-key');
  const send = async (input: Omit<A2AEnvelopeInput, 'signature'>) => transport.send({ ...input, signature: transport.sign(input) });

  await assert.rejects(() => send(unsigned({ capabilityGrant: { capabilities: ['delegate:write'], scope: { taskId: 'task-a2a' } } })), /capability/i);
  await assert.rejects(() => send(unsigned({ scope: { taskId: 'other-task' } })), /scope/i);
  await assert.rejects(() => send(unsigned({ deadline: new Date(Date.now() - 1_000).toISOString() })), /deadline/i);
  await assert.rejects(() => send(unsigned({ artifactRefs: [{ ...artifact(), sourceRunId: 'other-run' }] })), /Artifact/i);
  await assert.rejects(() => transport.send({ ...unsigned(), signature: 'b'.repeat(64) }), /signature/i);
  const accepted = await send(unsigned({ idempotencyKey: 'duplicate-key' }));
  assert.equal(accepted.state, 'queued');
  await assert.rejects(() => send(unsigned({ idempotencyKey: 'duplicate-key' })), /idempotency/i);
  const rejected = (await store.listAll()).filter((event) => event.type === 'a2a.rejected');
  assert.ok(rejected.length >= 6);
});

test('A2A loopback keeps context bounded and rejects credential-like content', async () => {
  const store = new InMemoryEventStore();
  const transport = new A2ALoopbackTransport({ store });
  transport.registerIdentity(sender, 'sender-fixture-key');
  transport.registerIdentity(recipient, 'recipient-fixture-key');
  const input = unsigned({ context: { goalSummary: 'authorization: leaked-value' } });
  await assert.rejects(() => transport.send({ ...input, signature: transport.sign(input) }), /context/i);
});

test('A2A loopback keeps late ACKs UNKNOWN, retries the same message, and reconciles with evidence', async () => {
  const store = new InMemoryEventStore();
  const transport = new A2ALoopbackTransport({ store });
  transport.registerIdentity(sender, 'sender-fixture-key');
  transport.registerIdentity(recipient, 'recipient-fixture-key');
  const input = unsigned({ idempotencyKey: 'retry-once' });
  const sent = await transport.send({ ...input, signature: transport.sign(input) });
  await transport.dispatch(sent.messageId);
  const unknown = await transport.markUnknown(sent.messageId, 'remote disconnected after dispatch');
  assert.equal(unknown.state, 'unknown');
  const late = await transport.ack(sent.messageId, 'c'.repeat(64));
  assert.equal(late.state, 'unknown');
  assert.equal(late.receiptHash, 'c'.repeat(64));
  const retried = await transport.retry(sent.messageId);
  assert.equal(retried.state, 'sent');
  assert.equal(retried.attempt, 2);
  const acknowledged = await transport.ack(sent.messageId, 'd'.repeat(64));
  assert.equal(acknowledged.state, 'ack');

  const second = await transport.send({ ...input, idempotencyKey: 'reconcile-once', signature: transport.sign({ ...input, idempotencyKey: 'reconcile-once' }) });
  await transport.dispatch(second.messageId);
  await transport.markUnknown(second.messageId, 'remote restarted');
  await assert.rejects(() => transport.reconcile(second.messageId, 'known'), /evidence/i);
  const reconciled = await transport.reconcile(second.messageId, 'known', [{ type: 'local.postcondition', summary: 'Local read-after-write evidence.' }]);
  assert.equal(reconciled.state, 'ack');
  assert.ok(reconciled.reconciliationId);
  const restarted = new A2ALoopbackTransport({ store });
  assert.equal((await restarted.replay())[1]?.state, 'ack');
  assert.ok((await store.listAll()).some((event) => event.type === 'a2a.reconciliation'));
});
