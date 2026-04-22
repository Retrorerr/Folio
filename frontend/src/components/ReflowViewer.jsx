import { useEffect, useRef, useState, useLayoutEffect, useCallback } from 'react'

/**
 * Reflow viewer with CSS-column pagination: the current chapter flows into
 * page-sized columns, and a spread shows two columns (verso + recto) at a
 * time. Arrow keys advance sub-pages within a chapter, rolling over to the
 * next/prev chapter at the boundaries.
 */
export default function ReflowViewer({ reflow, chapterIdx = 0, setChapterIdx, runningHead, currentSentence = -1, onProgress, navRef, onPageTurn, wheelPaging = false, searchTarget = null }) {
  const viewportRef = useRef(null)
  const flowRef = useRef(null)
  const [pageCount, setPageCount] = useState(1)
  const [subPage, setSubPage] = useState(0) // 0-indexed spread within chapter (each spread = 2 columns)
  const [dims, setDims] = useState({ w: 520, h: 760 }) // per-page inner content size

  const chapter = reflow?.chapters?.[chapterIdx]

  // When the chapter changes, we want to land on the first page — unless we
  // arrived here by flipping backward past the start of the next chapter, in
  // which case we want the LAST page (like flipping back in a physical book).
  // goPrev sets `pendingLanding` to 'last' before changing the chapter, and
  // the measure pass consumes it after pageCount is known.
  const pendingLanding = useRef('first')
  // If set, after the next measure pass, land on whatever subPage contains this
  // sentence index. Used by the "jump to reader" (LIVE) button to sync across
  // chapters + scroll to the exact reader sentence.
  const pendingScrollSentence = useRef(null)
  const stateRef = useRef({ subPage: 0, pageCount: 1, chapterIdx: 0 })

  // Given a sentence idx, find which subPage (spread of 2 columns) it lives on,
  // using the single-column measure clone's offsetTop: a sentence at offsetTop
  // y lives on subPage floor(y / (2 * dims.h)), because each subPage consumes
  // 2 columns worth of vertical content at measure width.
  const subPageForSentence = useCallback((sentenceIdx) => {
    const m = measureRef.current
    if (!m || sentenceIdx == null || sentenceIdx < 0) return null
    const el = m.querySelector(`[data-sent-idx="${sentenceIdx}"]`)
    if (!el) return null
    const y = el.offsetTop
    const sp = Math.floor(y / (2 * dims.h))
    return Math.max(0, sp)
  }, [dims.h])

  // Estimate total book pages from measured current-chapter pages.
  // charsPerPage is calibrated off the current chapter, then extrapolated.
  useEffect(() => {
    if (!onProgress || !reflow?.chapters) return
    const chapterCharCount = (ch) => ch.blocks
      .filter(b => b.type === 'paragraph')
      .reduce((n, b) => n + b.sentences.reduce((m, s) => m + (s.text?.length || 0), 0), 0)
    const currentChars = chapter ? chapterCharCount(chapter) : 0
    const totalChars = reflow.chapters.reduce((n, c) => n + chapterCharCount(c), 0)
    const charsPerPage = pageCount > 0 && currentChars > 0 ? currentChars / (pageCount * 2) : 1800
    const charsBefore = reflow.chapters.slice(0, chapterIdx).reduce((n, c) => n + chapterCharCount(c), 0)
    const total = Math.max(1, Math.ceil(totalChars / charsPerPage))
    const cur = Math.min(total, Math.max(1, Math.round((charsBefore + subPage * 2 * charsPerPage) / charsPerPage) + 1))
    onProgress({ current: cur, total })
  }, [chapterIdx, subPage, pageCount, reflow, chapter, onProgress])

  // Measure by rendering a hidden single-column clone at page width; derive
  // page count from its natural height.
  const measureRef = useRef(null)
  const GAP = 112 // 2 * page inner padding (56) so columns end at each page's content edge

  // Pass 1: track viewport size.
  useLayoutEffect(() => {
    if (!viewportRef.current) return
    const updateDims = () => {
      const vp = viewportRef.current
      if (!vp) return
      const vpRect = vp.getBoundingClientRect()
      const innerW = Math.max(280, Math.floor((vpRect.width - GAP) / 2))
      const innerH = Math.max(400, Math.floor(vpRect.height))
      setDims(prev => (prev.w === innerW && prev.h === innerH) ? prev : { w: innerW, h: innerH })
    }
    updateDims()
    const ro = new ResizeObserver(updateDims)
    ro.observe(viewportRef.current)
    return () => ro.disconnect()
  }, [])

  // Pass 2: once the measure clone has been laid out at current dims and
  // with current chapter content, derive page count. Re-runs whenever either
  // changes.
  useLayoutEffect(() => {
    const m = measureRef.current
    if (!m) return
    const totalH = m.scrollHeight
    const pages = Math.max(1, Math.ceil(totalH / dims.h / 2))
    setPageCount(pages)
    if (searchTarget?.page === chapterIdx && searchTarget?.globalSentenceIdx != null) {
      const sp = subPageForSentence(searchTarget.globalSentenceIdx)
      setSubPage(sp != null ? Math.min(pages - 1, sp) : 0)
      pendingScrollSentence.current = null
    } else if (pendingScrollSentence.current != null) {
      const sp = subPageForSentence(pendingScrollSentence.current)
      setSubPage(sp != null ? Math.min(pages - 1, sp) : 0)
      pendingScrollSentence.current = null
    } else if (pendingLanding.current === 'last') {
      setSubPage(pages - 1)
    } else {
      setSubPage(0)
    }
    pendingLanding.current = 'first'
  }, [chapter, dims.w, dims.h, searchTarget, chapterIdx, subPageForSentence])

  // Keyboard: sub-page within chapter; roll over to next/prev chapter at edges.
  // Use refs to avoid stale closures while pageCount is still being measured.
  useEffect(() => {
    stateRef.current = { subPage, pageCount, chapterIdx }
  }, [subPage, pageCount, chapterIdx])

  const goNext = useCallback(() => {
    if (!reflow) return
    const nChapters = reflow.chapters.length
    const { subPage: sp, pageCount: pc, chapterIdx: ci } = stateRef.current
    if (sp < pc - 1) { setSubPage(sp + 1); onPageTurn?.('next') }
    else if (ci < nChapters - 1) { setChapterIdx?.(ci + 1); onPageTurn?.('next') }
  }, [reflow, setChapterIdx, onPageTurn])
  const goPrev = useCallback(() => {
    if (!reflow) return
    const { subPage: sp, chapterIdx: ci } = stateRef.current
    if (sp > 0) { setSubPage(sp - 1); onPageTurn?.('prev') }
    else if (ci > 0) {
      pendingLanding.current = 'last'
      setChapterIdx?.(ci - 1)
      onPageTurn?.('prev')
    }
  }, [reflow, setChapterIdx, onPageTurn])

  // Jump to the sub-page containing `sentenceIdx` within `targetChapter`
  // (defaults to the current chapter). If we have to cross a chapter boundary,
  // stash the sentence in pendingScrollSentence so the next measure pass lands
  // on the right subPage. Same-chapter jumps resolve synchronously.
  const goToSentence = useCallback((targetChapter, sentenceIdx) => {
    if (sentenceIdx == null || sentenceIdx < 0) return
    if (targetChapter != null && targetChapter !== chapterIdx) {
      pendingScrollSentence.current = sentenceIdx
      setChapterIdx?.(targetChapter)
      return
    }
    const sp = subPageForSentence(sentenceIdx)
    if (sp != null) setSubPage(sp)
  }, [chapterIdx, setChapterIdx, subPageForSentence])

  useEffect(() => {
    if (!navRef) return
    navRef.current = { goNext, goPrev, goToSentence }
  }, [navRef, goNext, goPrev, goToSentence])

  // Mouse-wheel flips pages within and across chapters (opt-in).
  useEffect(() => {
    if (!wheelPaging) return
    const vp = viewportRef.current
    if (!vp) return
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
    vp.addEventListener('wheel', onWheel, { passive: false })
    return () => vp.removeEventListener('wheel', onWheel)
  }, [wheelPaging, goNext, goPrev])


  if (!reflow) {
    return (
      <div className="page-scroll">
        <div style={{ margin: 'auto', color: 'var(--ink-3)', fontFamily: 'var(--font-display)', fontStyle: 'italic' }}>
          Loading reflow…
        </div>
      </div>
    )
  }

  if (!chapter) {
    return (
      <div className="page-scroll">
        <div style={{ margin: 'auto', color: 'var(--ink-3)' }}>No chapters found.</div>
      </div>
    )
  }

  // Drop-cap on first body paragraph of each chapter
  let dropCapBlockIdx = -1
  for (let i = 0; i < chapter.blocks.length; i++) {
    const b = chapter.blocks[i]
    if (b.type !== 'paragraph') continue
    const joined = b.sentences.map(s => s.text || '').join(' ').trim()
    const startsWithQuote = /^[“"'‘]/.test(joined)
    if (joined.length >= 140 && !startsWithQuote) { dropCapBlockIdx = i; break }
  }
  if (dropCapBlockIdx === -1) {
    dropCapBlockIdx = chapter.blocks.findIndex(b => b.type === 'paragraph')
  }

  const runHead = runningHead || reflow.metadata?.running_head || ''
  const chapLabel = `${chapter.number ? chapter.number + ' · ' : ''}${(chapter.title || '').toUpperCase()}`
  // Explicit 2*pageCount columns at exactly dims.w each, with (2p-1) gaps.
  // The stride between successive spreads is 2*(colW+gap).
  const nCols = Math.max(2, pageCount * 2)
  const flowWidth = nCols * dims.w + (nCols - 1) * GAP
  const stride = 2 * (dims.w + GAP)

  const contentEls = (
    <>
      {chapter.number || chapter.title ? (
        <div className="chapter-opener" style={{ breakAfter: 'avoid' }}>
          {chapter.number && <div className="label">CHAPTER {chapter.number}</div>}
          <h1>{chapter.title}</h1>
          <div className="fleuron">· · ·</div>
        </div>
      ) : null}
      {chapter.blocks.map((block, i) => {
        if (block.type === 'dinkus') {
          return <div key={i} className="fleuron" style={{ textAlign: 'center', margin: '24px 0' }}>· · ·</div>
        }
        if (block.type === 'heading') {
          const Tag = `h${Math.min(4, Math.max(2, block.level || 2))}`
          return <Tag key={i} style={{ fontFamily: 'var(--font-display)', fontWeight: 400, marginTop: '1.6em', marginBottom: '0.6em', breakAfter: 'avoid' }}>{block.text}</Tag>
        }
        if (block.type === 'paragraph') {
          const isFirstBodyPara = i === dropCapBlockIdx
          const prevType = chapter.blocks[i - 1]?.type
          const startsFresh = i === 0 || prevType === 'dinkus' || prevType === 'heading'
          return (
            <p key={i} className={startsFresh ? 'first' : ''}>
              {block.sentences.map((sent, si) => {
                const isDrop = isFirstBodyPara && si === 0
                const active = sent.idx === currentSentence
                const searchFocused = sent.idx === searchTarget?.globalSentenceIdx && searchTarget?.page === chapterIdx
                const text = sent.text || ''
                return (
                  <span key={si} className={`sentence ${active ? 'active-s' : ''} ${searchFocused ? 'search-s' : ''}`} data-sent-idx={sent.idx}>
                    {isDrop && text ? (<><span className="drop-cap">{text.charAt(0)}</span>{text.slice(1)}</>) : text}
                    {' '}
                  </span>
                )
              })}
            </p>
          )
        }
        return null
      })}
    </>
  )

  return (
    <div className="page-scroll reflow-scroll">
      <div className="spread reflow-spread">
        {/* Visual page frames (chrome only — content flows above) */}
        <article className="page-sheet reflow-sheet verso">
          <header className="page-header"><span>{runHead}</span><span>{chapLabel}</span></header>
          <div className="reflow-slot" />
          <div className="page-footer">— {subPage * 2 + 1} —</div>
        </article>
        <article className="page-sheet reflow-sheet recto">
          <header className="page-header"><span>{chapLabel}</span><span>{runHead}</span></header>
          <div className="reflow-slot" />
          <div className="page-footer">— {subPage * 2 + 2} —</div>
        </article>

        {/* Hidden measure clone — single-column, natural height */}
        <div
          ref={measureRef}
          className="reflow-flow reflow-measure"
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: -99999,
            top: 0,
            width: `${dims.w}px`,
            visibility: 'hidden',
            pointerEvents: 'none',
          }}
        >
          {contentEls}
        </div>

        {/* Column-flow viewport, absolutely positioned over the two sheets */}
        <div className="reflow-viewport" ref={viewportRef}>
          <div
            ref={flowRef}
            className="reflow-flow"
            style={{
              columnCount: nCols,
              columnGap: `${GAP}px`,
              columnFill: 'auto',
              height: `${dims.h}px`,
              width: `${flowWidth}px`,
              transform: `translateX(-${subPage * stride}px)`,
            }}
          >
            {contentEls}
          </div>
        </div>
      </div>
    </div>
  )
}
