import { useEffect, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import { apiFetch } from '../api'
import type {
  PageText,
  Position,
  ReaderNavHandle,
  ReaderSearchTarget,
  ReflowProgress,
} from '../types'
import type { ReaderPageNavigationState } from '../readerNavigation'
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy } from '../pdfRuntime'
import '../styles/pdf-reader.css'

interface PdfViewerProps {
  bookId: string
  pageIdx: number
  pageCount: number
  setPageIdx?: (page: number) => Promise<unknown> | undefined
  pageText?: PageText | null
  currentSentence?: number
  activePageIdx?: number
  isPlaying?: boolean
  onProgress?: (progress: ReflowProgress) => void
  onNavigationState?: (state: ReaderPageNavigationState) => void
  navRef?: MutableRefObject<ReaderNavHandle>
  searchTarget?: ReaderSearchTarget | null
  onSentenceSelect?: (page: number, sentence: number, options?: { progress?: number }) => void
  onVisualPositionChange?: (position: Position) => void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default function PdfViewer({
  bookId,
  pageIdx,
  pageCount,
  setPageIdx,
  pageText,
  currentSentence = -1,
  activePageIdx = pageIdx,
  isPlaying = false,
  onProgress,
  onNavigationState,
  navRef,
  searchTarget,
  onSentenceSelect,
  onVisualPositionChange,
}: PdfViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const documentRef = useRef<PDFDocumentProxy | null>(null)
  const loadingTaskRef = useRef<PDFDocumentLoadingTask | null>(null)
  const renderTaskRef = useRef<{ cancel: () => void } | null>(null)
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null)
  const [renderVersion, setRenderVersion] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    let disposed = false
    setLoading(true)
    setError('')
    ;(async () => {
      try {
        const response = await apiFetch(`/api/book/${bookId}/source`, { signal: controller.signal })
        if (!response.ok) throw new Error('The original PDF could not be opened from local storage.')
        const bytes = new Uint8Array(await response.arrayBuffer())
        const { getDocument, standardFontDataUrl } = await import('../pdfRuntime')
        const task = getDocument({ data: bytes, standardFontDataUrl, useSystemFonts: false })
        loadingTaskRef.current = task
        const next = await task.promise
        if (disposed) {
          await task.destroy()
          return
        }
        documentRef.current = next
        setDocument(next)
      } catch (cause) {
        if (!disposed && !(cause instanceof DOMException && cause.name === 'AbortError')) {
          setError(errorMessage(cause))
        }
      } finally {
        if (!disposed) setLoading(false)
      }
    })()
    return () => {
      disposed = true
      controller.abort()
      renderTaskRef.current?.cancel()
      documentRef.current = null
      setDocument(null)
      const task = loadingTaskRef.current
      loadingTaskRef.current = null
      if (task) void task.destroy()
    }
  }, [bookId])

  useEffect(() => {
    const element = containerRef.current
    if (!element || typeof ResizeObserver === 'undefined') return
    let frame = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setRenderVersion((value) => value + 1))
    })
    observer.observe(element)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [])

  useEffect(() => {
    if (!document || !canvasRef.current || !containerRef.current || !stageRef.current) return
    let disposed = false
    let page: PDFPageProxy | null = null
    setLoading(true)
    setError('')
    ;(async () => {
      try {
        page = await document.getPage(Math.min(document.numPages, Math.max(1, pageIdx + 1)))
        if (disposed || !canvasRef.current || !containerRef.current || !stageRef.current) return
        const natural = page.getViewport({ scale: 1 })
        const availableWidth = Math.max(280, containerRef.current.clientWidth - 40)
        const availableHeight = Math.max(360, window.innerHeight - 190)
        const scale = Math.min(2.25, availableWidth / natural.width, availableHeight / natural.height)
        const viewport = page.getViewport({ scale: Math.max(0.2, scale) })
        const pixelRatio = Math.min(2.5, Math.max(1, window.devicePixelRatio || 1))
        const canvas = canvasRef.current
        canvas.width = Math.max(1, Math.floor(viewport.width * pixelRatio))
        canvas.height = Math.max(1, Math.floor(viewport.height * pixelRatio))
        canvas.style.width = `${Math.floor(viewport.width)}px`
        canvas.style.height = `${Math.floor(viewport.height)}px`
        stageRef.current.style.height = `${Math.floor(viewport.height)}px`
        const task = page.render({
          canvas,
          viewport,
          transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0],
        })
        renderTaskRef.current = task
        await task.promise
      } catch (cause) {
        if (!disposed && (cause as { name?: string })?.name !== 'RenderingCancelledException') {
          setError(`PDF page rendering failed: ${errorMessage(cause)}`)
        }
      } finally {
        if (!disposed) setLoading(false)
        page?.cleanup()
      }
    })()
    return () => {
      disposed = true
      renderTaskRef.current?.cancel()
      renderTaskRef.current = null
      page?.cleanup()
    }
  }, [document, pageIdx, renderVersion])

  useEffect(() => {
    onProgress?.({ current: pageIdx + 1, total: pageCount, stable: true, allChaptersMeasured: true })
    onNavigationState?.({ canGoPrevious: pageIdx > 0, canGoNext: pageIdx < pageCount - 1 })
    onVisualPositionChange?.({
      page: pageIdx,
      sentence_idx: activePageIdx === pageIdx ? Math.max(0, currentSentence) : 0,
      content_page: pageIdx,
      visual_page: pageIdx,
      pages_per_view: 1,
      chunk_progress: 0,
    })
  }, [activePageIdx, currentSentence, onNavigationState, onProgress, onVisualPositionChange, pageCount, pageIdx])

  useEffect(() => {
    if (!navRef) return
    navRef.current = {
      goNext: () => { if (pageIdx < pageCount - 1) void setPageIdx?.(pageIdx + 1) },
      goPrev: () => { if (pageIdx > 0) void setPageIdx?.(pageIdx - 1) },
      goToSentence: (page) => { void setPageIdx?.(Math.min(pageCount - 1, Math.max(0, page))) },
      goToReadingPosition: (page) => { void setPageIdx?.(Math.min(pageCount - 1, Math.max(0, page))) },
      getVisualPosition: () => ({
        page: pageIdx,
        sentence_idx: activePageIdx === pageIdx ? Math.max(0, currentSentence) : 0,
        content_page: pageIdx,
        visual_page: pageIdx,
        pages_per_view: 1,
        chunk_progress: 0,
      }),
    }
    return () => { navRef.current = {} }
  }, [activePageIdx, currentSentence, navRef, pageCount, pageIdx, setPageIdx])

  useEffect(() => {
    if (!searchTarget || searchTarget.page === pageIdx) return
    void setPageIdx?.(Math.min(pageCount - 1, Math.max(0, searchTarget.page)))
  }, [pageCount, pageIdx, searchTarget, setPageIdx])

  const selectedSentence = activePageIdx === pageIdx ? currentSentence : -1

  return (
    <div ref={containerRef} className="pdf-viewer" data-loading={loading || undefined}>
      <div ref={stageRef} className="pdf-page-stage" aria-busy={loading}>
        <canvas ref={canvasRef} className="pdf-page-canvas" aria-label={`PDF page ${pageIdx + 1} of ${pageCount}`} />
        {loading && <div className="pdf-page-status">Rendering page {pageIdx + 1}…</div>}
        {error && <div className="pdf-page-error" role="alert">{error}</div>}
      </div>
      <section className="pdf-transcript" aria-label={`Text on PDF page ${pageIdx + 1}`}>
        <div className="pdf-transcript-heading">
          <span>Page {pageIdx + 1}</span>
          <span>{pageText?.sentences.length || 0} sentences</span>
        </div>
        {(pageText?.sentences || []).map((sentence, index) => (
          <button
            key={`${pageIdx}-${index}-${sentence.text.slice(0, 24)}`}
            type="button"
            className={`pdf-transcript-sentence ${index === selectedSentence ? 'is-active' : ''}`}
            aria-current={index === selectedSentence && isPlaying ? 'true' : undefined}
            onClick={() => onSentenceSelect?.(pageIdx, index, { progress: 0 })}
          >
            {sentence.text}
          </button>
        ))}
        {!loading && !error && !pageText?.sentences.length && (
          <p className="pdf-transcript-empty">This page contains no extractable text. You can still read the rendered page.</p>
        )}
      </section>
    </div>
  )
}
