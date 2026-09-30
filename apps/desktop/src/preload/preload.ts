import { contextBridge, ipcRenderer } from 'electron'

const allowedChannels = ['run:event'] as const
type AllowedChannel = (typeof allowedChannels)[number]

function isAllowedChannel(channel: string): channel is AllowedChannel {
  return allowedChannels.includes(channel as AllowedChannel)
}

contextBridge.exposeInMainWorld('helm', {
  runtimeInfo: () => ipcRenderer.invoke('helm:runtime-info'),
  requestApproval: (request: { action: string; reason?: string }) =>
    ipcRenderer.invoke('helm:request-approval', request),
  subscribe: (channel: AllowedChannel, listener: (payload: unknown) => void) => {
    if (!isAllowedChannel(channel)) return () => undefined
    const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
  },
})
