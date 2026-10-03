import {
  buildRunProjection,
  InMemoryEventStore,
  MockProvider,
  redactRunJsonl,
  RuntimeFacade,
  reduceRunEvents,
  type ProviderResponse,
} from '@helm/runtime'
import { openSqliteEventStore } from '@helm/runtime/sqlite-node'
import {
  createWorkspaceInspectionRuntime,
} from '@helm/runtime/tools'
import { OpenAICompatibleProvider } from '@helm/providers'
import { readKeychainSecret } from './keychain.js'

function printHelp(): void {
  console.log(`Helm local harness\n\nUsage:\n  helm run <goal>       Run a local task through the shared Runtime\n  helm inspect [path]   Inspect workspace metadata through the Runtime\n  helm export <run-id>  Export a redacted Run ledger and evidence projection\n  helm help             Show this help\n\nDefault provider: MockProvider. Set HELM_PROVIDER=kimi to use the Kimi Code\nKeychain entry without putting the API key in the shell or repository.`)
}

async function printRun(runtime: RuntimeFacade, goal: string, workspaceId: string): Promise<void> {
  const task = await runtime.createTask({ goal, workspaceId })
  const session = await runtime.createSession({ taskId: task.id })
  const createdRun = await runtime.startRun({ taskId: task.id, sessionId: session.id })
  const result = await runtime.run(createdRun.id)
  const events = await runtime.getEvents(createdRun.id)
  const projection = buildRunProjection(events, result)

  console.log(JSON.stringify({
    task: { id: task.id, goal: task.goal, workspaceId: task.workspaceId },
    session: { id: session.id },
    run: {
      id: result.id,
      state: result.state,
      steps: result.steps,
      lastError: result.lastError,
      verification: result.verification,
      finalOutput: result.finalOutput,
    },
    projection,
    artifacts: projection.artifacts,
    eventCount: events.length,
  }, null, 2))
}

async function exportRun(runId: string): Promise<void> {
  const statePath = process.env.HELM_STATE_DB
  if (!statePath) {
    console.error('helm export requires HELM_STATE_DB to point at the Runtime SQLite ledger')
    process.exitCode = 2
    return
  }
  const database = openSqliteEventStore(statePath)
  try {
    const events = await database.store.list(runId)
    if (!events.length) throw new Error(`Unknown run: ${runId}`)
    const run = reduceRunEvents(events, runId)
    const projection = buildRunProjection(events, run)
    const jsonl = database.store.exportJsonl ? await database.store.exportJsonl(runId) : redactRunJsonl(events)
    console.log(JSON.stringify({ runId, jsonl, projection, artifacts: projection.artifacts }, null, 2))
  } finally {
    await database.store.close()
  }
}

async function run(goal: string): Promise<void> {
  const useKimi = process.env.HELM_PROVIDER?.toLowerCase() === 'kimi'
  const provider = useKimi
    ? new OpenAICompatibleProvider({
        id: 'kimi',
        model: process.env.HELM_KIMI_MODEL ?? 'kimi-for-coding',
        baseUrl: process.env.HELM_KIMI_BASE_URL ?? 'https://api.kimi.com/coding/v1',
        getApiKey: () => readKeychainSecret(process.env.HELM_KIMI_KEYCHAIN_SERVICE ?? 'com.helm.provider.kimi-code'),
      })
    : new MockProvider([{ kind: 'final', content: `Completed local task: ${goal}` } satisfies ProviderResponse])
  const workspaceId = 'workspace-cli'
  const database = process.env.HELM_STATE_DB ? openSqliteEventStore(process.env.HELM_STATE_DB) : undefined
  const store = database?.store ?? new InMemoryEventStore()
  try {
    await printRun(createWorkspaceInspectionRuntime({
      store,
      provider,
      workspaceId,
      root: process.cwd(),
    }), goal, workspaceId)
  } finally {
    await store.close?.()
  }
}

async function inspect(path = '.'): Promise<void> {
  const workspaceId = 'workspace-cli'
  const workspaceRoot = process.cwd()
  const database = process.env.HELM_STATE_DB ? openSqliteEventStore(process.env.HELM_STATE_DB) : undefined
  const store = database?.store ?? new InMemoryEventStore()
  const runtime = createWorkspaceInspectionRuntime({
    store,
    provider: new MockProvider(),
    workspaceId,
    root: workspaceRoot,
  })
  try {
    await printRun(runtime, `inspect ${path}`, workspaceId)
  } finally {
    await store.close?.()
  }
}

const [command, ...args] = process.argv.slice(2).filter((argument) => argument !== '--')
if (command === 'run') {
  const goal = args.join(' ').trim()
  if (!goal) {
    console.error('helm run requires a goal')
    process.exitCode = 2
  } else {
    await run(goal)
  }
} else if (command === 'inspect') {
  await inspect(args.join(' ').trim() || '.')
} else if (command === 'export') {
  const runId = args.join(' ').trim()
  if (!runId) {
    console.error('helm export requires a run id')
    process.exitCode = 2
  } else {
    await exportRun(runId)
  }
} else {
  printHelp()
  if (command && command !== 'help') process.exitCode = 2
}
