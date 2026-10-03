import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import {
  MockProvider,
} from '@helm/runtime'
import { openSqliteEventStore } from '@helm/runtime/sqlite-node'
import { createWorkspaceInspectionRuntime } from '@helm/runtime/tools'
import { OpenAICompatibleProvider } from '@helm/providers'
import { registerRuntimeIpcHandlers } from './runtime-bridge.js'
import { readKeychainSecret } from './keychain.js'

const devServerUrl = process.env.HELM_DEV_SERVER_URL
let mainWindow: BrowserWindow | null = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 680,
    backgroundColor: '#09111f',
    title: 'Helm',
    webPreferences: {
      preload: join(__dirname, '../dist-electron/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl)
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    void mainWindow.loadFile(join(__dirname, '../dist/index.html'))
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.whenReady().then(() => {
  const useKimi = process.env.HELM_PROVIDER?.toLowerCase() === 'kimi'
  const baseProvider = useKimi
    ? new OpenAICompatibleProvider({
        id: 'kimi',
        model: process.env.HELM_KIMI_MODEL ?? 'kimi-for-coding',
        baseUrl: process.env.HELM_KIMI_BASE_URL ?? 'https://api.kimi.com/coding/v1',
        getApiKey: () => readKeychainSecret(process.env.HELM_KIMI_KEYCHAIN_SERVICE ?? 'com.helm.provider.kimi-code'),
      })
    : new MockProvider()
  const workspaceId = 'workspace-helm'
  const workspaceRoot = process.env.HELM_WORKSPACE_ROOT ?? process.cwd()
  const statePath = process.env.HELM_STATE_DB ?? join(app.getPath('userData'), 'state.sqlite')
  const sqlite = openSqliteEventStore(statePath)
  const runtime = createWorkspaceInspectionRuntime({
    store: sqlite.store,
    provider: baseProvider,
    workspaceId,
    root: workspaceRoot,
  })
  registerRuntimeIpcHandlers({
    ipc: {
      handle: (channel, handler) => ipcMain.handle(channel, (event, request) => {
        if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
          throw new Error('IPC source rejected.')
        }
        return handler(event, request)
      }),
    },
    runtime,
    workspaceIds: [workspaceId],
    runtimeInfo: {
      appVersion: app.getVersion(),
      platform: process.platform,
      isPackaged: app.isPackaged,
    },
    emit: (event) => {
      if (mainWindow && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send('helm:run-event', event)
    },
  })

  app.once('before-quit', () => {
    void sqlite.store.close()
  })

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
