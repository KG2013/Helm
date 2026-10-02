import {
  InMemoryEventStore,
  MockProvider,
  RuntimeFacade,
  type ProviderResponse,
} from '@helm/runtime'
import {
  createWorkspaceInspectionRuntime,
} from '@helm/runtime/tools'
import { OpenAICompatibleProvider } from '@helm/providers'
import { readKeychainSecret } from './keychain.js'

function printHelp(): void {
  console.log(`Helm local harness\n\nUsage:\n  helm run <goal>       Run a local task through the shared Runtime\n  helm inspect [path]   Inspect workspace metadata through the Runtime\n  helm help             Show this help\n\nDefault provider: MockProvider. Set HELM_PROVIDER=kimi to use the Kimi Code\nKeychain entry without putting the API key in the shell or repository.`)
}

async function printRun(runtime: RuntimeFacade, goal: string, workspaceId: string): Promise<void> {
  const task = await runtime.createTask({ goal, workspaceId })
  const session = await runtime.createSession({ taskId: task.id })
  const createdRun = await runtime.startRun({ taskId: task.id, sessionId: session.id })
  const result = await runtime.run(createdRun.id)
  const events = await runtime.getEvents(createdRun.id)

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
    eventCount: events.length,
  }, null, 2))
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
  await printRun(createWorkspaceInspectionRuntime({
    store: new InMemoryEventStore(),
    provider,
    workspaceId,
    root: process.cwd(),
  }), goal, workspaceId)
}

async function inspect(path = '.'): Promise<void> {
  const workspaceId = 'workspace-cli'
  const workspaceRoot = process.cwd()
  const runtime = createWorkspaceInspectionRuntime({
    store: new InMemoryEventStore(),
    provider: new MockProvider(),
    workspaceId,
    root: workspaceRoot,
  })
  await printRun(runtime, `inspect ${path}`, workspaceId)
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
} else {
  printHelp()
  if (command && command !== 'help') process.exitCode = 2
}
