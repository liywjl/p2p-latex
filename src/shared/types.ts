export interface TreeNode {
  name: string
  path: string // relative to project root, posix separators
  type: 'file' | 'dir'
  children?: TreeNode[]
}

export interface EngineInfo {
  id: string // binary name, e.g. 'latexmk'
  label: string
  version: string
  path: string
}

export interface CompileError {
  file: string | null
  line: number | null
  message: string
  severity: 'error' | 'warning'
}

export interface CompileResult {
  ok: boolean
  pdfPath: string | null
  errors: CompileError[]
  log: string
  durationMs: number
}

export interface PeerInfo {
  id: string
}

export type SwarmStatus =
  | { mode: 'none' }
  | { mode: 'hosting'; inviteKey: string; peers: string[] }
  | { mode: 'joined'; inviteKey: string; peers: string[] }

export interface FileChangeEvent {
  type: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir'
  path: string // relative
}

/** File extensions treated as editable text (synced via CRDT). */
export const TEXT_EXTENSIONS = [
  '.tex', '.bib', '.sty', '.cls', '.bst', '.bbx', '.cbx', '.dbx', '.lbx',
  '.def', '.clo', '.txt', '.md', '.csv', '.dat', '.tikz', '.pgf', '.lco'
]

/** Generated \includeonly wrapper for quick compiles — lives in the project
 * root because TeX engines resolve \input relative to the primary file. */
export const QUICK_WRAPPER = '_p2platex_quick.tex'

/** Directories / files never shown, synced or watched. */
export const IGNORED_NAMES = ['.p2platex', '.git', 'node_modules', '.DS_Store', QUICK_WRAPPER]

/** Aux extensions hidden from the file tree. */
export const AUX_EXTENSIONS = [
  '.aux', '.log', '.out', '.toc', '.lof', '.lot', '.fls', '.fdb_latexmk',
  '.synctex.gz', '.bbl', '.blg', '.bcf', '.run.xml', '.nav', '.snm', '.vrb',
  '.xdv', '.idx', '.ilg', '.ind'
]

export const MAX_ASSET_SYNC_BYTES = 25 * 1024 * 1024

export function isTextPath(p: string): boolean {
  const lower = p.toLowerCase()
  return TEXT_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

export function isAuxPath(p: string): boolean {
  const lower = p.toLowerCase()
  return AUX_EXTENSIONS.some((ext) => lower.endsWith(ext))
}
