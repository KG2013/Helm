import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { InMemoryEventStore, MockProvider, RuntimeFacade, type ProviderResponse } from '@helm/runtime'
import { createReadOnlyWorkspacePolicy, createWorkspaceInspectionExecutor, StaticToolRegistry, workspaceInspectProfile } from '@helm/runtime/tools'
import { WorkspaceInspectVerifier } from '@helm/runtime'
import { IPC_CHANNELS } from '../src/shared/ipc.js'
import { registerRuntimeIpcHandlers, type RuntimeIpc } from '../src/main/runtime-bridge.js'

const registeredTestTools = {
  get: (id: string) => ({ id, version: 'test-v1', readOnly: false, scope: 'workspace' as const, network: 'none' as const, maxOutputBytes: 32_000 }),
}

class FakeIpcMain implements RuntimeIpc {
  private readonly handlers = new Map<string, (event: unknown, request?: unknown) => unknown>()

  handle(channel: string, handler: (event: unknown, request?: unknown) => unknown): void {
    this.handlers.set(channel, handler)
  }

  invoke(channel: string, request?: unknown): Promise<unknown> {
    const handler = this.handlers.get(channel)
    if (!handler) throw new Error(`No handler registered for ${channel}`)
    return Promise.resolve(handler({}, request))
  }
}

test('desktop IPC starts a Runtime Run and forwards ordered events', async () => {
  const ipc = new FakeIpcMain()
  const events: number[] = []
  const runtime = new RuntimeFacade({
    store: new InMemoryEventStore(),
    provider: new MockProvider([{ kind: 'final', content: 'desktop smoke completed' }]),
  })
  const stop = registerRuntimeIpcHandlers({
    ipc,
    runtime,
    workspaceIds: ['workspace-test'],
    runtimeInfo: { appVersion: '0.1.0', platform: 'test', isPackaged: false },
    emit: (event) => events.push(event.sequence),
  })

  const started = await ipc.invoke(IPC_CHANNELS.runStart, { goal: 'run desktop smoke', workspaceId: 'workspace-test' }) as { task: { id: string }; session: { id: string }; run: { id: string } }
  assert.ok(started.task.id)
  assert.ok(started.session.id)
  assert.ok(started.run.id)

  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 1_000
    const poll = () => {
      void runtime.getRun(started.run.id).then((run) => {
        if (run?.state === 'completed') return resolve()
        if (Date.now() >= deadline) return reject(new Error('Run did not complete during smoke test'))
        setTimeout(poll, 5)
      })
    }
    poll()
  })

  const snapshot = await ipc.invoke(IPC_CHANNELS.runSnapshot, started.run.id) as { run: { state: string; verification?: { result: string }; finalOutput?: string }; events: Array<{ runId?: string; sequence: number }> }
  assert.equal(snapshot.run.state, 'completed')
  assert.equal(snapshot.run.verification?.result, 'passed')
  assert.equal(snapshot.run.finalOutput, 'desktop smoke completed')
  assert.ok(snapshot.events.length >= 5)
  assert.deepEqual(events, [...events].sort((left, right) => left - right))
  assert.ok(snapshot.events.every((event) => event.runId === started.run.id))
  stop()
})

test('desktop IPC inspect uses the registered read-only Runtime path and artifact verifier', async () => {
  const root = await mkdtemp('/tmp/helm-desktop-inspect-')
  try {
    const registry = new StaticToolRegistry([workspaceInspectProfile])
    const runtime = new RuntimeFacade({
      store: new InMemoryEventStore(),
      provider: new MockProvider([
        { kind: 'tool_call', name: 'workspace.inspect', arguments: { path: '.' } },
        { kind: 'final', content: 'Workspace inspection completed.' },
      ]),
      toolRegistry: registry,
      policy: createReadOnlyWorkspacePolicy(registry, { roots: { 'workspace-test': root } }),
      executor: createWorkspaceInspectionExecutor({ roots: { 'workspace-test': root } }),
      verifier: new WorkspaceInspectVerifier(),
    })
    const ipc = new FakeIpcMain()
    const stop = registerRuntimeIpcHandlers({
      ipc,
      runtime,
      workspaceIds: ['workspace-test'],
      runtimeInfo: { appVersion: '0.1.0', platform: 'test', isPackaged: false },
      emit: () => undefined,
    })
    const started = await ipc.invoke(IPC_CHANNELS.runStart, { goal: 'inspect .', workspaceId: 'workspace-test' }) as { run: { id: string } }
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 1_000
      const poll = () => void runtime.getRun(started.run.id).then((run) => {
        if (run?.state === 'completed') return resolve()
        if (Date.now() >= deadline) return reject(new Error(`inspect Run did not complete: ${run?.state}`))
        setTimeout(poll, 5)
      })
      poll()
    })
    const snapshot = await ipc.invoke(IPC_CHANNELS.runSnapshot, started.run.id) as { run: { verification?: { result: string; evidence: Array<{ uri?: string }> } }; events: Array<{ type: string; payload: Record<string, unknown> }>; projection: { artifacts: Array<{ type: string; tool: string; sourceRunId?: string; path?: string }>; verification?: { result: string } } }
    assert.equal(snapshot.run.verification?.result, 'passed')
    assert.match(snapshot.run.verification?.evidence[0]?.uri ?? '', /^workspace:\/\//)
    assert.ok(snapshot.events.some((event) => event.type === 'tool.receipt'))
    assert.equal(snapshot.projection.verification?.result, 'passed')
    assert.equal(snapshot.projection.artifacts.length, 1)
    assert.equal(snapshot.projection.artifacts[0]?.type, 'workspace-inspection')
    assert.equal(snapshot.projection.artifacts[0]?.tool, 'workspace.inspect')
    assert.equal(snapshot.projection.artifacts[0]?.sourceRunId, started.run.id)
    const exported = await ipc.invoke(IPC_CHANNELS.runExport, { runId: started.run.id }) as { runId: string; jsonl: string; projection: typeof snapshot.projection }
    assert.equal(exported.runId, started.run.id)
    assert.match(exported.jsonl, /"type":"tool\.receipt"/)
    assert.equal(exported.projection.verification?.result, 'passed')
    assert.equal(exported.projection.artifacts[0]?.sourceRunId, started.run.id)
    stop()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('desktop IPC cancellation is idempotent while a provider call is in flight', async () => {
  let release!: (response: ProviderResponse) => void
  const runtime = new RuntimeFacade({
    store: new InMemoryEventStore(),
    provider: {
      id: 'deferred',
      model: 'deferred-model',
      capabilities: new MockProvider().capabilities,
      complete: async () => new Promise<ProviderResponse>((resolve) => { release = resolve }),
    },
  })
  const ipc = new FakeIpcMain()
  const events: Array<{ type: string; sequence: number }> = []
  const stop = registerRuntimeIpcHandlers({
    ipc,
    runtime,
    workspaceIds: ['workspace-test'],
    runtimeInfo: { appVersion: '0.1.0', platform: 'test', isPackaged: false },
    emit: (event) => events.push({ type: event.type, sequence: event.sequence }),
  })
  const started = await ipc.invoke(IPC_CHANNELS.runStart, { goal: 'cancel from desktop', workspaceId: 'workspace-test' }) as { run: { id: string }; task: { id: string }; session: { id: string } }
  const cancelled = await ipc.invoke(IPC_CHANNELS.runControl, { runId: started.run.id, action: 'cancel' }) as { state: string }
  assert.equal(cancelled.state, 'cancelled')
  release({ kind: 'final', content: 'late provider response' })
  await new Promise((resolve) => setTimeout(resolve, 10))
  const repeated = await ipc.invoke(IPC_CHANNELS.runControl, { runId: started.run.id, action: 'cancel' }) as { state: string }
  assert.equal(repeated.state, 'cancelled')
  const snapshot = await ipc.invoke(IPC_CHANNELS.runSnapshot, started.run.id) as { task: { id: string }; session: { id: string }; run: { state: string }; events: Array<{ type: string }> }
  assert.equal(snapshot.run.state, 'cancelled')
  assert.equal(snapshot.task.id, started.task.id)
  assert.equal(snapshot.session.id, started.session.id)
  assert.equal(snapshot.events.filter((event) => event.type === 'step.proposal').length, 0)
  assert.deepEqual(events, [...events].sort((left, right) => left.sequence - right.sequence))
  stop()
})

test('desktop IPC pause and resume replay the same Run without duplicating history', async () => {
  const releases: Array<(response: ProviderResponse) => void> = []
  const provider = {
    id: 'deferred',
    model: 'deferred-model',
    capabilities: new MockProvider().capabilities,
    complete: async () => new Promise<ProviderResponse>((resolve) => { releases.push(resolve) }),
  }
  const runtime = new RuntimeFacade({ store: new InMemoryEventStore(), provider })
  const ipc = new FakeIpcMain()
  const stop = registerRuntimeIpcHandlers({
    ipc,
    runtime,
    workspaceIds: ['workspace-test'],
    runtimeInfo: { appVersion: '0.1.0', platform: 'test', isPackaged: false },
    emit: () => undefined,
  })
  const started = await ipc.invoke(IPC_CHANNELS.runStart, { goal: 'pause and resume', workspaceId: 'workspace-test' }) as { run: { id: string } }
  const initial = await runtime.getRun(started.run.id)
  assert.ok(initial)
  await assert.rejects(
    ipc.invoke(IPC_CHANNELS.runStart, { goal: 'duplicate active session', workspaceId: 'workspace-test', sessionId: initial.sessionId }),
    /already has active run/,
  )
  await new Promise<void>((resolve) => {
    const poll = () => releases.length > 0 ? resolve() : setTimeout(poll, 1)
    poll()
  })
  const paused = await ipc.invoke(IPC_CHANNELS.runControl, { runId: started.run.id, action: 'pause' }) as { state: string }
  assert.equal(paused.state, 'paused')
  releases.shift()?.({ kind: 'final', content: 'paused response' })
  await new Promise((resolve) => setTimeout(resolve, 10))
  const resumed = await ipc.invoke(IPC_CHANNELS.runControl, { runId: started.run.id, action: 'resume' }) as { state: string }
  assert.equal(resumed.state, 'deciding')
  await new Promise<void>((resolve) => {
    const poll = () => releases.length > 0 ? resolve() : setTimeout(poll, 1)
    poll()
  })
  releases.shift()?.({ kind: 'final', content: 'resumed response' })
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 1_000
    const poll = () => {
      void runtime.getRun(started.run.id).then((run) => {
        if (run?.state === 'completed') return resolve()
        if (Date.now() >= deadline) return reject(new Error('resumed Run did not complete'))
        setTimeout(poll, 5)
      })
    }
    poll()
  })
  const snapshot = await ipc.invoke(IPC_CHANNELS.runSnapshot, started.run.id) as { events: Array<{ type: string }> }
  assert.equal(snapshot.events.filter((event) => event.type === 'run.created').length, 1)
  assert.equal(snapshot.events.filter((event) => event.type === 'step.started').length, 2)
  stop()
})

test('desktop IPC approval binds the original proposal and exposes deny without executing it', async () => {
  const provider = new MockProvider([
    { kind: 'tool_call', name: 'write_file', arguments: { path: 'report.md', content: 'safe' } },
    { kind: 'final', content: 'approved output' },
  ])
  const executed: string[] = []
  const runtime = new RuntimeFacade({
    store: new InMemoryEventStore(),
    provider,
    toolRegistry: registeredTestTools,
    policy: { decide: () => ({ decision: 'ask' as const, reason: 'write requires approval' }) },
    executor: async (call) => { executed.push(call.id); return { ok: true, output: 'saved', receipt: { sideEffect: 'known' } } },
  })
  const ipc = new FakeIpcMain()
  const events: Array<{ type: string; payload: Record<string, unknown> }> = []
  const stop = registerRuntimeIpcHandlers({
    ipc,
    runtime,
    workspaceIds: ['workspace-test'],
    runtimeInfo: { appVersion: '0.1.0', platform: 'test', isPackaged: false },
    emit: (event) => events.push({ type: event.type, payload: event.payload }),
  })
  const started = await ipc.invoke(IPC_CHANNELS.runStart, { goal: 'approve a write', workspaceId: 'workspace-test' }) as { run: { id: string } }
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 1_000
    const poll = () => void runtime.getRun(started.run.id).then((run) => {
      if (run?.state === 'paused') return resolve()
      if (Date.now() >= deadline) return reject(new Error('approval did not pause the Run'))
      setTimeout(poll, 5)
    })
    poll()
  })
  const requested = events.find((event) => event.type === 'approval.requested')
  assert.ok(requested)
  const approvalId = requested.payload.approvalId as string
  assert.equal((requested.payload.call as { name: string }).name, 'write_file')
  await assert.rejects(
    ipc.invoke(IPC_CHANNELS.runApproval, { runId: started.run.id, approvalId, workspaceId: 'workspace-other', decision: 'approve' }),
    /workspace mismatch/,
  )
  const approved = await ipc.invoke(IPC_CHANNELS.runApproval, { runId: started.run.id, approvalId, workspaceId: 'workspace-test', decision: 'approve' }) as { state: string }
  assert.equal(approved.state, 'completed')
  assert.deepEqual(executed, [approvalId])
  assert.equal(provider.requests.length, 2)
  assert.equal(events.filter((event) => event.type === 'approval.decided').length, 1)
  stop()

  const denyRuntime = new RuntimeFacade({
    store: new InMemoryEventStore(),
    provider: new MockProvider([{ kind: 'tool_call', name: 'shell', arguments: { command: 'rm -rf /' } }]),
    toolRegistry: registeredTestTools,
    policy: { decide: () => ({ decision: 'ask' as const, reason: 'shell requires approval' }) },
    executor: async () => { throw new Error('executor must not run') },
  })
  const denyIpc = new FakeIpcMain()
  const denyStop = registerRuntimeIpcHandlers({
    ipc: denyIpc,
    runtime: denyRuntime,
    workspaceIds: ['workspace-test'],
    runtimeInfo: { appVersion: '0.1.0', platform: 'test', isPackaged: false },
    emit: () => undefined,
  })
  const denyStarted = await denyIpc.invoke(IPC_CHANNELS.runStart, { goal: 'deny shell', workspaceId: 'workspace-test' }) as { run: { id: string } }
  await new Promise<void>((resolve) => {
    const poll = () => void denyRuntime.getRun(denyStarted.run.id).then((run) => run?.state === 'paused' ? resolve() : setTimeout(poll, 5))
    poll()
  })
  const denyEvents = await denyRuntime.getEvents(denyStarted.run.id)
  const denyRequest = denyEvents.find((event) => event.type === 'approval.requested')
  assert.ok(denyRequest)
  const denied = await denyIpc.invoke(IPC_CHANNELS.runApproval, { runId: denyStarted.run.id, approvalId: denyRequest.payload.approvalId, workspaceId: 'workspace-test', decision: 'deny' }) as { state: string }
  assert.equal(denied.state, 'failed')
  assert.equal((await denyRuntime.getEvents(denyStarted.run.id)).filter((event) => event.type === 'tool.call').length, 0)
  denyStop()
})

test('desktop IPC keeps bounded failures and unknown outcomes explicit', async () => {
  const runToState = async (runtime: RuntimeFacade, providerGoal: string, expected: string, startOptions: Record<string, unknown> = {}) => {
    const ipc = new FakeIpcMain()
    const stop = registerRuntimeIpcHandlers({
      ipc,
      runtime,
      workspaceIds: ['workspace-test'],
      runtimeInfo: { appVersion: '0.1.0', platform: 'test', isPackaged: false },
      emit: () => undefined,
    })
    const started = await ipc.invoke(IPC_CHANNELS.runStart, { goal: providerGoal, workspaceId: 'workspace-test', ...startOptions }) as { run: { id: string } }
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 1_000
      const poll = () => void runtime.getRun(started.run.id).then((run) => {
        if (run?.state === expected) return resolve()
        if (Date.now() >= deadline) return reject(new Error(`expected ${expected}, got ${run?.state}`))
        setTimeout(poll, 5)
      })
      poll()
    })
    const snapshot = await ipc.invoke(IPC_CHANNELS.runSnapshot, started.run.id) as { run: { state: string; verification?: { result: string }; lastError?: string }; events: Array<{ type: string }> }
    stop()
    return snapshot
  }

  const providerFailure = await runToState(new RuntimeFacade({
    store: new InMemoryEventStore(),
    provider: { id: 'failure', model: 'failure-model', capabilities: new MockProvider().capabilities, complete: async () => { throw new Error('Authorization: Bearer sk-super-secret-token') } },
  }), 'provider failure', 'failed')
  assert.equal(providerFailure.run.state, 'failed')
  assert.match(providerFailure.run.lastError ?? '', /^Provider error:/)
  assert.doesNotMatch(providerFailure.run.lastError ?? '', /sk-super-secret|Authorization: Bearer/)

  const emptyFinal = await runToState(new RuntimeFacade({
    store: new InMemoryEventStore(),
    provider: new MockProvider([{ kind: 'final', content: '' }]),
  }), 'empty output', 'paused')
  assert.equal(emptyFinal.run.verification?.result, 'unknown')

  const budget = await runToState(new RuntimeFacade({
    store: new InMemoryEventStore(),
    provider: new MockProvider([{ kind: 'tool_call', name: 'read_file', arguments: { path: 'README.md' } }]),
    toolRegistry: registeredTestTools,
    policy: { decide: () => ({ decision: 'allow' as const, reason: 'read allowed' }) },
    executor: async () => ({ ok: true, output: 'read', receipt: { sideEffect: 'none' } }),
    defaultBudget: { maxSteps: 1 },
  }), 'budget limit', 'paused')
  assert.equal(budget.run.state, 'paused')

  const reconciliation = await runToState(new RuntimeFacade({
    store: new InMemoryEventStore(),
    provider: new MockProvider([{ kind: 'tool_call', name: 'write_file', arguments: { path: 'report.md' } }]),
    toolRegistry: registeredTestTools,
    policy: { decide: () => ({ decision: 'allow' as const, reason: 'write allowed' }) },
    executor: async () => ({ ok: false, error: 'connection lost', receipt: { sideEffect: 'unknown' } }),
  }), 'unknown side effect', 'needs_reconciliation')
  assert.equal(reconciliation.run.state, 'needs_reconciliation')
  assert.ok(reconciliation.events.some((event) => event.type === 'run.needs_reconciliation'))
})
