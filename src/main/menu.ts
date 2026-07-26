import { Menu, BrowserWindow, MenuItemConstructorOptions, shell } from 'electron'

/**
 * Explicit application menu. Without one, Electron's default menu binds
 * ⌘Z/⇧⌘Z as accelerators that call Chromium's *native* undo — the keystroke
 * never reaches the page, so CodeMirror's history (and the collaborative
 * Y.UndoManager) never runs. We route Undo/Redo/Find to the renderer instead;
 * cut/copy/paste/select-all keep their native roles, which CodeMirror handles
 * correctly through regular clipboard events.
 */
export function installMenu(): void {
  const isMac = process.platform === 'darwin'
  const send = (action: string): MenuItemConstructorOptions['click'] => (_item, win) => {
    const target = win instanceof BrowserWindow ? win : BrowserWindow.getFocusedWindow()
    target?.webContents.send('menu:action', action)
  }

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' } as MenuItemConstructorOptions] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: send('openProject') },
        { label: 'New File…', accelerator: 'CmdOrCtrl+N', click: send('newFile') },
        { type: 'separator' },
        { label: 'Compile', accelerator: 'CmdOrCtrl+Return', click: send('compile') },
        { label: 'Export PDF…', accelerator: 'CmdOrCtrl+E', click: send('exportPdf') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: send('undo') },
        { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', click: send('redo') },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find & Replace…', accelerator: 'CmdOrCtrl+F', click: send('find') }
      ]
    },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'LaTeX Documentation (Overleaf Learn)',
          click: () => shell.openExternal('https://www.overleaf.com/learn')
        },
        {
          label: 'Install a LaTeX Engine (Tectonic)',
          click: () =>
            shell.openExternal('https://tectonic-typesetting.github.io/en-US/install.html')
        }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** Right-click cut/copy/paste in editable areas (editor, inputs). */
export function installContextMenu(win: BrowserWindow): void {
  win.webContents.on('context-menu', (_e, params) => {
    // non-editable, no selection: let in-page menus (file tree) handle it
    if (!params.isEditable && !params.selectionText) return
    const items: MenuItemConstructorOptions[] = []
    if (params.isEditable) {
      items.push(
        { role: 'cut', enabled: params.editFlags.canCut },
        { role: 'copy', enabled: params.editFlags.canCopy },
        { role: 'paste', enabled: params.editFlags.canPaste },
        { type: 'separator' },
        { role: 'selectAll' }
      )
    } else {
      items.push({ role: 'copy', enabled: params.editFlags.canCopy })
    }
    Menu.buildFromTemplate(items).popup({ window: win })
  })
}
