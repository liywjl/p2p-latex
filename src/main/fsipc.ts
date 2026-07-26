import { ipcMain, dialog, BrowserWindow } from 'electron'
import { promises as fs } from 'fs'
import * as path from 'path'
import chokidar, { FSWatcher } from 'chokidar'
import { TreeNode, IGNORED_NAMES, isAuxPath, FileChangeEvent } from '../shared/types'
import { safeJoin } from './safepath'

function toPosix(p: string): string {
  return p.split(path.sep).join('/')
}

async function readTree(root: string, dir = ''): Promise<TreeNode[]> {
  const abs = safeJoin(root, dir)
  const entries = await fs.readdir(abs, { withFileTypes: true })
  const nodes: TreeNode[] = []
  for (const entry of entries) {
    if (IGNORED_NAMES.includes(entry.name) || entry.name.startsWith('.')) continue
    const rel = dir ? `${dir}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      nodes.push({ name: entry.name, path: rel, type: 'dir', children: await readTree(root, rel) })
    } else if (entry.isFile() && !isAuxPath(entry.name)) {
      nodes.push({ name: entry.name, path: rel, type: 'file' })
    }
  }
  nodes.sort((a, b) =>
    a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name)
  )
  return nodes
}

let watcher: FSWatcher | null = null

export function registerFsIpc(): void {
  ipcMain.handle('fs:readTree', (_e, root: string) => readTree(root))

  ipcMain.handle('fs:readTextFile', (_e, root: string, rel: string) =>
    fs.readFile(safeJoin(root, rel), 'utf8')
  )

  ipcMain.handle('fs:readBinaryFile', async (_e, root: string, rel: string) => {
    const buf = await fs.readFile(safeJoin(root, rel))
    return new Uint8Array(buf)
  })

  ipcMain.handle('fs:stat', async (_e, root: string, rel: string) => {
    try {
      const st = await fs.stat(safeJoin(root, rel))
      return { size: st.size, isFile: st.isFile() }
    } catch {
      return null
    }
  })

  ipcMain.handle('fs:writeTextFile', async (_e, root: string, rel: string, content: string) => {
    const abs = safeJoin(root, rel)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, content, 'utf8')
  })

  ipcMain.handle('fs:writeBinaryFile', async (_e, root: string, rel: string, data: Uint8Array) => {
    const abs = safeJoin(root, rel)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, Buffer.from(data))
  })

  ipcMain.handle('fs:delete', async (_e, root: string, rel: string) => {
    await fs.rm(safeJoin(root, rel), { recursive: true, force: true })
  })

  ipcMain.handle('fs:rename', async (_e, root: string, from: string, to: string) => {
    const dest = safeJoin(root, to)
    await fs.mkdir(path.dirname(dest), { recursive: true })
    await fs.rename(safeJoin(root, from), dest)
  })

  ipcMain.handle('fs:watch', (e, root: string) => {
    if (watcher) watcher.close()
    const win = BrowserWindow.fromWebContents(e.sender)
    watcher = chokidar.watch(root, {
      ignored: (p: string) => {
        const rel = path.relative(root, p)
        if (!rel) return false
        const parts = rel.split(path.sep)
        return (
          parts.some((seg) => IGNORED_NAMES.includes(seg) || seg.startsWith('.')) || isAuxPath(rel)
        )
      },
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 }
    })
    watcher.on('all', (type, p) => {
      const event: FileChangeEvent = {
        type: type as FileChangeEvent['type'],
        path: toPosix(path.relative(root, p))
      }
      win?.webContents.send('fs:changed', event)
    })
  })

  ipcMain.handle('fs:unwatch', async () => {
    if (watcher) {
      await watcher.close()
      watcher = null
    }
  })

  ipcMain.handle('fs:exportPdf', async (e, pdfPath: string, suggestedName: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const result = await dialog.showSaveDialog(win!, {
      title: 'Export PDF',
      defaultPath: suggestedName,
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    })
    if (result.canceled || !result.filePath) return null
    await fs.copyFile(pdfPath, result.filePath)
    return result.filePath
  })
}
