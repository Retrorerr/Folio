import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import {
  INITIAL_FOLLOW_ALONG_STATE,
  appendBoundedTrace,
  cursorTransitionKind,
  followAlongReducer,
  resolvePlaybackAnchor,
  updateStableProgress,
  type FollowAlongTraceEntry,
  type PlaybackAnchor,
  type ProgressGuardState,
  type VisualLineMap,
} from './playbackModel'
import {
  anchorForLine,
  buildVisualLineMap,
  currentVisualLineMapLayoutKey,
  hitTestVisualLine,
} from './visualLineMap'

type UsePlaybackLineCursorOptions = {
  rootRef: MutableRefObject<HTMLDivElement | null>
  bookId: string
  chapterIndex: number
  activeChapterIndex: number
  currentSentence: number
  rawProgress: number
  isPlaying: boolean
  followAlongMode: boolean
  pagesPerView: number
  viewPage: number
  pageStride: number
  layoutIdentity: string
  isPageTurning: boolean
  androidRuntime: boolean
  onRequestChapter?: (chapterIndex: number) => Promise<unknown> | undefined
  onRequestView: (viewIndex: number, animate?: boolean) => boolean
  onSentenceSelect?: (chapter: number, sentence: number, options?: { progress?: number }) => void
}

type CursorPresentationMode = 'hover' | 'selected' | 'playback' | 'paused' | 'waiting' | 'hidden'

const MAX_BUILD_ATTEMPTS = 2
const STALE_CURSOR_GRACE_MS = 520
const DOUBLE_TAP_MS = 340
const DOUBLE_TAP_DISTANCE = 22

function debugEnabled(name: string, storageKey: string) {
  if (typeof window === 'undefined') return false
  try {
    return Boolean((window as any)[name]) || window.localStorage?.getItem(storageKey) === '1'
  } catch {
    return Boolean((window as any)[name])
  }
}

function sameAnchor(a: PlaybackAnchor | null, b: PlaybackAnchor | null) {
  return Boolean(
    a && b &&
    a.bookId === b.bookId &&
    a.chapterIndex === b.chapterIndex &&
    a.sentenceIndex === b.sentenceIndex &&
    a.lineId === b.lineId &&
    a.viewIndex === b.viewIndex &&
    a.generation === b.generation &&
    a.placement.key === b.placement.key,
  )
}

export function usePlaybackLineCursor(options: UsePlaybackLineCursorOptions) {
  const {
    rootRef,
    bookId,
    chapterIndex,
    activeChapterIndex,
    currentSentence,
    rawProgress,
    isPlaying,
    followAlongMode,
    pagesPerView,
    viewPage,
    pageStride,
    layoutIdentity,
    isPageTurning,
    androidRuntime,
    onRequestChapter,
    onRequestView,
    onSentenceSelect,
  } = options

  const cursorRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<VisualLineMap | null>(null)
  const [lineMap, setLineMap] = useState<VisualLineMap | null>(null)
  const [followState, dispatch] = useReducer(followAlongReducer, INITIAL_FOLLOW_ALONG_STATE)
  const followStateRef = useRef(followState)
  const generationRef = useRef(0)
  const rebuildFrameRef = useRef<number | null>(null)
  const rebuildAttemptRef = useRef(0)
  const rebuildReasonRef = useRef('initial')
  const staleVisibleUntilRef = useRef(0)
  const stableProgressRef = useRef<ProgressGuardState | null>(null)
  const backwardResetTokenRef = useRef(0)
  const selectedPendingRef = useRef<PlaybackAnchor | null>(null)
  const requestedViewKeyRef = useRef('')
  const requestedChapterRef = useRef<number | null>(null)
  const lastResolvedAnchorRef = useRef<PlaybackAnchor | null>(null)
  const lastPresentationRef = useRef<{
    key: string
    x: number
    y: number
    height: number
    generation: number
    column: number
    viewIndex: number
  } | null>(null)
  const hoverFrameRef = useRef<number | null>(null)
  const hoverPointRef = useRef<{ x: number; y: number } | null>(null)
  const pointerDownRef = useRef({ pointerId: -1, x: 0, y: 0 })
  const lastTapRef = useRef({ at: 0, x: 0, y: 0 })
  const traceRef = useRef<FollowAlongTraceEntry[]>([])
  const [debugOverlay, setDebugOverlay] = useState(() => (
    debugEnabled('FOLIO_DEBUG_FOLLOW_OVERLAY', 'folioDebugFollowOverlay')
  ))

  useLayoutEffect(() => {
    followStateRef.current = followState
  }, [followState])

  const sessionId = useMemo(() => (
    `${bookId}:${activeChapterIndex}:${currentSentence}`
  ), [activeChapterIndex, bookId, currentSentence])

  const traceContextRef = useRef({
    sessionId,
    activeChapterIndex,
    currentSentence,
    rawProgress,
    viewPage,
  })
  useLayoutEffect(() => {
    traceContextRef.current = {
      sessionId,
      activeChapterIndex,
      currentSentence,
      rawProgress,
      viewPage,
    }
  }, [activeChapterIndex, currentSentence, rawProgress, sessionId, viewPage])

  // Keep instrumentation independent from live playback values. Recreating this
  // callback on every progress sample would also recreate scheduleRebuild and
  // make the layout-identity effect rebuild the full visual-line map repeatedly.
  const trace = useCallback((reason: string, detail: Record<string, unknown> = {}) => {
    const live = traceContextRef.current
    const state = followStateRef.current
    const progress = stableProgressRef.current
    const anchor = state.pendingAnchor || state.anchor || state.selectedAnchor || state.hoverAnchor
    const entry: FollowAlongTraceEntry = {
      at: Date.now(),
      sessionId: live.sessionId,
      chapterIndex: live.activeChapterIndex >= 0 ? live.activeChapterIndex : null,
      sentenceIndex: live.currentSentence >= 0 ? live.currentSentence : null,
      rawProgress: Number.isFinite(live.rawProgress) ? live.rawProgress : null,
      stableProgress: progress?.stableProgress ?? null,
      lineId: anchor?.lineId ?? null,
      targetView: anchor?.viewIndex ?? null,
      visibleView: live.viewPage,
      layoutGeneration: mapRef.current?.generation ?? null,
      state: state.status,
      reason,
      detail,
    }
    traceRef.current = appendBoundedTrace(traceRef.current, entry)
    if (debugEnabled('FOLIO_DEBUG_FOLLOW_ALONG', 'folioDebugFollowAlong')) {
      console.debug('[follow-along]', entry)
    }
  }, [])

  const commitMap = useCallback((map: VisualLineMap) => {
    mapRef.current = map
    setLineMap(map)
    rebuildAttemptRef.current = 0
    dispatch({ type: 'LAYOUT_READY', generation: map.generation })
    trace('layout-ready', {
      generation: map.generation,
      layoutKey: map.layoutKey,
      lineCount: map.lines.length,
      sentenceCount: map.bySentence.size,
      buildDurationMs: map.metrics.buildDurationMs ?? null,
      tokenCount: map.metrics.tokenCount ?? null,
      textNodeCount: map.metrics.textNodeCount ?? null,
      rangeCount: map.metrics.rangeCount ?? null,
      getClientRectsCount: map.metrics.getClientRectsCount ?? null,
    })
  }, [trace])

  const performRebuild = useCallback(() => {
    function attemptBuild() {
      rebuildFrameRef.current = null
      const root = rootRef.current
      if (!root || !bookId) return

      const generation = generationRef.current + 1
      generationRef.current = generation
      const map = buildVisualLineMap({
        root,
        bookId,
        chapterIndex,
        generation,
        pagesPerView,
        pageStride,
        layoutIdentity,
      })

      if (map) {
        commitMap(map)
        return
      }

      rebuildAttemptRef.current += 1
      trace('layout-build-failed', {
        reason: rebuildReasonRef.current,
        attempt: rebuildAttemptRef.current,
      })
      if (rebuildAttemptRef.current < MAX_BUILD_ATTEMPTS) {
        rebuildFrameRef.current = requestAnimationFrame(attemptBuild)
        return
      }
      dispatch({ type: 'UNAVAILABLE', reason: `layout:${rebuildReasonRef.current}` })
    }

    attemptBuild()
  }, [bookId, chapterIndex, commitMap, layoutIdentity, pageStride, pagesPerView, rootRef, trace])

  const scheduleRebuild = useCallback((reason: string) => {
    const root = rootRef.current
    const existingMap = mapRef.current
    if (
      existingMap &&
      root &&
      (reason === 'foreground' || reason === 'font-loading-complete') &&
      currentVisualLineMapLayoutKey({
        root,
        bookId,
        chapterIndex,
        generation: existingMap.generation,
        pagesPerView,
        pageStride,
        layoutIdentity,
      }) === existingMap.layoutKey
    ) {
      trace('layout-not-invalidated', { reason, layoutKey: existingMap.layoutKey })
      return
    }

    const alreadyScheduled = rebuildFrameRef.current != null
    rebuildReasonRef.current = reason
    if (alreadyScheduled) return
    rebuildAttemptRef.current = 0
    staleVisibleUntilRef.current = performance.now() + STALE_CURSOR_GRACE_MS
    dispatch({ type: 'LAYOUT_INVALIDATED', reason })
    trace('layout-invalidated', { reason })
    rebuildFrameRef.current = requestAnimationFrame(performRebuild)
  }, [bookId, chapterIndex, layoutIdentity, pageStride, pagesPerView, performRebuild, rootRef, trace])

  useLayoutEffect(() => {
    scheduleRebuild('layout-identity')
  }, [layoutIdentity, scheduleRebuild])

  useEffect(() => {
    const root = rootRef.current
    if (!root) return undefined
    const viewport = root.querySelector<HTMLElement>('.reflow-viewport')
    const flow = viewport?.querySelector<HTMLElement>('.reflow-flow:not(.reflow-measure)')
    const resizeObserver = new ResizeObserver(() => scheduleRebuild('resize-observer'))
    resizeObserver.observe(root)
    if (viewport) resizeObserver.observe(viewport)
    if (flow) resizeObserver.observe(flow)

    const onWindowResize = () => scheduleRebuild('window-resize')
    const onOrientation = () => scheduleRebuild('orientation-change')
    const onVisibility = () => {
      if (document.visibilityState === 'visible') scheduleRebuild('foreground')
    }
    const onFontsLoaded = () => scheduleRebuild('font-loading-complete')

    window.addEventListener('resize', onWindowResize)
    window.addEventListener('orientationchange', onOrientation)
    document.addEventListener('visibilitychange', onVisibility)
    document.fonts?.addEventListener?.('loadingdone', onFontsLoaded)
    document.fonts?.ready?.then(onFontsLoaded).catch(() => {})

    return () => {
      resizeObserver.disconnect()
      window.removeEventListener('resize', onWindowResize)
      window.removeEventListener('orientationchange', onOrientation)
      document.removeEventListener('visibilitychange', onVisibility)
      document.fonts?.removeEventListener?.('loadingdone', onFontsLoaded)
    }
  }, [rootRef, scheduleRebuild])

  useEffect(() => () => {
    if (rebuildFrameRef.current != null) cancelAnimationFrame(rebuildFrameRef.current)
    if (hoverFrameRef.current != null) cancelAnimationFrame(hoverFrameRef.current)
  }, [])

  useEffect(() => {
    mapRef.current = null
    setLineMap(null)
    stableProgressRef.current = null
    selectedPendingRef.current = null
    requestedViewKeyRef.current = ''
    requestedChapterRef.current = null
    lastResolvedAnchorRef.current = null
    dispatch({ type: 'RESET' })
  }, [bookId])

  const resolveCurrentAnchor = useCallback((map: VisualLineMap, stableProgress: number) => (
    resolvePlaybackAnchor(map, {
      bookId,
      chapterIndex: activeChapterIndex,
      sentenceIndex: currentSentence,
      progress: stableProgress,
      visibleViewIndex: viewPage,
    })
  ), [activeChapterIndex, bookId, currentSentence, viewPage])

  useLayoutEffect(() => {
    if (currentSentence < 0 || activeChapterIndex < 0) {
      stableProgressRef.current = null
      requestedViewKeyRef.current = ''
      dispatch({ type: 'STOP' })
      return
    }

    if (activeChapterIndex !== chapterIndex) {
      if (followAlongMode && requestedChapterRef.current !== activeChapterIndex) {
        requestedChapterRef.current = activeChapterIndex
        onRequestChapter?.(activeChapterIndex)
        trace('chapter-sync-requested', { from: chapterIndex, to: activeChapterIndex })
      }
      dispatch({ type: 'UNAVAILABLE', reason: 'chapter-mismatch' })
      return
    }
    requestedChapterRef.current = null

    const stable = updateStableProgress(stableProgressRef.current, {
      sessionKey: sessionId,
      progress: rawProgress,
      resetToken: backwardResetTokenRef.current,
    })
    stableProgressRef.current = stable

    const map = mapRef.current
    if (!map || map.chapterIndex !== activeChapterIndex) {
      dispatch({ type: 'UNAVAILABLE', reason: 'missing-current-layout' })
      return
    }

    const selectionPending = selectedPendingRef.current
    if (selectionPending && !isPlaying) {
      return
    }
    if (selectionPending && isPlaying) selectedPendingRef.current = null

    const anchor = resolveCurrentAnchor(map, stable.stableProgress)
    if (!anchor) {
      dispatch({ type: 'UNAVAILABLE', reason: 'unmapped-playback-position' })
      trace('anchor-unavailable', {
        generation: map.generation,
        sentence: currentSentence,
        progress: stable.stableProgress,
      })
      return
    }

    if (isPageTurning) {
      dispatch({ type: 'WAIT_FOR_LAYOUT', anchor, reason: 'manual-page-turn' })
      return
    }

    if (anchor.viewIndex !== viewPage) {
      if (!followAlongMode) {
        dispatch({ type: 'UNAVAILABLE', reason: 'playback-off-visible-view' })
        return
      }
      dispatch({ type: 'REQUEST_VIEW', anchor, reason: 'playback-anchor-view' })
      const requestKey = `${anchor.generation}:${anchor.chapterIndex}:${anchor.viewIndex}`
      if (requestedViewKeyRef.current !== requestKey) {
        requestedViewKeyRef.current = requestKey
        onRequestView(anchor.viewIndex, false)
        trace('view-sync-requested', {
          from: viewPage,
          to: anchor.viewIndex,
          lineId: anchor.lineId,
        })
      }
      return
    }

    requestedViewKeyRef.current = ''
    const previous = lastResolvedAnchorRef.current
    if (!sameAnchor(previous, anchor) || followStateRef.current.status !== (isPlaying ? 'playing' : 'paused')) {
      lastResolvedAnchorRef.current = anchor
      dispatch({ type: 'PLAYBACK_ANCHOR', anchor, playing: isPlaying })
      trace(isPlaying ? 'playback-anchor' : 'paused-anchor', {
        lineId: anchor.lineId,
        view: anchor.viewIndex,
        progressRange: [anchor.progressStart, anchor.progressEnd],
      })
    }
  }, [
    activeChapterIndex,
    chapterIndex,
    currentSentence,
    followAlongMode,
    isPageTurning,
    isPlaying,
    lineMap,
    onRequestChapter,
    onRequestView,
    rawProgress,
    resolveCurrentAnchor,
    sessionId,
    trace,
    viewPage,
  ])

  useLayoutEffect(() => {
    const pending = followStateRef.current.pendingAnchor
    const map = mapRef.current
    const stable = stableProgressRef.current
    if (!pending || !map || !stable) return
    if (pending.chapterIndex !== chapterIndex || pending.viewIndex !== viewPage) return

    const resolved = resolveCurrentAnchor(map, stable.stableProgress)
    if (!resolved || resolved.viewIndex !== viewPage) {
      dispatch({ type: 'WAIT_FOR_LAYOUT', anchor: pending, reason: 'destination-layout-not-committed' })
      return
    }

    requestedViewKeyRef.current = ''
    lastResolvedAnchorRef.current = resolved
    dispatch({ type: 'VIEW_COMMITTED', anchor: resolved, playing: isPlaying })
    trace('view-sync-committed', {
      lineId: resolved.lineId,
      view: resolved.viewIndex,
      generation: resolved.generation,
    })
  }, [chapterIndex, isPlaying, lineMap, resolveCurrentAnchor, trace, viewPage])

  const selectLine = useCallback((clientX: number, clientY: number) => {
    const map = mapRef.current
    const root = rootRef.current
    const line = hitTestVisualLine(map, root, clientX, clientY, viewPage)
    if (!map || !line) return false
    const anchor = anchorForLine(map, line, viewPage)
    if (!anchor) return false

    backwardResetTokenRef.current += 1
    stableProgressRef.current = updateStableProgress(stableProgressRef.current, {
      sessionKey: `${bookId}:${chapterIndex}:${line.sentenceIndex}`,
      progress: line.progressStart,
      resetToken: backwardResetTokenRef.current,
      allowBackward: true,
    })
    selectedPendingRef.current = anchor
    lastResolvedAnchorRef.current = anchor
    dispatch({ type: 'SELECT', anchor })
    trace('line-selected', {
      lineId: line.lineId,
      sentence: line.sentenceIndex,
      progress: line.progressStart,
    })
    onSentenceSelect?.(chapterIndex, line.sentenceIndex, { progress: line.progressStart })
    return true
  }, [bookId, chapterIndex, onSentenceSelect, rootRef, trace, viewPage])

  const flushHover = useCallback(() => {
    hoverFrameRef.current = null
    if (isPlaying || isPageTurning || selectedPendingRef.current) return
    const point = hoverPointRef.current
    const map = mapRef.current
    const root = rootRef.current
    if (!point || !map || !root) return
    const line = hitTestVisualLine(map, root, point.x, point.y, viewPage)
    if (!line) {
      dispatch({ type: 'CLEAR_HOVER' })
      return
    }
    const anchor = anchorForLine(map, line, viewPage)
    if (anchor) dispatch({ type: 'HOVER', anchor })
  }, [isPageTurning, isPlaying, rootRef, viewPage])

  const handleLinePointerMove = useCallback((event: ReactPointerEvent) => {
    if (event.pointerType === 'touch' || event.pointerType === 'pen') return
    hoverPointRef.current = { x: event.clientX, y: event.clientY }
    if (hoverFrameRef.current == null) hoverFrameRef.current = requestAnimationFrame(flushHover)
  }, [flushHover])

  const handleLinePointerLeave = useCallback(() => {
    hoverPointRef.current = null
    if (hoverFrameRef.current != null) cancelAnimationFrame(hoverFrameRef.current)
    hoverFrameRef.current = null
    dispatch({ type: 'CLEAR_HOVER' })
  }, [])

  const handleLineClick = useCallback((event: ReactMouseEvent) => {
    if (androidRuntime || event.button !== 0 || isPageTurning) return
    event.preventDefault()
    selectLine(event.clientX, event.clientY)
  }, [androidRuntime, isPageTurning, selectLine])

  const handleAndroidLinePointerDown = useCallback((event: ReactPointerEvent) => {
    if (!androidRuntime || (event.pointerType !== 'touch' && event.pointerType !== 'pen')) return
    const target = event.target as HTMLElement | null
    if (target?.closest('button, a, input, textarea, select, [role="button"]')) return
    pointerDownRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY }
  }, [androidRuntime])

  const handleAndroidLinePointerUp = useCallback((event: ReactPointerEvent) => {
    const down = pointerDownRef.current
    pointerDownRef.current = { pointerId: -1, x: 0, y: 0 }
    if (!androidRuntime || event.pointerId !== down.pointerId || isPageTurning) return
    if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > 12) return

    const now = performance.now()
    const previous = lastTapRef.current
    const isDoubleTap = (
      now - previous.at <= DOUBLE_TAP_MS &&
      Math.hypot(event.clientX - previous.x, event.clientY - previous.y) <= DOUBLE_TAP_DISTANCE
    )
    lastTapRef.current = { at: now, x: event.clientX, y: event.clientY }
    if (!isDoubleTap) return

    event.preventDefault()
    lastTapRef.current = { at: 0, x: 0, y: 0 }
    selectLine(event.clientX, event.clientY)
  }, [androidRuntime, isPageTurning, selectLine])

  const cancelAndroidLineTap = useCallback(() => {
    pointerDownRef.current = { pointerId: -1, x: 0, y: 0 }
  }, [])

  useLayoutEffect(() => {
    const cursor = cursorRef.current
    if (!cursor) return

    let anchor: PlaybackAnchor | null = null
    let mode: CursorPresentationMode = 'hidden'
    if (followState.status === 'hovering') {
      anchor = followState.hoverAnchor
      mode = 'hover'
    } else if (followState.status === 'selected') {
      anchor = followState.selectedAnchor
      mode = 'selected'
    } else if (followState.status === 'playing') {
      anchor = followState.anchor
      mode = 'playback'
    } else if (followState.status === 'paused') {
      anchor = followState.anchor || followState.selectedAnchor
      mode = followState.anchor ? 'paused' : 'selected'
    } else if (followState.status === 'changing-view' || followState.status === 'waiting-for-layout') {
      const keepStale = performance.now() <= staleVisibleUntilRef.current
      anchor = keepStale ? followState.anchor : null
      mode = keepStale ? 'waiting' : 'hidden'
    }

    if (isPageTurning || !anchor || anchor.placement.key.endsWith(':pending')) {
      cursor.style.opacity = '0'
      cursor.classList.remove('is-visible')
      cursor.dataset.cursorMode = isPageTurning ? 'turn-suppressed' : 'hidden'
      return
    }

    const previous = lastPresentationRef.current
    const movement = cursorTransitionKind(previous, {
      x: anchor.placement.x,
      generation: anchor.generation,
      column: anchor.placement.column,
      viewIndex: anchor.viewIndex,
    })
    cursor.dataset.cursorPosition = movement
    cursor.dataset.cursorMode = mode === 'paused' || mode === 'waiting' ? 'playback' : mode
    cursor.style.transform = `translate3d(${anchor.placement.x}px, ${anchor.placement.y}px, 0)`
    cursor.style.width = `${anchor.placement.width}px`
    cursor.style.height = `${anchor.placement.height}px`
    cursor.style.opacity = mode === 'waiting' ? '0.72' : '1'
    cursor.classList.add('is-visible')
    lastPresentationRef.current = {
      key: anchor.placement.key,
      x: anchor.placement.x,
      y: anchor.placement.y,
      height: anchor.placement.height,
      generation: anchor.generation,
      column: anchor.placement.column,
      viewIndex: anchor.viewIndex,
    }
  }, [followState, isPageTurning])

  const overlayNode = useMemo(() => {
    if (!debugOverlay || !lineMap) return null
    const visibleLines = lineMap.lines.filter(line => line.viewIndex === viewPage)
    return (
      <div aria-hidden="true" style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 8 }}>
        {visibleLines.map(line => {
          const slot = line.contentPage - viewPage * lineMap.pagesPerView
          const left = lineMap.metrics.rootContentX + (
            slot * lineMap.metrics.pageStride + line.pageX
          ) * lineMap.metrics.scaleX
          const top = lineMap.metrics.rootContentY + line.pageY * lineMap.metrics.scaleY
          const width = line.lineWidth * lineMap.metrics.scaleX
          const height = line.lineHeight * lineMap.metrics.scaleY
          const active = followState.anchor?.lineId === line.lineId || followState.selectedAnchor?.lineId === line.lineId
          return (
            <div
              key={`${line.generation}:${line.lineId}`}
              style={{
                position: 'absolute',
                left,
                top,
                width,
                height,
                border: `1px solid ${active ? 'rgba(255,70,40,.9)' : 'rgba(40,160,255,.45)'}`,
                background: active ? 'rgba(255,70,40,.08)' : 'transparent',
                font: '9px/1.1 monospace',
                color: active ? '#ff4628' : '#1796dc',
              }}
            >
              {line.lineId} {line.progressStart.toFixed(2)}–{line.progressEnd.toFixed(2)}
            </div>
          )
        })}
        <div style={{ position: 'absolute', left: 8, top: 8, padding: '5px 7px', background: 'rgba(0,0,0,.75)', color: '#fff', font: '10px monospace' }}>
          view {viewPage} · generation {lineMap.generation} · {followState.status}
        </div>
      </div>
    )
  }, [debugOverlay, followState.anchor?.lineId, followState.selectedAnchor?.lineId, followState.status, lineMap, viewPage])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const debugApi = {
      snapshot: () => ({
        state: followStateRef.current,
        progress: stableProgressRef.current,
        map: mapRef.current ? {
          bookId: mapRef.current.bookId,
          chapterIndex: mapRef.current.chapterIndex,
          generation: mapRef.current.generation,
          layoutKey: mapRef.current.layoutKey,
          lineCount: mapRef.current.lines.length,
          sentenceCount: mapRef.current.bySentence.size,
        } : null,
        visibleView: viewPage,
      }),
      trace: () => [...traceRef.current],
      rebuild: (reason = 'debug') => scheduleRebuild(reason),
      overlay: (enabled: boolean) => {
        try {
          window.localStorage?.setItem('folioDebugFollowOverlay', enabled ? '1' : '0')
        } catch {
          // Debug persistence is best-effort.
        }
        setDebugOverlay(Boolean(enabled))
      },
    }
    ;(window as any).__folioFollowAlong = debugApi
    return () => {
      if ((window as any).__folioFollowAlong === debugApi) delete (window as any).__folioFollowAlong
    }
  }, [scheduleRebuild, viewPage])

  return {
    cursorRef,
    debugOverlay: overlayNode,
    state: followState,
    handleLinePointerMove,
    handleLinePointerLeave,
    handleLineClick,
    handleAndroidLinePointerDown,
    handleAndroidLinePointerUp,
    cancelAndroidLineTap,
  }
}
