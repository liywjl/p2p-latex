import { ipcMain, BrowserWindow } from 'electron'
import { spawn } from 'child_process'
import { promises as fs } from 'fs'
import * as path from 'path'
import * as os from 'os'
import { EngineInfo, CompileResult, CompileError, QUICK_WRAPPER } from '../shared/types'
import { parseLatexErrors } from './latex-log'
import { parseSyncTex, forwardSearch, inverseSearch, SyncTexData } from './synctex'

export const BUILD_DIR = '.p2platex/build'

/**
 * GUI apps on macOS don't inherit the shell PATH, so TeX distributions
 * installed via MacTeX/homebrew/cargo are invisible unless we add their
 * standard locations explicitly.
 */
async function buildPath(): Promise<string> {
  const home = os.homedir()
  const candidates = [
    '/Library/TeX/texbin', // MacTeX / BasicTeX
    '/opt/homebrew/bin',
    '/usr/local/bin',
    `${home}/.cargo/bin`, // tectonic via cargo
    `${home}/bin`,
    `${home}/.local/bin`
  ]
  // TeX Live manual installs: /usr/local/texlive/<year>/bin/<arch>
  try {
    const years = await fs.readdir('/usr/local/texlive')
    for (const y of years.reverse()) {
      try {
        const arches = await fs.readdir(`/usr/local/texlive/${y}/bin`)
        for (const a of arches) candidates.push(`/usr/local/texlive/${y}/bin/${a}`)
      } catch {
        /* not a texlive year dir */
      }
    }
  } catch {
    /* no manual texlive */
  }
  const existing: string[] = []
  for (const c of candidates) {
    try {
      await fs.access(c)
      existing.push(c)
    } catch {
      /* skip */
    }
  }
  return [...existing, process.env.PATH ?? ''].join(path.delimiter)
}

function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env: NodeJS.ProcessEnv; timeoutMs: number }
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs)
    child.stdout.on('data', (d) => {
      if (stdout.length < 2_000_000) stdout += d.toString()
    })
    child.stderr.on('data', (d) => {
      if (stderr.length < 500_000) stderr += d.toString()
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ code: null, stdout, stderr })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout: stdout.slice(0, 2_000_000), stderr: stderr.slice(0, 500_000) })
    })
  })
}

const ENGINE_CANDIDATES: { id: string; label: string }[] = [
  { id: 'latexmk', label: 'latexmk (recommended — incremental builds)' },
  { id: 'tectonic', label: 'Tectonic (self-contained, auto-fetches packages)' },
  { id: 'pdflatex', label: 'pdfLaTeX' },
  { id: 'xelatex', label: 'XeLaTeX' },
  { id: 'lualatex', label: 'LuaLaTeX' }
]

async function detectEngines(): Promise<EngineInfo[]> {
  const PATH = await buildPath()
  const env = { ...process.env, PATH }
  const found: EngineInfo[] = []
  await Promise.all(
    ENGINE_CANDIDATES.map(async ({ id, label }) => {
      const which = await run('/usr/bin/which', [id], { env, timeoutMs: 5000 })
      if (which.code !== 0) return
      const binPath = which.stdout.trim()
      const ver = await run(id, ['--version'], { env, timeoutMs: 10000 })
      const version = (ver.stdout || ver.stderr).split('\n')[0]?.trim() ?? ''
      found.push({ id, label, version, path: binPath })
    })
  )
  // preserve preference order
  found.sort(
    (a, b) =>
      ENGINE_CANDIDATES.findIndex((c) => c.id === a.id) -
      ENGINE_CANDIDATES.findIndex((c) => c.id === b.id)
  )
  return found
}

interface CompileRequest {
  root: string
  mainTex: string
  engine: string
  /** Comma-separated \include names — compile only these chapters via \includeonly. */
  includeOnly?: string | null
}

/** Mirror the project's directory structure into the build dir: with
 * -output-directory, TeX cannot create `chapters/intro.aux` unless
 * `<build>/chapters/` already exists. */
async function mirrorDirs(root: string, buildAbs: string, dir = ''): Promise<void> {
  const entries = await fs.readdir(path.join(root, dir), { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const rel = dir ? `${dir}/${entry.name}` : entry.name
    await fs.mkdir(path.join(buildAbs, rel), { recursive: true })
    await mirrorDirs(root, buildAbs, rel)
  }
}

let compiling = false
let pending: CompileRequest | null = null

async function doCompile(req: CompileRequest): Promise<CompileResult> {
  const start = Date.now()
  const { root, mainTex, engine } = req
  const buildAbs = path.join(root, BUILD_DIR)
  await fs.mkdir(buildAbs, { recursive: true })
  await mirrorDirs(root, buildAbs)
  const PATH = await buildPath()
  const env = { ...process.env, PATH }

  // quick compile: typeset only the chapters being edited; page numbers and
  // cross-references for the rest come from the aux files of past builds
  let target = mainTex
  let base = path.basename(mainTex).replace(/\.tex$/i, '')
  if (req.includeOnly) {
    await fs.writeFile(
      path.join(root, QUICK_WRAPPER),
      `\\includeonly{${req.includeOnly}}\n\\input{${mainTex.split(path.sep).join('/')}}\n`,
      'utf8'
    )
    target = QUICK_WRAPPER
    base = QUICK_WRAPPER.replace(/\.tex$/, '')
  }

  // Shared projects can come from strangers, so compiling must never execute
  // arbitrary code: -norc stops latexmk from running a project-local
  // .latexmkrc (which is Perl), and -no-shell-escape overrides any
  // distribution config that enables \write18. Tectonic sandboxes by default
  // (shell escape is opt-in via -Z shell-escape, which we never pass).
  let args: string[]
  switch (engine) {
    case 'latexmk':
      args = [
        '-norc',
        '-latexoption=-no-shell-escape',
        '-pdf',
        '-interaction=nonstopmode',
        '-file-line-error',
        '-synctex=1',
        `-outdir=${buildAbs}`,
        target
      ]
      break
    case 'tectonic':
      args = ['-X', 'compile', '--synctex', '--keep-logs', '--outdir', buildAbs, target]
      break
    default:
      // pdflatex / xelatex / lualatex single pass
      args = [
        '-no-shell-escape',
        '-interaction=nonstopmode',
        '-file-line-error',
        '-synctex=1',
        `-output-directory=${buildAbs}`,
        target
      ]
  }

  const res = await run(engine, args, { cwd: root, env, timeoutMs: 10 * 60 * 1000 })

  let logContent = ''
  try {
    logContent = await fs.readFile(path.join(buildAbs, `${base}.log`), 'utf8')
  } catch {
    /* no log file */
  }
  const combined = [res.stdout, res.stderr, logContent].join('\n')
  const errors = parseLatexErrors(combined)

  const pdfPath = path.join(buildAbs, `${base}.pdf`)
  let pdfExists = false
  try {
    await fs.access(pdfPath)
    pdfExists = true
  } catch {
    /* no pdf */
  }

  const ok = res.code === 0 && pdfExists
  if (!ok && errors.filter((e) => e.severity === 'error').length === 0) {
    errors.unshift({
      file: null,
      line: null,
      message:
        res.code === null
          ? `Failed to start "${engine}" — is it installed and on PATH?`
          : `${engine} exited with code ${res.code}. See full log.`,
      severity: 'error'
    })
  }

  return {
    ok,
    pdfPath: pdfExists ? pdfPath : null,
    errors,
    log: combined.slice(-200_000),
    durationMs: Date.now() - start
  }
}

export function registerCompilerIpc(): void {
  ipcMain.handle('compiler:detect', () => detectEngines())

  ipcMain.handle('compiler:compile', async (e, req: CompileRequest): Promise<CompileResult> => {
    const win = BrowserWindow.fromWebContents(e.sender)
    // Coalesce: if a compile is running, remember only the latest request.
    if (compiling) {
      pending = req
      return { ok: false, pdfPath: null, errors: [], log: 'queued', durationMs: 0 }
    }
    compiling = true
    try {
      let result = await doCompile(req)
      while (pending) {
        const next = pending
        pending = null
        result = await doCompile(next)
      }
      return result
    } finally {
      compiling = false
      win?.webContents.send('compiler:idle')
    }
  })

  ipcMain.handle('compiler:getPdf', async (_e, pdfPath: string) => {
    const buf = await fs.readFile(pdfPath)
    return new Uint8Array(buf)
  })

  // ---- synctex ------------------------------------------------------------

  let synctexCache: { file: string; mtimeMs: number; data: SyncTexData } | null = null

  async function loadSyncTex(pdfPath: string): Promise<SyncTexData | null> {
    for (const ext of ['.synctex.gz', '.synctex']) {
      const file = pdfPath.replace(/\.pdf$/i, ext)
      try {
        const st = await fs.stat(file)
        if (synctexCache && synctexCache.file === file && synctexCache.mtimeMs === st.mtimeMs) {
          return synctexCache.data
        }
        const data = parseSyncTex(await fs.readFile(file))
        synctexCache = { file, mtimeMs: st.mtimeMs, data }
        return data
      } catch {
        /* try next extension */
      }
    }
    return null
  }

  ipcMain.handle(
    'synctex:forward',
    async (_e, root: string, pdfPath: string, relFile: string, line: number) => {
      const data = await loadSyncTex(pdfPath)
      return data ? forwardSearch(data, root, relFile, line) : null
    }
  )

  ipcMain.handle(
    'synctex:inverse',
    async (_e, root: string, pdfPath: string, page: number, xBp: number, yBp: number) => {
      const data = await loadSyncTex(pdfPath)
      return data ? inverseSearch(data, root, page, xBp, yBp) : null
    }
  )
}
