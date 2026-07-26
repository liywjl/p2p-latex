import { useCallback, useEffect, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy, PDFDocumentLoadingTask } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

export interface PdfHighlight {
  page: number
  y: number // bp from top of page
  nonce: number
}

interface Props {
  data: Uint8Array | null
  status: 'idle' | 'running' | 'ok' | 'error'
  highlight: PdfHighlight | null
  onSyncClick: (page: number, xBp: number, yBp: number) => void
}

/**
 * Virtualized PDF view: every page gets a fixed-size placeholder, but a page
 * canvas is only rendered while it is near the viewport and is torn down when
 * it scrolls far away. A 2000-page thesis costs a few visible canvases, not
 * 2000. Scroll position and zoom survive recompiles.
 */
export function PdfViewer({ data, status, highlight, onSyncClick }: Props): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const docRef = useRef<PDFDocumentProxy | null>(null)
  const loadingTaskRef = useRef<PDFDocumentLoadingTask | null>(null)
  const [pageCount, setPageCount] = useState(0)
  const [pageSize, setPageSize] = useState<{ width: number; height: number } | null>(null)
  const [zoom, setZoom] = useState(1) // multiplier on fit-width
  const [containerWidth, setContainerWidth] = useState(800)
  const [docEpoch, setDocEpoch] = useState(0)
  const renderedRef = useRef(new Map<number, { canvas: HTMLCanvasElement; task: any }>())
  const observerRef = useRef<IntersectionObserver | null>(null)

  // track container width for fit-width scaling
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setContainerWidth(el.clientWidth))
    ro.observe(el)
    setContainerWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  // load document when bytes change
  useEffect(() => {
    if (!data) return
    let cancelled = false
    const scrollTop = containerRef.current?.scrollTop ?? 0
    ;(async () => {
      // pdf.js takes ownership of the buffer, so hand it a copy
      const task = pdfjs.getDocument({ data: data.slice() })
      task.promise.catch((err: unknown) => console.log('[pdf] load error:', String(err)))
      const doc = await task.promise
      if (cancelled) {
        task.destroy()
        return
      }
      const oldTask = loadingTaskRef.current
      loadingTaskRef.current = task
      docRef.current = doc
      const page1 = await doc.getPage(1)
      const vp = page1.getViewport({ scale: 1 })
      if (cancelled) return
      setPageSize({ width: vp.width, height: vp.height })
      setPageCount(doc.numPages)
      console.log(`[pdf] loaded ${doc.numPages} page(s)`)
      setDocEpoch((e) => e + 1)
      oldTask?.destroy()
      requestAnimationFrame(() => {
        if (containerRef.current) containerRef.current.scrollTop = scrollTop
      })
    })()
    return () => {
      cancelled = true
    }
  }, [data])

  const scale = pageSize ? ((containerWidth - 32) / pageSize.width) * zoom : 1

  const renderPage = useCallback(
    async (pageNo: number, holder: HTMLDivElement) => {
      const doc = docRef.current
      const canvasHolder = holder.querySelector<HTMLDivElement>('.pdf-canvas-holder')
      if (!doc || !canvasHolder || renderedRef.current.has(pageNo)) return
      const entry = { canvas: document.createElement('canvas'), task: null as any }
      renderedRef.current.set(pageNo, entry)
      try {
        const page = await doc.getPage(pageNo)
        const dpr = window.devicePixelRatio || 1
        // render at device resolution, display at CSS size
        const vp = page.getViewport({ scale: scale * dpr })
        entry.canvas.width = Math.floor(vp.width)
        entry.canvas.height = Math.floor(vp.height)
        entry.canvas.style.width = `${vp.width / dpr}px`
        entry.canvas.style.height = `${vp.height / dpr}px`
        entry.task = page.render({ canvas: entry.canvas, viewport: vp })
        await entry.task.promise
        canvasHolder.replaceChildren(entry.canvas)
      } catch {
        renderedRef.current.delete(pageNo)
      }
    },
    [scale]
  )

  const dropPage = useCallback((pageNo: number, holder: HTMLDivElement) => {
    const entry = renderedRef.current.get(pageNo)
    if (!entry) return
    entry.task?.cancel?.()
    renderedRef.current.delete(pageNo)
    holder.querySelector<HTMLDivElement>('.pdf-canvas-holder')?.replaceChildren()
  }, [])

  // (re)build the intersection observer whenever doc or scale changes
  useEffect(() => {
    const container = containerRef.current
    if (!container || pageCount === 0) return
    // clear everything rendered at the old scale/doc
    for (const [, entry] of renderedRef.current) entry.task?.cancel?.()
    renderedRef.current.clear()
    for (const holder of container.querySelectorAll<HTMLDivElement>('.pdf-canvas-holder')) {
      holder.replaceChildren()
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const holder = e.target as HTMLDivElement
          const pageNo = parseInt(holder.dataset.page!, 10)
          if (e.isIntersecting) renderPage(pageNo, holder)
          else dropPage(pageNo, holder)
        }
      },
      { root: container, rootMargin: '600px 0px' }
    )
    observerRef.current = observer
    for (const holder of container.querySelectorAll<HTMLDivElement>('.pdf-page')) {
      observer.observe(holder)
    }
    return () => observer.disconnect()
  }, [pageCount, scale, docEpoch, renderPage, dropPage])

  useEffect(
    () => () => {
      loadingTaskRef.current?.destroy()
    },
    []
  )

  // scroll the highlighted position into view when a forward search lands
  useEffect(() => {
    const container = containerRef.current
    if (!container || !highlight || !pageSize) return
    const holder = container.querySelector<HTMLDivElement>(
      `.pdf-page[data-page="${highlight.page}"]`
    )
    if (!holder) return
    const yPx = (highlight.y / pageSize.height) * holder.offsetHeight
    container.scrollTo({
      top: holder.offsetTop + yPx - container.clientHeight / 2,
      behavior: 'smooth'
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlight?.nonce])

  const pageW = pageSize ? pageSize.width * scale : 0
  const pageH = pageSize ? pageSize.height * scale : 0

  return (
    <div className="pdf-pane">
      <div className="pdf-toolbar">
        <button onClick={() => setZoom((z) => Math.max(0.25, z / 1.2))} title="Zoom out">−</button>
        <span className="zoom-label">{Math.round(zoom * 100)}%</span>
        <button onClick={() => setZoom((z) => Math.min(4, z * 1.2))} title="Zoom in">+</button>
        <button onClick={() => setZoom(1)} title="Fit width">fit</button>
        <div className="spacer" />
        {pageCount > 0 && <span className="page-count">{pageCount} pages</span>}
        {status === 'running' && <span className="compiling-badge">recompiling…</span>}
      </div>
      <div className="pdf-scroll" ref={containerRef}>
        {pageCount === 0 ? (
          <div className="pdf-empty">
            {status === 'running'
              ? 'Compiling…'
              : status === 'error'
                ? 'Compile failed — see errors below'
                : 'No PDF yet. Press Compile (or just save a file).'}
          </div>
        ) : (
          Array.from({ length: pageCount }, (_, i) => (
            <div
              key={`${docEpoch}:${i + 1}`}
              className="pdf-page"
              data-page={i + 1}
              style={{ width: pageW, height: pageH }}
              title="⌘-click to jump to the source line"
              onClick={(e) => {
                if (!(e.metaKey || e.ctrlKey) || !pageSize) return
                const rect = e.currentTarget.getBoundingClientRect()
                const xBp = ((e.clientX - rect.left) / rect.width) * pageSize.width
                const yBp = ((e.clientY - rect.top) / rect.height) * pageSize.height
                onSyncClick(i + 1, xBp, yBp)
              }}
            >
              <div className="pdf-canvas-holder" />
              {highlight && highlight.page === i + 1 && pageSize && (
                <div
                  key={highlight.nonce}
                  className="sync-flash"
                  style={{ top: `${(highlight.y / pageSize.height) * 100}%` }}
                />
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
