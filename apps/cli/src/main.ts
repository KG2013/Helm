import {
  InMemoryEventStore,
  MockProvider,
  RuntimeFacade,
  type ProviderResponse,
} from '@helm/runtime'

function printHelp(): void {
  console.log(`Helm local harness\n\nUsage:\n  helm run <goal>       Run a local demo task through the shared Runtime\n  helm help             Show this help\n\nThe P0 skeleton uses a Mock Provider. Provider adapters, Keychain lookup,\nand real tool execution will be connected in subsequent slices.`)
}

async function run(goal: string): Promise<void> {
  const responses: ProviderResponse[] = [
    { kind: 'final', content: `Completed local task: ${goal}` },
  ]
  const runtime = new RuntimeFacade({
    store: new InMemoryEventStore(),
    provider: new MockProvider(responses),
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
