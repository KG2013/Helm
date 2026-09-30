import {
  InMemoryEventStore,
  MockProvider,
  RuntimeFacade,
  type ProviderResponse,
} from '@helm/runtime'
import { OpenAICompatibleProvider } from '@helm/providers'
import { readKeychainSecret } from './keychain.js'

function printHelp(): void {
  console.log(`Helm local harness\n\nUsage:\n  helm run <goal>       Run a local task through the shared Runtime\n  helm help             Show this help\n\nDefault provider: MockProvider. Set HELM_PROVIDER=kimi to use the Kimi Code\nKeychain entry without putting the API key in the shell or repository.`)
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
  const runtime = new RuntimeFacade({
    store: new InMemoryEventStore(),
    provider,
  })
  const task = await runtime.createTask({ goal, workspaceId: process.cwd() })
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
      verification: result.verification,
      finalOutput: result.finalOutput,
    },
    eventCount: events.length,
  }, null, 2))
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
} else {
  printHelp()
  if (command && command !== 'help') process.exitCode = 2
}
