import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { InMemoryEventStore, MockProvider, RuntimeFacade } from '@helm/runtime'
import { registerRuntimeIpcHandlers } from './runtime-bridge.js'

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
  const runtime = new RuntimeFacade({
    store: new InMemoryEventStore(),
    provider: new MockProvider(),
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
    runtimeInfo: {
      appVersion: app.getVersion(),
      platform: process.platform,
      isPackaged: app.isPackaged,
    },
    emit: (event) => {
      if (mainWindow && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send('helm:run-event', event)
    },
  })

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
