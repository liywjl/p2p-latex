import type { CompileResult } from '../../../shared/types'

interface Props {
  result: CompileResult | null
  expanded: boolean
  onToggle: () => void
  onErrorClick: (file: string | null, line: number | null) => void
}

export function ErrorsPanel({ result, expanded, onToggle, onErrorClick }: Props): React.JSX.Element | null {
  if (!result) return null
  const errors = result.errors.filter((e) => e.severity === 'error')
  const warnings = result.errors.filter((e) => e.severity === 'warning')
  if (errors.length === 0 && warnings.length === 0 && !expanded) return null

  return (
    <div className={`errors-panel ${expanded ? 'expanded' : ''}`}>
      <div className="errors-header" onClick={onToggle}>
        <span>
          {errors.length > 0 && <span className="err-count">{errors.length} errors</span>}
          {warnings.length > 0 && <span className="warn-count">{warnings.length} warnings</span>}
          {errors.length === 0 && warnings.length === 0 && <span>log</span>}
        </span>
        <span className="expand-hint">{expanded ? 'hide full log ▾' : 'show full log ▸'}</span>
      </div>
      <div className="errors-list">
        {[...errors, ...warnings].slice(0, 50).map((e, i) => (
          <div
            key={i}
            className={`error-row ${e.severity}`}
            onClick={() => onErrorClick(e.file, e.line)}
          >
            <span className="error-loc">
              {e.file ?? ''}
              {e.line ? `:${e.line}` : ''}
            </span>
            <span className="error-msg">{e.message}</span>
          </div>
        ))}
      </div>
      {expanded && <pre className="full-log">{result.log}</pre>}
    </div>
  )
}
