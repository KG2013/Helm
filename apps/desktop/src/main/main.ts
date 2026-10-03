import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import {
  MockProvider,
  FileArtifactStore,
  PythonDocumentWorkerClient,
  createOfficeRuntime,
  type RuntimeFacade,
} from '@helm/runtime'
import { openSqliteEventStore } from '@helm/runtime/sqlite-node'
import { createCodingRuntime, createWorkspaceInspectionRuntime } from '@helm/runtime/tools'
import { createProviderFromEnv } from '@helm/providers'
import { registerRuntimeIpcHandlers } from './runtime-bridge.js'
import { readKeychainSecret } from './keychain.js'

const devServerUrl = process.env.HELM_DEV_SERVER_URL
let mainWindow: BrowserWindow | null = null
let activeRuntime: RuntimeFacade | undefined
let activeStore: { close(): Promise<void> | void } | undefined
let isQuitting = false

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
  const baseProvider = createProviderFromEnv({ env: process.env, getApiKey: (service) => readKeychainSecret(service) }) ?? new MockProvider()
  const workspaceId = 'workspace-helm'
  const workspaceRoot = process.env.HELM_WORKSPACE_ROOT ?? process.cwd()
  const statePath = process.env.HELM_STATE_DB ?? join(app.getPath('userData'), 'state.sqlite')
  const sqlite = openSqliteEventStore(statePath)
  activeStore = sqlite.store
  const artifactStore = new FileArtifactStore(join(app.getPath('userData'), 'artifacts'))
  const ownerId = process.env.HELM_RUNTIME_OWNER ?? `desktop-${process.pid}`
  const taskKind = process.env.HELM_TASK_KIND?.toLowerCase()
  const runtime = taskKind === 'office'
    ? createOfficeRuntime({
        store: sqlite.store,
        provider: baseProvider,
        worker: new PythonDocumentWorkerClient({
          scriptPath: process.env.HELM_DOCUMENT_WORKER ?? join(__dirname, '../../../workers/document-worker/worker.py'),
          workspaceRoot,
        }),
        workspaceId,
        root: workspaceRoot,
        ownerId,
        artifactStore,
      })
    : taskKind === 'coding'
      ? createCodingRuntime({
          store: sqlite.store,
          provider: baseProvider,
          workspaceId,
          root: workspaceRoot,
          ownerId,
          artifactStore,
        })
    : createWorkspaceInspectionRuntime({
        store: sqlite.store,
        provider: baseProvider,
        workspaceId,
        root: workspaceRoot,
        ownerId,
        artifactStore,
      })
  activeRuntime = runtime
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

  app.on('before-quit', (event) => {
    if (isQuitting) return
    event.preventDefault()
    isQuitting = true
    void (async () => {
      await activeRuntime?.shutdown('Desktop process shutting down')
      await activeStore?.close()
      app.quit()
    })()
  })

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
