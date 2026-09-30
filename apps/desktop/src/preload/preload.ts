import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, type RunApprovalRequest, type RunControlRequest, type RunSnapshot, type RuntimeInfo, type RunEventPayload, type StartRunRequest, type StartRunResponse } from '../shared/ipc.js'

contextBridge.exposeInMainWorld('helm', {
  runtimeInfo: (): Promise<RuntimeInfo> => ipcRenderer.invoke(IPC_CHANNELS.runtimeInfo),
  startRun: (request: StartRunRequest): Promise<StartRunResponse> => ipcRenderer.invoke(IPC_CHANNELS.runStart, request),
  getRunSnapshot: (runId: string): Promise<RunSnapshot> => ipcRenderer.invoke(IPC_CHANNELS.runSnapshot, runId),
  controlRun: (request: RunControlRequest) => ipcRenderer.invoke(IPC_CHANNELS.runControl, request),
  resolveApproval: (request: RunApprovalRequest) => ipcRenderer.invoke(IPC_CHANNELS.runApproval, request),
  subscribe: (listener: (payload: RunEventPayload) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: RunEventPayload) => listener(payload)
    ipcRenderer.on(IPC_CHANNELS.runEvent, wrapped)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.runEvent, wrapped)
  },
})
