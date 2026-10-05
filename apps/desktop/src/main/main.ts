import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import {
  MockProvider,
  FileArtifactStore,
  PythonDocumentWorkerClient,
  unavailableOfficePreflight,
  createOfficeRuntime,
  type RuntimeFacade,
} from '@helm/runtime'
import { openSqliteEventStore } from '@helm/runtime/sqlite-node'
import { createCodingRuntime, createDockerCodingSandboxFromEnv, createWorkspaceInspectionRuntime } from '@helm/runtime/tools'
import { createProviderFromEnv } from '@helm/providers'
import { registerRuntimeIpcHandlers } from './runtime-bridge.js'
import { DesktopWindowRegistry } from './window-registry.js'
import { readKeychainSecret } from './keychain.js'

const devServerUrl = process.env.HELM_DEV_SERVER_URL
let mainWindow: BrowserWindow | null = null
const windowRegistry = new DesktopWindowRegistry()
let activeRuntime: RuntimeFacade | undefined
let activeStore: { close(): Promise<void> | void } | undefined
let isQuitting = false

function createWindow() {
  const window = new BrowserWindow({
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
    void window.loadURL(devServerUrl)
    window.webContents.openDevTools({ mode: 'detach' })
  } else {
    void window.loadFile(join(__dirname, '../dist/index.html'))
  }

  window.webContents.setWindowOpenHandler(({ url }) => {
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  windowRegistry.register(window.webContents)
  if (!mainWindow) mainWindow = window

  window.on('closed', () => {
    windowRegistry.unregister(window.webContents)
    if (mainWindow === window) mainWindow = BrowserWindow.getAllWindows().find((candidate) => candidate !== window) ?? null
  })
}

app.whenReady().then(async () => {
  const baseProvider = createProviderFromEnv({ env: process.env, getApiKey: (service) => readKeychainSecret(service) }) ?? new MockProvider()
  const workspaceId = 'workspace-helm'
  const workspaceRoot = process.env.HELM_WORKSPACE_ROOT ?? process.cwd()
  const statePath = process.env.HELM_STATE_DB ?? join(app.getPath('userData'), 'state.sqlite')
  const sqlite = openSqliteEventStore(statePath)
  activeStore = sqlite.store
  const artifactStore = new FileArtifactStore(join(app.getPath('userData'), 'artifacts'))
  const ownerId = process.env.HELM_RUNTIME_OWNER ?? `desktop-${process.pid}`
  const taskKind = process.env.HELM_TASK_KIND?.toLowerCase()
  const officeWorker = taskKind === 'office'
    ? new PythonDocumentWorkerClient({
        scriptPath: process.env.HELM_DOCUMENT_WORKER ?? join(__dirname, '../../../workers/document-worker/worker.py'),
        workspaceRoot,
      })
    : undefined
  const officePreflight = officeWorker ? await officeWorker.health().catch(() => unavailableOfficePreflight()) : undefined
  const runtime = taskKind === 'office'
    ? createOfficeRuntime({
        store: sqlite.store,
        provider: baseProvider,
        worker: officeWorker!,
        workspaceId,
        root: workspaceRoot,
        preflight: officePreflight,
        ownerId,
        artifactStore,
      })
    : taskKind === 'coding'
      ? createCodingRuntime({
          store: sqlite.store,
          provider: baseProvider,
          workspaceId,
          root: workspaceRoot,
          sandbox: createDockerCodingSandboxFromEnv(process.env, workspaceRoot),
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
  await runtime.ready()
  activeRuntime = runtime
  registerRuntimeIpcHandlers({
    ipc: {
      handle: (channel, handler) => ipcMain.handle(channel, (event, request) => {
        if (!windowRegistry.has(event.sender) || event.senderFrame !== event.sender.mainFrame) {
          throw new Error('IPC source rejected.')
        }
        return handler(event, request)
      }),
    },
    runtime,
    workspaceIds: [workspaceId],
    windowRegistry,
    runtimeInfo: {
      appVersion: app.getVersion(),
      platform: process.platform,
      isPackaged: app.isPackaged,
      officePreflight,
    },
    emit: (event) => windowRegistry.publish(event),
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
