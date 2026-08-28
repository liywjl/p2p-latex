import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import type { TreeNode, FileChangeEvent } from '../../../shared/types'
import { isTextPath, MAX_ASSET_SYNC_BYTES } from '../../../shared/types'

const MSG_SYNC = 0
const MSG_AWARENESS = 1

export const SESSION_FILE = '.p2platex/session.json'
export const SNAPSHOT_FILE = '.p2platex/ydoc.bin'

export interface SavedSession {
  inviteKey: string
  role: 'host' | 'joiner'
  savedAt: string
}

export async function readSavedSession(root: string): Promise<SavedSession | null> {
  try {
    const raw = await window.api.readTextFile(root, SESSION_FILE)
    const parsed = JSON.parse(raw) as SavedSession
    return parsed.inviteKey ? parsed : null
  } catch {
    return null
  }
}

export async function writeSavedSession(root: string, s: SavedSession): Promise<void> {
  await window.api.writeTextFile(root, SESSION_FILE, JSON.stringify(s, null, 2))
  await window.api.writeTextFile(root, '.p2platex/.gitignore', '*\n').catch(() => {})
}

export async function forgetSavedSession(root: string): Promise<void> {
  await window.api.deletePath(root, SESSION_FILE).catch(() => {})
  await window.api.deletePath(root, SNAPSHOT_FILE).catch(() => {})
}

/** Transaction origins that must not trigger a write back to disk. */
const LOCAL_ONLY_ORIGINS = new Set(['disk', 'seed', 'snapshot'])

const CURSOR_COLORS = [
  '#f38ba8', '#fab387', '#a6e3a1', '#89b4fa', '#cba6f7', '#94e2d5', '#f9e2af', '#eba0ac'
]

export interface CollabCallbacks {
  /** Fired once on the joiner after the first full sync — folder is materialized after this. */
  onInitialSync: () => void
  /** Fired whenever a remote edit touched a file (after it was written to disk). */
  onRemoteFileChange: (path: string) => void
  /** Fired when the set of files in the shared project changes. */
  onFilesetChange: () => void
}

/**
 * One shared LaTeX project. All text files live in a Y.Map<path, Y.Text>,
 * binary assets in a Y.Map<path, Uint8Array>. Sync + awareness messages are
 * exchanged with every swarm peer (relayed through the main process), using
 * the same wire format as y-websocket. Every change — local or remote — is
 * flushed back to disk so each collaborator compiles locally from real files.
 */
export class CollabSession {
  readonly doc = new Y.Doc()
  readonly awareness = new awarenessProtocol.Awareness(this.doc)
  readonly files: Y.Map<Y.Text>
  readonly assets: Y.Map<Uint8Array>
  readonly meta: Y.Map<string>
  readonly role: 'host' | 'joiner'

  private root: string
  private cb: CollabCallbacks
  private disposers: (() => void)[] = []
  private writeTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Content we last wrote to (or loaded from) disk, to tell our writes from external ones. */
  private diskState = new Map<string, string>()
  private synced = false
  private destroyed = false
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * Create a session, restoring the CRDT snapshot from a previous run if one
   * exists. Restored sessions skip initial-materialization (their folder is
   * already real) — call reconcileWithDisk() afterwards to fold in edits made
   * while offline.
   */
  static async create(
    root: string,
    role: 'host' | 'joiner',
    userName: string,
    cb: CollabCallbacks
  ): Promise<{ session: CollabSession; restored: boolean }> {
    const session = new CollabSession(root, role, userName, cb)
    let restored = false
    try {
      const snapshot = await window.api.readBinaryFile(root, SNAPSHOT_FILE)
      if (snapshot.byteLength > 0) {
        Y.applyUpdate(session.doc, snapshot, 'snapshot')
        session.synced = true // we already hold real state; never re-materialize
        restored = true
      }
    } catch {
      /* no snapshot — fresh session */
    }
    return { session, restored }
  }

  constructor(root: string, role: 'host' | 'joiner', userName: string, cb: CollabCallbacks) {
    this.root = root
    this.role = role
    this.cb = cb
    this.files = this.doc.getMap('files')
    this.assets = this.doc.getMap('assets')
    this.meta = this.doc.getMap('meta')

    const color = CURSOR_COLORS[Math.abs(hashCode(userName)) % CURSOR_COLORS.length]
    this.awareness.setLocalStateField('user', { name: userName, color, colorLight: color + '55' })

    this.doc.on('update', this.onDocUpdate)
    this.doc.on('update', this.scheduleSnapshot)
    this.awareness.on('update', this.onAwarenessUpdate)

    this.disposers.push(
      window.api.onPeerJoined((peerId) => this.introduceTo(peerId)),
      window.api.onPeerData((peerId, data) => this.onPeerMessage(peerId, data)),
      window.api.onPeerLeft(() => {
        /* awareness states of dead peers expire via the protocol's 30s timeout */
      })
    )

    this.files.observeDeep((events, tx) => this.onFilesEvent(events, tx))
    this.assets.observe((event, tx) => this.onAssetsEvent(event, tx))
  }

  // ---- persistence --------------------------------------------------------

  private scheduleSnapshot = (): void => {
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer)
    this.snapshotTimer = setTimeout(() => this.saveSnapshotNow(), 1500)
  }

  async saveSnapshotNow(): Promise<void> {
    if (this.destroyed) return
    await window.api
      .writeBinaryFile(this.root, SNAPSHOT_FILE, Y.encodeStateAsUpdate(this.doc))
      .catch(() => {})
  }

  /**
   * Fold offline changes into a restored session: disk content wins for files
   * that exist on disk; files present only in the CRDT are re-materialized
   * (safer than propagating a possibly-accidental offline delete).
   */
  async reconcileWithDisk(tree: TreeNode[]): Promise<void> {
    const diskPaths = new Set<string>()
    const walk = (nodes: TreeNode[]): void => {
      for (const n of nodes) {
        if (n.type === 'dir') walk(n.children ?? [])
        else diskPaths.add(n.path)
      }
    }
    walk(tree)

    for (const path of diskPaths) {
      if (isTextPath(path)) {
        const content = await window.api.readTextFile(this.root, path).catch(() => null)
        if (content === null) continue
        this.diskState.set(path, content)
        const existing = this.files.get(path)
        if (!existing) {
          this.doc.transact(() => this.files.set(path, new Y.Text(content)), 'disk')
        } else if (existing.toString() !== content) {
          this.doc.transact(() => {
            existing.delete(0, existing.length)
            existing.insert(0, content)
          }, 'disk')
        }
      } else {
        const st = await window.api.stat(this.root, path)
        if (!st || st.size > MAX_ASSET_SYNC_BYTES) continue
        const data = await window.api.readBinaryFile(this.root, path)
        const current = this.assets.get(path)
        if (!current || !bytesEqual(current, data)) {
          this.doc.transact(() => this.assets.set(path, data), 'disk')
        }
      }
    }

    for (const [path, ytext] of this.files.entries()) {
      if (!diskPaths.has(path)) {
        const content = ytext.toString()
        this.diskState.set(path, content)
        await window.api.writeTextFile(this.root, path, content)
      }
    }
    for (const [path, data] of this.assets.entries()) {
      if (!diskPaths.has(path)) {
        await window.api.writeBinaryFile(this.root, path, data)
      }
    }
  }

  // ---- outgoing -----------------------------------------------------------

  private onDocUpdate = (update: Uint8Array, origin: unknown): void => {
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, MSG_SYNC)
    syncProtocol.writeUpdate(enc, update)
    // relay to everyone except whoever sent it to us (they already have it)
    window.api.broadcast(encoding.toUint8Array(enc), typeof origin === 'string' ? origin : undefined)
  }

  private onAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown
  ): void => {
    const changed = [...added, ...updated, ...removed]
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, MSG_AWARENESS)
    encoding.writeVarUint8Array(
      enc,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed)
    )
    window.api.broadcast(encoding.toUint8Array(enc), typeof origin === 'string' ? origin : undefined)
  }

  /** Kick off sync with a newly connected peer. */
  private introduceTo(peerId: string): void {
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, MSG_SYNC)
    syncProtocol.writeSyncStep1(enc, this.doc)
    window.api.sendToPeer(peerId, encoding.toUint8Array(enc))

    const states = this.awareness.getStates()
    if (states.size > 0) {
      const aw = encoding.createEncoder()
      encoding.writeVarUint(aw, MSG_AWARENESS)
      encoding.writeVarUint8Array(
        aw,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...states.keys()])
      )
      window.api.sendToPeer(peerId, encoding.toUint8Array(aw))
    }
  }

  // ---- incoming -----------------------------------------------------------

  private onPeerMessage(peerId: string, data: Uint8Array): void {
    if (this.destroyed) return
    const dec = decoding.createDecoder(data)
    const type = decoding.readVarUint(dec)
    if (type === MSG_SYNC) {
      const enc = encoding.createEncoder()
      encoding.writeVarUint(enc, MSG_SYNC)
      const syncType = syncProtocol.readSyncMessage(dec, enc, this.doc, peerId)
      if (encoding.length(enc) > 1) {
        window.api.sendToPeer(peerId, encoding.toUint8Array(enc))
      }
      if (syncType === syncProtocol.messageYjsSyncStep2 && !this.synced) {
        this.synced = true
        this.materializeAll().then(() => {
          this.saveSnapshotNow()
          this.cb.onInitialSync()
        })
      }
    } else if (type === MSG_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(
        this.awareness,
        decoding.readVarUint8Array(dec),
        peerId
      )
    }
  }

  // ---- seeding / materialization -----------------------------------------

  /** Host: load the whole project folder into the CRDT before inviting anyone. */
  async seedFromDisk(tree: TreeNode[], mainTex: string | null): Promise<void> {
    const paths: { path: string; text: boolean }[] = []
    const walk = (nodes: TreeNode[]): void => {
      for (const n of nodes) {
        if (n.type === 'dir') walk(n.children ?? [])
        else paths.push({ path: n.path, text: isTextPath(n.path) })
      }
    }
    walk(tree)

    for (const { path, text } of paths) {
      if (text) {
        const content = await window.api.readTextFile(this.root, path)
        this.diskState.set(path, content)
        this.doc.transact(() => this.files.set(path, new Y.Text(content)), 'seed')
      } else {
        const st = await window.api.stat(this.root, path)
        if (st && st.size <= MAX_ASSET_SYNC_BYTES) {
          const data = await window.api.readBinaryFile(this.root, path)
          this.doc.transact(() => this.assets.set(path, data), 'seed')
        }
      }
    }
    if (mainTex) this.meta.set('mainTex', mainTex)
    this.synced = true // host is authoritative at t0; no initial sync to wait for
  }

  /** Joiner: write the whole synced project into the chosen folder. */
  private async materializeAll(): Promise<void> {
    for (const [path, ytext] of this.files.entries()) {
      const content = ytext.toString()
      this.diskState.set(path, content)
      await window.api.writeTextFile(this.root, path, content)
    }
    for (const [path, data] of this.assets.entries()) {
      await window.api.writeBinaryFile(this.root, path, data)
    }
  }

  // ---- CRDT -> disk -------------------------------------------------------

  private onFilesEvent(events: Y.YEvent<any>[], tx: Y.Transaction): void {
    const touched = new Set<string>()
    let filesetChanged = false
    for (const event of events) {
      if (event.target === this.files) {
        // top-level map: files added/removed
        for (const [key, change] of (event as Y.YMapEvent<Y.Text>).changes.keys) {
          if (change.action === 'delete') {
            filesetChanged = true
            this.diskState.delete(key)
            if (tx.origin !== 'disk') window.api.deletePath(this.root, key)
          } else {
            filesetChanged = true
            touched.add(key)
          }
        }
      } else {
        // Y.Text edit inside a file
        const key = event.path[0] ?? this.keyOf(event.target as Y.Text)
        if (typeof key === 'string') touched.add(key)
      }
    }
    for (const path of touched) this.scheduleDiskWrite(path, tx.origin)
    if (filesetChanged) this.cb.onFilesetChange()
  }

  private keyOf(ytext: Y.Text): string | null {
    for (const [k, v] of this.files.entries()) if (v === ytext) return k
    return null
  }

  private onAssetsEvent(event: Y.YMapEvent<Uint8Array>, tx: Y.Transaction): void {
    if (typeof tx.origin === 'string' && LOCAL_ONLY_ORIGINS.has(tx.origin)) return
    for (const [key, change] of event.changes.keys) {
      if (change.action === 'delete') {
        window.api.deletePath(this.root, key)
      } else {
        const data = this.assets.get(key)
        if (data) window.api.writeBinaryFile(this.root, key, data)
      }
    }
    this.cb.onFilesetChange()
  }

  private scheduleDiskWrite(path: string, origin: unknown): void {
    if (typeof origin === 'string' && LOCAL_ONLY_ORIGINS.has(origin)) return
    const existing = this.writeTimers.get(path)
    if (existing) clearTimeout(existing)
    this.writeTimers.set(
      path,
      setTimeout(async () => {
        this.writeTimers.delete(path)
        if (this.destroyed) return
        const ytext = this.files.get(path)
        if (!ytext) return
        const content = ytext.toString()
        if (this.diskState.get(path) === content) return
        this.diskState.set(path, content)
        await window.api.writeTextFile(this.root, path, content)
        this.cb.onRemoteFileChange(path)
      }, 400)
    )
  }

  // ---- disk -> CRDT (external edits, e.g. git pull or another editor) -----

  async handleExternalChange(event: FileChangeEvent): Promise<void> {
    const { path, type } = event
    if (type === 'unlink') {
      if (this.diskState.get(path) !== undefined || this.files.has(path)) {
        this.diskState.delete(path)
        this.doc.transact(() => this.files.delete(path), 'disk')
      }
      if (this.assets.has(path)) this.doc.transact(() => this.assets.delete(path), 'disk')
      return
    }
    if (type !== 'add' && type !== 'change') return

    if (isTextPath(path)) {
      const content = await window.api.readTextFile(this.root, path).catch(() => null)
      if (content === null || this.diskState.get(path) === content) return
      this.diskState.set(path, content)
      const existing = this.files.get(path)
      this.doc.transact(() => {
        if (existing) {
          if (existing.toString() !== content) {
            existing.delete(0, existing.length)
            existing.insert(0, content)
          }
        } else {
          this.files.set(path, new Y.Text(content))
        }
      }, 'disk')
    } else {
      const st = await window.api.stat(this.root, path)
      if (!st || st.size > MAX_ASSET_SYNC_BYTES) return
      const data = await window.api.readBinaryFile(this.root, path)
      const current = this.assets.get(path)
      if (current && bytesEqual(current, data)) return
      this.doc.transact(() => this.assets.set(path, data), 'disk')
    }
  }

  /** Y.Text for an open editor tab. */
  getText(path: string): Y.Text | null {
    return this.files.get(path) ?? null
  }

  private undoManagers = new Map<string, Y.UndoManager>()

  /** One undo manager per file for the session's lifetime, so undo history
   * survives tab switches and window focus changes. */
  getUndoManager(path: string): Y.UndoManager | null {
    const ytext = this.files.get(path)
    if (!ytext) return null
    let um = this.undoManagers.get(path)
    if (!um) {
      um = new Y.UndoManager(ytext)
      this.undoManagers.set(path, um)
    }
    return um
  }

  listFiles(): string[] {
    return [...this.files.keys(), ...this.assets.keys()]
  }

  destroy(): void {
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer)
    // final snapshot flush (fire-and-forget; destroyed flag not yet set)
    window.api
      .writeBinaryFile(this.root, SNAPSHOT_FILE, Y.encodeStateAsUpdate(this.doc))
      .catch(() => {})
    this.destroyed = true
    for (const t of this.writeTimers.values()) clearTimeout(t)
    this.writeTimers.clear()
    for (const um of this.undoManagers.values()) um.destroy()
    this.undoManagers.clear()
    for (const d of this.disposers) d()
    this.awareness.destroy()
    this.doc.destroy()
  }
}

function hashCode(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return h
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false
  return true
}
