import {
  buildEpisode,
  buildRunProjection,
  evaluateReleaseGate,
  InMemoryEventStore,
  isTerminalRunState,
  MockProvider,
  FileArtifactStore,
  redactRunJsonl,
  RuntimeFacade,
  reduceRunEvents,
  type ProviderResponse,
  type EventStore,
  PythonDocumentWorkerClient,
  type OfficeHealthSnapshot,
  unavailableOfficePreflight,
  createOfficeRuntime,
  type BrowserActionName,
} from '@helm/runtime'
import { openSqliteEventStore } from '@helm/runtime/sqlite-node'
import {
  createCodingRuntime,
  createDockerCodingSandboxFromEnv,
  createWorkspaceInspectionRuntime,
} from '@helm/runtime/tools'
import { createProviderFromEnv } from '@helm/providers'
import { readKeychainSecret } from './keychain.js'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function printHelp(): void {
  console.log(`Helm local harness\n\nUsage:\n  helm run <goal>       Run a local task through the shared Runtime\n  helm inspect [path]   Inspect workspace metadata through the Runtime\n  helm office health    Preflight Office/OCR dependencies and report versions\n  helm experience list  List Experience Candidates\n  helm experience review <candidate-id> <approve|reject|revalidate>  Review a Candidate with --evidence <uri>\n  helm control <id> <action>  Pause, resume, or cancel a persisted Run\n  helm approve <run-id> <approval-id>  Approve or deny the exact pending action\n  helm reconcile <run-id> [tool-call-id]  Inspect or record evidence-backed side-effect reconciliation\n  helm agent list <run-id>  List persisted child AgentRuns\n  helm agent create <run-id> <role> <goal>  Create a bounded child AgentRun\n  helm agent cancel|recover <run-id>  Cancel or recover child AgentRuns\n  helm connector list  List registered Connector Profiles\n  helm connector register <id> <version> <connector-id>  Register a bounded Profile\n  helm connector preview <run-id> <connector-id> <profile-id> <version> <action> <target>  Create a dry-run preview\n  helm connector write <run-id> <connector-id> <profile-id> <version> <action> <target>  Request an idempotent connector write\n  helm connector verify <run-id> <action-id> <target>  Query read-after-write evidence\n  helm browser list [run-id]  List controlled browser contexts\n  helm browser create <run-id> <app-id> <window-id>  Create a scoped fixture context\n  helm browser navigate|approve <context-id> <url>  Navigate through the ActionGateway\n  helm browser assert <context-id>  Assert fixture DOM evidence\n  helm browser close|reconnect|cleanup <context-id>  Control context lifecycle\n  helm browser profile-list|profile-register  Manage versioned browser action profiles\n  helm browser action|action-approve <context-id> <profile-id> <version> <action> <locator>  Execute or approve an action\n  helm browser verify <context-id> <action-id> --expected-hash <sha256>  Verify an action postcondition\n  helm a2a list [run-id]  List persisted loopback remote-agent deliveries\n  helm a2a retry <message-id>  Retry a queued/unknown/failed delivery with the same idempotency key\n  helm a2a reconcile <message-id> <known|failed|unknown> [reason]  Record evidence-backed local A2A reconciliation\n  helm export <run-id>  Explicitly export a redacted Episode and evidence projection\n\nSet HELM_OUTPUT=jsonl (or pass --jsonl) for ordered redacted Run events.\nSet HELM_TASK_KIND=office and HELM_WORKSPACE_ROOT to reconnect Office approvals.\n\nDefault provider: MockProvider. Set HELM_PROVIDER=kimi to use the Kimi Code\nKeychain entry without putting the API key in the shell or repository.`)
}

async function printRun(runtime: RuntimeFacade, goal: string, workspaceId: string, jsonl = false, officePreflight?: OfficeHealthSnapshot): Promise<void> {
  const task = await runtime.createTask({ goal, workspaceId })
  const session = await runtime.createSession({ taskId: task.id })
  const createdRun = await runtime.startRun({ taskId: task.id, sessionId: session.id })
  const result = await runtime.run(createdRun.id)
  const events = await runtime.getEvents(createdRun.id)
  const projection = buildRunProjection(events, result)

  const summary = {
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
    officePreflight,
    artifacts: projection.artifacts,
    eventCount: events.length,
  }
  if (jsonl) {
    for (const event of events) console.log(JSON.stringify(JSON.parse(redactRunJsonl([event]))))
    console.log(JSON.stringify({ type: 'run.summary', runId: result.id, projection: summary.projection, officePreflight: summary.officePreflight }))
    return
  }
  console.log(JSON.stringify(summary, null, 2))
}

async function officeHealth(): Promise<void> {
  const root = process.env.HELM_WORKSPACE_ROOT ?? process.cwd();
  const scriptPath = process.env.HELM_DOCUMENT_WORKER ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../../workers/document-worker/worker.py');
  const worker = new PythonDocumentWorkerClient({ scriptPath, workspaceRoot: root });
  console.log(JSON.stringify(await worker.health().catch(() => unavailableOfficePreflight()), null, 2));
}

async function experienceCommand(action: 'list' | 'review', args: string[]): Promise<void> {
  const statePath = process.env.HELM_STATE_DB
  if (!statePath) {
    console.error('helm experience requires HELM_STATE_DB to point at the Runtime SQLite ledger')
    process.exitCode = 2
    return
  }
  const database = openSqliteEventStore(statePath)
  const runtime = await createPersistedRuntime(database.store, process.env.HELM_WORKSPACE_ID ?? 'workspace-cli')
  try {
    if (action === 'list') {
      console.log(JSON.stringify(await runtime.listExperienceCandidates(), null, 2))
      return
    }
    const candidateId = args[0]?.trim()
    const reviewAction = args[1] as 'approve' | 'reject' | 'revalidate' | undefined
    if (!candidateId || !reviewAction || !['approve', 'reject', 'revalidate'].includes(reviewAction)) {
      throw new Error('helm experience review requires a candidate id and approve, reject, or revalidate')
    }
    const evidenceIndex = args.indexOf('--evidence')
    const evidence = evidenceIndex >= 0 ? (args[evidenceIndex + 1] ?? '').split(',').map((item) => item.trim()).filter(Boolean) : undefined
    const riskIndex = args.indexOf('--risk')
    const riskValue = riskIndex >= 0 ? args[riskIndex + 1] : undefined
    const risk = riskValue && ['low', 'medium', 'high', 'unknown'].includes(riskValue) ? riskValue as 'low' | 'medium' | 'high' | 'unknown' : undefined
    const reviewerIndex = args.indexOf('--reviewer')
    const reviewerId = reviewerIndex >= 0 ? args[reviewerIndex + 1]?.trim() : undefined
    const validation = reviewAction === 'approve' ? 'validated' : reviewAction === 'reject' ? 'rejected' : 'unvalidated'
    const approval = reviewAction === 'approve' ? 'approved' : reviewAction === 'reject' ? 'rejected' : 'pending'
    console.log(JSON.stringify(await runtime.reviewExperienceCandidateById(candidateId, {
      action: reviewAction,
      validation,
      approval,
      risk,
      validationEvidence: evidence,
      reviewerId,
      reviewedAt: new Date().toISOString(),
    }), null, 2))
  } finally {
    await runtime.shutdown('CLI Experience Candidate command completed')
    await database.store.close()
  }
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
    const episode = await buildEpisode(database.store, runId)
    console.log(JSON.stringify({ runId, jsonl, episode, releaseGate: evaluateReleaseGate([episode]), projection, artifacts: projection.artifacts }, null, 2))
  } finally {
    await database.store.close()
  }
}

async function approvalRun(runId: string, approvalId: string, decision: 'approve' | 'deny', workspaceId: string): Promise<void> {
  const statePath = process.env.HELM_STATE_DB
  if (!statePath) {
    console.error('helm approve requires HELM_STATE_DB to point at the Runtime SQLite ledger')
    process.exitCode = 2
    return
  }
  const database = openSqliteEventStore(statePath)
  const runtime = await createPersistedRuntime(database.store, workspaceId)
  try {
    const result = await runtime.resolveApproval(runId, approvalId, decision, workspaceId)
    const events = await runtime.getEvents(runId)
    console.log(JSON.stringify({ runId, run: result, projection: buildRunProjection(events, result) }, null, 2))
  } finally {
    await runtime.shutdown('CLI approval completed')
    await database.store.close()
  }
}

async function createPersistedRuntime(store: EventStore, workspaceId: string): Promise<RuntimeFacade> {
  const root = process.env.HELM_WORKSPACE_ROOT ?? process.cwd()
  const taskKind = process.env.HELM_TASK_KIND?.toLowerCase()
  if (taskKind === 'office') {
    const scriptPath = process.env.HELM_DOCUMENT_WORKER ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../../workers/document-worker/worker.py')
    return createOfficeRuntime({
      store,
      provider: new MockProvider(),
      worker: new PythonDocumentWorkerClient({ scriptPath, workspaceRoot: root }),
      workspaceId,
      root,
      ownerId: process.env.HELM_RUNTIME_OWNER ?? `cli-${process.pid}`,
      artifactStore: createCliArtifactStore(),
    })
  }
  if (taskKind === 'coding') {
    return createCodingRuntime({
      store,
      provider: new MockProvider(),
      workspaceId,
      root,
      sandbox: createDockerCodingSandboxFromEnv(process.env, root),
      ownerId: process.env.HELM_RUNTIME_OWNER ?? `cli-${process.pid}`,
      artifactStore: createCliArtifactStore(),
    })
  }
  return createWorkspaceInspectionRuntime({
    store,
    provider: new MockProvider(),
    workspaceId,
    root,
    ownerId: process.env.HELM_RUNTIME_OWNER ?? `cli-${process.pid}`,
  })
}

function createCliArtifactStore(): FileArtifactStore | undefined {
  const statePath = process.env.HELM_STATE_DB
  const root = process.env.HELM_ARTIFACT_ROOT ?? (statePath ? `${statePath}.artifacts` : undefined)
  return root ? new FileArtifactStore(root) : undefined
}

async function controlRun(runId: string, action: 'pause' | 'resume' | 'cancel', reason?: string): Promise<void> {
  const statePath = process.env.HELM_STATE_DB
  if (!statePath) {
    console.error('helm control requires HELM_STATE_DB to point at the Runtime SQLite ledger')
    process.exitCode = 2
    return
  }
  const database = openSqliteEventStore(statePath)
  const runtime = await createPersistedRuntime(database.store, process.env.HELM_WORKSPACE_ID ?? 'workspace-cli')
  try {
    const current = await runtime.getRun(runId)
    if (!current) throw new Error(`Unknown run: ${runId}`)
    let result = current
    if (action === 'pause' && current.state !== 'paused' && !isTerminalRunState(current.state)) result = await runtime.pauseRun(runId, reason ?? 'paused by CLI')
    if (action === 'resume' && current.state === 'paused') {
      result = await runtime.resumeRun(runId)
      result = await runtime.run(runId)
    }
    if (action === 'cancel' && !isTerminalRunState(current.state)) result = await runtime.cancelRun(runId, reason ?? 'cancelled by CLI')
    const events = await runtime.getEvents(runId)
    const projection = buildRunProjection(events, result)
    console.log(JSON.stringify({ runId, run: result, projection, artifacts: projection.artifacts, eventCount: events.length }, null, 2))
  } finally {
    await runtime.shutdown('CLI control completed')
    await database.store.close()
  }
}

async function reconcileRun(runId: string, options: { toolCallId?: string; actionId?: string; outcome?: 'known' | 'failed' | 'unknown'; summary?: string; uri?: string; hash?: string }): Promise<void> {
  const statePath = process.env.HELM_STATE_DB
  if (!statePath) {
    console.error('helm reconcile requires HELM_STATE_DB to point at the Runtime SQLite ledger')
    process.exitCode = 2
    return
  }
  const database = openSqliteEventStore(statePath)
  const runtime = await createPersistedRuntime(database.store, process.env.HELM_WORKSPACE_ID ?? 'workspace-cli')
  try {
    if (!options.outcome) {
      const [run, budgetUsage, candidates] = await Promise.all([
        runtime.getRun(runId),
        runtime.getBudgetUsage(runId),
        runtime.listReconciliationCandidates(runId),
      ])
      if (!run) throw new Error(`Unknown run: ${runId}`)
      console.log(JSON.stringify({ runId, run, budgetUsage, candidates }, null, 2))
      return
    }
    const evidence = options.summary
      ? [{ type: 'runtime.reconciliation', summary: options.summary, ...(options.uri ? { uri: options.uri } : {}), ...(options.hash ? { hash: options.hash } : {}) }]
      : undefined
    const record = await runtime.recordReconciliation({ runId, toolCallId: options.toolCallId, actionId: options.actionId, outcome: options.outcome, evidence, reason: options.summary })
    console.log(JSON.stringify({ runId, reconciliation: record, budgetUsage: await runtime.getBudgetUsage(runId), candidates: await runtime.listReconciliationCandidates(runId) }, null, 2))
  } finally {
    await runtime.shutdown('CLI reconciliation completed')
    await database.store.close()
  }
}

async function agentCommand(action: 'list' | 'create' | 'cancel' | 'recover', args: string[]): Promise<void> {
  const statePath = process.env.HELM_STATE_DB
  if (!statePath) {
    console.error('helm agent requires HELM_STATE_DB to point at the Runtime SQLite ledger')
    process.exitCode = 2
    return
  }
  const database = openSqliteEventStore(statePath)
  const runtime = await createPersistedRuntime(database.store, process.env.HELM_WORKSPACE_ID ?? 'workspace-cli')
  try {
    const parentRunId = args[0]?.trim()
    if (!parentRunId) throw new Error('helm agent requires a parent run id')
    if (action === 'list') {
      console.log(JSON.stringify({ parentRunId, agents: await runtime.listAgentRuns(parentRunId), aggregate: await runtime.aggregateAgentResults(parentRunId) }, null, 2))
      return
    }
    if (action === 'cancel') {
      console.log(JSON.stringify({ parentRunId, agents: await runtime.cancelAgentTree(parentRunId, args.slice(1).join(' ').trim() || undefined) }, null, 2))
      return
    }
    if (action === 'recover') {
      console.log(JSON.stringify({ parentRunId, agents: await runtime.recoverAgentRuns(parentRunId), budgetUsage: await runtime.getAgentBudgetUsage(parentRunId) }, null, 2))
      return
    }
    const role = args[1]?.trim()
    const goal = args[2]?.trim()
    const capabilitiesIndex = args.indexOf('--capabilities')
    const capabilities = capabilitiesIndex >= 0 ? (args[capabilitiesIndex + 1] ?? '').split(',').map((item) => item.trim()).filter(Boolean) : []
    const scopeIndex = args.indexOf('--scope-json')
    let scope: Record<string, unknown> = {}
    if (scopeIndex >= 0 && args[scopeIndex + 1]) scope = JSON.parse(args[scopeIndex + 1]) as Record<string, unknown>
    if (!role || !goal || capabilities.length === 0) throw new Error('agent create requires role, goal, and --capabilities')
    const created = await runtime.createAgentChild({ parentRunId, role, principal: process.env.HELM_PRINCIPAL ?? 'local-user', goal, capabilities, scope, allowedCapabilities: capabilities, allowedScope: scope })
    console.log(JSON.stringify(created, null, 2))
  } finally {
    await runtime.shutdown('CLI Agent command completed')
    await database.store.close()
  }
}

async function connectorCommand(action: 'list' | 'register' | 'preview' | 'write' | 'verify', args: string[]): Promise<void> {
  const statePath = process.env.HELM_STATE_DB
  if (!statePath) {
    console.error('helm connector requires HELM_STATE_DB to point at the Runtime SQLite ledger')
    process.exitCode = 2
    return
  }
  const database = openSqliteEventStore(statePath)
  const runtime = await createPersistedRuntime(database.store, process.env.HELM_WORKSPACE_ID ?? 'workspace-cli')
  try {
    if (action === 'list') {
      console.log(JSON.stringify(runtime.listConnectorProfiles(), null, 2))
      return
    }
    if (action === 'register') {
      const [id, version, connectorId] = args
      const actions = (args[args.indexOf('--actions') + 1] ?? '').split(',').map((item) => item.trim()).filter(Boolean)
      const targets = (args[args.indexOf('--targets') + 1] ?? '').split(',').map((item) => item.trim()).filter(Boolean)
      const fields = (args[args.indexOf('--fields') + 1] ?? '').split(',').map((item) => item.trim()).filter(Boolean)
      const scopeIndex = args.indexOf('--scope-json')
      const scope = scopeIndex >= 0 && args[scopeIndex + 1] ? JSON.parse(args[scopeIndex + 1]) as Record<string, unknown> : {}
      if (!id || !version || !connectorId || !actions.length || !targets.length) throw new Error('connector register requires id, version, connector-id, --actions, and --targets')
      console.log(JSON.stringify(await runtime.registerConnectorProfile({ id, version, connectorId, actions, allowedTargets: targets, allowedFields: fields, scope }), null, 2))
      return
    }
    if (action === 'verify') {
      const [runId, actionId, target] = args
      const run = runId ? await runtime.getRun(runId) : undefined
      const expectedHashIndex = args.indexOf('--expected-hash')
      const expectedVersionIndex = args.indexOf('--expected-version')
      const postconditionIndex = args.indexOf('--postcondition')
      const expectedAfterHash = expectedHashIndex >= 0 ? args[expectedHashIndex + 1]?.trim() : undefined
      if (!run || !actionId || !target || !expectedAfterHash || !/^[a-f0-9]{64}$/i.test(expectedAfterHash)) throw new Error('connector verify requires run id, action id, target, and --expected-hash with a SHA-256 hash')
      console.log(JSON.stringify(await runtime.verifyConnectorWrite({ runId, taskId: run.taskId, sessionId: run.sessionId, actionId, target, expectedAfterHash, expectedVersion: expectedVersionIndex >= 0 ? args[expectedVersionIndex + 1]?.trim() : undefined, postcondition: postconditionIndex >= 0 ? args[postconditionIndex + 1] : undefined }), null, 2))
      return
    }
    const [runId, connectorId, profileId, profileVersion, actionName, target] = args
    const run = runId ? await runtime.getRun(runId) : undefined
    const scopeIndex = args.indexOf('--scope-json')
    const afterIndex = args.indexOf('--after-json')
    const scope = scopeIndex >= 0 && args[scopeIndex + 1] ? JSON.parse(args[scopeIndex + 1]) as Record<string, unknown> : {}
    const after = afterIndex >= 0 && args[afterIndex + 1] ? JSON.parse(args[afterIndex + 1]) : {}
    if (!run || !connectorId || !profileId || !profileVersion || !actionName || !target) throw new Error(`connector ${action} requires run id, connector, profile, action, and target`)
    if (action === 'write') {
      const expectedVersionIndex = args.indexOf('--expected-version')
      const idempotencyIndex = args.indexOf('--idempotency-key')
      const actionIdIndex = args.indexOf('--action-id')
      const remoteRequestIndex = args.indexOf('--remote-request-id')
      const postconditionIndex = args.indexOf('--postcondition')
      const artifactRefIndex = args.indexOf('--artifact-ref')
      const traceRefIndex = args.indexOf('--trace-ref')
      const idempotencyKey = idempotencyIndex >= 0 ? args[idempotencyIndex + 1]?.trim() : undefined
      if (!idempotencyKey) throw new Error('connector write requires --idempotency-key')
      console.log(JSON.stringify(await runtime.writeConnector({ runId, taskId: run.taskId, sessionId: run.sessionId, connectorId, profileId, profileVersion, action: actionName, target, scope, after, expectedVersion: expectedVersionIndex >= 0 ? args[expectedVersionIndex + 1]?.trim() : undefined, actionId: actionIdIndex >= 0 ? args[actionIdIndex + 1]?.trim() : undefined, remoteRequestId: remoteRequestIndex >= 0 ? args[remoteRequestIndex + 1]?.trim() : undefined, postcondition: postconditionIndex >= 0 ? args[postconditionIndex + 1] : undefined, artifactRef: artifactRefIndex >= 0 ? args[artifactRefIndex + 1]?.trim() : undefined, traceRef: traceRefIndex >= 0 ? args[traceRefIndex + 1]?.trim() : undefined, idempotencyKey }), null, 2))
      return
    }
    console.log(JSON.stringify(await runtime.previewConnector({ runId, taskId: run.taskId, sessionId: run.sessionId, connectorId, profileId, profileVersion, action: actionName, target, scope, before: {}, after, impact: ['preview'], rollbackPlan: 'No write was performed.', reconciliationPlan: 'Read target state before any future write.' }), null, 2))
  } finally {
    await runtime.shutdown('CLI Connector command completed')
    await database.store.close()
  }
}

async function browserCommand(action: 'list' | 'create' | 'navigate' | 'approve' | 'assert' | 'close' | 'reconnect' | 'cleanup' | 'profile-list' | 'profile-register' | 'action' | 'action-approve' | 'verify', args: string[]): Promise<void> {
  const statePath = process.env.HELM_STATE_DB
  if (!statePath) {
    console.error('helm browser requires HELM_STATE_DB to point at the Runtime SQLite ledger')
    process.exitCode = 2
    return
  }
  const database = openSqliteEventStore(statePath)
  const runtime = await createPersistedRuntime(database.store, process.env.HELM_WORKSPACE_ID ?? 'workspace-cli')
  try {
    if (action === 'list') {
      console.log(JSON.stringify(runtime.listBrowserContexts(args[0]?.trim() || undefined), null, 2))
      return
    }
    if (action === 'profile-list') {
      console.log(JSON.stringify(runtime.listBrowserActionProfiles(), null, 2))
      return
    }
    if (action === 'profile-register') {
      const [id, version] = args
      const actions = (args[args.indexOf('--actions') + 1] ?? '').split(',').map((item) => item.trim()).filter(Boolean)
      const locators = (args[args.indexOf('--locators') + 1] ?? '').split(',').map((item) => item.trim()).filter(Boolean)
      const highRisk = (args[args.indexOf('--high-risk') + 1] ?? '').split(',').map((item) => item.trim()).filter(Boolean)
      const artifacts = (args[args.indexOf('--artifacts') + 1] ?? '').split(',').map((item) => item.trim()).filter(Boolean)
      if (!id || !version || !actions.length || !locators.length) throw new Error('browser profile-register requires id, version, --actions, and --locators')
      console.log(JSON.stringify(await runtime.registerBrowserActionProfile({ id, version, actions: actions as BrowserActionName[], allowedLocators: locators, highRiskActions: highRisk as BrowserActionName[], allowedArtifactUris: artifacts }), null, 2))
      return
    }
    if (action === 'verify') {
      const [contextId, actionId] = args
      const hashIndex = args.indexOf('--expected-hash')
      const expectedDomAfterHash = hashIndex >= 0 ? args[hashIndex + 1]?.trim() : undefined
      if (!contextId || !actionId || !expectedDomAfterHash || !/^[a-f0-9]{64}$/i.test(expectedDomAfterHash)) throw new Error('browser verify requires context id, action id, and --expected-hash sha256')
      console.log(JSON.stringify(await runtime.verifyBrowserAction({ contextId, actionId, expectedDomAfterHash }), null, 2))
      return
    }
    if (action === 'create') {
      const [runId, appId, windowId] = args
      const run = runId ? await runtime.getRun(runId) : undefined
      const profileIndex = args.indexOf('--profile-json')
      const profile = profileIndex >= 0 && args[profileIndex + 1] ? JSON.parse(args[profileIndex + 1]) : { id: 'browser.fixture', version: 'v1', allowedOrigins: ['https://fixture.example.test'], allowedApps: [appId], allowedWindows: [windowId] }
      if (!run || !appId || !windowId) throw new Error('browser create requires run id, app id, and window id')
      console.log(JSON.stringify(await runtime.createBrowserContext({ runId, taskId: run.taskId, sessionId: run.sessionId, profile, appId, windowId }), null, 2))
      return
    }
    const contextId = args[0]?.trim()
    if (!contextId) throw new Error(`browser ${action} requires a context id`)
    if (action === 'action' || action === 'action-approve') {
      const [contextId, profileId, profileVersion, actionName, locator] = args
      const valueIndex = args.indexOf('--value')
      const artifactIndex = args.indexOf('--artifact-uri')
      const keyIndex = args.indexOf('--idempotency-key')
      if (!contextId || !profileId || !profileVersion || !actionName || !locator) throw new Error('browser action requires context, profile, version, action, and locator')
      const request = { contextId, profileId, profileVersion, action: actionName as BrowserActionName, locator, value: valueIndex >= 0 ? args[valueIndex + 1] : undefined, artifactUri: artifactIndex >= 0 ? args[artifactIndex + 1] : undefined, idempotencyKey: keyIndex >= 0 ? args[keyIndex + 1] ?? `action:${contextId}:${actionName}:${locator}` : `action:${contextId}:${actionName}:${locator}` }
      console.log(JSON.stringify(action === 'action' ? await runtime.executeBrowserAction(request) : await runtime.approveBrowserAction(request), null, 2))
      return
    }
    if (action === 'navigate' || action === 'approve') {
      const url = args[1]?.trim()
      const keyIndex = args.indexOf('--idempotency-key')
      const idempotencyKey = keyIndex >= 0 ? args[keyIndex + 1]?.trim() : `${action}:${contextId}:${url}`
      if (!url || !idempotencyKey) throw new Error(`browser ${action} requires a URL and idempotency key`)
      const result = action === 'navigate' ? await runtime.navigateBrowser({ contextId, url, idempotencyKey }) : await runtime.approveBrowserNavigation({ contextId, url, idempotencyKey })
      console.log(JSON.stringify(result, null, 2))
      return
    }
    if (action === 'assert') {
      const textIndex = args.indexOf('--text')
      const selectorIndex = args.indexOf('--selector')
      const keyIndex = args.indexOf('--idempotency-key')
      console.log(JSON.stringify(await runtime.assertBrowserDom({ contextId, expectedText: textIndex >= 0 ? args[textIndex + 1] : undefined, expectedSelector: selectorIndex >= 0 ? args[selectorIndex + 1] : undefined, idempotencyKey: keyIndex >= 0 ? args[keyIndex + 1] ?? `assert:${contextId}` : `assert:${contextId}` }), null, 2))
      return
    }
    console.log(JSON.stringify(action === 'close' ? await runtime.closeBrowserContext(contextId) : action === 'reconnect' ? await runtime.reconnectBrowserContext(contextId) : await runtime.cleanupBrowserContext(contextId), null, 2))
  } finally {
    await runtime.shutdown('CLI Browser command completed')
    await database.store.close()
  }
}

async function a2aCommand(action: 'list' | 'retry' | 'reconcile', args: string[]): Promise<void> {
  const statePath = process.env.HELM_STATE_DB
  if (!statePath) { console.error('helm a2a requires HELM_STATE_DB to point at the Runtime SQLite ledger'); process.exitCode = 2; return }
  const database = openSqliteEventStore(statePath)
  const runtime = await createPersistedRuntime(database.store, process.env.HELM_WORKSPACE_ID ?? 'workspace-cli')
  try {
    if (action === 'list') console.log(JSON.stringify(await runtime.listA2ADeliveries(args[0]?.trim() || undefined), null, 2))
    if (action === 'retry') {
      if (!args[0]) throw new Error('helm a2a retry requires a message id')
      console.log(JSON.stringify(await runtime.retryA2A(args[0]), null, 2))
    }
    if (action === 'reconcile') {
      const messageId = args[0]?.trim()
      const outcome = args[1] as 'known' | 'failed' | 'unknown' | undefined
      if (!messageId || !outcome || !['known', 'failed', 'unknown'].includes(outcome)) throw new Error('helm a2a reconcile requires a message id and known, failed, or unknown')
      const reason = args.slice(2).join(' ').trim() || undefined
      const evidence = reason ? [{ type: 'cli.a2a.reconciliation', summary: reason }] : []
      console.log(JSON.stringify(await runtime.reconcileA2A(messageId, outcome, evidence, reason), null, 2))
    }
  } finally {
    await runtime.shutdown('CLI A2A command completed')
    await database.store.close()
  }
}

async function run(goal: string): Promise<void> {
  const provider = createProviderFromEnv({ env: process.env, getApiKey: (service) => readKeychainSecret(service) })
    ?? new MockProvider([{ kind: 'final', content: `Completed local task: ${goal}` } satisfies ProviderResponse])
  const workspaceId = process.env.HELM_WORKSPACE_ID ?? 'workspace-cli'
  const workspaceRoot = process.env.HELM_WORKSPACE_ROOT ?? process.cwd()
  const database = process.env.HELM_STATE_DB ? openSqliteEventStore(process.env.HELM_STATE_DB) : undefined
  const store = database?.store ?? new InMemoryEventStore()
  const artifactStore = createCliArtifactStore()
  const taskKind = process.env.HELM_TASK_KIND?.toLowerCase()
  const officeWorker = taskKind === 'office'
    ? new PythonDocumentWorkerClient({
        scriptPath: process.env.HELM_DOCUMENT_WORKER ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../../workers/document-worker/worker.py'),
        workspaceRoot,
      })
    : undefined
  const officePreflight = officeWorker ? await officeWorker.health().catch(() => unavailableOfficePreflight()) : undefined
  const runtime = taskKind === 'office'
    ? createOfficeRuntime({
        store,
        provider,
        worker: officeWorker!,
        workspaceId,
        root: workspaceRoot,
        preflight: officePreflight,
        ownerId: process.env.HELM_RUNTIME_OWNER ?? `cli-${process.pid}`,
        artifactStore,
      })
    : taskKind === 'coding'
      ? createCodingRuntime({
          store,
          provider,
          workspaceId,
          root: workspaceRoot,
          sandbox: createDockerCodingSandboxFromEnv(process.env, workspaceRoot),
          ownerId: process.env.HELM_RUNTIME_OWNER ?? `cli-${process.pid}`,
          artifactStore,
        })
    : createWorkspaceInspectionRuntime({
        store,
        provider,
        workspaceId,
        root: workspaceRoot,
        ownerId: process.env.HELM_RUNTIME_OWNER ?? `cli-${process.pid}`,
        artifactStore,
      })
  try {
    await printRun(runtime, goal, workspaceId, outputJsonl, officePreflight)
  } finally {
    await runtime.shutdown('CLI process completed')
    await store.close?.()
  }
}

async function inspect(path = '.'): Promise<void> {
  const workspaceId = process.env.HELM_WORKSPACE_ID ?? 'workspace-cli'
  const workspaceRoot = process.env.HELM_WORKSPACE_ROOT ?? process.cwd()
  const database = process.env.HELM_STATE_DB ? openSqliteEventStore(process.env.HELM_STATE_DB) : undefined
  const store = database?.store ?? new InMemoryEventStore()
  const runtime = createWorkspaceInspectionRuntime({
    store,
    provider: new MockProvider(),
    workspaceId,
    root: workspaceRoot,
    ownerId: process.env.HELM_RUNTIME_OWNER ?? `cli-${process.pid}`,
    artifactStore: createCliArtifactStore(),
  })
  try {
    await printRun(runtime, `inspect ${path}`, workspaceId, outputJsonl)
  } finally {
    await runtime.shutdown('CLI process completed')
    await store.close?.()
  }
}

const rawArgs = process.argv.slice(2).filter((argument) => argument !== '--')
const jsonl = rawArgs.includes('--jsonl')
const [command, ...args] = rawArgs.filter((argument) => argument !== '--jsonl')
const outputJsonl = jsonl || process.env.HELM_OUTPUT === 'jsonl'
if (command === 'run') {
  const goal = args.join(' ').trim()
  if (!goal) {
    console.error('helm run requires a goal')
    process.exitCode = 2
  } else {
    await run(goal)
  }
} else if (command === 'inspect') {
  if (args.length > 1) {
    console.error('helm inspect accepts at most one workspace-relative path')
    process.exitCode = 2
  } else {
    await inspect(args[0]?.trim() || '.')
  }
} else if (command === 'office') {
  if (args[0] !== 'health') {
    console.error('helm office requires health')
    process.exitCode = 2
  } else {
    await officeHealth()
  }
} else if (command === 'experience') {
  if (args[0] !== 'list' && args[0] !== 'review') {
    console.error('helm experience requires list or review')
    process.exitCode = 2
  } else {
    await experienceCommand(args[0], args.slice(1))
  }
} else if (command === 'export') {
  const runId = args.join(' ').trim()
  if (!runId) {
    console.error('helm export requires a run id')
    process.exitCode = 2
  } else {
    await exportRun(runId)
  }
} else if (command === 'control') {
  const runId = args[0]?.trim()
  const action = args[1]
  if (!runId || (action !== 'pause' && action !== 'resume' && action !== 'cancel')) {
    console.error('helm control requires a run id and one of pause, resume, cancel')
    process.exitCode = 2
  } else {
    await controlRun(runId, action, args.slice(2).join(' ').trim() || undefined)
  }
} else if (command === 'approve') {
  const runId = args[0]?.trim()
  const approvalId = args[1]?.trim()
  const deny = args.includes('--deny')
  const workspaceId = process.env.HELM_WORKSPACE_ID ?? 'workspace-cli'
  if (!runId || !approvalId) {
    console.error('helm approve requires a run id and approval id; pass --deny to reject')
    process.exitCode = 2
  } else {
    await approvalRun(runId, approvalId, deny ? 'deny' : 'approve', workspaceId)
  }
} else if (command === 'reconcile') {
  const runId = args[0]?.trim()
  const toolCallId = args[1]?.trim() || undefined
  const actionIdIndex = args.indexOf('--action-id')
  const actionId = actionIdIndex >= 0 ? args[actionIdIndex + 1]?.trim() : undefined
  const outcomeIndex = args.indexOf('--outcome')
  const rawOutcome = outcomeIndex >= 0 ? args[outcomeIndex + 1] : undefined
  const outcome = rawOutcome === 'known' || rawOutcome === 'failed' || rawOutcome === 'unknown' ? rawOutcome : undefined
  const summaryIndex = args.indexOf('--summary')
  const summary = summaryIndex >= 0 ? args[summaryIndex + 1]?.trim() : undefined
  const uriIndex = args.indexOf('--evidence-uri')
  const uri = uriIndex >= 0 ? args[uriIndex + 1]?.trim() : undefined
  const hashIndex = args.indexOf('--evidence-hash')
  const hash = hashIndex >= 0 ? args[hashIndex + 1]?.trim() : undefined
  if (!runId || (rawOutcome !== undefined && !outcome) || (outcome && (outcome === 'known' || outcome === 'failed') && !summary)) {
    console.error('helm reconcile requires a run id; recording known/failed outcomes also requires --summary')
    process.exitCode = 2
  } else {
    await reconcileRun(runId, { toolCallId, actionId, outcome, summary, uri, hash })
  }
} else if (command === 'agent') {
  const action = args[0] === 'create' ? 'create' : args[0] === 'list' ? 'list' : args[0] === 'cancel' ? 'cancel' : args[0] === 'recover' ? 'recover' : undefined
  if (!action) {
    console.error('helm agent requires list or create')
    process.exitCode = 2
  } else {
    await agentCommand(action, args.slice(1))
  }
} else if (command === 'connector') {
  const action = args[0] === 'list' ? 'list' : args[0] === 'register' ? 'register' : args[0] === 'preview' ? 'preview' : args[0] === 'write' ? 'write' : args[0] === 'verify' ? 'verify' : undefined
  if (!action) {
    console.error('helm connector requires list, register, preview, write, or verify')
    process.exitCode = 2
  } else {
    await connectorCommand(action, args.slice(1))
  }
} else if (command === 'browser') {
  const action = args[0] === 'list' ? 'list' : args[0] === 'create' ? 'create' : args[0] === 'navigate' ? 'navigate' : args[0] === 'approve' ? 'approve' : args[0] === 'assert' ? 'assert' : args[0] === 'close' ? 'close' : args[0] === 'reconnect' ? 'reconnect' : args[0] === 'cleanup' ? 'cleanup' : args[0] === 'profile-list' ? 'profile-list' : args[0] === 'profile-register' ? 'profile-register' : args[0] === 'action' ? 'action' : args[0] === 'action-approve' ? 'action-approve' : args[0] === 'verify' ? 'verify' : undefined
  if (!action) {
    console.error('helm browser requires list, create, navigate, approve, assert, close, reconnect, cleanup, profile-list, profile-register, action, action-approve, or verify')
    process.exitCode = 2
  } else {
    await browserCommand(action, args.slice(1))
  }
} else if (command === 'a2a') {
  const action = args[0] === 'list' || args[0] === 'retry' || args[0] === 'reconcile' ? args[0] : undefined
  if (!action) {
    console.error('helm a2a requires list, retry, or reconcile')
    process.exitCode = 2
  } else {
    await a2aCommand(action, args.slice(1))
  }
} else {
  printHelp()
  if (command && command !== 'help') process.exitCode = 2
}
