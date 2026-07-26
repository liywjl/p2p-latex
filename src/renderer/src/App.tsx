import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  TreeNode,
  EngineInfo,
  CompileResult,
  SwarmStatus,
  FileChangeEvent
} from '../../shared/types'
import { isTextPath } from '../../shared/types'
import {
  CollabSession,
  SavedSession,
  readSavedSession,
  writeSavedSession,
  forgetSavedSession
} from './lib/collab'
import { WelcomeScreen } from './components/WelcomeScreen'
import { FileTree } from './components/FileTree'
import { Editor, JumpTarget, EditorCommands } from './components/Editor'
import type { EditorState } from '@codemirror/state'
import { PdfViewer, PdfHighlight } from './components/PdfViewer'
import { SharePanel, Collaborator } from './components/SharePanel'
import { ErrorsPanel } from './components/ErrorsPanel'
import { EngineBanner } from './components/EngineBanner'

type CompileStatus = 'idle' | 'running' | 'ok' | 'error'

function useDebouncedCallback<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number
): (...args: A) => void {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const fnRef = useRef(fn)
  fnRef.current = fn
  return useCallback(
    (...args: A) => {
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => fnRef.current(...args), ms)
    },
    [ms]
  )
}

export default function App(): React.JSX.Element {
  const [root, setRoot] = useState<string | null>(null)
  const [tree, setTree] = useState<TreeNode[]>([])
  const [engines, setEngines] = useState<EngineInfo[] | null>(null)
  const [engineId, setEngineId] = useState<string | null>(null)
  const [mainTex, setMainTex] = useState<string | null>(null)
  const [tabs, setTabs] = useState<string[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [fileVersion, setFileVersion] = useState<Record<string, number>>({})
  const [compileStatus, setCompileStatus] = useState<CompileStatus>('idle')
  const [compileResult, setCompileResult] = useState<CompileResult | null>(null)
  const [pdfData, setPdfData] = useState<Uint8Array | null>(null)
  const [swarm, setSwarm] = useState<SwarmStatus>({ mode: 'none' })
  const [savedSession, setSavedSession] = useState<SavedSession | null>(null)
  const [collaborators, setCollaborators] = useState<Collaborator[]>([])
  const [shareEpoch, setShareEpoch] = useState(0)
  const [syncing, setSyncing] = useState(false)
  const [logOpen, setLogOpen] = useState(false)
  const [autoCompile, setAutoCompile] = useState(true)
  const [quickCompile, setQuickCompile] = useState(true)
  const [compileScope, setCompileScope] = useState<string>('full')
  const [jump, setJump] = useState<JumpTarget | null>(null)
  const [pdfHighlight, setPdfHighlight] = useState<PdfHighlight | null>(null)
  const [toasts, setToasts] = useState<{ id: number; kind: 'info' | 'error'; msg: string }[]>([])
  const [userName, setUserName] = useState(
    () => localStorage.getItem('userName') ?? `writer-${Math.floor(Math.random() * 1000)}`
  )

  const sessionRef = useRef<CollabSession | null>(null)
  const configLoadedForRef = useRef<string | null>(null)
  /** Content of our own last write per file — tells our save echoes apart
   * from genuinely external changes, so the editor (and its undo history)
   * is only reloaded when the file really changed under us. */
  const lastSavedRef = useRef(new Map<string, string>())
  /** .tex files edited since the last compile — the quick-compile targets. */
  const editedTexRef = useRef(new Set<string>())
  const editorCommandsRef = useRef<EditorCommands | null>(null)
  /** Editor states (incl. undo history + cursor) kept across tab switches. */
  const editorStateCacheRef = useRef(new Map<string, EditorState>())
  const completionIndexRef = useRef<{ cites: string[]; labels: string[] }>({
    cites: [],
    labels: []
  })
  const draftsRef = useRef(new Map<string, string>()) // unsaved buffers (non-shared mode only)
  const compileArgsRef = useRef({ root, mainTex, engineId, autoCompile, quickCompile })
  compileArgsRef.current = { root, mainTex, engineId, autoCompile, quickCompile }

  useEffect(() => {
    localStorage.setItem('userName', userName)
  }, [userName])

  const pushToast = useCallback((kind: 'info' | 'error', msg: string) => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t.slice(-3), { id, kind, msg }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000)
  }, [])

  // ---- engines ------------------------------------------------------------

  // compiles await this so an auto-compile right after startup can't race detection
  const detectPromiseRef = useRef<Promise<EngineInfo[]> | null>(null)

  const detectEngines = useCallback(async () => {
    const p = window.api.detectEngines()
    detectPromiseRef.current = p
    const found = await p
    setEngines(found)
    setEngineId((cur) => cur && found.some((e) => e.id === cur) ? cur : (found[0]?.id ?? null))
  }, [])

  useEffect(() => {
    detectEngines()
  }, [detectEngines])

  useEffect(() => window.api.onSwarmStatus(setSwarm), [])

  // dev-only smoke-test hook: auto-open a project passed via P2PLATEX_SMOKE
  useEffect(() => {
    window.api.getSmokeRoot().then((r) => {
      if (r) openProjectRef.current(r)
    })
  }, [])

  // application-menu actions (⌘Z/⇧⌘Z/⌘F arrive here, not as keystrokes —
  // the menu accelerator intercepts them before the page sees a keydown)
  const menuHandlersRef = useRef<Record<string, () => void>>({})
  useEffect(
    () =>
      window.api.onMenuAction((action) => {
        console.log(`[menu] ${action}`)
        const el = document.activeElement
        const inPlainInput =
          el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
        if (action === 'undo' || action === 'redo') {
          if (inPlainInput) {
            document.execCommand(action) // native inputs keep native history
          } else {
            editorCommandsRef.current?.[action]()
          }
          return
        }
        if (action === 'find') {
          if (!inPlainInput) editorCommandsRef.current?.find()
          return
        }
        menuHandlersRef.current[action]?.()
      }),
    []
  )

  // ---- compile ------------------------------------------------------------

  const compileNow = useCallback(
    async (manual = false): Promise<CompileResult | null> => {
      const { root, mainTex, quickCompile } = compileArgsRef.current
      let { engineId } = compileArgsRef.current
      if (!root) return null
      if (!engineId && detectPromiseRef.current) {
        const found = await detectPromiseRef.current.catch(() => [] as EngineInfo[])
        engineId = compileArgsRef.current.engineId ?? found[0]?.id ?? null
      }
      if (!engineId) {
        if (manual)
          pushToast('error', 'No LaTeX engine found — install one (see the banner) and re-detect')
        return null
      }
      if (!mainTex) {
        if (manual) pushToast('error', 'Pick a main .tex file in the toolbar first')
        return null
      }

      // Quick compile: if everything edited since the last run is an
      // \include'd chapter, typeset only those chapters. Manual = always full.
      let includeOnly: string | null = null
      const edited = [...editedTexRef.current]
      editedTexRef.current.clear()
      if (!manual && quickCompile && edited.length > 0 && !edited.includes(mainTex)) {
        const mainContent = await window.api.readTextFile(root, mainTex).catch(() => '')
        const includes = new Set(
          [...mainContent.matchAll(/\\include\{([^}]+)\}/g)].map((m) =>
            m[1].trim().replace(/\.tex$/i, '')
          )
        )
        const targets = edited.map((p) => p.replace(/\.tex$/i, ''))
        if (includes.size > 0 && targets.every((t) => includes.has(t))) {
          includeOnly = targets.join(',')
        }
      }
      const scope = includeOnly ? `quick: ${includeOnly}` : 'full'

      setCompileStatus('running')
      try {
        const result = await window.api.compile(root, mainTex, engineId, includeOnly)
        if (result.log === 'queued') return null // coalesced into an in-flight compile
        setCompileResult(result)
        setCompileScope(scope)
        setCompileStatus(result.ok ? 'ok' : 'error')
        console.log(
          `[compile] ok=${result.ok} scope=${scope} in ${result.durationMs}ms, ${result.errors.length} diagnostics`
        )
        if (result.pdfPath) {
          setPdfData(await window.api.getPdf(result.pdfPath))
        }
        return result
      } catch {
        setCompileStatus('error')
        return null
      }
    },
    [pushToast]
  )

  const compileSoon = useDebouncedCallback(compileNow, 1200)

  // ---- project open / tree ------------------------------------------------

  const refreshTree = useCallback(async (r: string) => {
    setTree(await window.api.readTree(r))
  }, [])
  const refreshTreeSoon = useDebouncedCallback(refreshTree, 300)

  /** Index \cite keys (.bib) and \label targets (.tex) across the project. */
  const rebuildCompletionIndex = useCallback(async (r: string) => {
    const nodes = await window.api.readTree(r)
    const cites: string[] = []
    const labels: string[] = []
    const files: { path: string; kind: 'bib' | 'tex' }[] = []
    const walk = (ns: TreeNode[]): void => {
      for (const n of ns) {
        if (n.type === 'dir') walk(n.children ?? [])
        else if (n.path.toLowerCase().endsWith('.bib')) files.push({ path: n.path, kind: 'bib' })
        else if (n.path.toLowerCase().endsWith('.tex')) files.push({ path: n.path, kind: 'tex' })
      }
    }
    walk(nodes)
    for (const f of files.slice(0, 500)) {
      const text = await window.api.readTextFile(r, f.path).catch(() => '')
      if (f.kind === 'bib') {
        for (const m of text.matchAll(/@\w+\s*\{\s*([^,\s{}]+)\s*,/g)) cites.push(m[1])
      } else {
        for (const m of text.matchAll(/\\label\{([^}]+)\}/g)) labels.push(m[1])
      }
    }
    completionIndexRef.current = { cites: [...new Set(cites)], labels: [...new Set(labels)] }
  }, [])
  const rebuildCompletionIndexSoon = useDebouncedCallback(rebuildCompletionIndex, 2000)

  const guessMainTex = useCallback(async (r: string, nodes: TreeNode[]): Promise<string | null> => {
    const texFiles: string[] = []
    const walk = (ns: TreeNode[]): void => {
      for (const n of ns) {
        if (n.type === 'dir') walk(n.children ?? [])
        else if (n.path.toLowerCase().endsWith('.tex')) texFiles.push(n.path)
      }
    }
    walk(nodes)
    if (texFiles.length === 0) return null
    const preferred = texFiles.find((p) => /^(main|thesis|dissertation|cv|report)\.tex$/i.test(p))
    if (preferred) return preferred
    // first file that declares a document class wins
    for (const p of texFiles.slice(0, 30)) {
      try {
        const head = (await window.api.readTextFile(r, p)).slice(0, 4000)
        if (head.includes('\\documentclass')) return p
      } catch {
        /* unreadable */
      }
    }
    return texFiles[0]
  }, [])

  const openProject = useCallback(
    async (r: string) => {
      const nodes = await window.api.readTree(r)
      setRoot(r)
      setTree(nodes)
      setTabs([])
      setActive(null)
      setPdfData(null)
      setCompileResult(null)
      setCompileStatus('idle')
      draftsRef.current.clear()
      lastSavedRef.current.clear()
      editorStateCacheRef.current.clear()
      await window.api.watchProject(r)
      const main = await guessMainTex(r, nodes)
      setMainTex(main)
      setSavedSession(await readSavedSession(r))
      // per-project settings override the guesses
      configLoadedForRef.current = null
      try {
        const cfg = JSON.parse(await window.api.readTextFile(r, '.p2platex/config.json'))
        if (cfg.mainTex) setMainTex(cfg.mainTex)
        if (cfg.engineId) setEngineId((cur) => cfg.engineId ?? cur)
        if (typeof cfg.autoCompile === 'boolean') setAutoCompile(cfg.autoCompile)
        if (typeof cfg.quickCompile === 'boolean') setQuickCompile(cfg.quickCompile)
      } catch {
        /* no config yet */
      }
      configLoadedForRef.current = r
      rebuildCompletionIndex(r)
      const recents: string[] = JSON.parse(localStorage.getItem('recentProjects') ?? '[]')
      localStorage.setItem(
        'recentProjects',
        JSON.stringify([r, ...recents.filter((x) => x !== r)].slice(0, 8))
      )
      if (main) setTimeout(compileNow, 100)
    },
    [guessMainTex, compileNow, rebuildCompletionIndex]
  )

  const openProjectRef = useRef(openProject)
  openProjectRef.current = openProject

  const pickAndOpenProject = useCallback(async () => {
    const r = await window.api.openFolderDialog()
    if (r) await openProject(r)
  }, [openProject])

  // persist per-project settings once they've been loaded for this root
  const saveConfig = useDebouncedCallback(() => {
    const { root, mainTex, engineId, autoCompile, quickCompile } = compileArgsRef.current
    if (!root || configLoadedForRef.current !== root) return
    window.api
      .writeTextFile(
        root,
        '.p2platex/config.json',
        JSON.stringify({ mainTex, engineId, autoCompile, quickCompile }, null, 2)
      )
      .catch(() => {})
  }, 500)

  useEffect(() => {
    saveConfig()
  }, [mainTex, engineId, autoCompile, quickCompile, saveConfig])

  // ---- file watching ------------------------------------------------------

  useEffect(() => {
    if (!root) return
    return window.api.onFileChanged((event: FileChangeEvent) => {
      refreshTreeSoon(root)
      const session = sessionRef.current
      if (session) {
        session.handleExternalChange(event)
      } else if (
        event.type === 'change' &&
        isTextPath(event.path) &&
        !draftsRef.current.has(event.path) // don't clobber unsaved edits
      ) {
        // Reload the editor only for genuinely external changes. Our own
        // auto-saves echo back through the watcher; remounting on those
        // would wipe the undo history and cursor a second after every save.
        window.api
          .readTextFile(root, event.path)
          .then((content) => {
            if (content !== lastSavedRef.current.get(event.path)) {
              setFileVersion((v) => ({ ...v, [event.path]: (v[event.path] ?? 0) + 1 }))
            }
          })
          .catch(() => {})
      }
      if (!session && /\.tex$/i.test(event.path) && event.type === 'change') {
        editedTexRef.current.add(event.path)
      }
      if (!session && autoCompile && /\.(tex|bib|sty|cls)$/i.test(event.path)) {
        compileSoon()
      }
      if (/\.(tex|bib)$/i.test(event.path)) rebuildCompletionIndexSoon(root)
    })
  }, [root, autoCompile, refreshTreeSoon, compileSoon, rebuildCompletionIndexSoon])

  // ---- editing / saving (non-shared mode) ----------------------------------

  const saveDraft = useDebouncedCallback(async (path: string) => {
    const { root } = compileArgsRef.current
    const content = draftsRef.current.get(path)
    if (!root || content === undefined) return
    lastSavedRef.current.set(path, content)
    await window.api.writeTextFile(root, path, content)
    draftsRef.current.delete(path)
    if (compileArgsRef.current.autoCompile && /\.(tex|bib|sty|cls)$/i.test(path)) compileSoon()
  }, 800)

  const onEditorChange = useCallback(
    (path: string, content: string) => {
      if (/\.tex$/i.test(path)) editedTexRef.current.add(path)
      if (sessionRef.current) return // CRDT observer handles persistence
      draftsRef.current.set(path, content)
      saveDraft(path)
    },
    [saveDraft]
  )

  const onEditorSave = useCallback(
    async (path: string, content: string | null) => {
      if (!sessionRef.current && root && content !== null) {
        draftsRef.current.delete(path)
        lastSavedRef.current.set(path, content)
        await window.api.writeTextFile(root, path, content)
      }
      compileNow(true)
    },
    [root, compileNow]
  )

  // ---- tabs ----------------------------------------------------------------

  const openFile = useCallback((path: string) => {
    if (!isTextPath(path)) return
    setTabs((t) => (t.includes(path) ? t : [...t, path]))
    setActive(path)
  }, [])

  const closeTab = useCallback(
    (path: string) => {
      setTabs((t) => {
        const next = t.filter((p) => p !== path)
        setActive((a) => (a === path ? next[next.length - 1] ?? null : a))
        return next
      })
    },
    []
  )

  const newFile = useCallback(
    async (dirPath?: string) => {
      if (!root) return
      const suggestion = dirPath ? `${dirPath}/` : ''
      const name = prompt('New file name (e.g. chapters/intro.tex):', suggestion)
      if (!name || name.endsWith('/')) return
      await window.api.writeTextFile(root, name, '')
      await refreshTree(root)
      if (sessionRef.current) {
        await sessionRef.current.handleExternalChange({ type: 'add', path: name })
      }
      openFile(name)
    },
    [root, refreshTree, openFile]
  )

  const renameNode = useCallback(
    async (node: TreeNode) => {
      if (!root) return
      const to = prompt(`Rename ${node.path} to:`, node.path)
      if (!to || to === node.path) return
      try {
        await window.api.renamePath(root, node.path, to)
      } catch (err) {
        pushToast('error', `Rename failed: ${err instanceof Error ? err.message : err}`)
        return
      }
      // fix up open tabs (works for files and files inside a renamed dir)
      const remap = (p: string): string =>
        p === node.path ? to : p.startsWith(node.path + '/') ? to + p.slice(node.path.length) : p
      setTabs((t) => t.map(remap))
      setActive((a) => (a ? remap(a) : a))
      draftsRef.current = new Map(
        [...draftsRef.current].map(([p, c]) => [remap(p), c] as [string, string])
      )
      await refreshTree(root)
      // sharing: the watcher's unlink+add events propagate the rename to peers
    },
    [root, refreshTree, pushToast]
  )

  const deleteNode = useCallback(
    async (node: TreeNode) => {
      if (!root) return
      if (!confirm(`Delete ${node.path}${node.type === 'dir' ? ' and everything in it' : ''}?`))
        return
      await window.api.deletePath(root, node.path)
      const gone = (p: string): boolean => p === node.path || p.startsWith(node.path + '/')
      setTabs((t) => {
        const next = t.filter((p) => !gone(p))
        setActive((a) => (a && gone(a) ? next[next.length - 1] ?? null : a))
        return next
      })
      for (const p of [...draftsRef.current.keys()]) if (gone(p)) draftsRef.current.delete(p)
      await refreshTree(root)
    },
    [root, refreshTree]
  )

  // ---- sharing --------------------------------------------------------------

  const makeCallbacks = useCallback(
    (r: string) => ({
      onInitialSync: async () => {
        setSyncing(false)
        await refreshTree(r)
        const session = sessionRef.current
        const main = session?.meta.get('mainTex') ?? null
        if (main) setMainTex(main)
        await window.api.watchProject(r)
        setTimeout(compileNow, 200)
      },
      onRemoteFileChange: (path: string) => {
        if (/\.tex$/i.test(path)) editedTexRef.current.add(path)
        if (compileArgsRef.current.autoCompile) compileSoon()
        if (/\.(tex|bib)$/i.test(path)) rebuildCompletionIndexSoon(r)
      },
      onFilesetChange: () => refreshTreeSoon(r)
    }),
    [refreshTree, refreshTreeSoon, compileNow, compileSoon, rebuildCompletionIndexSoon]
  )

  /** Resume a previously shared/joined project: restore CRDT state, fold in offline edits, reconnect. */
  const reconnectWith = useCallback(
    async (r: string, saved: SavedSession) => {
      const { session, restored } = await CollabSession.create(
        r,
        saved.role,
        userName,
        makeCallbacks(r)
      )
      sessionRef.current = session
      const nodes = await window.api.readTree(r)
      if (restored) {
        await session.reconcileWithDisk(nodes)
      } else if (saved.role === 'host') {
        await session.seedFromDisk(nodes, compileArgsRef.current.mainTex)
      }
      try {
        if (saved.role === 'host') await window.api.hostSession(saved.inviteKey)
        else await window.api.joinSession(saved.inviteKey)
      } catch (err) {
        session.destroy()
        sessionRef.current = null
        throw err
      }
      const sharedMain = session.meta.get('mainTex')
      if (sharedMain) setMainTex(sharedMain)
      setShareEpoch((e) => e + 1)
    },
    [userName, makeCallbacks]
  )

  const startSharing = useCallback(async () => {
    if (!root || sessionRef.current) return
    // flush unsaved drafts so the CRDT seeds from current content
    for (const [p, c] of draftsRef.current) await window.api.writeTextFile(root, p, c)
    draftsRef.current.clear()
    if (savedSession) {
      await reconnectWith(root, savedSession)
      return
    }
    const { session } = await CollabSession.create(root, 'host', userName, makeCallbacks(root))
    sessionRef.current = session
    await session.seedFromDisk(await window.api.readTree(root), mainTex)
    const inviteKey = await window.api.hostSession()
    const saved: SavedSession = { inviteKey, role: 'host', savedAt: new Date().toISOString() }
    await writeSavedSession(root, saved)
    await session.saveSnapshotNow()
    setSavedSession(saved)
    setShareEpoch((e) => e + 1)
  }, [root, userName, mainTex, savedSession, makeCallbacks, reconnectWith])

  const joinShared = useCallback(
    async (inviteKey: string, destFolder: string) => {
      const existing = await readSavedSession(destFolder)
      if (existing && existing.inviteKey === inviteKey.trim()) {
        // re-joining a folder we've synced before: merge, don't overwrite
        await openProject(destFolder)
        await reconnectWith(destFolder, existing)
        return
      }
      setRoot(destFolder)
      setTree([])
      setTabs([])
      setActive(null)
      setSyncing(true)
      const { session, restored } = await CollabSession.create(
        destFolder,
        'joiner',
        userName,
        makeCallbacks(destFolder)
      )
      sessionRef.current = session
      if (restored) setSyncing(false) // stale snapshot from another session still counts as state
      try {
        await window.api.joinSession(inviteKey)
      } catch (err) {
        session.destroy()
        sessionRef.current = null
        setSyncing(false)
        setRoot(null)
        throw err
      }
      const saved: SavedSession = {
        inviteKey: inviteKey.trim(),
        role: 'joiner',
        savedAt: new Date().toISOString()
      }
      await writeSavedSession(destFolder, saved)
      setSavedSession(saved)
      setShareEpoch((e) => e + 1)
    },
    [userName, makeCallbacks, openProject, reconnectWith]
  )

  const stopSharing = useCallback(async () => {
    await window.api.leaveSession()
    sessionRef.current?.destroy()
    sessionRef.current = null
    setCollaborators([])
    setShareEpoch((e) => e + 1)
  }, [])

  const reconnect = useCallback(async () => {
    if (!root || !savedSession || sessionRef.current) return
    try {
      await reconnectWith(root, savedSession)
      pushToast('info', 'Reconnected — waiting for peers')
    } catch (err) {
      pushToast('error', `Reconnect failed: ${err instanceof Error ? err.message : err}`)
    }
  }, [root, savedSession, reconnectWith, pushToast])

  const forgetSession = useCallback(async () => {
    if (!root) return
    if (sessionRef.current) await stopSharing()
    await forgetSavedSession(root)
    setSavedSession(null)
  }, [root, stopSharing])

  // collaborator presence from awareness
  useEffect(() => {
    const session = sessionRef.current
    if (!session) {
      setCollaborators([])
      return
    }
    const update = (): void => {
      const list: Collaborator[] = []
      for (const [clientId, state] of session.awareness.getStates()) {
        if (clientId === session.doc.clientID) continue
        const user = (state as { user?: { name: string; color: string } }).user
        if (user) list.push({ name: user.name, color: user.color })
      }
      setCollaborators(list)
    }
    session.awareness.on('change', update)
    update()
    return () => session.awareness.off('change', update)
  }, [shareEpoch])

  // ---- export ---------------------------------------------------------------

  const exportPdf = useCallback(async () => {
    let result = compileResult
    // never export a partial (quick) build — silently do a full compile first
    if (compileScope !== 'full' || !result?.pdfPath) {
      pushToast('info', 'Running a full compile before export…')
      result = await compileNow(true)
    }
    if (!result?.pdfPath) return
    const name = (mainTex ?? 'document').replace(/^.*\//, '').replace(/\.tex$/i, '.pdf')
    const dest = await window.api.exportPdf(result.pdfPath, name)
    if (dest) pushToast('info', `Exported to ${dest}`)
  }, [compileResult, compileScope, mainTex, pushToast, compileNow])

  // ---- synctex ----------------------------------------------------------------

  const syncToPdf = useCallback(
    async (path: string, line: number) => {
      const { root } = compileArgsRef.current
      if (!root || !compileResult?.pdfPath) return
      const res = await window.api.synctexForward(root, compileResult.pdfPath, path, line)
      if (res) {
        setPdfHighlight({ page: res.page, y: res.y, nonce: Date.now() })
        setTimeout(() => setPdfHighlight((h) => (h && Date.now() - h.nonce >= 2400 ? null : h)), 2500)
      } else {
        pushToast('info', 'No SyncTeX data for that line — compile first')
      }
    },
    [compileResult, pushToast]
  )

  const onPdfSyncClick = useCallback(
    async (page: number, xBp: number, yBp: number) => {
      const { root } = compileArgsRef.current
      if (!root || !compileResult?.pdfPath) return
      const res = await window.api.synctexInverse(root, compileResult.pdfPath, page, xBp, yBp)
      if (res) {
        openFile(res.file)
        setJump({ path: res.file, line: res.line, nonce: Date.now() })
      } else {
        pushToast('info', 'No source found for that spot')
      }
    },
    [compileResult, openFile, pushToast]
  )

  // populated each render so menu actions always call the latest callbacks
  menuHandlersRef.current = {
    openProject: pickAndOpenProject,
    newFile: () => newFile(),
    compile: () => compileNow(true),
    exportPdf
  }

  // ---- error click → jump ----------------------------------------------------

  const onErrorClick = useCallback(
    (file: string | null, line: number | null) => {
      const target = file ?? mainTex
      if (!target) return
      openFile(target)
      if (line) setJump({ path: target, line, nonce: Date.now() })
    },
    [mainTex, openFile]
  )

  // ---- derived ---------------------------------------------------------------

  const texFiles = useMemo(() => {
    const out: string[] = []
    const walk = (ns: TreeNode[]): void => {
      for (const n of ns) {
        if (n.type === 'dir') walk(n.children ?? [])
        else if (n.path.toLowerCase().endsWith('.tex')) out.push(n.path)
      }
    }
    walk(tree)
    return out
  }, [tree])

  const errorCount = compileResult?.errors.filter((e) => e.severity === 'error').length ?? 0

  if (!root) {
    return (
      <WelcomeScreen
        onOpenFolder={pickAndOpenProject}
        onJoin={joinShared}
        onOpenRecent={openProject}
      />
    )
  }

  const session = sessionRef.current

  return (
    <div className="app">
      <div className="toolbar">
        <span className="brand">P2P LaTeX</span>
        <button onClick={pickAndOpenProject} title="Open another project">Open</button>
        <button onClick={() => newFile()}>New file</button>
        <div className="spacer" />
        <select
          className="main-select"
          value={mainTex ?? ''}
          onChange={(e) => setMainTex(e.target.value || null)}
          title="Main .tex file"
        >
          <option value="">— main file —</option>
          {texFiles.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
        <select
          className="engine-select"
          value={engineId ?? ''}
          onChange={(e) => setEngineId(e.target.value || null)}
          title="LaTeX engine"
        >
          {(engines ?? []).length === 0 && <option value="">no engine found</option>}
          {(engines ?? []).map((e) => (
            <option key={e.id} value={e.id}>{e.id}</option>
          ))}
        </select>
        <label className="auto-toggle" title="Recompile automatically on save">
          <input
            type="checkbox"
            checked={autoCompile}
            onChange={(e) => setAutoCompile(e.target.checked)}
          />
          auto
        </label>
        <label
          className="auto-toggle"
          title={
            'Quick compile: auto-compiles rebuild only the \\include{…}\'d chapters you just edited ' +
            '(via \\includeonly), reusing page numbers and references from the last full build. ' +
            'Needs \\include (not \\input) for chapters. The Compile button always builds everything.'
          }
        >
          <input
            type="checkbox"
            checked={quickCompile}
            onChange={(e) => setQuickCompile(e.target.checked)}
          />
          quick
        </label>
        <button
          className="primary"
          onClick={() => compileNow(true)}
          disabled={!mainTex || !engineId || compileStatus === 'running'}
        >
          {compileStatus === 'running' ? 'Compiling…' : 'Compile'}
        </button>
        <button onClick={exportPdf} disabled={!compileResult?.pdfPath}>Export PDF</button>
      </div>

      {engines !== null && engines.length === 0 && <EngineBanner onRedetect={detectEngines} />}

      <div className="body">
        <div className="sidebar">
          <div className="sidebar-section files-section">
            <div className="sidebar-title">Files</div>
            <FileTree
              tree={tree}
              active={active}
              onOpen={openFile}
              onRename={renameNode}
              onDelete={deleteNode}
              onNewFile={(d) => newFile(d)}
            />
          </div>
          <SharePanel
            swarm={swarm}
            syncing={syncing}
            collaborators={collaborators}
            userName={userName}
            hasSavedSession={savedSession !== null}
            onUserNameChange={setUserName}
            onShare={startSharing}
            onReconnect={reconnect}
            onForget={forgetSession}
            onLeave={stopSharing}
          />
        </div>

        <div className="editor-pane">
          <div className="tabs">
            {tabs.map((p) => (
              <div
                key={p}
                className={`tab ${p === active ? 'active' : ''}`}
                onClick={() => setActive(p)}
              >
                <span>{p.replace(/^.*\//, '')}</span>
                <button
                  className="tab-close"
                  onClick={(ev) => {
                    ev.stopPropagation()
                    closeTab(p)
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          {active ? (
            <Editor
              key={`${active}:${shareEpoch}:${fileVersion[active] ?? 0}`}
              root={root}
              path={active}
              session={session}
              draft={draftsRef.current.get(active)}
              jump={jump && jump.path === active ? jump : null}
              onChange={onEditorChange}
              onSave={onEditorSave}
              onSyncToPdf={syncToPdf}
              completionIndex={completionIndexRef}
              commandsRef={editorCommandsRef}
              stateCache={editorStateCacheRef.current}
            />
          ) : (
            <div className="editor-empty">
              {syncing ? 'Syncing project from peers…' : 'Open a file from the sidebar'}
            </div>
          )}
        </div>

        <PdfViewer
          data={pdfData}
          status={compileStatus}
          highlight={pdfHighlight}
          onSyncClick={onPdfSyncClick}
        />
      </div>

      {toasts.length > 0 && (
        <div className="toasts">
          {toasts.map((t) => (
            <div key={t.id} className={`toast ${t.kind}`}>
              {t.msg}
            </div>
          ))}
        </div>
      )}

      {(compileResult || logOpen) && (
        <ErrorsPanel
          result={compileResult}
          expanded={logOpen}
          onToggle={() => setLogOpen((o) => !o)}
          onErrorClick={onErrorClick}
        />
      )}

      <div className="statusbar">
        <span className={`status-dot ${compileStatus}`} />
        <span>
          {compileStatus === 'running' && 'compiling…'}
          {compileStatus === 'ok' &&
            `compiled${compileScope === 'full' ? '' : ` (${compileScope})`} in ${((compileResult?.durationMs ?? 0) / 1000).toFixed(1)}s`}
          {compileStatus === 'error' && `${errorCount} error${errorCount === 1 ? '' : 's'}`}
          {compileStatus === 'idle' && 'ready'}
        </span>
        <div className="spacer" />
        {swarm.mode !== 'none' && (
          <span className="peers-badge">
            {swarm.mode === 'hosting' ? 'sharing' : 'joined'} · {swarm.peers.length} peer
            {swarm.peers.length === 1 ? '' : 's'}
          </span>
        )}
        <span className="root-path" title={root}>{root}</span>
      </div>
    </div>
  )
}
