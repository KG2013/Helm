import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, type AgentControlRequest, type AgentCreateRequest, type AgentListRequest, type ConnectorPreviewRequest, type ConnectorRegisterRequest, type ConnectorWriteRequest, type RunApprovalRequest, type RunControlRequest, type RunExportRequest, type RunExportResponse, type RunReconciliationRequest, type RunReconciliationResponse, type RunSnapshot, type RuntimeInfo, type RunEventPayload, type StartRunRequest, type StartRunResponse } from '../shared/ipc.js'

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
  controlRun: (request: RunControlRequest) => ipcRenderer.invoke(IPC_CHANNELS.runControl, request),
  resolveApproval: (request: RunApprovalRequest) => ipcRenderer.invoke(IPC_CHANNELS.runApproval, request),
  subscribe: (listener: (payload: RunEventPayload) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: RunEventPayload) => listener(payload)
    ipcRenderer.on(IPC_CHANNELS.runEvent, wrapped)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.runEvent, wrapped)
  },
})
