import { useEffect, useRef } from 'react'
import { EditorState, Extension } from '@codemirror/state'
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  rectangularSelection
} from '@codemirror/view'
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  undo as cmUndo,
  redo as cmRedo
} from '@codemirror/commands'
import { searchKeymap, highlightSelectionMatches, openSearchPanel } from '@codemirror/search'
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  CompletionContext,
  CompletionResult,
  snippetCompletion
} from '@codemirror/autocomplete'
import { StreamLanguage, bracketMatching, indentUnit } from '@codemirror/language'
import { stex } from '@codemirror/legacy-modes/mode/stex'
import { oneDark } from '@codemirror/theme-one-dark'
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next'
import * as Y from 'yjs'
import type { CollabSession } from '../lib/collab'

export interface JumpTarget {
  path: string
  line: number
  nonce: number
}

export interface CompletionIndex {
  cites: string[]
  labels: string[]
}

/** Editor commands the app menu can invoke (⌘Z routes here, not to native undo). */
export interface EditorCommands {
  undo: () => void
  redo: () => void
  find: () => void
}

interface Props {
  root: string
  path: string
  session: CollabSession | null
  draft: string | undefined
  jump: JumpTarget | null
  onChange: (path: string, content: string) => void
  onSave: (path: string, content: string | null) => void
  onSyncToPdf: (path: string, line: number) => void
  completionIndex: React.MutableRefObject<CompletionIndex>
  commandsRef: React.MutableRefObject<EditorCommands | null>
  /** Per-file editor states so undo history and cursor survive tab switches. */
  stateCache: Map<string, EditorState>
}

const LATEX_SNIPPETS = [
  snippetCompletion('\\begin{${env}}\n\t${}\n\\end{${env}}', { label: '\\begin', detail: 'environment' }),
  snippetCompletion('\\section{${title}}', { label: '\\section' }),
  snippetCompletion('\\subsection{${title}}', { label: '\\subsection' }),
  snippetCompletion('\\subsubsection{${title}}', { label: '\\subsubsection' }),
  snippetCompletion('\\chapter{${title}}', { label: '\\chapter' }),
  snippetCompletion('\\textbf{${}}', { label: '\\textbf' }),
  snippetCompletion('\\textit{${}}', { label: '\\textit' }),
  snippetCompletion('\\emph{${}}', { label: '\\emph' }),
  snippetCompletion('\\cite{${key}}', { label: '\\cite' }),
  snippetCompletion('\\ref{${label}}', { label: '\\ref' }),
  snippetCompletion('\\label{${name}}', { label: '\\label' }),
  snippetCompletion('\\includegraphics[width=${0.8}\\linewidth]{${file}}', { label: '\\includegraphics' }),
  snippetCompletion('\\begin{figure}[htbp]\n\t\\centering\n\t\\includegraphics[width=0.8\\linewidth]{${file}}\n\t\\caption{${}}\n\t\\label{fig:${}}\n\\end{figure}', { label: 'figure', detail: 'figure environment' }),
  snippetCompletion('\\begin{table}[htbp]\n\t\\centering\n\t\\caption{${}}\n\t\\begin{tabular}{${lcc}}\n\t\t${}\n\t\\end{tabular}\n\\end{table}', { label: 'table', detail: 'table environment' }),
  snippetCompletion('\\begin{itemize}\n\t\\item ${}\n\\end{itemize}', { label: 'itemize' }),
  snippetCompletion('\\begin{enumerate}\n\t\\item ${}\n\\end{enumerate}', { label: 'enumerate' }),
  snippetCompletion('\\begin{equation}\n\t${}\n\\end{equation}', { label: 'equation' }),
  snippetCompletion('\\begin{align}\n\t${}\n\\end{align}', { label: 'align' }),
  snippetCompletion('\\frac{${num}}{${den}}', { label: '\\frac' }),
  snippetCompletion('\\usepackage{${pkg}}', { label: '\\usepackage' }),
  snippetCompletion('\\input{${file}}', { label: '\\input' }),
  snippetCompletion('\\include{${file}}', { label: '\\include' }),
  snippetCompletion('\\footnote{${}}', { label: '\\footnote' }),
  snippetCompletion('\\item ', { label: '\\item' }),
  snippetCompletion('\\tableofcontents', { label: '\\tableofcontents' }),
  snippetCompletion('\\bibliography{${refs}}', { label: '\\bibliography' }),
  snippetCompletion('\\documentclass{${article}}', { label: '\\documentclass' })
]

function latexCompletions(context: CompletionContext): CompletionResult | null {
  const word = context.matchBefore(/\\[a-zA-Z]*/)
  if (!word || (word.from === word.to && !context.explicit)) return null
  return { from: word.from, options: LATEX_SNIPPETS, validFor: /^\\[a-zA-Z]*$/ }
}

// ---- toolbar editing commands ----------------------------------------------

/** Wrap the selection in before…after; with no selection, place the cursor inside. */
function wrapSelection(view: EditorView, before: string, after: string): boolean {
  const { from, to } = view.state.selection.main
  const sel = view.state.sliceDoc(from, to)
  view.dispatch({
    changes: { from, to, insert: before + sel + after },
    selection:
      sel.length > 0
        ? { anchor: from + before.length + sel.length + after.length }
        : { anchor: from + before.length }
  })
  view.focus()
  return true
}

/** Insert a block template on its own line(s) at the cursor. */
function insertBlock(view: EditorView, text: string, cursorOffset: number): void {
  const { from } = view.state.selection.main
  const line = view.state.doc.lineAt(from)
  // non-empty line: start the block on a fresh line below; empty line: insert in place
  const prefix = line.length > 0 ? '\n' : ''
  const insertAt = line.length > 0 ? line.to : from
  view.dispatch({
    changes: { from: insertAt, insert: prefix + text },
    selection: { anchor: insertAt + prefix.length + cursorOffset }
  })
  view.focus()
}

/** Turn the selected lines into a list environment (or insert a template). */
function makeList(view: EditorView, env: 'itemize' | 'enumerate'): void {
  const { from, to } = view.state.selection.main
  const sel = view.state.sliceDoc(from, to).trim()
  if (sel.includes('\n') || sel.length > 0) {
    const items = sel
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => `  \\item ${l}`)
      .join('\n')
    const text = `\\begin{${env}}\n${items}\n\\end{${env}}`
    view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } })
    view.focus()
  } else {
    insertBlock(view, `\\begin{${env}}\n  \\item \n\\end{${env}}`, `\\begin{${env}}\n  \\item `.length)
  }
}

/** Toggle "% " comments on all selected lines (⌘/). */
function toggleLatexComment(view: EditorView): boolean {
  const { from, to } = view.state.selection.main
  const startLine = view.state.doc.lineAt(from).number
  const endLine = view.state.doc.lineAt(to).number
  const lines = []
  for (let n = startLine; n <= endLine; n++) lines.push(view.state.doc.line(n))
  const allCommented = lines.every((l) => /^\s*%/.test(l.text) || l.text.trim() === '')
  const changes = lines
    .map((l) => {
      if (allCommented) {
        const m = l.text.match(/^(\s*)% ?/)
        return m ? { from: l.from + m[1].length, to: l.from + m[0].length, insert: '' } : null
      }
      return l.text.trim() === '' ? null : { from: l.from, insert: '% ' }
    })
    .filter((c): c is NonNullable<typeof c> => c !== null)
  if (changes.length > 0) view.dispatch({ changes })
  view.focus()
  return true
}

/** Complete \cite{…} from .bib keys and \ref{…} from \label targets. */
function refCiteCompletions(indexRef: React.MutableRefObject<CompletionIndex>) {
  return (context: CompletionContext): CompletionResult | null => {
    const m = context.matchBefore(
      /\\(?:[a-zA-Z]*[cC]ite[a-zA-Z]*|ref|eqref|autoref|[cC]ref|pageref|vref)\s*\{[^{}]*/
    )
    if (!m) return null
    const cmd = /^\\([a-zA-Z]+)/.exec(m.text)![1].toLowerCase()
    const isCite = cmd.includes('cite')
    const keys = isCite ? indexRef.current.cites : indexRef.current.labels
    if (keys.length === 0) return null
    const brace = m.text.indexOf('{')
    const inner = m.text.slice(brace + 1)
    // cite lists can be comma-separated; complete the last segment
    const lastComma = isCite ? inner.lastIndexOf(',') : -1
    const from = m.from + brace + 1 + lastComma + 1
    return {
      from,
      options: keys.map((k) => ({ label: k, type: isCite ? 'constant' : 'variable' })),
      validFor: /^[^{},]*$/
    }
  }
}

export function Editor({
  root,
  path,
  session,
  draft,
  jump,
  onChange,
  onSave,
  onSyncToPdf,
  completionIndex,
  commandsRef,
  stateCache
}: Props): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const undoManagerRef = useRef<Y.UndoManager | null>(null)
  const propsRef = useRef({ onChange, onSave, onSyncToPdf })
  propsRef.current = { onChange, onSave, onSyncToPdf }

  // toolbar actions — work on whichever view is currently mounted
  const withView = (fn: (v: EditorView) => void) => (): void => {
    const v = viewRef.current
    if (v) fn(v)
  }
  const doUndo = withView((v) => {
    if (undoManagerRef.current) undoManagerRef.current.undo()
    else cmUndo(v)
    v.focus()
  })
  const doRedo = withView((v) => {
    if (undoManagerRef.current) undoManagerRef.current.redo()
    else cmRedo(v)
    v.focus()
  })

  // register with the app menu for the lifetime of this editor
  useEffect(() => {
    commandsRef.current = {
      undo: doUndo,
      redo: doRedo,
      find: withView((v) => openSearchPanel(v))
    }
    return () => {
      commandsRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toolbar: { label: string; title: string; run: () => void; wide?: boolean }[] = [
    { label: '↺', title: 'Undo (⌘Z)', run: doUndo },
    { label: '↻', title: 'Redo (⇧⌘Z)', run: doRedo },
    { label: 'B', title: 'Bold — \\textbf{…} (⌘B)', run: withView((v) => wrapSelection(v, '\\textbf{', '}')) },
    { label: 'I', title: 'Italic — \\textit{…} (⌘I)', run: withView((v) => wrapSelection(v, '\\textit{', '}')) },
    { label: 'U', title: 'Underline — \\underline{…}', run: withView((v) => wrapSelection(v, '\\underline{', '}')) },
    { label: '§', title: 'Section — \\section{…}', run: withView((v) => wrapSelection(v, '\\section{', '}')) },
    { label: '§§', title: 'Subsection — \\subsection{…}', run: withView((v) => wrapSelection(v, '\\subsection{', '}')) },
    { label: '••', title: 'Bullet list — itemize (turns selected lines into items)', run: withView((v) => makeList(v, 'itemize')) },
    { label: '1.', title: 'Numbered list — enumerate', run: withView((v) => makeList(v, 'enumerate')) },
    { label: '𝑥', title: 'Inline math — $…$', run: withView((v) => wrapSelection(v, '$', '$')) },
    { label: '∑', title: 'Equation block — \\begin{equation}', run: withView((v) => insertBlock(v, '\\begin{equation}\n  \n\\end{equation}', '\\begin{equation}\n  '.length)) },
    { label: '🖼', title: 'Figure — \\begin{figure} with \\includegraphics', run: withView((v) => insertBlock(v, '\\begin{figure}[htbp]\n  \\centering\n  \\includegraphics[width=0.8\\linewidth]{}\n  \\caption{}\n  \\label{fig:}\n\\end{figure}', '\\begin{figure}[htbp]\n  \\centering\n  \\includegraphics[width=0.8\\linewidth]{'.length)) },
    { label: '⊞', title: 'Table — \\begin{table} with tabular', run: withView((v) => insertBlock(v, '\\begin{table}[htbp]\n  \\centering\n  \\caption{}\n  \\begin{tabular}{lcc}\n     &  &  \\\\\n  \\end{tabular}\n\\end{table}', '\\begin{table}[htbp]\n  \\centering\n  \\caption{'.length)) },
    { label: '†', title: 'Footnote — \\footnote{…}', run: withView((v) => wrapSelection(v, '\\footnote{', '}')) },
    { label: '%', title: 'Toggle comment on selected lines (⌘/)', run: withView((v) => toggleLatexComment(v)) },
    { label: '🔍', title: 'Find & replace (⌘F)', run: withView((v) => openSearchPanel(v)) }
  ]

  useEffect(() => {
    let cancelled = false
    let view: EditorView | null = null
    let cacheStateOnUnmount = false

    const setup = async (): Promise<void> => {
      const ytext = session?.getText(path) ?? null
      let content: string
      if (ytext) {
        content = ytext.toString()
      } else {
        content = draft ?? (await window.api.readTextFile(root, path).catch(() => ''))
      }
      if (cancelled || !hostRef.current) return

      const collab = ytext && session
      const extensions: Extension[] = [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        drawSelection(),
        rectangularSelection(),
        bracketMatching(),
        closeBrackets(),
        highlightSelectionMatches(),
        autocompletion({ override: [refCiteCompletions(completionIndex), latexCompletions] }),
        StreamLanguage.define(stex),
        oneDark,
        indentUnit.of('  '),
        EditorView.lineWrapping,
        EditorView.theme({ '&': { height: '100%' }, '.cm-scroller': { overflow: 'auto' } }),
        EditorView.domEventHandlers({
          mousedown: (e, v) => {
            if (!(e.metaKey || e.ctrlKey)) return false
            const pos = v.posAtCoords({ x: e.clientX, y: e.clientY })
            if (pos === null) return false
            propsRef.current.onSyncToPdf(path, v.state.doc.lineAt(pos).number)
            return true
          }
        }),
        keymap.of([
          {
            key: 'Mod-s',
            run: (v) => {
              propsRef.current.onSave(path, collab ? null : v.state.doc.toString())
              return true
            }
          },
          { key: 'Mod-b', run: (v) => wrapSelection(v, '\\textbf{', '}') },
          { key: 'Mod-i', run: (v) => wrapSelection(v, '\\textit{', '}') },
          { key: 'Mod-/', run: (v) => toggleLatexComment(v) },
          ...(collab ? yUndoManagerKeymap : historyKeymap),
          ...defaultKeymap,
          ...searchKeymap,
          ...closeBracketsKeymap,
          ...completionKeymap,
          indentWithTab
        ])
      ]

      if (collab) {
        // per-file undo manager owned by the session, so undo history
        // survives tab switches and only ever reverts *your* edits
        const undoManager = session.getUndoManager(path) ?? new Y.UndoManager(ytext)
        undoManagerRef.current = undoManager
        extensions.push(yCollab(ytext, session.awareness, { undoManager }))
      } else {
        extensions.push(
          history(),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              propsRef.current.onChange(path, update.state.doc.toString())
            }
          })
        )
      }

      // reuse the cached state (undo history + cursor) if the file on disk
      // still matches what that state last contained
      const cached = !collab ? stateCache.get(path) : undefined
      const state =
        cached && cached.doc.toString() === content
          ? cached
          : EditorState.create({ doc: content, extensions })
      cacheStateOnUnmount = !collab

      view = new EditorView({ state, parent: hostRef.current })
      viewRef.current = view
      view.focus()
    }

    setup()
    return () => {
      cancelled = true
      if (cacheStateOnUnmount && view) {
        stateCache.set(path, view.state)
        // bound the cache — drop the oldest entries
        while (stateCache.size > 24) {
          const oldest = stateCache.keys().next().value
          if (oldest === undefined) break
          stateCache.delete(oldest)
        }
      }
      view?.destroy()
      viewRef.current = null
      undoManagerRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, path, session]) // draft is only the initial value; jump handled below

  useEffect(() => {
    const view = viewRef.current
    if (!view || !jump) return
    const lineNo = Math.min(Math.max(jump.line, 1), view.state.doc.lines)
    const line = view.state.doc.line(lineNo)
    view.dispatch({
      selection: { anchor: line.from },
      effects: EditorView.scrollIntoView(line.from, { y: 'center' })
    })
    view.focus()
  }, [jump])

  return (
    <div className="editor-wrap">
      <div className="editor-toolbar">
        {toolbar.map((b) => (
          <button
            key={b.title}
            className="tb-btn"
            title={b.title}
            onMouseDown={(e) => e.preventDefault() /* keep editor selection/focus */}
            onClick={b.run}
          >
            {b.label}
          </button>
        ))}
      </div>
      <div className="editor-host" ref={hostRef} />
    </div>
  )
}
