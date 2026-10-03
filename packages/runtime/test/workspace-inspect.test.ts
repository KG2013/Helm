import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, symlink, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  InMemoryEventStore,
  MockProvider,
  RuntimeFacade,
  WorkspaceInspectVerifier,
  buildProviderContext,
} from '../src/index.js'
import {
  StaticToolRegistry,
  createReadOnlyWorkspacePolicy,
  createWorkspaceInspectionExecutor,
  workspaceInspectProfile,
  createWorkspaceInspectionRuntime,
} from '../src/tools.js'

async function createInspectionRuntime(root: string, responses: ConstructorParameters<typeof MockProvider>[0]) {
  const workspaceId = 'workspace-test'
  const registry = new StaticToolRegistry([workspaceInspectProfile])
  const runtime = new RuntimeFacade({
    store: new InMemoryEventStore(),
    provider: new MockProvider(responses),
    toolRegistry: registry,
    policy: createReadOnlyWorkspacePolicy(registry, { roots: { [workspaceId]: root } }),
    executor: createWorkspaceInspectionExecutor({ roots: { [workspaceId]: root } }),
    verifier: new WorkspaceInspectVerifier(),
  })
  const task = await runtime.createTask({ goal: 'inspect workspace', workspaceId })
  const session = await runtime.createSession({ taskId: task.id })
  const createdRun = await runtime.startRun({ taskId: task.id, sessionId: session.id })
  return { runtime, run: await runtime.run(createdRun.id) }
}

test('workspace inspection returns a bounded artifact and passes structured verification', async () => {
  const root = await mkdtemp('/tmp/helm-inspect-')
  try {
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'README.md'), '# safe metadata')
    const { runtime, run } = await createInspectionRuntime(root, [
      { kind: 'tool_call', name: 'workspace.inspect', arguments: { path: 'src/../README.md' } },
      { kind: 'final', content: 'Workspace inspection completed.' },
    ])

    assert.equal(run.state, 'completed')
    assert.equal(run.verification?.result, 'passed')
    const events = await runtime.getEvents(run.id)
    const receipt = events.find((event) => event.type === 'tool.receipt')
    const observation = events.find((event) => event.type === 'step.observation')
    assert.ok(receipt)
    assert.ok(observation)
    assert.equal((observation.payload.observation as { ok: boolean }).ok, true)
    const payload = receipt.payload as { receipt?: { artifact?: { type?: string; uri?: string; hash?: string }; sideEffect?: string } }
    assert.equal(payload.receipt?.sideEffect, 'none')
    assert.equal(payload.receipt?.artifact?.type, 'workspace-inspection')
    assert.equal((payload.receipt as { path?: string }).path, 'README.md')
    assert.match(payload.receipt?.artifact?.uri ?? '', /^workspace:\/\/workspace-test\//)
    assert.match(payload.receipt?.artifact?.hash ?? '', /^[a-f0-9]{64}$/)
    assert.ok(!JSON.stringify(payload).includes(root))
    const decision = events.find((event) => event.type === 'policy.decision')
    assert.equal((decision?.payload.toolProfile as { version?: string }).version, 'v1')
    assert.ok(events.some((event) => event.type === 'verification.result'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('provider context enforces its byte budget and redacts tool errors', () => {
  const task = { id: 'task-1', goal: `goal ${'x'.repeat(100_000)} authorization=Bearer secret-value`, workspaceId: 'workspace', createdAt: 'now', budget: { maxSteps: 2, maxDurationMs: 1000, maxReviewerRounds: 0 } }
  const { context } = buildProviderContext(task, [{
    id: 'event-1', sequence: 1, type: 'tool.receipt', timestamp: 'now', runId: 'run-1', taskId: 'task-1', sessionId: 'session-1',
    payload: { toolCallId: 'tool-1', name: 'read', ok: false, error: 'Authorization: Bearer secret-value', output: 'private output' },
  }], 1024)
  assert.ok(context.bytes <= 1024)
  assert.equal(JSON.stringify(context).includes('secret-value'), false)
})

test('a provider-driven inspect Run receives Tool schema and structured ToolResult through the Runtime Facade', async () => {
  const root = await mkdtemp('/tmp/helm-inspect-provider-')
  try {
    await writeFile(join(root, 'README.md'), '# provider contract')
    const requests: import('../src/types.js').ProviderRequest[] = []
    const provider = {
      id: 'fixture-provider',
      model: 'fixture-model',
      capabilities: new MockProvider().capabilities,
      complete: async (request: import('../src/types.js').ProviderRequest) => {
        requests.push(request)
        return requests.length === 1
          ? { kind: 'tool_call' as const, name: 'workspace.inspect', arguments: { path: 'README.md' }, provider: 'fixture-provider', model: 'fixture-model' }
          : { kind: 'final' as const, content: 'provider inspect complete', provider: 'fixture-provider', model: 'fixture-model' }
      },
    }
    const runtime = createWorkspaceInspectionRuntime({ store: new InMemoryEventStore(), provider, workspaceId: 'workspace-provider', root })
    const task = await runtime.createTask({ goal: 'inspect README.md', workspaceId: 'workspace-provider' })
    const session = await runtime.createSession({ taskId: task.id })
    const run = await runtime.startRun({ taskId: task.id, sessionId: session.id })
    const result = await runtime.run(run.id)
    assert.equal(result.state, 'completed')
    assert.equal(requests.length, 2)
    assert.equal(requests[0]?.tools?.[0]?.name, 'workspace.inspect')
    assert.equal(requests[0]?.contextEnvelope?.version, 'v1')
    assert.equal(requests[1]?.toolResults?.length, 1)
    assert.equal(requests[1]?.toolResults?.[0]?.name, 'workspace.inspect')
    assert.equal(requests[1]?.messages?.filter((message) => message.role === 'tool').length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('unregistered tools are rejected before the executor and default policy still denies', async () => {
  const root = await mkdtemp('/tmp/helm-inspect-')
  try {
    let executed = false
    const registry = new StaticToolRegistry([workspaceInspectProfile])
    const runtime = new RuntimeFacade({
      store: new InMemoryEventStore(),
      provider: new MockProvider([{ kind: 'tool_call', name: 'shell.exec', arguments: { command: 'echo unsafe' } }]),
      toolRegistry: registry,
      executor: async () => { executed = true; return { ok: true } },
    })
    const task = await runtime.createTask({ goal: 'reject unknown tool', workspaceId: 'workspace-test' })
    const session = await runtime.createSession({ taskId: task.id })
    const createdRun = await runtime.startRun({ taskId: task.id, sessionId: session.id })
    const result = await runtime.run(createdRun.id)

    assert.equal(result.state, 'failed')
    assert.equal(executed, false)
    const events = await runtime.getEvents(result.id)
    const decision = events.find((event) => event.type === 'policy.decision')
    assert.equal(decision?.payload.decision, 'deny')
    assert.match(String(decision?.payload.reason), /not registered/i)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a registered inspection tool remains default-deny until an explicit policy allows it', async () => {
  const root = await mkdtemp('/tmp/helm-inspect-')
  try {
    let executed = false
    const registry = new StaticToolRegistry([workspaceInspectProfile])
    const runtime = new RuntimeFacade({
      store: new InMemoryEventStore(),
      provider: new MockProvider([{ kind: 'tool_call', name: 'workspace.inspect', arguments: { path: '.' } }]),
      toolRegistry: registry,
      executor: async () => { executed = true; return { ok: true } },
    })
    const task = await runtime.createTask({ goal: 'default deny inspection', workspaceId: 'workspace-test' })
    const session = await runtime.createSession({ taskId: task.id })
    const createdRun = await runtime.startRun({ taskId: task.id, sessionId: session.id })
    const result = await runtime.run(createdRun.id)

    assert.equal(result.state, 'failed')
    assert.equal(executed, false)
    assert.match(result.lastError ?? '', /No ToolPolicy is configured/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('workspace traversal and symlink escapes fail without mutating the workspace', async () => {
  const root = await mkdtemp('/tmp/helm-inspect-')
  const outside = await mkdtemp('/tmp/helm-inspect-outside-')
  try {
    const outsideFile = join(outside, 'secret.txt')
    await writeFile(outsideFile, 'private')
    await symlink(outsideFile, join(root, 'escape.txt'))

    const traversal = await createInspectionRuntime(root, [
      { kind: 'tool_call', name: 'workspace.inspect', arguments: { path: '../secret.txt' } },
    ])
    assert.equal(traversal.run.state, 'failed')
    assert.match(traversal.run.lastError ?? '', /workspace|path|outside/i)

    const symlinkEscape = await createInspectionRuntime(root, [
      { kind: 'tool_call', name: 'workspace.inspect', arguments: { path: 'escape.txt' } },
    ])
    assert.equal(symlinkEscape.run.state, 'failed')
    assert.match(symlinkEscape.run.lastError ?? '', /symlink|workspace|path|outside/i)
    assert.equal(await import('node:fs/promises').then(({ readFile }) => readFile(outsideFile, 'utf8')), 'private')

    const unsupportedArgument = await createInspectionRuntime(root, [
      { kind: 'tool_call', name: 'workspace.inspect', arguments: { path: '.', write: true } },
    ])
    assert.equal(unsupportedArgument.run.state, 'failed')
    assert.match(unsupportedArgument.run.lastError ?? '', /unsupported/i)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})
