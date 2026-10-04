import test from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemoryEventStore,
  MockProvider,
  RuntimeFacade,
  RunStateError,
  transitionRunState,
  buildEpisode,
  evaluateReleaseGate,
  runFixedEvaluationMatrix,
  canPromoteExperienceCandidate,
  createExperienceCandidate,
  reviewExperienceCandidate,
  MemoryArtifactStore,
  type ProviderResponse,
  type ToolRegistry,
} from '../src/index.js';

const allowToolPolicy = {
  decide: () => ({ decision: 'allow' as const, reason: 'test policy' }),
};

const registeredTestTools: ToolRegistry = {
  get: (id) => ({ id, version: 'test-v1', readOnly: false, scope: 'workspace', network: 'none', maxOutputBytes: 32_000 }),
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
  const replayed = await store.replayRun(run.id);
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

test('usage ledger deduplicates request ids and release gate accepts a passed Episode', async () => {
  const store = new InMemoryEventStore();
  const runtime = new RuntimeFacade({
    store,
    provider: new MockProvider([{ kind: 'final', content: 'verified', usage: { requestId: 'request-1', totalTokens: 2, costUsd: 0.01 } }]),
  });
  const task = await runtime.createTask({ goal: 'trace a run', workspaceId: 'workspace-1' });
  const session = await runtime.createSession({ taskId: task.id });
  const run = await runtime.startRun({ taskId: task.id, sessionId: session.id });
  await runtime.run(run.id);
  const episode = await buildEpisode(store, run.id);
  assert.equal(episode.usage.length, 1);
  assert.equal(evaluateReleaseGate([episode]).result, 'passed');
  assert.equal((await store.list(run.id)).filter((event) => event.type === 'usage.recorded').length, 1);
});

test('provider failures are recorded in the UsageLedger with a normalized failure class', async () => {
  const store = new InMemoryEventStore();
  const runtime = new RuntimeFacade({
    store,
    provider: {
      id: 'failing-provider',
      model: 'model',
      capabilities: new MockProvider().capabilities,
      complete: async () => {
        const error = new Error('Provider unavailable');
        Object.assign(error, { failure: { code: 'rate_limit', requestId: 'provider-request-1', retryable: true } });
        throw error;
      },
    },
  });
  const task = await runtime.createTask({ goal: 'record failure', workspaceId: 'workspace-1' });
  const session = await runtime.createSession({ taskId: task.id });
  const run = await runtime.startRun({ taskId: task.id, sessionId: session.id });
  const result = await runtime.run(run.id);
  assert.equal(result.state, 'failed');
  const usage = (await store.list(run.id)).find((event) => event.type === 'usage.recorded');
  assert.equal(usage?.payload.kind, 'provider');
  assert.equal(usage?.payload.failureCode, 'rate_limit');
  assert.equal(usage?.payload.requestId, 'provider-request-1');
  assert.equal(usage?.payload.cacheHit, false);
});

test('Episodes retain redacted trace links and release gates require dev and holdout repeats', async () => {
  const store = new InMemoryEventStore();
  const runtime = new RuntimeFacade({
    store,
    provider: new MockProvider([{ kind: 'final', content: 'trace output' }]),
  });
  const task = await runtime.createTask({ goal: 'trace release case', workspaceId: 'workspace-1' });
  const session = await runtime.createSession({ taskId: task.id });
  const run = await runtime.startRun({ taskId: task.id, sessionId: session.id });
  await runtime.run(run.id);
  const episode = await buildEpisode(store, run.id);
  assert.deepEqual(episode.trace.providerIds, ['mock', 'mock-model']);
  assert.ok(episode.trace.verifierIds.includes('text-output-v1'));
  assert.ok(episode.trace.stepIds.length >= 1);
  assert.doesNotMatch(episode.redactedJsonl, /api[-_ ]?key|authorization/i);

  const incomplete = { ...episode, evaluationCase: 'coding-basic', evaluationSplit: 'dev' as const, evaluationAttempt: 1 };
  assert.equal(evaluateReleaseGate([incomplete]).result, 'blocked');
  assert.equal(evaluateReleaseGate([{ ...episode, redactedJsonl: '{"authorization":"still-secret"}' }]).result, 'blocked');
  const repeated = (split: 'dev' | 'holdout') => [1, 2, 3].map((attempt) => ({
    ...episode,
    runId: `${split}-${attempt}`,
    evaluationCase: 'coding-basic',
    evaluationSplit: split,
    evaluationAttempt: attempt,
  }));
  assert.equal(evaluateReleaseGate([...repeated('dev'), ...repeated('holdout')]).result, 'passed');
});

test('fixed coding and office dev/holdout cases run three times before release', async () => {
  const base = {
    runId: 'fixed-run',
    taskId: 'fixed-task',
    sessionId: 'fixed-session',
    events: [
      { type: 'run.completed', payload: { verification: { result: 'passed' } } },
      { type: 'verification.result', payload: { verification: { result: 'passed' } } },
    ],
    usage: [],
    redactedJsonl: '{"result":"passed"}',
    trace: { providerIds: [], toolProfiles: [], toolProfileVersions: [], policyVersions: [], stepIds: [], approvalIds: [], artifactUris: [], verifierIds: [], requestIds: [], traceIds: [] },
  } as const;
  const matrix = await runFixedEvaluationMatrix([
    ...(['coding', 'office'] as const).flatMap((id) => (['dev', 'holdout'] as const).map((split) => ({
      id,
      split,
      run: async (attempt: number) => ({ ...base, runId: `${id}-${split}-${attempt}`, evaluationCase: id, evaluationSplit: split, evaluationAttempt: attempt }),
    }))),
  ]);
  assert.equal(matrix.episodes.length, 12);
  assert.equal(matrix.gate.result, 'passed');
  await assert.rejects(() => runFixedEvaluationMatrix([{ id: 'coding', split: 'dev', run: async (attempt: number) => ({ ...base, evaluationCase: 'wrong', evaluationSplit: 'dev' as const, evaluationAttempt: attempt }) }]));
});

test('token budget hard-stops a response before delivery', async () => {
  const runtime = new RuntimeFacade({
    store: new InMemoryEventStore(),
    provider: new MockProvider([{ kind: 'final', content: 'too expensive', usage: { totalTokens: 3 } }]),
  });
  const task = await runtime.createTask({ goal: 'bounded run', workspaceId: 'workspace-1', budget: { maxTokens: 2 } });
  const session = await runtime.createSession({ taskId: task.id });
  const run = await runtime.startRun({ taskId: task.id, sessionId: session.id });
  const result = await runtime.run(run.id);
  assert.equal(result.state, 'paused');
  assert.match(result.pauseReason ?? '', /budget/i);
  assert.equal(result.finalOutput, undefined);
});

test('latency, retry, and cache budgets hard-stop UsageLedger overspend', async () => {
  const runtime = new RuntimeFacade({
    store: new InMemoryEventStore(),
    provider: new MockProvider([{ kind: 'final', content: 'slow', usage: { latencyMs: 11, retries: 1, cacheHit: false } }]),
  });
  const task = await runtime.createTask({ goal: 'bounded usage', workspaceId: 'workspace-1', budget: { maxLatencyMs: 10, maxRetries: 0, maxCacheMisses: 0 } });
  const session = await runtime.createSession({ taskId: task.id });
  const run = await runtime.startRun({ taskId: task.id, sessionId: session.id });
  const result = await runtime.run(run.id);
  assert.equal(result.state, 'paused');
  assert.match(result.pauseReason ?? '', /budget/i);
});

test('Runtime ownership blocks stale controls and releases safely on shutdown', async () => {
  const store = new InMemoryEventStore();
  const first = new RuntimeFacade({ store, ownerId: 'desktop-owner', provider: new MockProvider([{ kind: 'final', content: 'done' }]) });
  const task = await first.createTask({ goal: 'owned run', workspaceId: 'workspace-1' });
  const session = await first.createSession({ taskId: task.id });
  const run = await first.startRun({ taskId: task.id, sessionId: session.id });
  const second = new RuntimeFacade({ store, ownerId: 'cli-owner', provider: new MockProvider([{ kind: 'final', content: 'stale' }]) });
  await assert.rejects(() => second.cancelRun(run.id), /owned by another active Runtime/);
  await first.shutdown();
  const resumed = await second.resumeRun(run.id);
  assert.equal(resumed.state, 'deciding');
});

test('Experience Candidate remains pending until explicit validation and approval', () => {
  const candidate = createExperienceCandidate({ id: 'candidate-1', sourceEpisodeId: 'episode-1', summary: 'avoid repeated patch mismatch', applicability: ['coding'], costChecks: { tokenBudgetOk: true, costBudgetOk: true }, validationEvidence: ['trace://episode-1/step-1'], createdAt: 'now' });
  assert.equal(canPromoteExperienceCandidate(candidate), false);
  const reviewed = reviewExperienceCandidate(candidate, { validation: 'validated', approval: 'approved', action: 'approve' });
  assert.equal(canPromoteExperienceCandidate(reviewed), true);
  assert.equal(candidate.approvalState, 'pending');
});

test('Experience Candidates persist for review and obey the reviewer round budget', async () => {
  const runtime = new RuntimeFacade({ store: new InMemoryEventStore(), provider: new MockProvider(), defaultBudget: { maxReviewerRounds: 1 } });
  const candidate = await runtime.createExperienceCandidate({
    id: 'candidate-persisted',
    sourceEpisodeId: 'episode-1',
    sourceTraceId: 'trace-1',
    summary: 'retain a validated failure pattern',
    applicability: ['coding'],
    costChecks: { tokenBudgetOk: true, costBudgetOk: true },
    validationEvidence: ['trace://trace-1/step-1'],
    createdAt: 'now',
  });
  assert.deepEqual((await runtime.listExperienceCandidates()).map((item) => item.id), [candidate.id]);
  const reviewed = await runtime.reviewExperienceCandidateById(candidate.id, { validation: 'validated', approval: 'approved', action: 'approve', reviewerId: 'reviewer-1' });
  assert.equal(reviewed.approvalState, 'approved');
  assert.equal((await runtime.listExperienceCandidates())[0]?.validationState, 'validated');
  await assert.rejects(() => runtime.reviewExperienceCandidateById(candidate.id, { validation: 'validated', approval: 'approved' }), /reviewer round budget/i);
})

test('Experience Candidate approval fails closed without evidence and revalidate appends a new version', async () => {
  const runtime = new RuntimeFacade({ store: new InMemoryEventStore(), provider: new MockProvider(), defaultBudget: { maxReviewerRounds: 3 } });
  const candidate = await runtime.createExperienceCandidate({
    id: 'candidate-gated', sourceEpisodeId: 'episode-gated', sourceTraceId: 'trace-gated', summary: 'gated candidate', applicability: ['coding'], costChecks: { tokenBudgetOk: true, costBudgetOk: true }, createdAt: 'now',
  });
  await assert.rejects(() => runtime.reviewExperienceCandidateById(candidate.id, { action: 'approve', validation: 'validated', approval: 'approved' }), /requires a source Episode\/trace and validation evidence/i);
  const revalidated = await runtime.reviewExperienceCandidateById(candidate.id, { action: 'revalidate', validation: 'unvalidated', approval: 'pending', validationEvidence: ['trace://episode-gated/recheck'], reviewerId: 'reviewer-2' });
  assert.equal(revalidated.validationState, 'unvalidated');
  assert.equal(revalidated.approvalState, 'pending');
  assert.deepEqual(revalidated.validationEvidence, ['trace://episode-gated/recheck']);
  assert.equal(revalidated.reviewVersion, 1);
  assert.equal((await runtime.listExperienceCandidates())[0]?.reviewVersion, 1);
});

test('Experience Candidate evidence rejects bare paths and sensitive values', () => {
  assert.throws(() => createExperienceCandidate({
    id: 'candidate-invalid-evidence', sourceEpisodeId: 'episode-invalid', sourceTraceId: 'trace-invalid', summary: 'bounded candidate', applicability: ['coding'], costChecks: { tokenBudgetOk: true, costBudgetOk: true }, validationEvidence: ['foo'], createdAt: 'now',
  }), /validation evidence/i);
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
    toolRegistry: registeredTestTools,
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
    toolRegistry: registeredTestTools,
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

test('a pending approval cannot be resumed or changed after its binding expires', async () => {
  const store = new InMemoryEventStore();
  let now = 0;
  const runtime = new RuntimeFacade({
    store,
    clock: { now: () => new Date(now) },
    approvalTtlMs: 100,
    provider: new MockProvider([{ kind: 'tool_call', name: 'write_file', arguments: { path: 'report.md', content: 'bound' } }]),
    toolRegistry: registeredTestTools,
    policy: { id: 'approval-policy', version: 'v1', decide: () => ({ decision: 'ask' as const, reason: 'write requires approval' }) },
    executor: async () => ({ ok: true, output: 'saved', receipt: { sideEffect: 'known' } }),
  });
  const task = await runtime.createTask({ goal: 'expire approval', workspaceId: 'workspace-1' });
  const session = await runtime.createSession({ taskId: task.id });
  const run = await runtime.startRun({ taskId: task.id, sessionId: session.id });
  const paused = await runtime.run(run.id);
  assert.equal(paused.state, 'paused');
  await assert.rejects(() => runtime.resumeRun(run.id), /pending approval/);
  const approval = (await store.list(run.id)).find((event) => event.type === 'approval.requested');
  assert.ok(approval);
  now = 101;
  await assert.rejects(() => runtime.resolveApproval(run.id, String(approval.payload.approvalId), 'approve'), /expired/);
  assert.equal((await runtime.getRun(run.id))?.state, 'paused');
});

test('large tool outputs are offloaded to an ArtifactStore and only a bounded preview enters the ledger', async () => {
  const artifactStore = new MemoryArtifactStore();
  const store = new InMemoryEventStore();
  const runtime = new RuntimeFacade({
    store,
    artifactStore,
    provider: new MockProvider([{ kind: 'tool_call', name: 'read_file', arguments: { path: 'README.md' } }, { kind: 'final', content: 'done' }]),
    toolRegistry: registeredTestTools,
    policy: allowToolPolicy,
    executor: async () => ({ ok: true, output: 'x'.repeat(9_000), receipt: { sideEffect: 'none' } }),
  });
  const task = await runtime.createTask({ goal: 'offload output', workspaceId: 'workspace-1' });
  const session = await runtime.createSession({ taskId: task.id });
  const run = await runtime.startRun({ taskId: task.id, sessionId: session.id });
  await runtime.run(run.id);
  const receipt = (await store.list(run.id)).find((event) => event.type === 'tool.receipt');
  const output = String(receipt?.payload.output ?? '');
  const artifact = (receipt?.payload.receipt as { artifact?: { uri?: string } } | undefined)?.artifact;
  assert.ok(artifact?.uri?.startsWith('artifact://'));
  assert.ok(output.length < 3_000);
  assert.equal((await artifactStore.read(String(artifact?.uri))).byteLength, 9_000);
});

test('denying an approval is auditable and never reaches the executor', async () => {
  const store = new InMemoryEventStore();
  let executorCalls = 0;
  const runtime = new RuntimeFacade({
    store,
    provider: new MockProvider([{ kind: 'tool_call', name: 'shell', arguments: { command: 'unsafe' } }]),
    toolRegistry: registeredTestTools,
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
    toolRegistry: registeredTestTools,
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
    toolRegistry: registeredTestTools,
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
    toolRegistry: registeredTestTools,
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

test('successful tool results with unknown side effects still require reconciliation', async () => {
  const runtime = new RuntimeFacade({
    store: new InMemoryEventStore(),
    provider: new MockProvider([{ kind: 'tool_call', name: 'write_file', arguments: { path: 'report.md' } }]),
    toolRegistry: registeredTestTools,
    policy: allowToolPolicy,
    executor: async () => ({ ok: true, output: 'reported success', receipt: { sideEffect: 'unknown' } }),
  });
  const task = await runtime.createTask({ goal: 'write a report', workspaceId: 'workspace-1' });
  const session = await runtime.createSession({ taskId: task.id });
  const run = await runtime.startRun({ taskId: task.id, sessionId: session.id });
  const result = await runtime.run(run.id);

  assert.equal(result.state, 'needs_reconciliation');
  assert.equal(result.verification, undefined);
});

test('cancelling while the provider is in flight prevents a late proposal or tool action', async () => {
  let release!: (response: ProviderResponse) => void;
  let providerSignal: AbortSignal | undefined;
  const provider = {
    id: 'deferred',
    model: 'deferred-model',
    capabilities: new MockProvider().capabilities,
    complete: async (request: import('../src/types.js').ProviderRequest) => new Promise<ProviderResponse>((resolve) => { providerSignal = request.signal; release = resolve; }),
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
  assert.equal(providerSignal?.aborted, true);
  release({ kind: 'tool_call', name: 'write_file', arguments: { path: 'late.md' } });
  const result = await running;

  assert.equal(result.state, 'cancelled');
  const events = await store.list(run.id);
  assert.equal(events.filter((event) => event.type === 'tool.call').length, 0);
  assert.equal(events.filter((event) => event.type === 'step.proposal').length, 0);
});
