import { useEffect, useRef, useState, useLayoutEffect, useCallback, useMemo } from 'react'

const PAGE_WIDTH = 680
const PAGE_HEIGHT = 936
const PAGE_PAD_X = 56
const CONTENT_TOP = 120
const CONTENT_BOTTOM = 96
const GAP = PAGE_PAD_X * 2
const TEXT_WIDTH = PAGE_WIDTH - PAGE_PAD_X * 2
const TEXT_HEIGHT = PAGE_HEIGHT - CONTENT_TOP - CONTENT_BOTTOM
const TWO_PAGE_WIDTH = PAGE_WIDTH * 2

export default function ReflowViewer({
  reflow,
  chapterIdx = 0,
  setChapterIdx,
  runningHead,
  currentSentence = -1,
  activeChapterIdx = chapterIdx,
  onProgress,
  navRef,
  onPageTurn,
  pageTurn = null,
  motion = true,
  wheelPaging = false,
  searchTarget = null,
  followAlongMode = false,
  onSentenceSelect,
}) {
  const scrollRef = useRef(null)
  const measureRef = useRef(null)
  const chapterMeasureRefs = useRef([])
  const [contentPageCount, setContentPageCount] = useState(1)
  const [chapterPageCounts, setChapterPageCounts] = useState([])
  const [viewPage, setViewPage] = useState(0)
  const [pagesPerView, setPagesPerView] = useState(1)

  const chapter = reflow?.chapters?.[chapterIdx]
  const viewCount = Math.max(1, Math.ceil(contentPageCount / pagesPerView))
  const firstVisiblePage = viewPage * pagesPerView
  const chapterPageOffset = useMemo(() => {
    if (!reflow?.chapters) return 0
    let total = 0
    for (let i = 0; i < chapterIdx; i++) {
      total += chapterPageCounts[i] || 1
    }
    return total
  }, [reflow, chapterIdx, chapterPageCounts])
  const bookPageTotal = useMemo(() => {
    if (!reflow?.chapters?.length) return Math.max(1, contentPageCount)
    return reflow.chapters.reduce((total, _ch, idx) => {
      return total + (chapterPageCounts[idx] || (idx === chapterIdx ? contentPageCount : 1))
    }, 0)
  }, [reflow, chapterPageCounts, chapterIdx, contentPageCount])
  const pendingLanding = useRef('first')
  const pendingScrollSentence = useRef(null)
  const stateRef = useRef({ viewPage: 0, viewCount: 1, chapterIdx: 0, pagesPerView: 1 })

  const renderChapterContent = useCallback((targetChapter, targetChapterIdx = chapterIdx, interactive = true) => {
    if (!targetChapter) return null

    let localSentenceIdx = 0

    let targetDropCapBlockIdx = -1
    for (let i = 0; i < targetChapter.blocks.length; i++) {
      const block = targetChapter.blocks[i]
      if (block.type !== 'paragraph') continue
      const joined = block.sentences.map(s => s.text || '').join(' ').trim()
      const startsWithQuote = /^["']/.test(joined)
      if (joined.length >= 140 && !startsWithQuote) {
        targetDropCapBlockIdx = i
        break
      }
    }
    if (targetDropCapBlockIdx === -1) {
      targetDropCapBlockIdx = targetChapter.blocks.findIndex(b => b.type === 'paragraph')
    }

    return (
      <>
        {targetChapter.number || targetChapter.title ? (
          <div className="chapter-opener" style={{ breakAfter: 'avoid' }}>
            {targetChapter.number && <div className="label">CHAPTER {targetChapter.number}</div>}
            <h1>{targetChapter.title}</h1>
            <div className="fleuron">. . .</div>
          </div>
        ) : null}
        {targetChapter.blocks.map((block, i) => {
          if (block.type === 'dinkus') {
            return <div key={i} className="fleuron" style={{ textAlign: 'center', margin: '24px 0' }}>. . .</div>
          }
          if (block.type === 'heading') {
            const Tag = `h${Math.min(4, Math.max(2, block.level || 2))}`
            return <Tag key={i} style={{ fontFamily: 'var(--font-display)', fontWeight: 400, marginTop: '1.6em', marginBottom: '0.6em', breakAfter: 'avoid' }}>{block.text}</Tag>
          }
          if (block.type !== 'paragraph') return null

          const isFirstBodyPara = i === targetDropCapBlockIdx
          const prevType = targetChapter.blocks[i - 1]?.type
          const startsFresh = i === 0 || prevType === 'dinkus' || prevType === 'heading'
          return (
            <p key={i} className={startsFresh ? 'first' : ''}>
              {block.sentences.map((sent, si) => {
                const localIdx = localSentenceIdx
                localSentenceIdx += 1
                const isDrop = isFirstBodyPara && si === 0
                const active = interactive && targetChapterIdx === activeChapterIdx && localIdx === currentSentence
                const searchFocused = interactive && sent.idx === searchTarget?.globalSentenceIdx && searchTarget?.page === targetChapterIdx
                const text = sent.text || ''
                return (
                  <span
                    key={si}
                    className={`sentence ${interactive ? 'selectable-s' : ''} ${active ? 'active-s' : ''} ${searchFocused ? 'search-s' : ''}`}
                    data-sent-idx={sent.idx}
                    data-local-sent-idx={localIdx}
                    onClick={interactive ? (e) => {
                      e.stopPropagation()
                      onSentenceSelect?.(targetChapterIdx, localIdx)
                    } : undefined}
                  >
                    {isDrop && text ? (<><span className="drop-cap">{text.charAt(0)}</span>{text.slice(1)}</>) : text}
                    {' '}
                  </span>
                )
              })}
            </p>
          )
        })}
      </>
    )
  }, [activeChapterIdx, chapterIdx, currentSentence, onSentenceSelect, searchTarget])

  // Single-page mode has no flipper — a brief fade+slide masks the instant
  // content swap when nav happens. `singleTurn` is the direction; cleared
  // after the animation runs.
  const [singleTurn, setSingleTurn] = useState(null)
  const singleTurnTimeoutRef = useRef(null)
  const triggerSingleTurn = useCallback((direction) => {
    if (!motion) return
    setSingleTurn(direction)
    clearTimeout(singleTurnTimeoutRef.current)
    singleTurnTimeoutRef.current = setTimeout(() => setSingleTurn(null), 320)
  }, [motion])
  useEffect(() => () => clearTimeout(singleTurnTimeoutRef.current), [])

  const updateMode = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const available = el.clientWidth || el.getBoundingClientRect().width
    const next = available >= TWO_PAGE_WIDTH + 96 ? 2 : 1
    setPagesPerView(prev => prev === next ? prev : next)
  }, [])

  useLayoutEffect(() => {
    const raf = requestAnimationFrame(updateMode)
    const ro = new ResizeObserver(updateMode)
    if (scrollRef.current) ro.observe(scrollRef.current)
    window.addEventListener('resize', updateMode)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', updateMode)
      ro.disconnect()
    }
  }, [updateMode])

  const viewForSentence = useCallback((sentenceIdx, indexType = 'local') => {
    const measure = measureRef.current
    if (!measure || sentenceIdx == null || sentenceIdx < 0) return null
    const attr = indexType === 'global' ? 'data-sent-idx' : 'data-local-sent-idx'
    const el = measure.querySelector(`[${attr}="${sentenceIdx}"]`)
    if (!el) return null
    const contentPage = Math.floor(el.offsetTop / TEXT_HEIGHT)
    return Math.max(0, Math.floor(contentPage / pagesPerView))
  }, [pagesPerView])

  useEffect(() => {
    if (!onProgress || !reflow?.chapters) return
    const total = Math.max(1, bookPageTotal)
    const cur = Math.min(total, Math.max(1, chapterPageOffset + firstVisiblePage + 1))
    onProgress({ current: cur, total })
  }, [firstVisiblePage, reflow, onProgress, chapterPageOffset, bookPageTotal])

  useLayoutEffect(() => {
    const measure = measureRef.current
    if (!measure) return

    const pages = Math.max(1, Math.ceil(measure.scrollHeight / TEXT_HEIGHT))
    const nextViewCount = Math.max(1, Math.ceil(pages / pagesPerView))
    setContentPageCount(pages)

    if (searchTarget?.page === chapterIdx && searchTarget?.globalSentenceIdx != null) {
      const targetView = viewForSentence(searchTarget.globalSentenceIdx, 'global')
      setViewPage(targetView != null ? Math.min(nextViewCount - 1, targetView) : 0)
      pendingScrollSentence.current = null
    } else if (pendingScrollSentence.current != null) {
      const targetView = viewForSentence(pendingScrollSentence.current.idx, pendingScrollSentence.current.indexType)
      setViewPage(targetView != null ? Math.min(nextViewCount - 1, targetView) : 0)
      pendingScrollSentence.current = null
    } else if (pendingLanding.current === 'last') {
      setViewPage(nextViewCount - 1)
    } else {
      setViewPage(0)
    }
    pendingLanding.current = 'first'
  }, [chapter, pagesPerView, searchTarget, chapterIdx, viewForSentence])

  useLayoutEffect(() => {
    const raf = requestAnimationFrame(() => {
      if (!reflow?.chapters?.length) {
        setChapterPageCounts([])
        return
      }

      const counts = reflow.chapters.map((_, idx) => {
        const el = chapterMeasureRefs.current[idx]
        return Math.max(1, Math.ceil((el?.scrollHeight || TEXT_HEIGHT) / TEXT_HEIGHT))
      })
      setChapterPageCounts(prev => (
        prev.length === counts.length && prev.every((n, i) => n === counts[i])
          ? prev
          : counts
      ))
    })
    return () => cancelAnimationFrame(raf)
  }, [reflow])

  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      setViewPage(prev => Math.min(prev, Math.max(0, viewCount - 1)))
    })
    return () => cancelAnimationFrame(raf)
  }, [pagesPerView, viewCount])

  useEffect(() => {
    stateRef.current = { viewPage, viewCount, chapterIdx, pagesPerView }
  }, [viewPage, viewCount, chapterIdx, pagesPerView])

  const goNext = useCallback(() => {
    if (!reflow) return
    const nChapters = reflow.chapters.length
    const { viewPage: vp, viewCount: vc, chapterIdx: ci, pagesPerView: ppv } = stateRef.current
    if (vp < vc - 1) {
      setViewPage(vp + 1)
      if (ppv === 2) onPageTurn?.('next')
      else triggerSingleTurn('next')
    } else if (ci < nChapters - 1) {
      setChapterIdx?.(ci + 1)
      if (ppv === 2) onPageTurn?.('next')
      else triggerSingleTurn('next')
    }
  }, [reflow, setChapterIdx, onPageTurn, triggerSingleTurn])

  const goPrev = useCallback(() => {
    if (!reflow) return
    const { viewPage: vp, chapterIdx: ci, pagesPerView: ppv } = stateRef.current
    if (vp > 0) {
      setViewPage(vp - 1)
      if (ppv === 2) onPageTurn?.('prev')
      else triggerSingleTurn('prev')
    } else if (ci > 0) {
      pendingLanding.current = 'last'
      setChapterIdx?.(ci - 1)
      if (ppv === 2) onPageTurn?.('prev')
      else triggerSingleTurn('prev')
    }
  }, [reflow, setChapterIdx, onPageTurn, triggerSingleTurn])

  const goToSentence = useCallback((targetChapter, sentenceIdx, indexType = 'local') => {
    if (sentenceIdx == null || sentenceIdx < 0) return
    if (targetChapter != null && targetChapter !== chapterIdx) {
      pendingScrollSentence.current = { idx: sentenceIdx, indexType }
      setChapterIdx?.(targetChapter)
      const direction = targetChapter > chapterIdx ? 'next' : 'prev'
      if (stateRef.current.pagesPerView === 2) onPageTurn?.(direction)
      else triggerSingleTurn(direction)
      return
    }
    const targetView = viewForSentence(sentenceIdx, indexType)
    if (targetView != null) {
      const currentView = stateRef.current.viewPage
      if (targetView !== currentView) {
        const direction = targetView > currentView ? 'next' : 'prev'
        if (stateRef.current.pagesPerView === 2) onPageTurn?.(direction)
        else triggerSingleTurn(direction)
      }
      setViewPage(targetView)
    }
  }, [chapterIdx, onPageTurn, setChapterIdx, triggerSingleTurn, viewForSentence])

  useEffect(() => {
    if (!navRef) return
    navRef.current = { goNext, goPrev, goToSentence }
  }, [navRef, goNext, goPrev, goToSentence])

  useEffect(() => {
    if (!wheelPaging) return
    const el = scrollRef.current
    if (!el) return
    let cooldown = 0
    const onWheel = (e) => {
      e.preventDefault()
      const now = Date.now()
      if (now < cooldown) return
      const dy = e.deltaY
      const dx = e.deltaX
      if (Math.abs(dy) < 12 && Math.abs(dx) < 12) return
      cooldown = now + 220
      if (dy > 0 || dx > 0) goNext()
      else goPrev()
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [wheelPaging, goNext, goPrev])

  if (!reflow) {
    return (
      <div className={`page-scroll ${followAlongMode ? 'follow-along-scroll' : ''}`}>
        <div style={{ margin: 'auto', color: 'var(--ink-3)', fontFamily: 'var(--font-display)', fontStyle: 'italic' }}>
          Loading reflow...
        </div>
      </div>
    )
  }

  if (!chapter) {
    return (
      <div className={`page-scroll ${followAlongMode ? 'follow-along-scroll' : ''}`}>
        <div style={{ margin: 'auto', color: 'var(--ink-3)' }}>No chapters found.</div>
      </div>
    )
  }

  const runHead = runningHead || reflow.metadata?.running_head || ''
  const chapLabel = `${chapter.number ? `${chapter.number} - ` : ''}${(chapter.title || '').toUpperCase()}`
  const nCols = Math.max(1, contentPageCount)
  const flowWidth = nCols * TEXT_WIDTH + (nCols - 1) * GAP
  const stride = pagesPerView * (TEXT_WIDTH + GAP)
  const showRecto = pagesPerView === 2
  const bookPageNumber = (localPageIdx) => chapterPageOffset + localPageIdx + 1
  const versoFooter = bookPageNumber(firstVisiblePage)
  const rectoFooter = bookPageNumber(Math.min(contentPageCount - 1, firstVisiblePage + 1))
  const pageColumnOffset = (pageIdx) => pageIdx * (TEXT_WIDTH + GAP)
  // viewPage has already advanced to the destination spread by the time the
  // flipper renders, so firstVisiblePage = the NEW verso. The lifting front
  // face shows the page being turned away (old recto for next, old verso for
  // prev); the back face shows the page revealed mid-flip (new verso for
  // next, new recto for prev).
  const turnFrontPage = pageTurn === 'prev' ? firstVisiblePage + 2 : firstVisiblePage - 1
  const turnBackPage = pageTurn === 'prev' ? firstVisiblePage + 1 : firstVisiblePage

  const renderTurnPage = (pageIdx, extraClass = '') => {
    if (pageIdx < 0 || pageIdx >= contentPageCount) return null
    const isRecto = pageIdx % 2 === 1
    return (
      <>
        <header className="page-header pt-page-header">
          {isRecto ? (
            <><span>{chapLabel}</span><span>{runHead}</span></>
          ) : (
            <><span>{runHead}</span><span>{chapLabel}</span></>
          )}
        </header>
        <div className={`pt-page-text ${extraClass}`}>
          <div
            className="reflow-flow"
            style={{
              columnCount: nCols,
              columnGap: `${GAP}px`,
              columnFill: 'auto',
              height: `${TEXT_HEIGHT}px`,
              width: `${flowWidth}px`,
              transform: `translateX(-${pageColumnOffset(pageIdx)}px)`,
            }}
          >
            {contentEls}
          </div>
        </div>
        <div className="page-footer pt-page-footer">- {bookPageNumber(pageIdx)} -</div>
      </>
    )
  }

  const contentEls = renderChapterContent(chapter, chapterIdx, true)

  return (
    <div className={`page-scroll reflow-scroll ${followAlongMode ? 'follow-along-scroll' : ''}`} ref={scrollRef}>
      <div className={`spread reflow-spread pt-spread pages-${pagesPerView}${singleTurn ? ` sp-turning sp-turning-${singleTurn}` : ''}`}>
        <article className="page-sheet reflow-sheet pt-page pt-verso verso">
          <header className="page-header"><span>{runHead}</span><span>{chapLabel}</span></header>
          <div className="reflow-slot" />
          <div className="page-footer">- {versoFooter} -</div>
        </article>

        {showRecto && (
          <article className="page-sheet reflow-sheet pt-page pt-recto recto">
            <header className="page-header"><span>{chapLabel}</span><span>{runHead}</span></header>
            <div className="reflow-slot" />
            <div className="page-footer">- {rectoFooter} -</div>
          </article>
        )}

        {showRecto && pageTurn && (
          <>
            <div className={`pt-flipper pt-flipper-${pageTurn}`}>
              <div className="pt-face pt-front">
                {renderTurnPage(turnFrontPage, 'pt-page-text-front')}
                <div className="pt-shade pt-shade-front" />
                <div className="pt-sheen" />
                <div className="pt-edge" />
              </div>
              <div className="pt-face pt-back">
                {renderTurnPage(turnBackPage, 'pt-page-text-back')}
                <div className="pt-shade pt-shade-back" />
                <div className="pt-sheen" />
              </div>
            </div>
            <div className={`pt-cast pt-cast-${pageTurn}`} />
            <div className={`pt-cast-receiving pt-recv-${pageTurn}`} />
          </>
        )}

        <div
          ref={measureRef}
          className="reflow-flow reflow-measure"
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: -99999,
            top: 0,
            width: `${TEXT_WIDTH}px`,
            // Clamp layout height to 0 so the (very tall) single-column clone
            // doesn't expand the page-scroll's scrollHeight. scrollHeight on
            // the measure itself still reports the natural content height,
            // which is what the pagination math reads.
            height: 0,
            overflow: 'hidden',
            visibility: 'hidden',
            pointerEvents: 'none',
          }}
        >
          {contentEls}
        </div>

        {reflow.chapters.map((ch, idx) => (
          <div
            key={`chapter-measure-${ch.id ?? idx}`}
            ref={(el) => { chapterMeasureRefs.current[idx] = el }}
            className="reflow-flow reflow-measure"
            aria-hidden="true"
            style={{
              position: 'absolute',
              left: -99999,
              top: 0,
              width: `${TEXT_WIDTH}px`,
              height: 0,
              overflow: 'hidden',
              visibility: 'hidden',
              pointerEvents: 'none',
            }}
          >
            {renderChapterContent(ch, idx, false)}
          </div>
        ))}

        <div className="reflow-viewport">
          <div
            className="reflow-flow"
            style={{
              columnCount: nCols,
              columnGap: `${GAP}px`,
              columnFill: 'auto',
              height: `${TEXT_HEIGHT}px`,
              width: `${flowWidth}px`,
              transform: `translateX(-${viewPage * stride}px)`,
            }}
          >
            {contentEls}
          </div>
        </div>
      </div>
    </div>
  )
}
