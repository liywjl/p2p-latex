import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
import type {
  TreeNode,
  EngineInfo,
  CompileResult,
  SwarmStatus,
  FileChangeEvent
} from '../shared/types'

function on<T extends unknown[]>(
  channel: string,
  cb: (...args: T) => void
): () => void {
  const listener = (_e: IpcRendererEvent, ...args: unknown[]): void => cb(...(args as T))
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  // dialogs / shell
  openFolderDialog: (): Promise<string | null> => ipcRenderer.invoke('dialog:openFolder'),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url),

  // filesystem (all paths relative to root)
  readTree: (root: string): Promise<TreeNode[]> => ipcRenderer.invoke('fs:readTree', root),
  readTextFile: (root: string, rel: string): Promise<string> =>
    ipcRenderer.invoke('fs:readTextFile', root, rel),
  readBinaryFile: (root: string, rel: string): Promise<Uint8Array> =>
    ipcRenderer.invoke('fs:readBinaryFile', root, rel),
  stat: (root: string, rel: string): Promise<{ size: number; isFile: boolean } | null> =>
    ipcRenderer.invoke('fs:stat', root, rel),
  writeTextFile: (root: string, rel: string, content: string): Promise<void> =>
    ipcRenderer.invoke('fs:writeTextFile', root, rel, content),
  writeBinaryFile: (root: string, rel: string, data: Uint8Array): Promise<void> =>
    ipcRenderer.invoke('fs:writeBinaryFile', root, rel, data),
  deletePath: (root: string, rel: string): Promise<void> =>
    ipcRenderer.invoke('fs:delete', root, rel),
  renamePath: (root: string, from: string, to: string): Promise<void> =>
    ipcRenderer.invoke('fs:rename', root, from, to),
  watchProject: (root: string): Promise<void> => ipcRenderer.invoke('fs:watch', root),
  unwatchProject: (): Promise<void> => ipcRenderer.invoke('fs:unwatch'),
  onFileChanged: (cb: (event: FileChangeEvent) => void): (() => void) =>
    on('fs:changed', cb),
  exportPdf: (pdfPath: string, suggestedName: string): Promise<string | null> =>
    ipcRenderer.invoke('fs:exportPdf', pdfPath, suggestedName),

  // compiler
  detectEngines: (): Promise<EngineInfo[]> => ipcRenderer.invoke('compiler:detect'),
  compile: (
    root: string,
    mainTex: string,
    engine: string,
    includeOnly?: string | null
  ): Promise<CompileResult> =>
    ipcRenderer.invoke('compiler:compile', { root, mainTex, engine, includeOnly }),
  getPdf: (pdfPath: string): Promise<Uint8Array> => ipcRenderer.invoke('compiler:getPdf', pdfPath),
  synctexForward: (
    root: string,
    pdfPath: string,
    relFile: string,
    line: number
  ): Promise<{ page: number; x: number; y: number } | null> =>
    ipcRenderer.invoke('synctex:forward', root, pdfPath, relFile, line),
  synctexInverse: (
    root: string,
    pdfPath: string,
    page: number,
    xBp: number,
    yBp: number
  ): Promise<{ file: string; line: number } | null> =>
    ipcRenderer.invoke('synctex:inverse', root, pdfPath, page, xBp, yBp),

  // p2p
  hostSession: (existingKey?: string): Promise<string> =>
    ipcRenderer.invoke('p2p:host', existingKey),
  joinSession: (inviteKey: string): Promise<void> => ipcRenderer.invoke('p2p:join', inviteKey),
  leaveSession: (): Promise<void> => ipcRenderer.invoke('p2p:leave'),
  sendToPeer: (peerId: string, data: Uint8Array): Promise<void> =>
    ipcRenderer.invoke('p2p:send', peerId, data),
  broadcast: (data: Uint8Array, exceptPeerId?: string): Promise<void> =>
    ipcRenderer.invoke('p2p:broadcast', data, exceptPeerId),
  onPeerJoined: (cb: (peerId: string) => void): (() => void) => on('p2p:peer-joined', cb),
  onPeerLeft: (cb: (peerId: string) => void): (() => void) => on('p2p:peer-left', cb),
  onPeerData: (cb: (peerId: string, data: Uint8Array) => void): (() => void) =>
    on('p2p:data', cb),
  onSwarmStatus: (cb: (status: SwarmStatus) => void): (() => void) => on('p2p:status', cb),

  // application menu → renderer actions (undo/redo/find/openProject/…)
  onMenuAction: (cb: (action: string) => void): (() => void) => on('menu:action', cb),

  // dev-only: smoke tests auto-open a project on launch
  getSmokeRoot: (): Promise<string | null> => ipcRenderer.invoke('smoke:getRoot')
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
