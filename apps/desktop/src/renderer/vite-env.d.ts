interface Window {
  helm?: {
    runtimeInfo: () => Promise<import('../shared/ipc.js').RuntimeInfo>
    startRun: (request: import('../shared/ipc.js').StartRunRequest) => Promise<import('../shared/ipc.js').StartRunResponse>
    getRunSnapshot: (runId: string) => Promise<import('../shared/ipc.js').RunSnapshot>
    reconcileRun: (request: import('../shared/ipc.js').RunReconciliationRequest) => Promise<import('../shared/ipc.js').RunReconciliationResponse>
    listAgents: (request?: import('../shared/ipc.js').AgentListRequest) => Promise<import('@helm/runtime').AgentRunRecord[]>
    createAgent: (request: import('../shared/ipc.js').AgentCreateRequest) => Promise<import('@helm/runtime').AgentRunRecord>
    controlRun: (request: import('../shared/ipc.js').RunControlRequest) => Promise<import('@helm/runtime').Run>
    resolveApproval: (request: import('../shared/ipc.js').RunApprovalRequest) => Promise<import('@helm/runtime').Run>
    subscribe: (listener: (payload: import('../shared/ipc.js').RunEventPayload) => void) => () => void
  }
}

declare module '*.css' {
  const content: Record<string, string>
  export default content
}
