import type { DomainEvent, Episode, ReleaseGateResult, Run, RunProjection, Session, Task } from '@helm/runtime'

export const IPC_CHANNELS = {
  runtimeInfo: 'helm:runtime-info',
  runStart: 'helm:run-start',
  runSnapshot: 'helm:run-snapshot',
  runControl: 'helm:run-control',
  runApproval: 'helm:run-approval',
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
