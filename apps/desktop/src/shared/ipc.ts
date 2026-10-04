import type { BudgetUsage, DomainEvent, Episode, Evidence, ReconciliationRecord, ReleaseGateResult, Run, RunProjection, Session, Task } from '@helm/runtime'

export const IPC_CHANNELS = {
  runtimeInfo: 'helm:runtime-info',
  runStart: 'helm:run-start',
  runSnapshot: 'helm:run-snapshot',
  runControl: 'helm:run-control',
  runApproval: 'helm:run-approval',
  runReconciliation: 'helm:run-reconciliation',
  agentList: 'helm:agent-list',
  agentCreate: 'helm:agent-create',
  agentControl: 'helm:agent-control',
  connectorList: 'helm:connector-list',
  connectorRegister: 'helm:connector-register',
  connectorPreview: 'helm:connector-preview',
  connectorWrite: 'helm:connector-write',
  runExport: 'helm:run-export',
  runEvent: 'helm:run-event',
} as const

export type RuntimeInfo = {
  appVersion: string
  platform: string
  isPackaged: boolean
}

export type StartRunRequest = {
  goal: string
  workspaceId: string
  sessionId?: string
}

export type RunControlRequest = {
  runId: string
  action: 'pause' | 'resume' | 'cancel'
  reason?: string
}

export type RunApprovalRequest = {
  runId: string
  approvalId: string
  workspaceId: string
  decision: 'approve' | 'deny'
}

export type RunExportRequest = {
  runId: string
}

export type RunExportResponse = {
  runId: string
  jsonl: string
  projection: RunProjection
  episode: Episode
  releaseGate: ReleaseGateResult
}

export type RunReconciliationRequest = {
  runId: string
  action: 'inspect' | 'record'
  toolCallId?: string
  outcome?: 'known' | 'failed' | 'unknown'
  evidence?: Evidence[]
  reason?: string
}

export type RunReconciliationResponse = {
  runId: string
  budgetUsage: BudgetUsage
  candidates: Array<{ toolCallId: string; stepId?: string; reason: string }>
  record?: ReconciliationRecord
}

export type AgentListRequest = { parentRunId?: string }
export type AgentCreateRequest = {
  parentRunId: string
  parentAgentId?: string
  role: string
  principal: string
  goal: string
  capabilities: string[]
  scope: Record<string, unknown>
  allowedCapabilities: string[]
  allowedScope: Record<string, unknown>
  budget?: Partial<import('@helm/runtime').Budget>
}
export type AgentControlRequest = { parentRunId: string; action: 'cancel' | 'recover'; reason?: string }
export type ConnectorPreviewRequest = import('@helm/runtime').ConnectorPreviewInput
export type ConnectorRegisterRequest = import('@helm/runtime').ConnectorActionProfile
export type ConnectorWriteRequest = import('@helm/runtime').ConnectorWriteInput

export type StartRunResponse = {
  task: Task
  session: Session
  run: Run
}

export type RunEventPayload = DomainEvent

export type RunSnapshot = {
  task: Task
  session: Session
  run: Run
  events: DomainEvent[]
  projection: RunProjection
}

export function isStartRunRequest(value: unknown): value is StartRunRequest {
  if (!value || typeof value !== 'object') return false
  const request = value as Partial<StartRunRequest>
  return typeof request.goal === 'string' && request.goal.trim().length > 0 && request.goal.length <= 8000
    && typeof request.workspaceId === 'string' && request.workspaceId.trim().length > 0
    && (request.sessionId === undefined || isRunId(request.sessionId))
}

export function isRunId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 200
}

export function isRunControlRequest(value: unknown): value is RunControlRequest {
  if (!value || typeof value !== 'object') return false
  const request = value as Partial<RunControlRequest>
  return isRunId(request.runId) && (request.action === 'pause' || request.action === 'resume' || request.action === 'cancel')
}

export function isRunApprovalRequest(value: unknown): value is RunApprovalRequest {
  if (!value || typeof value !== 'object') return false
  const request = value as Partial<RunApprovalRequest>
  return isRunId(request.runId) && isRunId(request.approvalId) && isRunId(request.workspaceId)
    && (request.decision === 'approve' || request.decision === 'deny')
}

export function isRunExportRequest(value: unknown): value is RunExportRequest {
  if (!value || typeof value !== 'object') return false
  return isRunId((value as Partial<RunExportRequest>).runId)
}

export function isRunReconciliationRequest(value: unknown): value is RunReconciliationRequest {
  if (!value || typeof value !== 'object') return false
  const request = value as Partial<RunReconciliationRequest>
  if (!isRunId(request.runId) || (request.action !== 'inspect' && request.action !== 'record')) return false
  if (request.toolCallId !== undefined && !isRunId(request.toolCallId)) return false
  if (request.outcome !== undefined && request.outcome !== 'known' && request.outcome !== 'failed' && request.outcome !== 'unknown') return false
  if (request.reason !== undefined && (typeof request.reason !== 'string' || request.reason.length > 2_000)) return false
  if (request.evidence !== undefined && (!Array.isArray(request.evidence) || request.evidence.length > 32 || request.evidence.some((item) => !item || typeof item !== 'object' || typeof item.type !== 'string' || typeof item.summary !== 'string'))) return false
  return request.action === 'inspect' || Boolean(request.outcome)
}

export function isAgentListRequest(value: unknown): value is AgentListRequest {
  return value === undefined || (Boolean(value) && typeof value === 'object' && ((value as AgentListRequest).parentRunId === undefined || isRunId((value as AgentListRequest).parentRunId)))
}

export function isAgentCreateRequest(value: unknown): value is AgentCreateRequest {
  if (!value || typeof value !== 'object') return false
  const request = value as Partial<AgentCreateRequest>
  return isRunId(request.parentRunId) && typeof request.role === 'string' && request.role.length <= 120
    && isRunId(request.principal) && typeof request.goal === 'string' && request.goal.trim().length > 0 && request.goal.length <= 4_000
    && Array.isArray(request.capabilities) && request.capabilities.every((item) => typeof item === 'string' && item.length <= 120)
    && Array.isArray(request.allowedCapabilities) && request.allowedCapabilities.every((item) => typeof item === 'string' && item.length <= 120)
    && Boolean(request.scope) && typeof request.scope === 'object' && Boolean(request.allowedScope) && typeof request.allowedScope === 'object'
}

export function isAgentControlRequest(value: unknown): value is AgentControlRequest {
  if (!value || typeof value !== 'object') return false
  const request = value as Partial<AgentControlRequest>
  return isRunId(request.parentRunId) && (request.action === 'cancel' || request.action === 'recover')
    && (request.reason === undefined || typeof request.reason === 'string')
}

export function isConnectorPreviewRequest(value: unknown): value is ConnectorPreviewRequest {
  if (!value || typeof value !== 'object') return false
  const request = value as Partial<ConnectorPreviewRequest>
  return isRunId(request.runId) && isRunId(request.taskId) && isRunId(request.sessionId)
    && typeof request.connectorId === 'string' && typeof request.profileId === 'string' && typeof request.profileVersion === 'string'
    && typeof request.action === 'string' && typeof request.target === 'string' && Boolean(request.scope) && typeof request.scope === 'object'
    && Array.isArray(request.impact) && typeof request.rollbackPlan === 'string' && typeof request.reconciliationPlan === 'string'
}

export function isConnectorRegisterRequest(value: unknown): value is ConnectorRegisterRequest {
  if (!value || typeof value !== 'object') return false
  const profile = value as Partial<ConnectorRegisterRequest>
  return typeof profile.id === 'string' && typeof profile.version === 'string' && typeof profile.connectorId === 'string'
    && Array.isArray(profile.actions) && profile.actions.every((item) => typeof item === 'string')
    && Array.isArray(profile.allowedTargets) && profile.allowedTargets.every((item) => typeof item === 'string')
    && Array.isArray(profile.allowedFields) && profile.allowedFields.every((item) => typeof item === 'string')
    && Boolean(profile.scope) && typeof profile.scope === 'object'
}

export function isConnectorWriteRequest(value: unknown): value is ConnectorWriteRequest {
  if (!value || typeof value !== 'object') return false
  const request = value as Partial<ConnectorWriteRequest>
  return isRunId(request.runId) && isRunId(request.taskId) && isRunId(request.sessionId)
    && typeof request.connectorId === 'string' && typeof request.profileId === 'string' && typeof request.profileVersion === 'string'
    && typeof request.action === 'string' && typeof request.target === 'string' && Boolean(request.scope) && typeof request.scope === 'object'
    && Boolean(request.after) && typeof request.after === 'object' && isRunId(request.idempotencyKey)
    && (request.actionId === undefined || isRunId(request.actionId))
    && (request.expectedVersion === undefined || isRunId(request.expectedVersion))
    && (request.remoteRequestId === undefined || (typeof request.remoteRequestId === 'string' && request.remoteRequestId.length <= 300))
    && (request.postcondition === undefined || (typeof request.postcondition === 'string' && request.postcondition.length <= 500))
    && (request.artifactRef === undefined || (typeof request.artifactRef === 'string' && request.artifactRef.length <= 300))
    && (request.traceRef === undefined || (typeof request.traceRef === 'string' && request.traceRef.length <= 300))
}
