from pathlib import Path

PATH = Path('frontend/src/components/ReflowViewer.tsx')
text = PATH.read_text(encoding='utf-8')
original = text


def replace_once(old: str, new: str, label: str) -> None:
    global text
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{label}: expected exactly one match, found {count}')
    text = text.replace(old, new, 1)


def remove_between(start: str, end: str, label: str, keep_end: bool = True) -> None:
    global text
    start_index = text.find(start)
    if start_index < 0:
        raise RuntimeError(f'{label}: start marker not found')
    end_index = text.find(end, start_index)
    if end_index < 0:
        raise RuntimeError(f'{label}: end marker not found')
    replacement = end if keep_end else ''
    text = text[:start_index] + replacement + text[end_index + len(end):]


replace_once(
    "import type React from 'react'\n",
    "import type React from 'react'\nimport { usePlaybackLineCursor } from '../followAlong/usePlaybackLineCursor'\n",
    'follow-along hook import',
)
replace_once("const LINE_SWITCH_HYSTERESIS = 0.018\n", '', 'old line hysteresis')

remove_between(
    'function debugFlag(globalName: string, storageKey: string) {',
    'function safeStorage() {',
    'legacy cursor debug helpers',
)

remove_between(
    'function rectToLocal(rect: DOMRect | any, rootRect: DOMRect, scrollEl: Element | null) {',
    'type WeightedWord = { start: number; end: number; weightStart: number; weightEnd: number }',
    'legacy live cursor geometry',
)

remove_between(
    'function wordIndexForOffset(words: WeightedWord[], offset: number) {',
    "function measuredSentenceElement(measure: Element | null, sentenceIdx: number, indexType = 'local') {",
    'legacy selection progress helpers',
)

remove_between(
    'function caretRangeFromPoint(x: number, y: number) {',
    'interface ReflowViewerProps {',
    'legacy point-selection geometry',
)

replace_once(
    '  const androidLineTapRef = useRef({ pointerId: -1, x: 0, y: 0 })\n',
    '',
    'legacy Android tap ref',
)

remove_between(
    "  const followTurnKeyRef = useRef('')",
    '  const chapterMeasureOrder = useMemo(() => {',
    'follow-along retry state',
)

replace_once(
    "  const [cursorRefreshTick, setCursorRefreshTick] = useState(0)\n"
    "  const cursorRefreshFrameRef = useRef<number | null>(null)\n"
    "  const refreshCursorAfterTurn = useCallback(() => {\n"
    "    if (cursorRefreshFrameRef.current != null) cancelAnimationFrame(cursorRefreshFrameRef.current)\n"
    "    cursorRefreshFrameRef.current = requestAnimationFrame(() => {\n"
    "      cursorRefreshFrameRef.current = null\n"
    "      setCursorRefreshTick((tick) => (tick + 1) % 1000000)\n"
    "    })\n"
    "  }, [])\n"
    "  const isPageTurning = Boolean(singleTurn || doubleTurn)\n",
    "  const isPageTurning = Boolean(singleTurn || doubleTurn)\n",
    'cursor refresh timer',
)

replace_once(
    "      singleTurnTimeoutRef.current = null\n      refreshCursorAfterTurn()\n",
    "      singleTurnTimeoutRef.current = null\n",
    'single-page turn cursor refresh',
)
replace_once(
    '  }, [motion, refreshCursorAfterTurn])\n',
    '  }, [motion])\n',
    'single-page turn dependencies',
)
replace_once(
    "      doubleTurnTimeoutRef.current = null\n      refreshCursorAfterTurn()\n",
    "      doubleTurnTimeoutRef.current = null\n",
    'double-page turn cursor refresh',
)
replace_once(
    '  }, [chapterLabel, chapterPageOffset, contentEls, contentPageCount, motion, refreshCursorAfterTurn, runHeadText])\n',
    '  }, [chapterLabel, chapterPageOffset, contentEls, contentPageCount, motion, runHeadText])\n',
    'double-page turn dependencies',
)

remove_between(
    '  // Reading/selection cursor — a single minimal line.',
    '  const turnToView = useCallback((targetView: number, animate = true) => {',
    'legacy cursor runtime',
)

replace_once(
    "    if (nextView === currentView) {\n      followTurnKeyRef.current = ''\n      return false\n    }\n"
    "    selectedLineRef.current = null\n"
    "    hideLineCursor('force-hidden')\n",
    "    if (nextView === currentView) return false\n",
    'turn-to-view legacy cursor ownership',
)
replace_once(
    '  }, [androidRuntime, hideLineCursor, triggerDoubleTurn, triggerSingleTurn])\n',
    '  }, [androidRuntime, triggerDoubleTurn, triggerSingleTurn])\n',
    'turn-to-view dependencies',
)

hook_wiring = """

  const playbackCursor = usePlaybackLineCursor({
    rootRef: scrollRef,
    bookId,
    chapterIndex: chapterIdx,
    activeChapterIndex: activeChapterIdx,
    currentSentence,
    rawProgress: chunkProgress,
    isPlaying,
    followAlongMode,
    pagesPerView,
    viewPage,
    pageStride: TEXT_WIDTH + GAP,
    layoutIdentity: [
      bookId,
      chapter?.id ?? chapterIdx,
      paginationKey || 'no-pagination-key',
      pagesPerView,
      theme,
      contentPageCount,
      modeMeasured ? 'measured' : 'pending',
    ].join(':'),
    isPageTurning,
    androidRuntime,
    onRequestChapter: setChapterIdx,
    onRequestView: turnToView,
    onSentenceSelect,
  })
  const {
    cursorRef,
    handleLinePointerMove,
    handleLinePointerLeave,
    handleLineDoubleClick,
    handleAndroidLinePointerDown,
    handleAndroidLinePointerUp,
    cancelAndroidLineTap,
  } = playbackCursor
"""

replace_once(
    '  }, [androidRuntime, triggerDoubleTurn, triggerSingleTurn])\n\n  useEffect(() => () => {',
    '  }, [androidRuntime, triggerDoubleTurn, triggerSingleTurn])' + hook_wiring + '\n  useEffect(() => () => {',
    'authoritative cursor hook wiring',
)

replace_once(
    "    if (singleTurnTimeoutRef.current) clearTimeout(singleTurnTimeoutRef.current)\n"
    "    if (doubleTurnTimeoutRef.current) clearTimeout(doubleTurnTimeoutRef.current)\n"
    "    if (followRetryTimeoutRef.current) clearTimeout(followRetryTimeoutRef.current)\n"
    "    if (cursorRefreshFrameRef.current != null) cancelAnimationFrame(cursorRefreshFrameRef.current)\n",
    "    if (singleTurnTimeoutRef.current) clearTimeout(singleTurnTimeoutRef.current)\n"
    "    if (doubleTurnTimeoutRef.current) clearTimeout(doubleTurnTimeoutRef.current)\n",
    'legacy cleanup timers',
)

remove_between(
    '  // Follow Along owns continuous page/sub-page synchronization.',
    "  const goToSentence = useCallback((targetChapter, sentenceIdx, indexType = 'local') => {",
    'legacy follow-along retry effect',
)

replace_once(
    '      <div className="reader-line-cursor" ref={cursorRef} aria-hidden="true" />\n',
    '      <div className="reader-line-cursor" ref={cursorRef} aria-hidden="true" />\n      {playbackCursor.debugOverlay}\n',
    'cursor debug overlay render',
)

for forbidden in (
    'followRetryTick',
    'followRetryTimeoutRef',
    'queueFollowRetry',
    'clearFollowRetry',
    'followTurnKeyRef',
    'selectedLineRef',
    'playbackLineCacheRef',
    'playbackLineHoldRef',
    'cursorRefreshTick',
    'cursorRefreshFrameRef',
    'placeLineOverlay(',
    'activeLineRect(',
    'caretRangeFromPoint(',
):
    if forbidden in text:
        raise RuntimeError(f'legacy cursor symbol remains: {forbidden}')

if text == original:
    raise RuntimeError('patch made no changes')

PATH.write_text(text, encoding='utf-8')
print(f'Patched {PATH}: {len(original.splitlines())} -> {len(text.splitlines())} lines')
