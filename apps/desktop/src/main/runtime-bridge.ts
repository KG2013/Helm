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
  type StartRunResponse,
} from '../shared/ipc.js'

export type RuntimeIpc = {
  handle(channel: string, handler: (event: unknown, request?: unknown) => unknown): void
}

export type RuntimeBridgeOptions = {
  ipc: RuntimeIpc
  runtime: RuntimeFacade
  runtimeInfo: RuntimeInfo
  emit: (event: DomainEvent) => void
  workspaceIds?: readonly string[]
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
  const unsubscribe = runtime.onEvent((event) => {
    if (event.runId) options.emit(sanitizeEvent(event))
  })

  ipc.handle(IPC_CHANNELS.runtimeInfo, () => options.runtimeInfo)
  ipc.handle(IPC_CHANNELS.runStart, async (_event, value) => {
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
    void runtime.run(run.id).catch(() => undefined)
    const response: StartRunResponse = { task, session, run }
    return response
  })
  ipc.handle(IPC_CHANNELS.runControl, async (_event, value) => {
    if (!isRunControlRequest(value)) throw new Error('Invalid Run control request.')
    const request = value as RunControlRequest
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
  ipc.handle(IPC_CHANNELS.runApproval, async (_event, value) => {
    if (!isRunApprovalRequest(value)) throw new Error('Invalid approval request.')
    const request = value as RunApprovalRequest
    const task = await runtime.loadTask((await runtime.getRun(request.runId))?.taskId ?? '')
    if (!task || task.workspaceId !== request.workspaceId) throw new Error('Approval workspace mismatch.')
    return runtime.resolveApproval(request.runId, request.approvalId, request.decision, request.workspaceId)
  })
  ipc.handle(IPC_CHANNELS.runSnapshot, async (_event, value) => {
    if (!isRunId(value)) throw new Error('Invalid run id.')
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
  ipc.handle(IPC_CHANNELS.runExport, async (_event, value) => {
    if (!isRunExportRequest(value)) throw new Error('Invalid Run export request.')
    const request = value as RunExportRequest
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
  ipc.handle(IPC_CHANNELS.runReconciliation, async (_event, value) => {
    if (!isRunReconciliationRequest(value)) throw new Error('Invalid Run reconciliation request.')
    const request = value as RunReconciliationRequest
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
  ipc.handle(IPC_CHANNELS.agentList, async (_event, value) => {
    if (!isAgentListRequest(value)) throw new Error('Invalid Agent list request.')
    const request = (value ?? {}) as AgentListRequest
    return sanitizeValue(await runtime.listAgentRuns(request.parentRunId))
  })
  ipc.handle(IPC_CHANNELS.agentCreate, async (_event, value) => {
    if (!isAgentCreateRequest(value)) throw new Error('Invalid Agent create request.')
    const request = value as AgentCreateRequest
    return sanitizeValue(await runtime.createAgentChild(request))
  })
  ipc.handle(IPC_CHANNELS.agentControl, async (_event, value) => {
    if (!isAgentControlRequest(value)) throw new Error('Invalid Agent control request.')
    const request = value as AgentControlRequest
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
  ipc.handle(IPC_CHANNELS.connectorPreview, async (_event, value) => {
    if (!isConnectorPreviewRequest(value)) throw new Error('Invalid Connector preview request.')
    return sanitizeValue(await runtime.previewConnector(value as ConnectorPreviewRequest))
  })
  ipc.handle(IPC_CHANNELS.connectorWrite, async (_event, value) => {
    if (!isConnectorWriteRequest(value)) throw new Error('Invalid Connector write request.')
    return sanitizeValue(await runtime.writeConnector(value as ConnectorWriteRequest))
  })

  return unsubscribe
}
