import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { autoUpdater } from 'electron-updater'
import { join } from 'path'
import { registerFsIpc } from './fsipc'
import { registerCompilerIpc } from './compiler'
import { registerP2pIpc, destroySwarm } from './p2p'
import { installMenu, installContextMenu } from './menu'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'P2P LaTeX',
    backgroundColor: '#1e1e2e',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  if (process.env.P2PLATEX_DEBUG) {
    win.webContents.on('console-message', (event) => {
      console.log(`[renderer:${event.level}]`, event.message)
    })
  }
  if (process.env.P2PLATEX_SMOKE) {
    // exercise the menu→renderer route the same way a real menu click does
    setTimeout(() => win.webContents.send('menu:action', 'compile'), 8000)
  }

  win.webContents.setWindowOpenHandler((details) => {
    if (/^https?:\/\//.test(details.url)) shell.openExternal(details.url)
    return { action: 'deny' }
  })

  installContextMenu(win)

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  if (app.isPackaged) {
    autoUpdater.checkForUpdatesAndNotify().catch(() => {})
    setInterval(() => void autoUpdater.checkForUpdatesAndNotify().catch(() => {}), 60 * 60 * 1000)
  }
  installMenu()
  registerFsIpc()
  registerCompilerIpc()
  registerP2pIpc()

  ipcMain.handle('dialog:openFolder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: 'Open LaTeX project folder'
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('shell:openExternal', (_e, url: string) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
  })

  // dev-only: lets smoke tests auto-open a project on launch
  ipcMain.handle('smoke:getRoot', () => process.env.P2PLATEX_SMOKE ?? null)

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  destroySwarm()
  app.quit()
})
