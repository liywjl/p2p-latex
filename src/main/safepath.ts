import * as path from 'path'

/**
 * Resolve a relative path inside root, refusing anything that would land
 * outside it. Hidden segments (dot-prefixed) are refused too — the app never
 * shows, syncs or watches them, and file paths arrive from remote peers via
 * the CRDT, so without this a malicious collaborator could write
 * `.git/hooks/pre-commit` (code execution on the victim's next commit) or
 * delete `.git` outright. The app's own `.p2platex` state directory is the
 * one allowed exception.
 */
export function safeJoin(root: string, rel: string): string {
  const abs = path.resolve(root, rel)
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`Path escapes project root: ${rel}`)
  }
  const segments = path.relative(root, abs).split(path.sep)
  const hidden = segments.findIndex((s) => s.startsWith('.'))
  if (hidden !== -1 && !(hidden === 0 && segments[0] === '.p2platex')) {
    throw new Error(`Hidden path refused: ${rel}`)
  }
  return abs
}
