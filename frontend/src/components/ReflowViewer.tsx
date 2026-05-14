import { memo, useEffect, useRef, useState, useLayoutEffect, useCallback, useMemo } from 'react'
import type React from 'react'

const PAGE_WIDTH = 680
const PAGE_HEIGHT = 936
const PAGE_PAD_X = 56
const CONTENT_TOP = 120
const CONTENT_BOTTOM = 96
const GAP = PAGE_PAD_X * 2
const TEXT_WIDTH = PAGE_WIDTH - PAGE_PAD_X * 2
const TEXT_HEIGHT = PAGE_HEIGHT - CONTENT_TOP - CONTENT_BOTTOM
const TWO_PAGE_WIDTH = PAGE_WIDTH * 2
const TWO_PAGE_MARGIN = 24
const READING_REGION_BEFORE = 1
const READING_REGION_AFTER = 3

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n))
}

function classNames(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(' ')
}

function blockRole(block: any) {
  return block?.role || 'prose'
}

function blockRoleClass(role: string) {
  return `reflow-para-${String(role || 'prose').replace(/[^a-z0-9_-]/gi, '-')}`
}

function debugFlag(globalName: string, storageKey: string) {
  if (typeof window === 'undefined') return false
  return Boolean(window[globalName]) || window.localStorage?.getItem(storageKey) === '1'
}

function debugRect(rect: any) {
  if (!rect) return null
  return {
    left: Math.round(rect.left),
    top: Math.round(rect.top),
    right: Math.round(rect.right),
    bottom: Math.round(rect.bottom),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  }
}

// Build a Range covering [start, end) character offsets inside the element's
// concatenated textContent. Walks text nodes so it works through nested spans
// (e.g. drop-cap). Returns null if offsets are out of bounds.
function rangeForCharOffsets(el: Element, start: number, end: number) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  let offset = 0
  let startNode = null, startOff = 0, endNode = null, endOff = 0
  let node: Node | null
  while ((node = walker.nextNode())) {
    const len = node.nodeValue?.length || 0
    if (startNode == null && offset + len >= start) {
      startNode = node
      startOff = start - offset
    }
    if (offset + len >= end) {
      endNode = node
      endOff = end - offset
      break
    }
    offset += len
  }
  if (!startNode || !endNode) return null
  try {
    const range = document.createRange()
    range.setStart(startNode, startOff)
    range.setEnd(endNode, endOff)
    return range
  } catch {
    return null
  }
}

function wordRect(active: Element, word: any) {
  const range = rangeForCharOffsets(active, word.start, word.end)
  if (!range) return null
  const rects = Array.from(range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0)
  const rect = rects.length ? normalizedWordRect(rects) : range.getBoundingClientRect()
  range.detach?.()
  return rect.width ? rect : null
}

function normalizedWordRect(rects: DOMRect[]) {
  if (rects.length === 1) return rects[0]
  const sortedByHeight = [...rects].sort((a, b) => a.height - b.height)
  const shortest = sortedByHeight[0]
  const tallest = sortedByHeight[sortedByHeight.length - 1]
  if (tallest.height > shortest.height * 1.8) return shortest

  const left = Math.min(...rects.map(rect => rect.left))
  const top = Math.min(...rects.map(rect => rect.top))
  const right = Math.max(...rects.map(rect => rect.right))
  const bottom = Math.max(...rects.map(rect => rect.bottom))
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
  }
}

function rectToLocal(rect: DOMRect | any, rootRect: DOMRect, scrollEl: Element | null) {
  // Cursor lives inside the scrolling .page-scroll container, so it's
  // positioned in the container's *content* coordinate space, not the
  // viewport. getBoundingClientRect returns viewport coords, so we add the
  // current scroll offset to anchor the cursor to its content position.
  // Without this, scrolling the reader leaves the cursor behind / ahead of
  // the active word.
  const scrollTop = scrollEl?.scrollTop || 0
  const scrollLeft = scrollEl?.scrollLeft || 0
  return {
    x: rect.left - rootRect.left + scrollLeft,
    y: rect.top - rootRect.top + scrollTop,
    width: rect.width,
    height: rect.height,
  }
}

function rectIntersects(a: DOMRect | any, b: DOMRect | any, pad = 2) {
  return (
    a.right >= b.left - pad &&
    a.left <= b.right + pad &&
    a.bottom >= b.top - pad &&
    a.top <= b.bottom + pad
  )
}

function sameVisualLine(a, b) {
  if (!a || !b) return false
  const aMid = a.top + a.height / 2
  const bMid = b.top + b.height / 2
  return Math.abs(aMid - bMid) < Math.max(7, Math.min(a.height, b.height) * 0.7)
}

function unionRects(rects: Array<DOMRect | any>) {
  const left = Math.min(...rects.map(rect => rect.left))
  const top = Math.min(...rects.map(rect => rect.top))
  const right = Math.max(...rects.map(rect => rect.right))
  const bottom = Math.max(...rects.map(rect => rect.bottom))
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
  }
}

function expandRect(rect: any, x: number, y: number) {
  return {
    left: rect.left - x,
    top: rect.top - y,
    right: rect.right + x,
    bottom: rect.bottom + y,
    width: rect.width + x * 2,
    height: rect.height + y * 2,
  }
}

function clampRectToBounds(rect: any, bounds: any) {
  const left = Math.max(rect.left, bounds.left)
  const top = Math.max(rect.top, bounds.top)
  const right = Math.min(rect.right, bounds.right)
  const bottom = Math.min(rect.bottom, bounds.bottom)
  return {
    left,
    top,
    right,
    bottom,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  }
}

function estimatedRegionRect(active: Element, words: any[], currentIdx: number, viewportRect: DOMRect | undefined) {
  const currentRect = wordRect(active, words[currentIdx])
  if (!currentRect) return null

  let startIdx = currentIdx
  let endIdx = currentIdx
  const rects = [currentRect]

  for (let i = currentIdx - 1; i >= Math.max(0, currentIdx - READING_REGION_BEFORE); i--) {
    const rect = wordRect(active, words[i])
    if (!rect || !sameVisualLine(currentRect, rect)) break
    rects.unshift(rect)
    startIdx = i
  }

  for (let i = currentIdx + 1; i <= Math.min(words.length - 1, currentIdx + READING_REGION_AFTER); i++) {
    const rect = wordRect(active, words[i])
    if (!rect || !sameVisualLine(currentRect, rect)) break
    rects.push(rect)
    endIdx = i
  }

  let rect = expandRect(unionRects(rects), 14, 8)
  if (viewportRect) rect = clampRectToBounds(rect, viewportRect)
  return rect.width && rect.height ? { rect, currentRect, startIdx, endIdx } : null
}

function placeOverlay(el: HTMLElement, rect: any, opacity: number) {
  el.style.opacity = `${opacity}`
  el.style.transform = `translate3d(${rect.x}px, ${rect.y}px, 0)`
  el.style.width = `${rect.width}px`
  el.style.height = `${rect.height}px`
}

function dampRect(current: any, target: any, amount: number) {
  return {
    x: current.x + (target.x - current.x) * amount,
    y: current.y + (target.y - current.y) * amount,
    width: current.width + (target.width - current.width) * amount,
    height: current.height + (target.height - current.height) * amount,
  }
}

function closeRect(a: any, b: any) {
  return (
    Math.abs(a.x - b.x) < 0.25 &&
    Math.abs(a.y - b.y) < 0.25 &&
    Math.abs(a.width - b.width) < 0.25 &&
    Math.abs(a.height - b.height) < 0.25
  )
}

function ReflowViewer({
  reflow,
  chapterIdx = 0,
  setChapterIdx,
  runningHead,
  currentSentence = -1,
  activeChapterIdx = chapterIdx,
  chunkProgress = 0,
  isPlaying = false,
  onProgress,
  navRef,
  onPageTurn,
  pageTurn = null,
  motion = true,
  wheelPaging = false,
  searchTarget = null,
  followAlongMode = false,
  onSentenceSelect,
}: any) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const measureRef = useRef<HTMLDivElement | null>(null)
  const chapterMeasureRef = useRef<HTMLDivElement | null>(null)
  const [contentPageCount, setContentPageCount] = useState(1)
  const [chapterPageCounts, setChapterPageCounts] = useState<number[]>([])
  const [measureChapterIdx, setMeasureChapterIdx] = useState<number | null>(null)
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
  const pendingScrollSentence = useRef<any>(null)
  const stateRef = useRef({ viewPage: 0, viewCount: 1, chapterIdx: 0, pagesPerView: 1 })

  const chapterMeasureOrder = useMemo(() => {
    const total = reflow?.chapters?.length || 0
    if (!total) return []
    const order: number[] = []
    for (let i = chapterIdx - 1; i >= 0; i -= 1) order.push(i)
    for (let i = chapterIdx + 1; i < total; i += 1) order.push(i)
    return order
  }, [reflow, chapterIdx])

  const renderChapterContent = useCallback((targetChapter: any, targetChapterIdx = chapterIdx, interactive = true) => {
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
            return <div key={i} className="reflow-dinkus" data-block-kind="section-break">. . .</div>
          }
          if (block.type === 'heading') {
            const Tag = `h${Math.min(4, Math.max(2, block.level || 2))}` as React.ElementType
            return (
              <Tag
                key={i}
                className="reflow-heading"
                data-block-kind="heading"
                data-block-level={block.level || 2}
              >
                {block.text}
              </Tag>
            )
          }
          if (block.type !== 'paragraph') return null

          const isFirstBodyPara = i === targetDropCapBlockIdx
          const prevType = targetChapter.blocks[i - 1]?.type
          const startsFresh = i === 0 || prevType === 'dinkus' || prevType === 'heading'
          const role = blockRole(block)
          return (
            <p
              key={i}
              className={classNames(
                'reflow-para',
                startsFresh && 'first',
                isFirstBodyPara && 'dropcap-para',
                blockRoleClass(role)
              )}
              data-block-kind={role}
              data-block-index={i}
            >
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

  const contentEls = useMemo(
    () => renderChapterContent(chapter, chapterIdx, true),
    [chapter, chapterIdx, renderChapterContent]
  )

  // Reading cursor — a single positioned overlay that sits on top of the word
  // indexed by chunkProgress inside the active chunk. The chunk text itself
  // never gets split into per-word DOM nodes; we just use the Range API to
  // measure where the current word's pixels are and translate the cursor div
  // to match. Cheap (one rect lookup per frame) and theme-agnostic.
  const cursorRef = useRef(null)
  const wordsCacheRef = useRef([])
  const cursorDebugRef = useRef({ lastKey: '', lastAt: 0 })
  const cursorMotionRef = useRef({ current: null, target: null, raf: null, visible: false })

  // Helper: find the active sentence in the LIVE column viewport, NOT the
  // hidden measure clones (which appear earlier in DOM order and would be
  // matched by a broader querySelector).
  const findLiveActiveSentence = useCallback(() => {
    const root = scrollRef.current
    if (!root) return null
    const live = root.querySelector('.reflow-viewport .reflow-flow:not(.reflow-measure)')
    return live?.querySelector('.sentence.active-s') || null
  }, [])

  // Rebuild the word offset cache when the active chunk changes.
  useEffect(() => {
    wordsCacheRef.current = []
    if (currentSentence == null || currentSentence < 0) return
    const active = findLiveActiveSentence()
    if (!active) return
    const text = active.textContent || ''
    const words = []
    const re = /\S+/g
    let m
    while ((m = re.exec(text))) words.push({ start: m.index, end: m.index + m[0].length })
    wordsCacheRef.current = words
    if (typeof window !== 'undefined') {
      window.__folioCursorWords = {
        currentSentence,
        activeChapterIdx,
        wordCount: words.length,
        textPreview: text.slice(0, 120),
      }
    }
  }, [currentSentence, activeChapterIdx, findLiveActiveSentence])

  // Position the cursor over Claude's estimated current word every progress
  // tick: floor(chunkProgress * wordCount). CSS transitions smooth the jumps,
  // and nearby glow elements stay anchored to that same estimate.
  useEffect(() => {
    const cursor = cursorRef.current
    const root = scrollRef.current
    if (!cursor || !root) return
    const stopCursorMotion = () => {
      if (cursorMotionRef.current.raf != null) {
        cancelAnimationFrame(cursorMotionRef.current.raf)
        cursorMotionRef.current.raf = null
      }
    }
    const animateCursor = () => {
      const motionState = cursorMotionRef.current
      if (!motionState.visible || !motionState.target) {
        motionState.raf = null
        return
      }
      if (!motionState.current) motionState.current = motionState.target
      const next = dampRect(motionState.current, motionState.target, 0.34)
      motionState.current = closeRect(next, motionState.target) ? motionState.target : next
      placeOverlay(cursor, motionState.current, 1)
      if (motionState.current === motionState.target) {
        motionState.raf = null
        return
      }
      motionState.raf = requestAnimationFrame(animateCursor)
    }
    const moveCursorTo = (rect, immediate = false) => {
      const motionState = cursorMotionRef.current
      motionState.target = rect
      motionState.visible = true
      if (immediate || !motionState.current) {
        motionState.current = rect
        placeOverlay(cursor, rect, 1)
        return
      }
      if (motionState.raf == null) {
        motionState.raf = requestAnimationFrame(animateCursor)
      }
    }
    const reportCursor = (reason: string, extra: any = {}) => {
      if (typeof window === 'undefined') return
      const entry = {
        reason,
        isPlaying,
        chunkProgress,
        currentSentence,
        activeChapterIdx,
        chapterIdx,
        viewPage,
        pagesPerView,
        wordCount: wordsCacheRef.current.length,
        liveActiveCount: root.querySelectorAll('.reflow-viewport .sentence.active-s').length,
        cursorStyle: cursor.getAttribute('style') || '',
        ...extra,
      }
      window.__folioCursorDebug = entry

      if (!debugFlag('FOLIO_DEBUG_CURSOR', 'folioDebugCursor')) return
      const now = performance.now()
      const key = `${reason}|${extra.currentIdx ?? ''}|${chunkProgress.toFixed(3)}`
      const prev = cursorDebugRef.current
      if (key !== prev.lastKey || now - prev.lastAt > 600) {
        cursorDebugRef.current = { lastKey: key, lastAt: now }
        console.debug('[cursor]', entry)
      }
    }
    const hide = (reason: string, extra: any = {}) => {
      stopCursorMotion()
      cursorMotionRef.current.visible = false
      cursorMotionRef.current.current = null
      cursorMotionRef.current.target = null
      cursor.style.opacity = '0'
      reportCursor(reason, extra)
    }
    if (!isPlaying) return hide('not-playing')
    const active = findLiveActiveSentence()
    if (!active) return hide('no-live-active-sentence')
    const words = wordsCacheRef.current
    if (!words.length) return hide('no-words')
    const viewportRect = active.closest('.reflow-viewport')?.getBoundingClientRect()
    const rootRect = root.getBoundingClientRect()
    const position = clamp(chunkProgress, 0, 0.999999) * words.length
    const currentIdx = Math.min(words.length - 1, Math.floor(position))
    const region = estimatedRegionRect(active, words, currentIdx, viewportRect)
    if (!region) return hide('no-estimated-region-rect', { currentIdx, position })
    if (viewportRect && !rectIntersects(region.currentRect, viewportRect)) {
      return hide('current-word-outside-viewport', {
        currentIdx,
        position,
        word: active.textContent?.slice(words[currentIdx].start, words[currentIdx].end),
        wordRect: debugRect(region.currentRect),
        viewportRect: debugRect(viewportRect),
      })
    }

    moveCursorTo(rectToLocal(region.rect, rootRect, root), !cursorMotionRef.current.current)
    reportCursor('placed', {
      currentIdx,
      startIdx: region.startIdx,
      endIdx: region.endIdx,
      position,
      word: active.textContent?.slice(words[currentIdx].start, words[currentIdx].end),
      phrase: active.textContent?.slice(words[region.startIdx].start, words[region.endIdx].end),
      wordRect: debugRect(region.currentRect),
      regionRect: debugRect(region.rect),
      viewportRect: debugRect(viewportRect),
    })
  }, [chunkProgress, currentSentence, activeChapterIdx, chapterIdx, isPlaying, viewPage, pagesPerView, findLiveActiveSentence])

  useEffect(() => () => {
    if (cursorMotionRef.current.raf != null) {
      cancelAnimationFrame(cursorMotionRef.current.raf)
      cursorMotionRef.current.raf = null
    }
  }, [])

  // Single-page mode has no flipper — a brief fade+slide masks the instant
  // content swap when nav happens. `singleTurn` is the direction; cleared
  // after the animation runs.
  const [singleTurn, setSingleTurn] = useState<'next' | 'prev' | null>(null)
  const singleTurnTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const triggerSingleTurn = useCallback((direction: 'next' | 'prev') => {
    if (!motion) return
    setSingleTurn(direction)
    if (singleTurnTimeoutRef.current) clearTimeout(singleTurnTimeoutRef.current)
    singleTurnTimeoutRef.current = setTimeout(() => setSingleTurn(null), 320)
  }, [motion])
  useEffect(() => () => {
    if (singleTurnTimeoutRef.current) clearTimeout(singleTurnTimeoutRef.current)
  }, [])

  const updateMode = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const available = el.clientWidth || el.getBoundingClientRect().width
    const next = available >= TWO_PAGE_WIDTH + TWO_PAGE_MARGIN ? 2 : 1
    setPagesPerView(prev => {
      if (prev === next) return prev
      setViewPage(currentView => {
        const firstContentPage = currentView * prev
        return Math.max(0, Math.floor(firstContentPage / next))
      })
      return next
    })
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

  const viewForSentence = useCallback((sentenceIdx: number, indexType = 'local') => {
    const measure = measureRef.current
    if (!measure || sentenceIdx == null || sentenceIdx < 0) return null
    const attr = indexType === 'global' ? 'data-sent-idx' : 'data-local-sent-idx'
    const el = measure.querySelector(`[${attr}="${sentenceIdx}"]`)
    if (!el) return null
    const contentPage = Math.floor((el as HTMLElement).offsetTop / TEXT_HEIGHT)
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
    setChapterPageCounts(prev => {
      const total = reflow?.chapters?.length || 0
      if (!total) return []
      const sameLength = prev.length === total
      const next = sameLength ? [...prev] : Array.from({ length: total }, (_, i) => prev[i] || 0)
      if (sameLength && next[chapterIdx] === pages) return prev
      next[chapterIdx] = pages
      return next
    })

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
  }, [chapter, pagesPerView, searchTarget, chapterIdx, viewForSentence, reflow])

  useEffect(() => {
    if (!reflow?.chapters?.length) {
      setChapterPageCounts([])
      setMeasureChapterIdx(null)
      return
    }
    setChapterPageCounts(prev => {
      const next = Array.from({ length: reflow.chapters.length }, (_, i) => prev[i] || 0)
      return prev.length === next.length ? prev : next
    })
  }, [reflow])

  useEffect(() => {
    const total = reflow?.chapters?.length || 0
    if (!total || measureChapterIdx != null) return

    const missing = chapterMeasureOrder.find(idx => idx !== chapterIdx && !chapterPageCounts[idx])
    if (missing == null) return

    const schedule = window.requestIdleCallback || ((cb) => window.setTimeout(cb, 250))
    const cancel = window.cancelIdleCallback || window.clearTimeout
    const handle = schedule(() => {
      setMeasureChapterIdx(missing)
    }, { timeout: 1200 })
    return () => cancel(handle)
  }, [reflow, chapterIdx, chapterMeasureOrder, chapterPageCounts, measureChapterIdx])

  useLayoutEffect(() => {
    if (measureChapterIdx == null) return
    const raf = requestAnimationFrame(() => {
      const el = chapterMeasureRef.current
      if (!el) return
      const pages = Math.max(1, Math.ceil((el.scrollHeight || TEXT_HEIGHT) / TEXT_HEIGHT))
      setChapterPageCounts(prev => {
        const total = reflow?.chapters?.length || 0
        if (!total) return []
        const sameLength = prev.length === total
        const next = sameLength ? [...prev] : Array.from({ length: total }, (_, i) => prev[i] || 0)
        if (sameLength && next[measureChapterIdx] === pages) return prev
        next[measureChapterIdx] = pages
        return next
      })
      setMeasureChapterIdx(null)
    })
    return () => cancelAnimationFrame(raf)
  }, [measureChapterIdx, reflow])

  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      setViewPage(prev => Math.min(prev, Math.max(0, viewCount - 1)))
    })
    return () => cancelAnimationFrame(raf)
  }, [pagesPerView, viewCount])

  useEffect(() => {
    stateRef.current = { viewPage, viewCount, chapterIdx, pagesPerView }
  }, [viewPage, viewCount, chapterIdx, pagesPerView])

  // Follow Along — advance the sub-page when the estimated reading point
  // crosses into a later view. Each chunk has multiple line boxes; we pick the
  // line indexed by `chunkProgress` and check which view holds that line. This
  // keeps the visible spread aligned with where the listener IS rather than
  // where the chunk started — useful when a chunk straddles a column break.
  useEffect(() => {
    const debug = typeof window !== 'undefined' && window.FOLIO_DEBUG_PAGE_TURN
    const log = (reason: string, extra: any = undefined) => {
      if (debug) console.debug('[page-turn]', reason, extra || '')
    }
    if (!followAlongMode) return log('skip: not in follow along')
    if (activeChapterIdx !== chapterIdx) return log('skip: chapter mismatch', { activeChapterIdx, chapterIdx })
    if (currentSentence == null || currentSentence < 0) return log('skip: no current sentence', { currentSentence })
    const measure = measureRef.current
    if (!measure) return log('skip: no measure ref')
    const el = measure.querySelector(`[data-local-sent-idx="${currentSentence}"]`)
    if (!el) return log('skip: no el for sentence', { currentSentence })
    const rects = el.getClientRects()
    if (!rects.length) return log('skip: no rects')
    const measureRect = measure.getBoundingClientRect()
    const lineIdx = Math.min(
      rects.length - 1,
      Math.max(0, Math.floor(chunkProgress * rects.length))
    )
    const lineY = rects[lineIdx].top - measureRect.top
    const contentPage = Math.floor(lineY / TEXT_HEIGHT)
    const targetView = Math.max(0, Math.floor(contentPage / pagesPerView))
    const { viewPage: vp, viewCount: vc, pagesPerView: ppv } = stateRef.current
    log('checked', {
      currentSentence, chunkProgress: +chunkProgress.toFixed(3),
      lineCount: rects.length, lineIdx,
      lineY: Math.round(lineY), contentPage,
      targetView, currentView: vp, viewCount: vc,
    })
    if (targetView <= vp || targetView >= vc) return
    log('ADVANCE', { from: vp, to: targetView })
    const raf = requestAnimationFrame(() => {
      const direction = 'next'
      if (ppv === 2) onPageTurn?.(direction)
      else triggerSingleTurn(direction)
      setViewPage(targetView)
    })
    return () => cancelAnimationFrame(raf)
  }, [followAlongMode, activeChapterIdx, chapterIdx, currentSentence, chunkProgress, pagesPerView, onPageTurn, triggerSingleTurn])

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

  return (
    <div className={`page-scroll reflow-scroll ${followAlongMode ? 'follow-along-scroll' : ''}`} ref={scrollRef}>
      {/* Reading cursor — sits on top of the current word inside the active
          chunk. Positioned via Range API every progress tick. */}
      <div className="reading-focus-glow" ref={cursorRef} aria-hidden="true" />
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

        {measureChapterIdx != null && reflow.chapters[measureChapterIdx] && (
          <div
            key={`chapter-measure-${reflow.chapters[measureChapterIdx].id ?? measureChapterIdx}`}
            ref={chapterMeasureRef}
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
            {renderChapterContent(reflow.chapters[measureChapterIdx], measureChapterIdx, false)}
          </div>
        )}

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

export default memo(ReflowViewer)
