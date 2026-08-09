import * as zlib from 'zlib'
import * as path from 'path'

/**
 * Minimal SyncTeX parser — enough for forward (source line → PDF position)
 * and inverse (PDF click → source line) search.
 *
 * File shape (after gunzip):
 *   Input:<tag>:<path>          maps a tag to a source file
 *   {<page> ... }<page>         page blocks
 *   <kind><tag>,<line>:<x>,<y>[:...]   records; kind ∈ ( [ h v g k x r $
 * Coordinates are TeX scaled points (65536 sp = 1 TeX pt = 1/72.27 in),
 * origin top-left. PDF space uses big points (1/72 in).
 */

const SP_TO_BP = 72 / 72.27 / 65536

export interface SyncTexRecord {
  page: number
  tag: number
  line: number
  x: number // sp
  y: number // sp
}

export interface SyncTexData {
  inputs: Map<number, string>
  records: SyncTexRecord[]
}

const RECORD_RE = /^[([hvgkxr$](\d+),(\d+):(-?\d+),(-?\d+)/

export function parseSyncTex(raw: Buffer): SyncTexData {
  const content = (
    raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b ? zlib.gunzipSync(raw) : raw
  ).toString('latin1')
  const inputs = new Map<number, string>()
  const records: SyncTexRecord[] = []
  let page = 0
  for (const line of content.split('\n')) {
    const c = line.charCodeAt(0)
    if (c === 0x7b /* { */) {
      page = parseInt(line.slice(1), 10) || 0
    } else if (c === 0x7d /* } */) {
      page = 0
    } else if (page > 0) {
      const m = RECORD_RE.exec(line)
      if (m) {
        records.push({
          page,
          tag: parseInt(m[1], 10),
          line: parseInt(m[2], 10),
          x: parseInt(m[3], 10),
          y: parseInt(m[4], 10)
        })
      }
    } else if (line.startsWith('Input:')) {
      const m = /^Input:(\d+):(.+)$/.exec(line)
      if (m) inputs.set(parseInt(m[1], 10), m[2])
    }
  }
  return { inputs, records }
}

/** Tags whose input file resolves to `relFile` inside `root`. */
function tagsForFile(data: SyncTexData, root: string, relFile: string): Set<number> {
  const target = path.resolve(root, relFile)
  const tags = new Set<number>()
  for (const [tag, input] of data.inputs) {
    if (path.resolve(root, input) === target) tags.add(tag)
  }
  return tags
}

export interface ForwardResult {
  page: number
  x: number // bp from left
  y: number // bp from top
}

export function forwardSearch(
  data: SyncTexData,
  root: string,
  relFile: string,
  line: number
): ForwardResult | null {
  const tags = tagsForFile(data, root, relFile)
  if (tags.size === 0) return null
  let best: SyncTexRecord | null = null
  let bestScore = Infinity
  for (const r of data.records) {
    if (!tags.has(r.tag)) continue
    const d = r.line - line
    // prefer the record at the exact line, then the closest following, then preceding
    const score = d === 0 ? 0 : d > 0 ? d * 2 : -d * 2 + 1
    if (score < bestScore || (score === bestScore && best && r.y < best.y)) {
      bestScore = score
      best = r
    }
  }
  if (!best) return null
  return { page: best.page, x: best.x * SP_TO_BP, y: best.y * SP_TO_BP }
}

export interface InverseResult {
  file: string // relative to root
  line: number
}

export function inverseSearch(
  data: SyncTexData,
  root: string,
  page: number,
  xBp: number,
  yBp: number
): InverseResult | null {
  // only consider records from files inside the project
  const projectTags = new Map<number, string>()
  const absRoot = path.resolve(root)
  for (const [tag, input] of data.inputs) {
    const abs = path.resolve(root, input)
    if (abs === absRoot || abs.startsWith(absRoot + path.sep)) {
      projectTags.set(tag, path.relative(absRoot, abs).split(path.sep).join('/'))
    }
  }
  const xs = xBp / SP_TO_BP
  const ys = yBp / SP_TO_BP
  let best: SyncTexRecord | null = null
  let bestDist = Infinity
  for (const r of data.records) {
    if (r.page !== page || !projectTags.has(r.tag)) continue
    // vertical proximity matters much more than horizontal
    const dist = Math.abs(r.y - ys) * 4 + Math.abs(r.x - xs)
    if (dist < bestDist) {
      bestDist = dist
      best = r
    }
  }
  if (!best) return null
  return { file: projectTags.get(best.tag)!, line: best.line }
}
