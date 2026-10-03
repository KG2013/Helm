import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MockProvider,
  RuntimeFacade,
  type ProviderResponse,
  type ToolRegistry,
} from '../src/index.js';
import { openSqliteEventStore } from '../src/sqlite-node.js';

const registry: ToolRegistry = {
  get: (id) => ({ id, version: 'test-v1', readOnly: false, scope: 'workspace', network: 'none', maxOutputBytes: 32_000 }),
};
const allow = { decide: () => ({ decision: 'allow' as const, reason: 'test allow' }) };

async function withDatabase<T>(callback: (filename: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join('/tmp', 'helm-runtime-'));
  const filename = join(directory, 'state.sqlite');
  try {
    return await callback(filename);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function runReopenProcess(filename: string, runId: string): Promise<{ state?: string; checkpointRunId?: string; eventCount: number; jsonlLines: number }> {
  const require = createRequire(import.meta.url);
  const loader = require.resolve('tsx/esm');
  const fixture = fileURLToPath(new URL('./fixtures/reopen-run.ts', import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', loader, fixture, filename, runId], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0) return reject(new Error(`reopen process exited with ${code}: ${stderr}`));
      try { resolve(JSON.parse(stdout) as { state?: string; checkpointRunId?: string; eventCount: number; jsonlLines: number }); }
      catch (error) { reject(new Error(`invalid reopen output: ${stdout}; ${String(error)}`)); }
    });
  });
}

test('native SQLite migrates, serializes concurrent appends, projects facts, and exports redacted JSONL', async () => {
  await withDatabase(async (filename) => {
    const first = openSqliteEventStore(filename);
    const events = await Promise.all([
      first.store.append({ type: 'task.created', taskId: 'task-1', payload: { id: 'task-1', goal: 'inspect', workspaceId: 'workspace-1', apiKey: 'sk-secret' } }),
      first.store.append({ type: 'session.created', taskId: 'task-1', sessionId: 'session-1', payload: { id: 'session-1', taskId: 'task-1' } }),
    ]);
    assert.deepEqual(events.map((event) => event.sequence).sort((a, b) => a - b), [1, 2]);
    await first.store.appendMany([
      { type: 'run.created', taskId: 'task-1', sessionId: 'session-1', runId: 'run-1', payload: { id: 'run-1', taskId: 'task-1', sessionId: 'session-1', state: 'ready', createdAt: 'now', updatedAt: 'now', steps: 0, reviewerRounds: 0, budget: { maxSteps: 2, maxDurationMs: 1000, maxReviewerRounds: 0 } } },
      { type: 'run.checkpoint', taskId: 'task-1', sessionId: 'session-1', runId: 'run-1', payload: { stepId: 'step-1', state: 'ready', output: 'private text' } },
      { type: 'tool.receipt', taskId: 'task-1', sessionId: 'session-1', runId: 'run-1', payload: { stepId: 'step-1', toolCallId: 'tool-1', ok: true, output: 'private text', error: 'Authorization: Bearer secret-value', receipt: { sideEffect: 'none' } } },
      { type: 'verification.result', taskId: 'task-1', sessionId: 'session-1', runId: 'run-1', payload: { stepId: 'step-1', verification: { result: 'passed', verifier: 'test', evidence: [] } } },
    ]);
    const jsonl = await first.store.exportJsonl();
    assert.equal(jsonl.split('\n').length, 6);
    assert.equal(jsonl.includes('sk-secret'), false);
    assert.equal(jsonl.includes('secret-value'), false);
    assert.equal(jsonl.includes('private text'), false);
    assert.equal(first.store.replayRun ? (await first.store.replayRun('run-1')).id : '', 'run-1');
    const projection = first.database.all<{ count: number }>('SELECT COUNT(*) AS count FROM helm_checkpoints');
    assert.equal(Number(projection[0]?.count), 1);
    await first.store.close();
  });
});

test('two SQLite store instances allocate a unique append-only sequence', async () => {
  await withDatabase(async (filename) => {
    const first = openSqliteEventStore(filename)
    const second = openSqliteEventStore(filename)
    const [left, right] = await Promise.all([
      first.store.append({ type: 'task.created', taskId: 'task-left', payload: { id: 'task-left' } }),
      second.store.append({ type: 'task.created', taskId: 'task-right', payload: { id: 'task-right' } }),
    ])
    assert.notEqual(left.sequence, right.sequence)
    const all = await first.store.listAll()
    assert.deepEqual(all.map((event) => event.sequence), [1, 2])
    await first.store.close()
    await second.store.close()
  })
})

test('SQLite lease acquisition is an atomic owner decision across Runtime instances', async () => {
  await withDatabase(async (filename) => {
    const first = openSqliteEventStore(filename)
    const second = openSqliteEventStore(filename)
    await first.store.appendMany([
      { type: 'task.created', taskId: 'task-lease', payload: { id: 'task-lease', goal: 'lease', workspaceId: 'workspace-1' } },
      { type: 'session.created', taskId: 'task-lease', sessionId: 'session-lease', payload: { id: 'session-lease', taskId: 'task-lease', status: 'active' } },
      { type: 'run.created', taskId: 'task-lease', sessionId: 'session-lease', runId: 'run-lease', payload: { id: 'run-lease', taskId: 'task-lease', sessionId: 'session-lease', state: 'deciding', steps: 0, reviewerRounds: 0, budget: { maxSteps: 2, maxDurationMs: 1000, maxReviewerRounds: 0 } } },
    ])
    const [left, right] = await Promise.all([
      first.store.tryAcquireRunLease!({ runId: 'run-lease', ownerId: 'owner-left', leaseExpiresAt: '2099-01-01T00:00:00.000Z', now: '2026-10-03T00:00:00.000Z' }),
      second.store.tryAcquireRunLease!({ runId: 'run-lease', ownerId: 'owner-right', leaseExpiresAt: '2099-01-01T00:00:00.000Z', now: '2026-10-03T00:00:00.000Z' }),
    ])
    assert.equal([left, right].filter((value) => value !== false).length, 1)
    assert.equal([left, right].filter((value) => value === false).length, 1)
    const owner = (await first.store.getRun('run-lease'))?.ownerId
    assert.ok(owner === 'owner-left' || owner === 'owner-right')
    await first.store.close()
    await second.store.close()
  })
})

test('SQLite owner release clears the durable lease projection for reconnect', async () => {
  await withDatabase(async (filename) => {
    const first = openSqliteEventStore(filename)
    const runtime = new RuntimeFacade({
      store: first.store,
      provider: new MockProvider(),
      ownerId: 'owner-first',
    })
    const task = await runtime.createTask({ goal: 'pause on shutdown', workspaceId: 'workspace-1' })
    const session = await runtime.createSession({ taskId: task.id })
    const run = await runtime.startRun({ taskId: task.id, sessionId: session.id })
    await runtime.shutdown('test disconnect')
    assert.equal((await first.store.getRun(run.id))?.ownerId, undefined)
    await first.store.close()

    const second = openSqliteEventStore(filename)
    const claimed = await second.store.tryAcquireRunLease!({
      runId: run.id,
      ownerId: 'owner-second',
      leaseExpiresAt: '2099-01-01T00:00:00.000Z',
      now: '2026-10-03T00:00:00.000Z',
    })
    assert.notEqual(claimed, false)
    assert.equal((await second.store.getRun(run.id))?.ownerId, 'owner-second')
    await second.store.close()
  })
})

test('a second Runtime reopens a completed run without calling the provider again', async () => {
  await withDatabase(async (filename) => {
    const first = openSqliteEventStore(filename);
    const providerResponses: ProviderResponse[] = [
      { kind: 'tool_call', name: 'read_file', arguments: { path: 'README.md' } },
      { kind: 'final', content: 'done' },
    ];
    const firstRuntime = new RuntimeFacade({
      store: first.store,
      provider: new MockProvider(providerResponses),
      toolRegistry: registry,
      policy: allow,
      executor: async () => ({ ok: true, output: { kind: 'file' }, receipt: { sideEffect: 'none' } }),
    });
    const task = await firstRuntime.createTask({ goal: 'inspect', workspaceId: 'workspace-1' });
    const session = await firstRuntime.createSession({ taskId: task.id });
    const run = await firstRuntime.startRun({ taskId: task.id, sessionId: session.id });
    assert.equal((await firstRuntime.run(run.id)).state, 'completed');
    await first.store.close();

    const second = openSqliteEventStore(filename);
    let providerCalls = 0;
    const secondRuntime = new RuntimeFacade({
      store: second.store,
      provider: { ...new MockProvider(), complete: async () => { providerCalls += 1; throw new Error('must not call provider'); } },
      toolRegistry: registry,
      policy: allow,
      executor: async () => { throw new Error('must not execute tool'); },
    });
    const recovered = await secondRuntime.run(run.id);
    assert.equal(recovered.state, 'completed');
    assert.equal(providerCalls, 0);
    assert.equal(recovered.checkpoint?.runId, run.id);
    await second.store.close();
  });
});

test('a separate Runtime process rehydrates the same Run, checkpoint, and JSONL history', async () => {
  await withDatabase(async (filename) => {
    const first = openSqliteEventStore(filename);
    const runtime = new RuntimeFacade({ store: first.store, provider: new MockProvider([{ kind: 'final', content: 'reopened' }]) });
    const task = await runtime.createTask({ goal: 'process reopen', workspaceId: 'workspace-1' });
    const session = await runtime.createSession({ taskId: task.id });
    const created = await runtime.startRun({ taskId: task.id, sessionId: session.id });
    const completed = await runtime.run(created.id);
    assert.equal(completed.state, 'completed');
    const expectedEvents = (await first.store.list(created.id)).length;
    await first.store.close();

    const reopened = await runReopenProcess(filename, created.id);
    assert.equal(reopened.state, 'completed');
    assert.equal(reopened.checkpointRunId, created.id);
    assert.equal(reopened.eventCount, expectedEvents);
    assert.equal(reopened.jsonlLines, expectedEvents);
  });
});

test('a pending approval is hydrated and resolved after Runtime restart', async () => {
  await withDatabase(async (filename) => {
    const first = openSqliteEventStore(filename);
    const firstRuntime = new RuntimeFacade({
      store: first.store,
      provider: new MockProvider([{ kind: 'tool_call', name: 'write_file', arguments: { path: 'report.md' } }]),
      toolRegistry: registry,
      policy: { decide: () => ({ decision: 'ask' as const, reason: 'approval required' }) },
      executor: async () => ({ ok: true, output: 'written', receipt: { sideEffect: 'known' } }),
    });
    const task = await firstRuntime.createTask({ goal: 'write', workspaceId: 'workspace-1' });
    const session = await firstRuntime.createSession({ taskId: task.id });
    const run = await firstRuntime.startRun({ taskId: task.id, sessionId: session.id });
    const paused = await firstRuntime.run(run.id);
    assert.equal(paused.state, 'paused');
    const requested = (await firstRuntime.getEvents(run.id)).find((event) => event.type === 'approval.requested');
    assert.ok(requested);
    await first.store.close();

    const second = openSqliteEventStore(filename);
    const secondRuntime = new RuntimeFacade({
      store: second.store,
      provider: new MockProvider([{ kind: 'final', content: 'approved' }]),
      toolRegistry: registry,
      policy: allow,
      executor: async () => ({ ok: true, output: 'written', receipt: { sideEffect: 'known' } }),
    });
    const result = await secondRuntime.resolveApproval(run.id, requested.payload.approvalId as string, 'approve', 'workspace-1');
    assert.equal(result.state, 'completed');
    await second.store.close();
  });
});

test('a restarted Runtime reconciles an unresolved tool call before asking the provider', async () => {
  await withDatabase(async (filename) => {
    const first = openSqliteEventStore(filename);
    await first.store.appendMany([
      { type: 'task.created', taskId: 'task-1', payload: { id: 'task-1', goal: 'write', workspaceId: 'workspace-1', createdAt: 'now', budget: { maxSteps: 2, maxDurationMs: 1000, maxReviewerRounds: 0 } } },
      { type: 'session.created', taskId: 'task-1', sessionId: 'session-1', payload: { id: 'session-1', taskId: 'task-1', createdAt: 'now', status: 'active' } },
      { type: 'run.created', taskId: 'task-1', sessionId: 'session-1', runId: 'run-1', payload: { id: 'run-1', taskId: 'task-1', sessionId: 'session-1', state: 'executing', createdAt: 'now', updatedAt: 'now', steps: 1, reviewerRounds: 0, budget: { maxSteps: 2, maxDurationMs: 1000, maxReviewerRounds: 0 } } },
      { type: 'tool.call', taskId: 'task-1', sessionId: 'session-1', runId: 'run-1', payload: { id: 'tool-1', stepId: 'step-1', runId: 'run-1', name: 'write_file', arguments: { path: 'report.md' } } },
    ]);
    await first.store.close();
    const second = openSqliteEventStore(filename);
    let providerCalls = 0;
    const runtime = new RuntimeFacade({ store: second.store, provider: { ...new MockProvider(), complete: async () => { providerCalls += 1; throw new Error('must not call provider'); } } });
    const result = await runtime.run('run-1');
    assert.equal(result.state, 'needs_reconciliation');
    assert.equal(providerCalls, 0);
    await second.store.close();
  });
});
