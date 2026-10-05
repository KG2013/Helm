import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { InMemoryEventStore, MockProvider, RuntimeFacade, createOfficeRuntime, type OfficeWorkerClient, type OfficeWorkerRequest, type OfficeWorkerResponse, type ProviderResponse } from '@helm/runtime'
import { createReadOnlyWorkspacePolicy, createWorkspaceInspectionExecutor, StaticToolRegistry, workspaceInspectProfile } from '@helm/runtime/tools'
import { WorkspaceInspectVerifier } from '@helm/runtime'
import { IPC_CHANNELS } from '../src/shared/ipc.js'
import { registerRuntimeIpcHandlers, type RuntimeIpc } from '../src/main/runtime-bridge.js'
import { DesktopWindowRegistry, type WebContentsLike } from '../src/main/window-registry.js'

const registeredTestTools = {
  get: (id: string) => ({ id, version: 'test-v1', readOnly: false, scope: 'workspace' as const, network: 'none' as const, maxOutputBytes: 32_000 }),
}

class FakeIpcMain implements RuntimeIpc {
  private readonly handlers = new Map<string, (event: unknown, request?: unknown) => unknown>()

  handle(channel: string, handler: (event: unknown, request?: unknown) => unknown): void {
    this.handlers.set(channel, handler)
  }

  invoke(channel: string, request?: unknown, event: unknown = {}): Promise<unknown> {
    const handler = this.handlers.get(channel)
    if (!handler) throw new Error(`No handler registered for ${channel}`)
    return Promise.resolve(handler(event, request))
  }
}

function fakeSender(): WebContentsLike {
  return { isDestroyed: () => false, send: () => undefined }
}

test('desktop IPC authorizes a Run per window and recovery is triggered by reconnect snapshot', async () => {
  const ipc = new FakeIpcMain()
  const registry = new DesktopWindowRegistry()
  const first = fakeSender()
  const second = fakeSender()
  registry.register(first)
  registry.register(second)
  const runtime = new RuntimeFacade({
    store: new InMemoryEventStore(),
    provider: new MockProvider([{ kind: 'final', content: 'reconnectable' }]),
  })
  const stop = registerRuntimeIpcHandlers({
    ipc,
    runtime,
    windowRegistry: registry,
    workspaceIds: ['workspace-test'],
    runtimeInfo: { appVersion: '0.1.0', platform: 'test', isPackaged: true },
    emit: (event) => registry.publish(event),
  })
  const started = await ipc.invoke(IPC_CHANNELS.runStart, { goal: 'restart recovery', workspaceId: 'workspace-test' }, { sender: first }) as { run: { id: string } }
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 1_000
    const poll = () => void runtime.getRun(started.run.id).then((run) => {
      if (run?.state === 'completed') return resolve()
      if (Date.now() >= deadline) return reject(new Error(`Run did not complete: ${run?.state}`))
      setTimeout(poll, 5)
    })
    poll()
  })
  await assert.rejects(() => ipc.invoke(IPC_CHANNELS.runControl, { runId: started.run.id, action: 'pause' }, { sender: second }), /not authorized|source/i)
  const snapshot = await ipc.invoke(IPC_CHANNELS.runSnapshot, started.run.id, { sender: second }) as { run: { id: string; state: string }; events: Array<{ sequence: number }> }
  assert.equal(snapshot.run.id, started.run.id)
  assert.equal(snapshot.run.state, 'completed')
  assert.deepEqual(snapshot.events.map((event) => event.sequence), [...snapshot.events].map((event) => event.sequence).sort((a, b) => a - b))
  stop()
})

test('desktop IPC rejects cross-window access to Agent, Connector, Browser, and A2A Run data', async () => {
  const ipc = new FakeIpcMain()
  const registry = new DesktopWindowRegistry()
  const owner = fakeSender()
  const other = fakeSender()
  registry.register(owner)
  registry.register(other)
  const runtime = new RuntimeFacade({
    store: new InMemoryEventStore(),
    provider: new MockProvider([{ kind: 'final', content: 'authorized run' }]),
  })
  const stop = registerRuntimeIpcHandlers({
    ipc,
    runtime,
    windowRegistry: registry,
    workspaceIds: ['workspace-test'],
    runtimeInfo: { appVersion: '0.1.0', platform: 'test', isPackaged: true },
    emit: (event) => registry.publish(event),
  })
  const started = await ipc.invoke(IPC_CHANNELS.runStart, { goal: 'authorization boundary', workspaceId: 'workspace-test' }, { sender: owner }) as { task: { id: string }; session: { id: string }; run: { id: string } }
  await assert.rejects(() => ipc.invoke(IPC_CHANNELS.agentList, { parentRunId: started.run.id }, { sender: other }), /not authorized/i)
  await assert.rejects(() => ipc.invoke(IPC_CHANNELS.agentCreate, {
    parentRunId: started.run.id,
    role: 'observer',
    principal: 'local-user',
    goal: 'read one bounded resource',
    capabilities: ['workspace.read'],
    scope: { workspaceId: 'workspace-test' },
    allowedCapabilities: ['workspace.read'],
    allowedScope: { workspaceId: 'workspace-test' },
  }, { sender: other }), /not authorized/i)
  await assert.rejects(() => ipc.invoke(IPC_CHANNELS.connectorPreview, {
    runId: started.run.id,
    taskId: started.task.id,
    sessionId: started.session.id,
    connectorId: 'loopback',
    profileId: 'missing',
    profileVersion: 'v1',
    action: 'record.preview',
    target: 'loopback://records/1',
    scope: { records: ['1'] },
    before: {},
    after: {},
    impact: [],
    rollbackPlan: 'none',
    reconciliationPlan: 'read back',
  }, { sender: other }), /not authorized/i)
  const context = await ipc.invoke(IPC_CHANNELS.browserContextCreate, {
    runId: started.run.id,
    taskId: started.task.id,
    sessionId: started.session.id,
    profile: { id: 'browser.fixture', version: 'v1', allowedOrigins: ['https://fixture.example.test'], allowedApps: ['fixture-app'], allowedWindows: ['fixture-window'] },
    appId: 'fixture-app',
    windowId: 'fixture-window',
  }, { sender: owner }) as { contextId: string }
  await assert.rejects(() => ipc.invoke(IPC_CHANNELS.browserNavigate, { contextId: context.contextId, url: 'https://fixture.example.test/home', idempotencyKey: 'cross-window-navigation' }, { sender: other }), /not authorized/i)
  await assert.rejects(() => ipc.invoke(IPC_CHANNELS.a2aList, { runId: started.run.id }, { sender: other }), /not authorized/i)
  stop()
})

test('desktop IPC lists and reviews Experience Candidates with evidence gates', async () => {
  const ipc = new FakeIpcMain()
  const runtime = new RuntimeFacade({ store: new InMemoryEventStore(), provider: new MockProvider() })
  const stop = registerRuntimeIpcHandlers({
    ipc,
    runtime,
    runtimeInfo: { appVersion: '0.1.0', platform: 'test', isPackaged: false },
    emit: () => undefined,
  })
  await runtime.createExperienceCandidate({
    id: 'candidate-ipc',
    sourceEpisodeId: 'episode-ipc',
    sourceTraceId: 'trace-ipc',
    summary: 'Review a bounded coding pattern',
    applicability: ['coding'],
    risk: 'medium',
    costChecks: { tokenBudgetOk: true, costBudgetOk: true },
    createdAt: 'now',
  })
  const listed = await ipc.invoke(IPC_CHANNELS.experienceList) as Array<{ id: string; approvalState: string; risk?: string }>
  assert.equal(listed[0]?.id, 'candidate-ipc')
  assert.equal(listed[0]?.approvalState, 'pending')
  assert.equal(listed[0]?.risk, 'medium')
  await assert.rejects(() => ipc.invoke(IPC_CHANNELS.experienceReview, { candidateId: 'candidate-ipc', action: 'approve' }), /requires a source Episode\/trace and validation evidence/i)
  const reviewed = await ipc.invoke(IPC_CHANNELS.experienceReview, { candidateId: 'candidate-ipc', action: 'approve', evidence: ['trace://episode-ipc/step-1'], reviewerId: 'desktop-reviewer' }) as { approvalState: string; validationState: string; reviewVersion: number; reviewerId?: string }
  assert.equal(reviewed.approvalState, 'approved')
  assert.equal(reviewed.validationState, 'validated')
  assert.equal(reviewed.reviewVersion, 1)
  assert.equal(reviewed.reviewerId, 'desktop-reviewer')
  stop()
})

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
  const agent = await ipc.invoke(IPC_CHANNELS.agentCreate, {
    parentRunId: started.run.id,
    role: 'observer',
    principal: 'local-user',
    goal: 'Inspect one bounded resource',
    capabilities: ['workspace.read'],
    scope: { workspaceId: 'workspace-test' },
    allowedCapabilities: ['workspace.read'],
    allowedScope: { workspaceId: 'workspace-test' },
  }) as { agentRunId: string; parentRunId: string }
  assert.equal(agent.parentRunId, started.run.id)
  const listedAgents = await ipc.invoke(IPC_CHANNELS.agentList, { parentRunId: started.run.id }) as Array<{ agentRunId: string }>
  assert.deepEqual(listedAgents.map((item) => item.agentRunId), [agent.agentRunId])
  const a2aDeliveries = await ipc.invoke(IPC_CHANNELS.a2aList, { runId: started.run.id }) as Array<{ runId: string }>
  assert.deepEqual(a2aDeliveries, [])
  const recoveredAgents = await ipc.invoke(IPC_CHANNELS.agentControl, { parentRunId: started.run.id, action: 'recover' }) as { parentRunId: string; agents: unknown[] }
  assert.equal(recoveredAgents.parentRunId, started.run.id)
  await ipc.invoke(IPC_CHANNELS.connectorRegister, { id: 'loopback.records', version: 'v1', connectorId: 'loopback', actions: ['record.preview', 'record.write'], allowedTargets: ['loopback://records'], allowedFields: ['name'], scope: { records: ['1'] } })
  const connectors = await ipc.invoke(IPC_CHANNELS.connectorList) as Array<{ id: string }>
  assert.equal(connectors[0]?.id, 'loopback.records')
  const preview = await ipc.invoke(IPC_CHANNELS.connectorPreview, { runId: started.run.id, taskId: started.task.id, sessionId: started.session.id, connectorId: 'loopback', profileId: 'loopback.records', profileVersion: 'v1', action: 'record.preview', target: 'loopback://records/1', scope: { records: ['1'] }, before: { name: 'old' }, after: { name: 'new' }, impact: ['one record'], rollbackPlan: 'restore', reconciliationPlan: 'read back' }) as { preview: { dryRun: boolean }; action: { status: string } }
  assert.equal(preview.preview.dryRun, true)
  assert.equal(preview.action.status, 'denied')
  const write = await ipc.invoke(IPC_CHANNELS.connectorWrite, { runId: started.run.id, taskId: started.task.id, sessionId: started.session.id, connectorId: 'loopback', profileId: 'loopback.records', profileVersion: 'v1', action: 'record.write', target: 'loopback://records/1', scope: { records: ['1'] }, after: { name: 'new' }, idempotencyKey: 'desktop-write-1' }) as { action: { status: string }; receipt: { target: string } }
  assert.equal(write.action.status, 'denied')
  assert.equal(write.receipt.target, 'loopback://records/1')
  const verification = await ipc.invoke(IPC_CHANNELS.connectorVerify, { runId: started.run.id, taskId: started.task.id, sessionId: started.session.id, actionId: 'desktop-write-1', target: 'loopback://records/1', expectedAfterHash: '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a' }) as { status: string }
  assert.equal(verification.status, 'unknown')
  const browserContext = await ipc.invoke(IPC_CHANNELS.browserContextCreate, { runId: started.run.id, taskId: started.task.id, sessionId: started.session.id, profile: { id: 'browser.fixture', version: 'v1', allowedOrigins: ['https://fixture.example.test'], allowedApps: ['fixture-app'], allowedWindows: ['fixture-window'] }, appId: 'fixture-app', windowId: 'fixture-window' }) as { contextId: string }
  const browserContexts = await ipc.invoke(IPC_CHANNELS.browserContextList, { runId: started.run.id }) as Array<{ contextId: string }>
  assert.deepEqual(browserContexts.map((item) => item.contextId), [browserContext.contextId])
  const browserNavigation = await ipc.invoke(IPC_CHANNELS.browserNavigate, { contextId: browserContext.contextId, url: 'https://fixture.example.test/home', idempotencyKey: 'desktop-navigation-1' }) as { action: { status: string } }
  assert.equal(browserNavigation.action.status, 'denied')
  const closedContext = await ipc.invoke(IPC_CHANNELS.browserControl, { contextId: browserContext.contextId, action: 'close' }) as { state: string }
  assert.equal(closedContext.state, 'closed')
  const reconciliation = await ipc.invoke(IPC_CHANNELS.runReconciliation, { runId: started.run.id, action: 'inspect' }) as { runId: string; budgetUsage: { steps: number }; candidates: unknown[] }
  assert.equal(reconciliation.runId, started.run.id)
  assert.equal(reconciliation.budgetUsage.steps, snapshot.run.steps)
  assert.deepEqual(reconciliation.candidates, [])
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
    assert.ok(snapshot.events.some((event) => event.type === 'action.requested'))
    assert.ok(snapshot.events.some((event) => event.type === 'action.receipt'))
    assert.equal(snapshot.projection.verification?.result, 'passed')
    assert.equal(snapshot.projection.artifacts.length, 1)
    assert.equal(snapshot.projection.artifacts[0]?.type, 'workspace-inspection')
    assert.equal(snapshot.projection.artifacts[0]?.tool, 'workspace.inspect')
    assert.equal(snapshot.projection.artifacts[0]?.sourceRunId, started.run.id)
    const exported = await ipc.invoke(IPC_CHANNELS.runExport, { runId: started.run.id }) as { runId: string; jsonl: string; projection: typeof snapshot.projection; episode: { runId: string; trace: { taskId?: string; verifierIds: string[] } } }
    assert.equal(exported.runId, started.run.id)
    assert.match(exported.jsonl, /"type":"tool\.receipt"/)
    assert.equal(exported.projection.verification?.result, 'passed')
    assert.equal(exported.projection.artifacts[0]?.sourceRunId, started.run.id)
    assert.equal(exported.episode.runId, started.run.id)
    assert.ok(exported.episode.trace.verifierIds.length > 0)
    stop()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('desktop IPC exposes the same Office artifact and verification projection after approval', async () => {
  const root = await mkdtemp('/tmp/helm-desktop-office-')
  try {
    const worker: OfficeWorkerClient = {
      health: async () => ({ worker: 'document-worker', version: '0.3.0', tools: {}, python: {}, missing: [], checks: { docxRendering: 'passed', pdfOcr: 'unknown' }, limitations: [] }),
      execute: async (request: OfficeWorkerRequest): Promise<OfficeWorkerResponse> => ({
        id: request.id,
        ok: true,
        result: { paragraphs: 1 },
        receipt: {
          worker: 'document-worker', workerVersion: '0.3.0', sideEffect: 'known',
          artifact: { type: 'docx', path: request.path, hash: 'a'.repeat(64), bytes: 128, sourceRunId: request.runId },
          checks: { structure: 'passed', content: 'passed', rendering: 'passed' },
        },
      }),
    }
    const runtime = createOfficeRuntime({
      store: new InMemoryEventStore(),
      provider: new MockProvider([
        { kind: 'tool_call', name: 'office.docx.create', arguments: { path: 'report.docx', paragraphs: ['hello'] } },
        { kind: 'final', content: 'DOCX delivered.' },
      ]),
      worker,
      workspaceId: 'workspace-office',
      root,
    })
    const ipc = new FakeIpcMain()
    const stop = registerRuntimeIpcHandlers({
      ipc,
      runtime,
      workspaceIds: ['workspace-office'],
      runtimeInfo: { appVersion: '0.1.0', platform: 'test', isPackaged: false },
      emit: () => undefined,
    })
    const started = await ipc.invoke(IPC_CHANNELS.runStart, { goal: 'create office report', workspaceId: 'workspace-office' }) as { run: { id: string } }
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 1_000
      const poll = () => void runtime.getRun(started.run.id).then((run) => {
        if (run?.state === 'paused') return resolve()
        if (Date.now() >= deadline) return reject(new Error(`Office approval did not pause: ${run?.state}`))
        setTimeout(poll, 5)
      })
      poll()
    })
    const events = await runtime.getEvents(started.run.id)
    const approval = events.find((event) => event.type === 'approval.requested')
    assert.ok(approval)
    await ipc.invoke(IPC_CHANNELS.runApproval, { runId: started.run.id, approvalId: approval.payload.approvalId, workspaceId: 'workspace-office', decision: 'approve' })
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 1_000
      const poll = () => void runtime.getRun(started.run.id).then((run) => {
        if (run?.state === 'completed') return resolve()
        if (Date.now() >= deadline) return reject(new Error(`Office Run did not complete: ${run?.state}`))
        setTimeout(poll, 5)
      })
      poll()
    })
    const snapshot = await ipc.invoke(IPC_CHANNELS.runSnapshot, started.run.id) as { projection: { verification?: { result: string }; artifacts: Array<{ type: string; path?: string; sourceRunId?: string }> } }
    assert.equal(snapshot.projection.verification?.result, 'passed')
    assert.equal(snapshot.projection.artifacts[0]?.type, 'docx')
    assert.equal(snapshot.projection.artifacts[0]?.path, 'report.docx')
    assert.equal(snapshot.projection.artifacts[0]?.sourceRunId, started.run.id)
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
