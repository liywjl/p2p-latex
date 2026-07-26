/**
 * Thesis-scale stress benchmark. Generates a synthetic multi-chapter thesis,
 * then measures the same pipeline the app runs:
 *
 *   1. full compile (cold, then warm/incremental)
 *   2. quick compile of a single edited chapter (\includeonly wrapper,
 *      exactly what src/main/compiler.ts generates)
 *   3. error-log parsing and SyncTeX parsing at scale
 *   4. CRDT (Yjs) costs: seeding the whole project, the initial-sync payload
 *      a joiner downloads, per-keystroke update size, big-file edit latency
 *   5. opening the resulting PDF with pdf.js (what the viewer does)
 *
 * Usage: npx tsx tests/stress/run.ts [--dir <path>] [--chapters N] [--engine tectonic|latexmk|pdflatex]
 */
import { spawnSync } from 'child_process'
import { promises as fs } from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as Y from 'yjs'
import { generateThesis, DEFAULT_OPTIONS } from './generate'
import { parseLatexErrors } from '../../src/main/latex-log'
import { parseSyncTex, forwardSearch } from '../../src/main/synctex'

const BUILD_DIR = '.p2platex/build'
const QUICK_WRAPPER = '_p2platex_quick.tex'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 ? process.argv[i + 1] : undefined
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`
}
function fmtBytes(b: number): string {
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`
  if (b >= 1024) return `${(b / 1024).toFixed(0)} kB`
  return `${b} B`
}

const results: [string, string][] = []
function report(metric: string, value: string): void {
  results.push([metric, value])
  console.log(`  ${metric}: ${value}`)
}

/** Same argument sets as src/main/compiler.ts — keep in sync. */
function compileArgs(engine: string, buildAbs: string, target: string): string[] {
  switch (engine) {
    case 'latexmk':
      return [
        '-norc',
        '-latexoption=-no-shell-escape',
        '-pdf',
        '-interaction=nonstopmode',
        '-file-line-error',
        '-synctex=1',
        `-outdir=${buildAbs}`,
        target
      ]
    case 'tectonic':
      return ['-X', 'compile', '--synctex', '--keep-logs', '--outdir', buildAbs, target]
    default:
      return [
        '-no-shell-escape',
        '-interaction=nonstopmode',
        '-file-line-error',
        '-synctex=1',
        `-output-directory=${buildAbs}`,
        target
      ]
  }
}

function compile(
  engine: string,
  root: string,
  target: string
): { ms: number; ok: boolean; log: string } {
  const buildAbs = path.join(root, BUILD_DIR)
  const start = Date.now()
  const res = spawnSync(engine, compileArgs(engine, buildAbs, target), {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30 * 60 * 1000
  })
  const ms = Date.now() - start
  const stdout = (res.stdout ?? '') + (res.stderr ?? '')
  return { ms, ok: res.status === 0, log: stdout }
}

function pagesFromLog(log: string): number | null {
  const m = log.match(/Output written on .*\((\d+) pages?/)
  return m ? Number(m[1]) : null
}

async function main(): Promise<void> {
  const chapters = Number(arg('chapters') ?? DEFAULT_OPTIONS.chapters)
  const dir = path.resolve(arg('dir') ?? path.join(os.tmpdir(), 'p2platex-stress'))
  const opts = { ...DEFAULT_OPTIONS, chapters }

  console.log(`\n== Generating synthetic thesis (${chapters} chapters) in ${dir}`)
  let t = Date.now()
  const gen = await generateThesis(dir, opts)
  report('project generated', `${gen.files} files, ${fmtBytes(gen.bytes)} in ${fmtMs(Date.now() - t)}`)

  // ---- engine ------------------------------------------------------------
  const preferred = arg('engine')
  const engine =
    preferred ??
    ['latexmk', 'tectonic', 'pdflatex'].find(
      (e) => spawnSync('which', [e], { encoding: 'utf8' }).status === 0
    )
  if (!engine) {
    console.error('No TeX engine found (latexmk/tectonic/pdflatex) — compile benchmarks skipped.')
  } else {
    console.log(`\n== Compiling with ${engine}`)
    const buildAbs = path.join(dir, BUILD_DIR)
    await fs.mkdir(path.join(buildAbs, 'chapters'), { recursive: true })

    const cold = compile(engine, dir, 'main.tex')
    const logFile = await fs
      .readFile(path.join(buildAbs, 'main.log'), 'utf8')
      .catch(() => cold.log)
    if (!cold.ok) {
      console.error('--- compile failed; last 3000 chars of output ---')
      console.error((cold.log + logFile).slice(-3000))
      process.exitCode = 1
      return
    }
    const pages = pagesFromLog(logFile) ?? pagesFromLog(cold.log)
    report('full compile (cold)', fmtMs(cold.ms))
    report('document size', `${pages ?? '?'} pages`)

    const warm = compile(engine, dir, 'main.tex')
    report('full compile (warm)', fmtMs(warm.ms))

    // quick compile: exactly the wrapper compiler.ts writes
    const editedChapter = `chapters/chapter${String(Math.ceil(chapters / 2)).padStart(3, '0')}`
    await fs.writeFile(
      path.join(dir, QUICK_WRAPPER),
      `\\includeonly{${editedChapter}}\n\\input{main.tex}\n`
    )
    const quick = compile(engine, dir, QUICK_WRAPPER)
    const quickLog = await fs
      .readFile(path.join(buildAbs, QUICK_WRAPPER.replace('.tex', '.log')), 'utf8')
      .catch(() => quick.log)
    report(
      `quick compile (1 chapter, ${editedChapter})`,
      `${fmtMs(quick.ms)} (${pagesFromLog(quickLog) ?? '?'} pages typeset)${quick.ok ? '' : ' [FAILED]'}`
    )

    // ---- parsers at scale --------------------------------------------------
    console.log('\n== Parsers')
    const combined = [cold.log, logFile].join('\n')
    t = Date.now()
    const errors = parseLatexErrors(combined)
    report(
      `error-log parse (${fmtBytes(combined.length)})`,
      `${fmtMs(Date.now() - t)}, ${errors.length} diagnostics`
    )

    let synctexPath: string | null = null
    for (const f of ['main.synctex.gz', 'main.synctex']) {
      const abs = path.join(buildAbs, f)
      if (await fs.stat(abs).then((s) => s.isFile()).catch(() => false)) {
        synctexPath = abs
        break
      }
    }
    if (synctexPath) {
      const raw = await fs.readFile(synctexPath)
      t = Date.now()
      const data = parseSyncTex(raw)
      const parseMs = Date.now() - t
      t = Date.now()
      forwardSearch(data, dir, `${editedChapter}.tex`, 10)
      report(
        `synctex parse (${fmtBytes(raw.length)})`,
        `${fmtMs(parseMs)}, forward search ${fmtMs(Date.now() - t)}`
      )
    }

    // ---- pdf.js open (what the viewer does) --------------------------------
    try {
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
      const data = new Uint8Array(await fs.readFile(path.join(buildAbs, 'main.pdf')))
      report('pdf file size', fmtBytes(data.length))
      t = Date.now()
      const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise
      const openMs = Date.now() - t
      t = Date.now()
      const mid = await doc.getPage(Math.floor(doc.numPages / 2))
      mid.getViewport({ scale: 1 })
      report(
        `pdf.js open (${doc.numPages} pages)`,
        `${fmtMs(openMs)}, middle page load ${fmtMs(Date.now() - t)}`
      )
    } catch (e) {
      report('pdf.js open', `skipped (${(e as Error).message.slice(0, 60)})`)
    }
  }

  // ---- CRDT / collaboration costs ----------------------------------------
  console.log('\n== Collaboration (Yjs CRDT)')
  const texFiles: { p: string; content: string }[] = []
  const walk = async (rel: string): Promise<void> => {
    for (const e of await fs.readdir(path.join(dir, rel || '.'), { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === QUICK_WRAPPER) continue
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) await walk(r)
      else if (/\.(tex|bib)$/.test(e.name))
        texFiles.push({ p: r, content: await fs.readFile(path.join(dir, r), 'utf8') })
    }
  }
  await walk('')

  // host seeds the project (share-this-project click)
  t = Date.now()
  const hostDoc = new Y.Doc()
  const files = hostDoc.getMap<Y.Text>('files')
  hostDoc.transact(() => {
    for (const f of texFiles) files.set(f.p, new Y.Text(f.content))
  })
  report(`seed ${texFiles.length} text files into CRDT`, fmtMs(Date.now() - t))

  // initial sync payload a joiner downloads
  t = Date.now()
  const snapshot = Y.encodeStateAsUpdate(hostDoc)
  const encodeMs = Date.now() - t
  t = Date.now()
  const joinerDoc = new Y.Doc()
  Y.applyUpdate(joinerDoc, snapshot)
  report(
    'initial sync payload',
    `${fmtBytes(snapshot.length)}, encode ${fmtMs(encodeMs)}, apply ${fmtMs(Date.now() - t)}`
  )

  // typing latency + per-keystroke update size in a large file, with a live peer
  const big = texFiles.reduce((a, b) => (a.content.length > b.content.length ? a : b))
  const ytext = files.get(big.p)!
  let updateBytes = 0
  let updates = 0
  const listener = (u: Uint8Array): void => {
    updateBytes += u.length
    updates++
    Y.applyUpdate(joinerDoc, u)
  }
  hostDoc.on('update', listener)
  const KEYSTROKES = 500
  t = Date.now()
  for (let i = 0; i < KEYSTROKES; i++) {
    ytext.insert(Math.floor(ytext.length / 2) + i, 'x')
  }
  const typeMs = Date.now() - t
  hostDoc.off('update', listener)
  report(
    `${KEYSTROKES} keystrokes in largest file (${fmtBytes(big.content.length)})`,
    `${fmtMs(typeMs)} total (${((typeMs / KEYSTROKES) * 1000).toFixed(0)} µs/keystroke), ` +
      `avg update ${Math.round(updateBytes / Math.max(updates, 1))} B`
  )

  console.log('\n== Summary')
  const width = Math.max(...results.map(([m]) => m.length))
  for (const [m, v] of results) console.log(`  ${m.padEnd(width)}  ${v}`)
  console.log()
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
