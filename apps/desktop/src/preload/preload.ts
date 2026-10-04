import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, type A2AListRequest, type AgentControlRequest, type AgentCreateRequest, type AgentListRequest, type BrowserActionProfileRequest, type BrowserActionRequest, type BrowserAssertRequest, type BrowserContextCreateRequest, type BrowserContextListRequest, type BrowserControlRequest, type BrowserNavigateRequest, type BrowserVerifyRequest, type ConnectorPreviewRequest, type ConnectorRegisterRequest, type ConnectorVerifyRequest, type ConnectorWriteRequest, type RunApprovalRequest, type RunControlRequest, type RunExportRequest, type RunExportResponse, type RunReconciliationRequest, type RunReconciliationResponse, type RunSnapshot, type RuntimeInfo, type RunEventPayload, type StartRunRequest, type StartRunResponse } from '../shared/ipc.js'

contextBridge.exposeInMainWorld('helm', {
  runtimeInfo: (): Promise<RuntimeInfo> => ipcRenderer.invoke(IPC_CHANNELS.runtimeInfo),
  startRun: (request: StartRunRequest): Promise<StartRunResponse> => ipcRenderer.invoke(IPC_CHANNELS.runStart, request),
  getRunSnapshot: (runId: string): Promise<RunSnapshot> => ipcRenderer.invoke(IPC_CHANNELS.runSnapshot, runId),
  exportRun: (request: RunExportRequest): Promise<RunExportResponse> => ipcRenderer.invoke(IPC_CHANNELS.runExport, request),
  reconcileRun: (request: RunReconciliationRequest): Promise<RunReconciliationResponse> => ipcRenderer.invoke(IPC_CHANNELS.runReconciliation, request),
  listAgents: (request?: AgentListRequest) => ipcRenderer.invoke(IPC_CHANNELS.agentList, request),
  createAgent: (request: AgentCreateRequest) => ipcRenderer.invoke(IPC_CHANNELS.agentCreate, request),
  controlAgents: (request: AgentControlRequest) => ipcRenderer.invoke(IPC_CHANNELS.agentControl, request),
  listConnectors: () => ipcRenderer.invoke(IPC_CHANNELS.connectorList),
  registerConnector: (request: ConnectorRegisterRequest) => ipcRenderer.invoke(IPC_CHANNELS.connectorRegister, request),
  previewConnector: (request: ConnectorPreviewRequest) => ipcRenderer.invoke(IPC_CHANNELS.connectorPreview, request),
  writeConnector: (request: ConnectorWriteRequest) => ipcRenderer.invoke(IPC_CHANNELS.connectorWrite, request),
  verifyConnector: (request: ConnectorVerifyRequest) => ipcRenderer.invoke(IPC_CHANNELS.connectorVerify, request),
  listBrowserContexts: (request?: BrowserContextListRequest) => ipcRenderer.invoke(IPC_CHANNELS.browserContextList, request),
  createBrowserContext: (request: BrowserContextCreateRequest) => ipcRenderer.invoke(IPC_CHANNELS.browserContextCreate, request),
  navigateBrowser: (request: BrowserNavigateRequest) => ipcRenderer.invoke(IPC_CHANNELS.browserNavigate, request),
  approveBrowserNavigation: (request: BrowserNavigateRequest) => ipcRenderer.invoke(IPC_CHANNELS.browserApprove, request),
  assertBrowserDom: (request: BrowserAssertRequest) => ipcRenderer.invoke(IPC_CHANNELS.browserAssert, request),
  controlBrowserContext: (request: BrowserControlRequest) => ipcRenderer.invoke(IPC_CHANNELS.browserControl, request),
  listBrowserActionProfiles: () => ipcRenderer.invoke(IPC_CHANNELS.browserProfileList),
  registerBrowserActionProfile: (request: BrowserActionProfileRequest) => ipcRenderer.invoke(IPC_CHANNELS.browserProfileRegister, request),
  executeBrowserAction: (request: BrowserActionRequest) => ipcRenderer.invoke(IPC_CHANNELS.browserAction, request),
  approveBrowserAction: (request: BrowserActionRequest) => ipcRenderer.invoke(IPC_CHANNELS.browserActionApprove, request),
  verifyBrowserAction: (request: BrowserVerifyRequest) => ipcRenderer.invoke(IPC_CHANNELS.browserVerify, request),
  listA2ADeliveries: (request?: A2AListRequest) => ipcRenderer.invoke(IPC_CHANNELS.a2aList, request),
  controlRun: (request: RunControlRequest) => ipcRenderer.invoke(IPC_CHANNELS.runControl, request),
  resolveApproval: (request: RunApprovalRequest) => ipcRenderer.invoke(IPC_CHANNELS.runApproval, request),
  subscribe: (listener: (payload: RunEventPayload) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: RunEventPayload) => listener(payload)
    ipcRenderer.on(IPC_CHANNELS.runEvent, wrapped)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.runEvent, wrapped)
  },
})
