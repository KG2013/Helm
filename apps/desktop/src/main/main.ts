import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'

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
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.whenReady().then(() => {
  ipcMain.handle('helm:runtime-info', () => ({
    appVersion: app.getVersion(),
    platform: process.platform,
    isPackaged: app.isPackaged,
  }))

  ipcMain.handle('helm:request-approval', (_event, request: { action: string; reason?: string }) => ({
    status: 'pending',
    request,
  }))

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
