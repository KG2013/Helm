interface Window {
  helm?: {
    runtimeInfo: () => Promise<import('../shared/ipc.js').RuntimeInfo>
    startRun: (request: import('../shared/ipc.js').StartRunRequest) => Promise<import('../shared/ipc.js').StartRunResponse>
    getRunSnapshot: (runId: string) => Promise<import('../shared/ipc.js').RunSnapshot>
    reconcileRun: (request: import('../shared/ipc.js').RunReconciliationRequest) => Promise<import('../shared/ipc.js').RunReconciliationResponse>
    listAgents: (request?: import('../shared/ipc.js').AgentListRequest) => Promise<import('@helm/runtime').AgentRunRecord[]>
    createAgent: (request: import('../shared/ipc.js').AgentCreateRequest) => Promise<import('@helm/runtime').AgentRunRecord>
    controlAgents: (request: import('../shared/ipc.js').AgentControlRequest) => Promise<unknown>
    listConnectors: () => Promise<import('@helm/runtime').ConnectorActionProfile[]>
    registerConnector: (request: import('../shared/ipc.js').ConnectorRegisterRequest) => Promise<import('@helm/runtime').ConnectorActionProfile>
    previewConnector: (request: import('../shared/ipc.js').ConnectorPreviewRequest) => Promise<unknown>
    writeConnector: (request: import('../shared/ipc.js').ConnectorWriteRequest) => Promise<unknown>
    verifyConnector: (request: import('../shared/ipc.js').ConnectorVerifyRequest) => Promise<unknown>
    listBrowserContexts: (request?: import('../shared/ipc.js').BrowserContextListRequest) => Promise<import('@helm/runtime').BrowserContextRecord[]>
    createBrowserContext: (request: import('../shared/ipc.js').BrowserContextCreateRequest) => Promise<import('@helm/runtime').BrowserContextRecord>
    navigateBrowser: (request: import('../shared/ipc.js').BrowserNavigateRequest) => Promise<import('@helm/runtime').BrowserNavigationResult>
    approveBrowserNavigation: (request: import('../shared/ipc.js').BrowserNavigateRequest) => Promise<import('@helm/runtime').BrowserNavigationResult>
    assertBrowserDom: (request: import('../shared/ipc.js').BrowserAssertRequest) => Promise<import('@helm/runtime').BrowserObservationResult>
    controlBrowserContext: (request: import('../shared/ipc.js').BrowserControlRequest) => Promise<import('@helm/runtime').BrowserContextRecord>
    listBrowserActionProfiles: () => Promise<import('@helm/runtime').BrowserActionProfile[]>
    registerBrowserActionProfile: (request: import('../shared/ipc.js').BrowserActionProfileRequest) => Promise<import('@helm/runtime').BrowserActionProfile>
    executeBrowserAction: (request: import('../shared/ipc.js').BrowserActionRequest) => Promise<import('@helm/runtime').BrowserActionResult>
    approveBrowserAction: (request: import('../shared/ipc.js').BrowserActionRequest) => Promise<import('@helm/runtime').BrowserActionResult>
    controlRun: (request: import('../shared/ipc.js').RunControlRequest) => Promise<import('@helm/runtime').Run>
    resolveApproval: (request: import('../shared/ipc.js').RunApprovalRequest) => Promise<import('@helm/runtime').Run>
    subscribe: (listener: (payload: import('../shared/ipc.js').RunEventPayload) => void) => () => void
  }
}

declare module '*.css' {
  const content: Record<string, string>
  export default content
}
