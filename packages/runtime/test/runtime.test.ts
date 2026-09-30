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
