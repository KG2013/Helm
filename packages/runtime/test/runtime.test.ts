import test from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemoryEventStore,
  MockProvider,
  RuntimeFacade,
  RunStateError,
  transitionRunState,
  type ProviderResponse,
} from '../src/index.js';

const allowToolPolicy = {
  decide: () => ({ decision: 'allow' as const, reason: 'test policy' }),
};

test('run state machine accepts the bounded happy path and rejects illegal transitions', () => {
  assert.equal(transitionRunState('ready', 'start'), 'deciding');
  assert.equal(transitionRunState('deciding', 'proposal_valid'), 'validating');
  assert.equal(transitionRunState('validating', 'policy_allow'), 'executing');
  assert.equal(transitionRunState('executing', 'observation'), 'reducing');
  assert.equal(transitionRunState('reducing', 'goal_candidate'), 'verifying');
  assert.equal(transitionRunState('verifying', 'verification_passed'), 'completed');
  assert.throws(
    () => transitionRunState('completed', 'start'),
    (error: unknown) => error instanceof RunStateError,
  );
});

test('event ledger can replay a run projection after pause and resume', async () => {
  const store = new InMemoryEventStore();
  const provider = new MockProvider([
    { kind: 'tool_call', name: 'read_file', arguments: { path: 'README.md' } },
    { kind: 'final', content: 'done' },
  ]);
  const runtime = new RuntimeFacade({ store, provider });
  const task = await runtime.createTask({ goal: 'inspect and report', workspaceId: 'workspace-1' });
  const session = await runtime.createSession({ taskId: task.id });
  const run = await runtime.startRun({ taskId: task.id, sessionId: session.id });

  await runtime.pauseRun(run.id, 'approval required');
  assert.equal((await runtime.getRun(run.id))?.state, 'paused');
  await runtime.resumeRun(run.id);
  assert.equal((await runtime.getRun(run.id))?.state, 'deciding');

  const events = await store.list(run.id);
  assert.ok(events.some((event) => event.type === 'run.paused'));
  assert.ok(events.some((event) => event.type === 'run.resumed'));
  const replayed = store.replayRun(run.id);
  assert.equal(replayed.state, 'deciding');
});

test('mock provider and facade complete a final response with evidence', async () => {
  const finalResponse: ProviderResponse = { kind: 'final', content: 'verified output' };
  const runtime = new RuntimeFacade({
    store: new InMemoryEventStore(),
    provider: new MockProvider([finalResponse]),
  });
  const task = await runtime.createTask({ goal: 'produce output', workspaceId: 'workspace-1' });
  const session = await runtime.createSession({ taskId: task.id });
  const run = await runtime.startRun({ taskId: task.id, sessionId: session.id });
  const result = await runtime.run(run.id);

  assert.equal(result.state, 'completed');
  assert.equal(result.steps, 1);
  assert.equal(result.verification?.result, 'passed');
  assert.equal((await runtime.getEvents(run.id)).filter((event) => event.type === 'step.completed').length, 1);
});

test('tool calls are executed through the injected executor and remain auditable', async () => {
  const store = new InMemoryEventStore();
  const provider = new MockProvider([
    { kind: 'tool_call', name: 'read_file', arguments: { path: 'README.md' } },
    { kind: 'final', content: 'tool result incorporated' },
  ]);
  const calls: string[] = [];
  const runtime = new RuntimeFacade({
    store,
    provider,
    policy: allowToolPolicy,
    executor: async (call) => {
      calls.push(call.name);
      return { ok: true, output: 'hello', receipt: { exitCode: 0 } };
    },
  });
  const task = await runtime.createTask({ goal: 'use a tool', workspaceId: 'workspace-1' });
  const session = await runtime.createSession({ taskId: task.id });
  const run = await runtime.startRun({ taskId: task.id, sessionId: session.id });
  const result = await runtime.run(run.id);

  assert.deepEqual(calls, ['read_file']);
  assert.equal(result.state, 'completed');
  const events = await store.list(run.id);
  assert.ok(events.some((event) => event.type === 'tool.receipt'));
});

test('an approval resumes the same proposal without asking the provider again', async () => {
  const store = new InMemoryEventStore();
  const provider = new MockProvider([
    { kind: 'tool_call', name: 'write_file', arguments: { path: 'report.md', content: 'hello' } },
    { kind: 'final', content: 'approved and complete' },
  ]);
  const calls: string[] = [];
  const runtime = new RuntimeFacade({
    store,
    provider,
    policy: { decide: () => ({ decision: 'ask' as const, reason: 'writing requires approval' }) },
    executor: async (call) => { calls.push(call.id); return { ok: true, output: 'written', receipt: { sideEffect: 'known' } }; },
  });
  const task = await runtime.createTask({ goal: 'write a report', workspaceId: 'workspace-1' });
  const session = await runtime.createSession({ taskId: task.id });
  const run = await runtime.startRun({ taskId: task.id, sessionId: session.id });
  const paused = await runtime.run(run.id);
  assert.equal(paused.state, 'paused');
  const requested = (await runtime.getEvents(run.id)).find((event) => event.type === 'approval.requested');
  assert.ok(requested);
  const approvalId = requested.payload.approvalId as string;

  const result = await runtime.resolveApproval(run.id, approvalId, 'approve');
  assert.equal(result.state, 'completed');
  assert.equal(provider.requests.length, 2);
  assert.deepEqual(calls, [approvalId]);
  const events = await runtime.getEvents(run.id);
  assert.equal(events.filter((event) => event.type === 'approval.requested').length, 1);
  assert.equal(events.filter((event) => event.type === 'approval.decided').length, 1);
  assert.equal(events.filter((event) => event.type === 'tool.call').length, 1);
  assert.equal((await runtime.resolveApproval(run.id, approvalId, 'approve')).state, 'completed');
});

test('denying an approval is auditable and never reaches the executor', async () => {
  const store = new InMemoryEventStore();
  let executorCalls = 0;
  const runtime = new RuntimeFacade({
    store,
    provider: new MockProvider([{ kind: 'tool_call', name: 'shell', arguments: { command: 'unsafe' } }]),
    policy: { decide: () => ({ decision: 'ask' as const, reason: 'shell requires approval' }) },
    executor: async () => { executorCalls += 1; return { ok: true }; },
  });
  const task = await runtime.createTask({ goal: 'run shell', workspaceId: 'workspace-1' });
  const session = await runtime.createSession({ taskId: task.id });
  const run = await runtime.startRun({ taskId: task.id, sessionId: session.id });
  await runtime.run(run.id);
  const requested = (await runtime.getEvents(run.id)).find((event) => event.type === 'approval.requested');
  assert.ok(requested);
  const result = await runtime.resolveApproval(run.id, requested.payload.approvalId as string, 'deny');
  assert.equal(result.state, 'failed');
  assert.equal(executorCalls, 0);
  assert.equal((await runtime.getEvents(run.id)).filter((event) => event.type === 'tool.call').length, 0);
});

test('a new facade can hydrate task and session metadata from the event ledger', async () => {
  const store = new InMemoryEventStore();
  const first = new RuntimeFacade({ store, provider: new MockProvider() });
  const task = await first.createTask({ goal: 'resume after restart', workspaceId: 'workspace-1' });
  const session = await first.createSession({ taskId: task.id });
  const run = await first.startRun({ taskId: task.id, sessionId: session.id });
  await first.pauseRun(run.id, 'waiting for user');

  const second = new RuntimeFacade({ store, provider: new MockProvider([{ kind: 'final', content: 'resumed' }]) });
  await second.resumeRun(run.id);
  const result = await second.run(run.id);
  assert.equal(result.state, 'completed');
  assert.equal(second.getTask(task.id)?.goal, task.goal);
  assert.equal(second.getSession(session.id)?.taskId, task.id);
});

test('the default tool executor fails closed when no execution boundary is configured', async () => {
  const store = new InMemoryEventStore();
  const runtime = new RuntimeFacade({
    store,
    provider: new MockProvider([{ kind: 'tool_call', name: 'shell', arguments: { command: 'echo unsafe' } }]),
    policy: allowToolPolicy,
  });
  const task = await runtime.createTask({ goal: 'run a command', workspaceId: 'workspace-1' });
  const session = await runtime.createSession({ taskId: task.id });
  const run = await runtime.startRun({ taskId: task.id, sessionId: session.id });
  const result = await runtime.run(run.id);

  assert.equal(result.state, 'failed');
  assert.match(result.lastError ?? '', /fail-closed/);
  assert.ok((await store.list(run.id)).some((event) => event.type === 'tool.receipt'));
});


test('tool proposals are denied when no policy is configured', async () => {
  const runtime = new RuntimeFacade({
    store: new InMemoryEventStore(),
    provider: new MockProvider([{ kind: 'tool_call', name: 'shell', arguments: { command: 'echo blocked' } }]),
    executor: async () => { throw new Error('executor must not run'); },
  });
  const task = await runtime.createTask({ goal: 'run a command', workspaceId: 'workspace-1' });
  const session = await runtime.createSession({ taskId: task.id });
  const run = await runtime.startRun({ taskId: task.id, sessionId: session.id });
  const result = await runtime.run(run.id);

  assert.equal(result.state, 'failed');
  assert.match(result.lastError ?? '', /No ToolPolicy/);
  assert.equal((await runtime.getEvents(run.id)).filter((event) => event.type === 'tool.call').length, 0);
});

test('unknown tool side effects require reconciliation instead of a normal failure', async () => {
  const runtime = new RuntimeFacade({
    store: new InMemoryEventStore(),
    provider: new MockProvider([{ kind: 'tool_call', name: 'write_file', arguments: { path: 'report.md' } }]),
    policy: allowToolPolicy,
    executor: async () => ({ ok: false, error: 'process disconnected', receipt: { sideEffect: 'unknown' } }),
  });
  const task = await runtime.createTask({ goal: 'write a report', workspaceId: 'workspace-1' });
  const session = await runtime.createSession({ taskId: task.id });
  const run = await runtime.startRun({ taskId: task.id, sessionId: session.id });
  const result = await runtime.run(run.id);

  assert.equal(result.state, 'needs_reconciliation');
  assert.ok((await runtime.getEvents(run.id)).some((event) => event.type === 'run.needs_reconciliation'));
});

test('cancelling while the provider is in flight prevents a late proposal or tool action', async () => {
  let release!: (response: ProviderResponse) => void;
  const provider = {
    id: 'deferred',
    model: 'deferred-model',
    capabilities: new MockProvider().capabilities,
    complete: async () => new Promise<ProviderResponse>((resolve) => { release = resolve; }),
  };
  const store = new InMemoryEventStore();
  const runtime = new RuntimeFacade({ store, provider });
  const task = await runtime.createTask({ goal: 'cancel in flight', workspaceId: 'workspace-1' });
  const session = await runtime.createSession({ taskId: task.id });
  const run = await runtime.startRun({ taskId: task.id, sessionId: session.id });
  const running = runtime.run(run.id);

  await new Promise<void>((resolve) => {
    const poll = () => provider.complete && release ? resolve() : setTimeout(poll, 1);
    poll();
  });
  await runtime.cancelRun(run.id);
  release({ kind: 'tool_call', name: 'write_file', arguments: { path: 'late.md' } });
  const result = await running;

  assert.equal(result.state, 'cancelled');
  const events = await store.list(run.id);
  assert.equal(events.filter((event) => event.type === 'tool.call').length, 0);
  assert.equal(events.filter((event) => event.type === 'step.proposal').length, 0);
});
