import { buildEpisode, buildRunProjection, evaluateReleaseGate, redactRunJsonl, reduceRunEvents, type DomainEvent, type RuntimeFacade, type Session, type Task } from '@helm/runtime'
import {
  IPC_CHANNELS,
  isRunId,
  isRunControlRequest,
  isRunApprovalRequest,
  isRunExportRequest,
  isRunReconciliationRequest,
  isAgentListRequest,
  isAgentCreateRequest,
  isAgentControlRequest,
  isConnectorPreviewRequest,
  isConnectorRegisterRequest,
  isConnectorWriteRequest,
  isConnectorVerifyRequest,
  isBrowserContextListRequest,
  isBrowserContextCreateRequest,
  isBrowserNavigateRequest,
  isBrowserAssertRequest,
  isBrowserControlRequest,
  isBrowserActionProfileRequest,
  isBrowserActionRequest,
  isBrowserVerifyRequest,
  isA2AListRequest,
  isA2AControlRequest,
  isExperienceReviewRequest,
  isStartRunRequest,
  type RuntimeInfo,
  type RunSnapshot,
  type StartRunRequest,
  type RunControlRequest,
  type RunApprovalRequest,
  type RunExportRequest,
  type RunExportResponse,
  type RunReconciliationRequest,
  type RunReconciliationResponse,
  type AgentListRequest,
  type AgentCreateRequest,
  type AgentControlRequest,
  type ConnectorPreviewRequest,
  type ConnectorRegisterRequest,
  type ConnectorWriteRequest,
  type ConnectorVerifyRequest,
  type BrowserContextListRequest,
  type BrowserContextCreateRequest,
  type BrowserNavigateRequest,
  type BrowserAssertRequest,
  type BrowserControlRequest,
  type BrowserActionProfileRequest,
  type BrowserActionRequest,
  type BrowserVerifyRequest,
  type A2AListRequest,
  type A2AControlRequest,
  type ExperienceReviewRequest,
  type StartRunResponse,
} from '../shared/ipc.js'
import { DesktopWindowRegistry } from './window-registry.js'

export type RuntimeIpc = {
  handle(channel: string, handler: (event: unknown, request?: unknown) => unknown): void
}

export type RuntimeBridgeOptions = {
  ipc: RuntimeIpc
  runtime: RuntimeFacade
  runtimeInfo: RuntimeInfo
  emit: (event: DomainEvent) => void
  workspaceIds?: readonly string[]
  windowRegistry?: DesktopWindowRegistry
}

const SENSITIVE_KEYS = /api[-_]?key|authorization|cookie|secret|password|token|oldText|newText/i

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[truncated]'
  if (typeof value === 'string') return value.length > 4000 ? `${value.slice(0, 4000)}…` : value
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeValue(item, depth + 1))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [key, SENSITIVE_KEYS.test(key) ? '[redacted]' : sanitizeValue(item, depth + 1)]))
}

function sanitizeEvent(event: DomainEvent): DomainEvent {
  return { ...event, payload: sanitizeValue(event.payload) as Record<string, unknown> }
}

export function registerRuntimeIpcHandlers(options: RuntimeBridgeOptions): () => void {
  const { ipc, runtime } = options
  const senderOf = (event: unknown) => (event as { sender?: unknown } | undefined)?.sender as Parameters<DesktopWindowRegistry['authorizeRun']>[0] | undefined
  const authorizeRun = (event: unknown, runId: string) => {
    const sender = senderOf(event)
    if (options.windowRegistry && sender) options.windowRegistry.authorizeRun(sender, runId)
  }
  const assertRunAccess = (event: unknown, runId: string) => {
    const sender = senderOf(event)
    if (options.windowRegistry && (!sender || !options.windowRegistry.isAuthorized(sender, runId))) throw new Error('Run is not authorized for this window.')
  }
  const authorized = (event: unknown, runId: string) => {
    const sender = senderOf(event)
    return !options.windowRegistry || Boolean(sender && options.windowRegistry.isAuthorized(sender, runId))
  }
  const browserRunId = (contextId: string): string => {
    const context = runtime.listBrowserContexts().find((candidate) => candidate.contextId === contextId)
    if (!context) throw new Error('Unknown browser context.')
    return context.runId
  }
  const a2aRunId = async (messageId: string): Promise<string> => {
    const delivery = (await runtime.listA2ADeliveries()).find((candidate) => candidate.messageId === messageId)
    if (!delivery) throw new Error('Unknown A2A message.')
    return delivery.runId
  }
  const unsubscribe = runtime.onEvent((event) => {
    if (event.runId) options.emit(sanitizeEvent(event))
  })

  ipc.handle(IPC_CHANNELS.runtimeInfo, () => options.runtimeInfo)
  ipc.handle(IPC_CHANNELS.runStart, async (event, value) => {
    if (!isStartRunRequest(value)) throw new Error('Invalid run request: goal and workspaceId are required.')
    const request = value as StartRunRequest
    if (!(options.workspaceIds ?? ['workspace-helm']).includes(request.workspaceId)) throw new Error('Unknown workspace.')
    let task: Task
    let session: Session
    if (request.sessionId) {
      const existingSession = await runtime.loadSession(request.sessionId)
      if (!existingSession) throw new Error('Unknown session.')
      const existingTask = await runtime.loadTask(existingSession.taskId)
      if (!existingTask || existingTask.workspaceId !== request.workspaceId) throw new Error('Session workspace mismatch.')
      session = existingSession
      task = existingTask
    } else {
      task = await runtime.createTask({ goal: request.goal.trim(), workspaceId: request.workspaceId.trim() })
      session = await runtime.createSession({ taskId: task.id })
    }
    const run = await runtime.startRun({ taskId: task.id, sessionId: session.id })
    authorizeRun(event, run.id)
    void runtime.run(run.id).catch(() => undefined)
    const response: StartRunResponse = { task, session, run }
    return response
  })
  ipc.handle(IPC_CHANNELS.runControl, async (event, value) => {
    if (!isRunControlRequest(value)) throw new Error('Invalid Run control request.')
    const request = value as RunControlRequest
    assertRunAccess(event, request.runId)
    const current = await runtime.getRun(request.runId)
    if (!current) throw new Error('Unknown run.')
    if (request.action === 'cancel' && ['completed', 'failed', 'cancelled', 'needs_reconciliation'].includes(current.state)) return current
    if (request.action === 'pause' && (current.state === 'paused' || ['completed', 'failed', 'cancelled', 'needs_reconciliation'].includes(current.state))) return current
    if (request.action === 'resume' && current.state !== 'paused') return current
    if (request.action === 'pause') return runtime.pauseRun(request.runId, request.reason ?? 'paused by user')
    if (request.action === 'resume') {
      const resumed = await runtime.resumeRun(request.runId)
      void runtime.run(request.runId).catch(() => undefined)
      return resumed
    }
    return runtime.cancelRun(request.runId, request.reason ?? 'cancelled by user')
  })
  ipc.handle(IPC_CHANNELS.runApproval, async (event, value) => {
    if (!isRunApprovalRequest(value)) throw new Error('Invalid approval request.')
    const request = value as RunApprovalRequest
    assertRunAccess(event, request.runId)
    const task = await runtime.loadTask((await runtime.getRun(request.runId))?.taskId ?? '')
    if (!task || task.workspaceId !== request.workspaceId) throw new Error('Approval workspace mismatch.')
    return runtime.resolveApproval(request.runId, request.approvalId, request.decision, request.workspaceId)
  })
  ipc.handle(IPC_CHANNELS.runSnapshot, async (event, value) => {
    if (!isRunId(value)) throw new Error('Invalid run id.')
    const persisted = await runtime.getRun(value)
    if (!persisted) throw new Error('Unknown run.')
    const persistedTask = await runtime.loadTask(persisted.taskId)
    if (!persistedTask || !(options.workspaceIds ?? ['workspace-helm']).includes(persistedTask.workspaceId)) throw new Error('Run workspace is not authorized.')
    authorizeRun(event, value)
    await runtime.recoverRun(value)
    const events = await runtime.getEvents(value)
    if (!events.length) throw new Error('Unknown run.')
    const run = reduceRunEvents(events, value)
    const task = await runtime.loadTask(run.taskId)
    const session = await runtime.loadSession(run.sessionId)
    if (!task || !session) throw new Error('Run metadata unavailable.')
    const projection = buildRunProjection(events, run)
    const snapshot: RunSnapshot = {
      task,
      session,
      run,
      events: events.map(sanitizeEvent),
      projection: sanitizeValue(projection) as RunSnapshot['projection'],
    }
    return snapshot
  })
  ipc.handle(IPC_CHANNELS.runExport, async (event, value) => {
    if (!isRunExportRequest(value)) throw new Error('Invalid Run export request.')
    const request = value as RunExportRequest
    assertRunAccess(event, request.runId)
    const events = await runtime.getEvents(request.runId)
    if (!events.length) throw new Error('Unknown run.')
    const run = reduceRunEvents(events, request.runId)
    const projection = buildRunProjection(events, run)
    const episode = await buildEpisode({
      list: async (runId) => runtime.getEvents(runId),
      exportJsonl: async () => redactRunJsonl(events),
    }, request.runId)
    const response: RunExportResponse = {
      runId: request.runId,
      jsonl: redactRunJsonl(events),
      projection: sanitizeValue(projection) as RunExportResponse['projection'],
      episode: sanitizeValue(episode) as RunExportResponse['episode'],
      releaseGate: evaluateReleaseGate([episode]),
    }
    return response
  })
  ipc.handle(IPC_CHANNELS.runReconciliation, async (event, value) => {
    if (!isRunReconciliationRequest(value)) throw new Error('Invalid Run reconciliation request.')
    const request = value as RunReconciliationRequest
    assertRunAccess(event, request.runId)
    const run = await runtime.getRun(request.runId)
    if (!run) throw new Error('Unknown run.')
    let record
    if (request.action === 'record') {
      if ((request.outcome === 'known' || request.outcome === 'failed') && (!request.evidence || request.evidence.length === 0)) {
        throw new Error('Reconciliation requires evidence when resolving an unknown effect.')
      }
      record = await runtime.recordReconciliation({
        runId: request.runId,
        toolCallId: request.toolCallId,
        actionId: request.actionId,
        outcome: request.outcome!,
        evidence: request.evidence,
        reason: request.reason,
      })
    }
    const response: RunReconciliationResponse = {
      runId: request.runId,
      budgetUsage: await runtime.getBudgetUsage(request.runId),
      candidates: await runtime.listReconciliationCandidates(request.runId),
      record,
    }
    return sanitizeValue(response) as RunReconciliationResponse
  })
  ipc.handle(IPC_CHANNELS.agentList, async (event, value) => {
    if (!isAgentListRequest(value)) throw new Error('Invalid Agent list request.')
    const request = (value ?? {}) as AgentListRequest
    if (request.parentRunId) {
      assertRunAccess(event, request.parentRunId)
      return sanitizeValue(await runtime.listAgentRuns(request.parentRunId))
    }
    const records = await runtime.listAgentRuns()
    return sanitizeValue(records.filter((record) => authorized(event, record.parentRunId)))
  })
  ipc.handle(IPC_CHANNELS.agentCreate, async (event, value) => {
    if (!isAgentCreateRequest(value)) throw new Error('Invalid Agent create request.')
    const request = value as AgentCreateRequest
    assertRunAccess(event, request.parentRunId)
    return sanitizeValue(await runtime.createAgentChild(request))
  })
  ipc.handle(IPC_CHANNELS.agentControl, async (event, value) => {
    if (!isAgentControlRequest(value)) throw new Error('Invalid Agent control request.')
    const request = value as AgentControlRequest
    assertRunAccess(event, request.parentRunId)
    const result = request.action === 'cancel'
      ? await runtime.cancelAgentTree(request.parentRunId, request.reason)
      : await runtime.recoverAgentRuns(request.parentRunId)
    return sanitizeValue({ parentRunId: request.parentRunId, action: request.action, agents: result, budgetUsage: await runtime.getAgentBudgetUsage(request.parentRunId) })
  })
  ipc.handle(IPC_CHANNELS.connectorList, () => sanitizeValue(runtime.listConnectorProfiles()))
  ipc.handle(IPC_CHANNELS.connectorRegister, async (_event, value) => {
    if (!isConnectorRegisterRequest(value)) throw new Error('Invalid Connector profile.')
    return sanitizeValue(await runtime.registerConnectorProfile(value as ConnectorRegisterRequest))
  })
  ipc.handle(IPC_CHANNELS.connectorPreview, async (event, value) => {
    if (!isConnectorPreviewRequest(value)) throw new Error('Invalid Connector preview request.')
    assertRunAccess(event, (value as ConnectorPreviewRequest).runId)
    return sanitizeValue(await runtime.previewConnector(value as ConnectorPreviewRequest))
  })
  ipc.handle(IPC_CHANNELS.connectorWrite, async (event, value) => {
    if (!isConnectorWriteRequest(value)) throw new Error('Invalid Connector write request.')
    assertRunAccess(event, (value as ConnectorWriteRequest).runId)
    return sanitizeValue(await runtime.writeConnector(value as ConnectorWriteRequest))
  })
  ipc.handle(IPC_CHANNELS.connectorVerify, async (event, value) => {
    if (!isConnectorVerifyRequest(value)) throw new Error('Invalid Connector verification request.')
    assertRunAccess(event, (value as ConnectorVerifyRequest).runId)
    return sanitizeValue(await runtime.verifyConnectorWrite(value as ConnectorVerifyRequest))
  })
  ipc.handle(IPC_CHANNELS.browserContextList, async (event, value) => {
    if (!isBrowserContextListRequest(value)) throw new Error('Invalid Browser context list request.')
    const runId = (value as BrowserContextListRequest | undefined)?.runId
    if (runId) {
      assertRunAccess(event, runId)
      return sanitizeValue(runtime.listBrowserContexts(runId))
    }
    return sanitizeValue(runtime.listBrowserContexts().filter((context) => authorized(event, context.runId)))
  })
  ipc.handle(IPC_CHANNELS.browserContextCreate, async (event, value) => {
    if (!isBrowserContextCreateRequest(value)) throw new Error('Invalid Browser context create request.')
    assertRunAccess(event, (value as BrowserContextCreateRequest).runId)
    return sanitizeValue(await runtime.createBrowserContext(value as BrowserContextCreateRequest))
  })
  ipc.handle(IPC_CHANNELS.browserNavigate, async (event, value) => {
    if (!isBrowserNavigateRequest(value)) throw new Error('Invalid Browser navigation request.')
    assertRunAccess(event, browserRunId((value as BrowserNavigateRequest).contextId))
    return sanitizeValue(await runtime.navigateBrowser(value as BrowserNavigateRequest))
  })
  ipc.handle(IPC_CHANNELS.browserApprove, async (event, value) => {
    if (!isBrowserNavigateRequest(value)) throw new Error('Invalid Browser navigation approval request.')
    assertRunAccess(event, browserRunId((value as BrowserNavigateRequest).contextId))
    return sanitizeValue(await runtime.approveBrowserNavigation(value as BrowserNavigateRequest))
  })
  ipc.handle(IPC_CHANNELS.browserAssert, async (event, value) => {
    if (!isBrowserAssertRequest(value)) throw new Error('Invalid Browser DOM assertion request.')
    assertRunAccess(event, browserRunId((value as BrowserAssertRequest).contextId))
    return sanitizeValue(await runtime.assertBrowserDom(value as BrowserAssertRequest))
  })
  ipc.handle(IPC_CHANNELS.browserControl, async (event, value) => {
    if (!isBrowserControlRequest(value)) throw new Error('Invalid Browser context control request.')
    const request = value as BrowserControlRequest
    assertRunAccess(event, browserRunId(request.contextId))
    const result = request.action === 'close'
      ? await runtime.closeBrowserContext(request.contextId, request.reason)
      : request.action === 'reconnect' ? await runtime.reconnectBrowserContext(request.contextId) : await runtime.cleanupBrowserContext(request.contextId)
    return sanitizeValue(result)
  })
  ipc.handle(IPC_CHANNELS.browserProfileList, () => sanitizeValue(runtime.listBrowserActionProfiles()))
  ipc.handle(IPC_CHANNELS.browserProfileRegister, async (_event, value) => {
    if (!isBrowserActionProfileRequest(value)) throw new Error('Invalid Browser action profile.')
    return sanitizeValue(await runtime.registerBrowserActionProfile(value as BrowserActionProfileRequest))
  })
  ipc.handle(IPC_CHANNELS.browserAction, async (event, value) => {
    if (!isBrowserActionRequest(value)) throw new Error('Invalid Browser action request.')
    assertRunAccess(event, browserRunId((value as BrowserActionRequest).contextId))
    return sanitizeValue(await runtime.executeBrowserAction(value as BrowserActionRequest))
  })
  ipc.handle(IPC_CHANNELS.browserActionApprove, async (event, value) => {
    if (!isBrowserActionRequest(value)) throw new Error('Invalid Browser action approval request.')
    assertRunAccess(event, browserRunId((value as BrowserActionRequest).contextId))
    return sanitizeValue(await runtime.approveBrowserAction(value as BrowserActionRequest))
  })
  ipc.handle(IPC_CHANNELS.browserVerify, async (event, value) => {
    if (!isBrowserVerifyRequest(value)) throw new Error('Invalid Browser postcondition verification request.')
    assertRunAccess(event, browserRunId((value as BrowserVerifyRequest).contextId))
    return sanitizeValue(await runtime.verifyBrowserAction(value as BrowserVerifyRequest))
  })
  ipc.handle(IPC_CHANNELS.a2aList, async (event, value) => {
    if (!isA2AListRequest(value)) throw new Error('Invalid A2A list request.')
    const runId = (value as A2AListRequest | undefined)?.runId
    if (runId) {
      assertRunAccess(event, runId)
      return sanitizeValue(await runtime.listA2ADeliveries(runId))
    }
    const deliveries = await runtime.listA2ADeliveries()
    return sanitizeValue(deliveries.filter((delivery) => authorized(event, delivery.runId)))
  })
  ipc.handle(IPC_CHANNELS.a2aControl, async (event, value) => {
    if (!isA2AControlRequest(value)) throw new Error('Invalid A2A control request.')
    const request = value as A2AControlRequest
    assertRunAccess(event, await a2aRunId(request.messageId))
    if (request.action === 'retry') return sanitizeValue(await runtime.retryA2A(request.messageId))
    if (request.action === 'mark-unknown') return sanitizeValue(await runtime.markUnknownA2A(request.messageId, request.reason ?? 'Marked unknown by local operator.'))
    return sanitizeValue(await runtime.reconcileA2A(request.messageId, request.outcome!, request.evidence, request.reason))
  })
  ipc.handle(IPC_CHANNELS.experienceList, async () => sanitizeValue(await runtime.listExperienceCandidates()))
  ipc.handle(IPC_CHANNELS.experienceReview, async (_event, value) => {
    if (!isExperienceReviewRequest(value)) throw new Error('Invalid Experience Candidate review request.')
    const request = value as ExperienceReviewRequest
    const validation = request.action === 'approve' ? 'validated' : request.action === 'reject' ? 'rejected' : 'unvalidated'
    const approval = request.action === 'approve' ? 'approved' : request.action === 'reject' ? 'rejected' : 'pending'
    return sanitizeValue(await runtime.reviewExperienceCandidateById(request.candidateId, {
      action: request.action,
      validation,
      approval,
      risk: request.risk,
      validationEvidence: request.evidence,
      reviewerId: request.reviewerId,
      reviewedAt: new Date().toISOString(),
    }))
  })

  return unsubscribe
}
