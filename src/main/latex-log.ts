import { CompileError } from '../shared/types'

/**
 * Parse errors from -file-line-error output and log content.
 * Matches "./file.tex:12: message", "error: file.tex:12: message" (tectonic)
 * and bare "! message" lines.
 */
export function parseLatexErrors(log: string): CompileError[] {
  const errors: CompileError[] = []
  const seen = new Set<string>()
  const push = (e: CompileError): void => {
    const k = `${e.file}:${e.line}:${e.message}`
    if (!seen.has(k) && errors.length < 100) {
      seen.add(k)
      errors.push(e)
    }
  }
  const lines = log.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    let m = line.match(/^(?:error: )?(?:\.\/)?([^\s:]+\.\w+):(\d+): (.+)$/)
    if (m) {
      push({ file: m[1], line: parseInt(m[2], 10), message: m[3].trim(), severity: 'error' })
      continue
    }
    m = line.match(/^! (.+)$/)
    if (m) {
      // look ahead for "l.<num>" to recover the line number
      let lineNo: number | null = null
      for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
        const lm = lines[j].match(/^l\.(\d+)/)
        if (lm) {
          lineNo = parseInt(lm[1], 10)
          break
        }
      }
      push({ file: null, line: lineNo, message: m[1].trim(), severity: 'error' })
      continue
    }
    m = line.match(/^(?:LaTeX|Package \w+) Warning: (.+)$/)
    if (m) push({ file: null, line: null, message: m[1].trim(), severity: 'warning' })
  }
  return errors
}
