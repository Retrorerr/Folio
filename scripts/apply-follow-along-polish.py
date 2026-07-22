from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


root = Path(__file__).resolve().parents[1]

# ---------------------------------------------------------------------------
# Pure playback model: canonical physical-line geometry and transition policy.
# ---------------------------------------------------------------------------
model_path = root / "frontend/src/followAlong/playbackModel.ts"
model = model_path.read_text(encoding="utf-8")

model = replace_once(
    model,
    """export type CursorPlacement = {
  x: number
  y: number
  width: number
  height: number
  key: string
  column: number
}
""",
    """export type CursorPlacement = {
  x: number
  y: number
  width: number
  height: number
  key: string
  column: number
}

export type PhysicalLineGeometry = {
  contentPage: number
  top: number
  bottom: number
  left: number
  right: number
}

export type CursorPresentationSnapshot = {
  x: number
  generation: number
  column: number
  viewIndex: number
}
""",
    "model geometry types",
)

model = replace_once(
    model,
    """export function placementForLine(
""",
    """export function mergeWithCanonicalLineGeometry<T extends PhysicalLineGeometry>(
  line: T,
  canonicalLines: PhysicalLineGeometry[],
): T {
  const lineMid = (line.top + line.bottom) / 2
  const lineHeight = Math.max(1, line.bottom - line.top)
  let best: PhysicalLineGeometry | null = null
  let bestDistance = Number.POSITIVE_INFINITY

  for (const candidate of canonicalLines) {
    if (candidate.contentPage !== line.contentPage) continue
    const candidateMid = (candidate.top + candidate.bottom) / 2
    const candidateHeight = Math.max(1, candidate.bottom - candidate.top)
    const overlap = Math.min(line.bottom, candidate.bottom) - Math.max(line.top, candidate.top)
    const distance = Math.abs(lineMid - candidateMid)
    const tolerance = Math.max(4, Math.min(lineHeight, candidateHeight) * 0.62)
    if (overlap < -1 && distance > tolerance) continue
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }

  if (!best) return line
  return {
    ...line,
    left: Math.min(line.left, best.left),
    right: Math.max(line.right, best.right),
    top: Math.min(line.top, best.top),
    bottom: Math.max(line.bottom, best.bottom),
  }
}

export function cursorTransitionKind(
  previous: CursorPresentationSnapshot | null,
  next: CursorPresentationSnapshot,
  maxHorizontalDistance = 96,
): 'smooth' | 'snap' {
  if (!previous) return 'snap'
  if (previous.generation !== next.generation) return 'snap'
  if (previous.viewIndex !== next.viewIndex) return 'snap'
  if (previous.column !== next.column) return 'snap'
  if (Math.abs(previous.x - next.x) > maxHorizontalDistance) return 'snap'
  return 'smooth'
}

export function placementForLine(
""",
    "model geometry helpers",
)
model_path.write_text(model, encoding="utf-8")

# ---------------------------------------------------------------------------
# Visual line map: derive sentence destinations from canonical paragraph lines.
# ---------------------------------------------------------------------------
map_path = root / "frontend/src/followAlong/visualLineMap.ts"
visual = map_path.read_text(encoding="utf-8")
visual = replace_once(
    visual,
    """  assignVisualLineProgress,
  placementForLine,
  tokenizeWeighted,
""",
    """  assignVisualLineProgress,
  mergeWithCanonicalLineGeometry,
  placementForLine,
  tokenizeWeighted,
""",
    "visual map imports",
)

visual = replace_once(
    visual,
    """function applyDropCapGeometry(
""",
    """function measureCanonicalParagraphLines(
  paragraph: Element,
  flowRect: DOMRect,
  scaleX: number,
  scaleY: number,
  pageStride: number,
) {
  const range = document.createRange()
  try {
    range.selectNodeContents(paragraph)
    const rects = usefulRects(range)
    const fragments: MeasuredFragment[] = rects.map((rect, index) => {
      const localLeft = (rect.left - flowRect.left) / scaleX
      const localRight = (rect.right - flowRect.left) / scaleX
      const localTop = (rect.top - flowRect.top) / scaleY
      const localBottom = (rect.bottom - flowRect.top) / scaleY
      const centerX = (localLeft + localRight) / 2
      const contentPage = Math.max(0, Math.floor((centerX + 0.01) / pageStride))
      const pageOffset = contentPage * pageStride
      return {
        tokenIndex: index,
        tokenWeight: 0.001,
        contentPage,
        pageX: localLeft - pageOffset,
        pageY: localTop,
        left: localLeft - pageOffset,
        right: localRight - pageOffset,
        top: localTop,
        bottom: localBottom,
        width: Math.max(0, localRight - localLeft),
        height: Math.max(0, localBottom - localTop),
      }
    })
    return groupFragments(fragments)
  } finally {
    range.detach?.()
  }
}

function applyDropCapGeometry(
""",
    "canonical paragraph measurement",
)

visual = replace_once(
    visual,
    """  const lines: VisualLine[] = []
  const bySentence = new Map<number, VisualLine[]>()
  const sentenceElements = Array.from(
""",
    """  const lines: VisualLine[] = []
  const bySentence = new Map<number, VisualLine[]>()
  const paragraphLineCache = new WeakMap<Element, MutableLine[]>()
  const sentenceElements = Array.from(
""",
    "paragraph line cache",
)

visual = replace_once(
    visual,
    """    const grouped = groupFragments(fragments)
    applyDropCapGeometry(sentence, grouped, flowRect, scaleX, scaleY, pageStride)

    const weightedLines = assignVisualLineProgress(grouped.map(line => ({
""",
    """    let grouped = groupFragments(fragments)
    const paragraph = sentence.closest('.reflow-para')
    if (paragraph) {
      let canonicalLines = paragraphLineCache.get(paragraph)
      if (!canonicalLines) {
        canonicalLines = measureCanonicalParagraphLines(paragraph, flowRect, scaleX, scaleY, pageStride)
        paragraphLineCache.set(paragraph, canonicalLines)
      }
      grouped = grouped.map(line => mergeWithCanonicalLineGeometry(line, canonicalLines || []))
    }
    applyDropCapGeometry(sentence, grouped, flowRect, scaleX, scaleY, pageStride)

    const weightedLines = assignVisualLineProgress(grouped.map(line => ({
""",
    "canonical sentence line geometry",
)
map_path.write_text(visual, encoding="utf-8")

# ---------------------------------------------------------------------------
# React hook: stable trace callback and deliberate smooth/snap presentation.
# ---------------------------------------------------------------------------
hook_path = root / "frontend/src/followAlong/usePlaybackLineCursor.tsx"
hook = hook_path.read_text(encoding="utf-8")
hook = replace_once(
    hook,
    """  appendBoundedTrace,
  followAlongReducer,
  resolvePlaybackAnchor,
""",
    """  appendBoundedTrace,
  cursorTransitionKind,
  followAlongReducer,
  resolvePlaybackAnchor,
""",
    "hook imports",
)

hook = replace_once(
    hook,
    """  const lastPresentationRef = useRef<{ key: string; x: number; generation: number } | null>(null)
""",
    """  const lastPresentationRef = useRef<{
    key: string
    x: number
    y: number
    height: number
    generation: number
    column: number
    viewIndex: number
  } | null>(null)
""",
    "presentation ref shape",
)

old_trace = """  const trace = useCallback((reason: string, detail: Record<string, unknown> = {}) => {
    const state = followStateRef.current
    const progress = stableProgressRef.current
    const anchor = state.pendingAnchor || state.anchor || state.selectedAnchor || state.hoverAnchor
    const entry: FollowAlongTraceEntry = {
      at: Date.now(),
      sessionId,
      chapterIndex: activeChapterIndex >= 0 ? activeChapterIndex : null,
      sentenceIndex: currentSentence >= 0 ? currentSentence : null,
      rawProgress: Number.isFinite(rawProgress) ? rawProgress : null,
      stableProgress: progress?.stableProgress ?? null,
      lineId: anchor?.lineId ?? null,
      targetView: anchor?.viewIndex ?? null,
      visibleView: viewPage,
      layoutGeneration: mapRef.current?.generation ?? null,
      state: state.status,
      reason,
      detail,
    }
    traceRef.current = appendBoundedTrace(traceRef.current, entry)
    if (debugEnabled('FOLIO_DEBUG_FOLLOW_ALONG', 'folioDebugFollowAlong')) {
      console.debug('[follow-along]', entry)
    }
  }, [activeChapterIndex, currentSentence, rawProgress, sessionId, viewPage])
"""
new_trace = """  const traceContextRef = useRef({
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
"""
hook = replace_once(hook, old_trace, new_trace, "stable trace callback")

hook = replace_once(
    hook,
    """    const previous = lastPresentationRef.current
    const discontinuous = Boolean(
      !previous ||
      previous.generation !== anchor.generation ||
      Math.abs(previous.x - anchor.placement.x) > COLUMN_SNAP_DISTANCE,
    )
""",
    """    const previous = lastPresentationRef.current
    const discontinuous = cursorTransitionKind(previous, {
      x: anchor.placement.x,
      generation: anchor.generation,
      column: anchor.placement.column,
      viewIndex: anchor.viewIndex,
    }, COLUMN_SNAP_DISTANCE) === 'snap'
""",
    "cursor transition classification",
)

hook = replace_once(
    hook,
    """    lastPresentationRef.current = {
      key: anchor.placement.key,
      x: anchor.placement.x,
      generation: anchor.generation,
    }
""",
    """    lastPresentationRef.current = {
      key: anchor.placement.key,
      x: anchor.placement.x,
      y: anchor.placement.y,
      height: anchor.placement.height,
      generation: anchor.generation,
      column: anchor.placement.column,
      viewIndex: anchor.viewIndex,
    }
""",
    "presentation snapshot assignment",
)
hook_path.write_text(hook, encoding="utf-8")

# ---------------------------------------------------------------------------
# CSS: slower, smoother ordinary line motion; height remains animated on snaps.
# ---------------------------------------------------------------------------
css_path = root / "frontend/src/styles/reader.css"
css = css_path.read_text(encoding="utf-8")
css = replace_once(
    css,
    """  transition: opacity 90ms ease-out;
  will-change: transform, height, opacity;
}

.reader-line-cursor[data-cursor-mode="playback"] {
  transition:
    transform 140ms cubic-bezier(0.2, 0.76, 0.24, 1),
    height 140ms cubic-bezier(0.2, 0.76, 0.24, 1),
    opacity 60ms ease-out;
}

.reader-line-cursor[data-cursor-mode="selected"] {
  transition:
    transform 165ms cubic-bezier(0.2, 0.76, 0.24, 1),
    height 165ms cubic-bezier(0.2, 0.76, 0.24, 1),
    opacity 90ms ease-out;
}

.reader-line-cursor[data-cursor-mode="hover"] {
  transition:
    transform 125ms cubic-bezier(0.2, 0.76, 0.24, 1),
    height 125ms cubic-bezier(0.2, 0.76, 0.24, 1),
    opacity 90ms ease-out;
}
""",
    """  transition: opacity 110ms ease-out;
  will-change: transform, height, opacity;
}

.reader-line-cursor[data-cursor-mode="playback"] {
  transition:
    transform 235ms cubic-bezier(0.22, 1, 0.36, 1),
    height 260ms cubic-bezier(0.22, 1, 0.36, 1),
    opacity 90ms ease-out;
}

.reader-line-cursor[data-cursor-mode="selected"] {
  transition:
    transform 210ms cubic-bezier(0.22, 1, 0.36, 1),
    height 240ms cubic-bezier(0.22, 1, 0.36, 1),
    opacity 100ms ease-out;
}

.reader-line-cursor[data-cursor-mode="hover"] {
  transition:
    transform 165ms cubic-bezier(0.22, 1, 0.36, 1),
    height 190ms cubic-bezier(0.22, 1, 0.36, 1),
    opacity 100ms ease-out;
}
""",
    "cursor animation timings",
)
css = replace_once(
    css,
    """    height 140ms cubic-bezier(0.2, 0.76, 0.24, 1),
    opacity 60ms ease-out;
""",
    """    height 260ms cubic-bezier(0.22, 1, 0.36, 1),
    opacity 90ms ease-out;
""",
    "snap height animation",
)
css_path.write_text(css, encoding="utf-8")

# ---------------------------------------------------------------------------
# Regression coverage for canonical geometry, transition policy and callback.
# ---------------------------------------------------------------------------
test_path = root / "frontend/tests/followAlongPlayback.test.mjs"
tests = test_path.read_text(encoding="utf-8")
tests = replace_once(
    tests,
    """const sourceUrl = new URL('../src/followAlong/playbackModel.ts', import.meta.url)
const source = await readFile(sourceUrl, 'utf8')
""",
    """const sourceUrl = new URL('../src/followAlong/playbackModel.ts', import.meta.url)
const hookUrl = new URL('../src/followAlong/usePlaybackLineCursor.tsx', import.meta.url)
const source = await readFile(sourceUrl, 'utf8')
const hookSource = await readFile(hookUrl, 'utf8')
""",
    "test hook source loading",
)

tests += """

test('a sentence beginning mid-line inherits the physical line left edge', () => {
  const sentenceLine = { contentPage: 0, top: 40, bottom: 62, left: 312, right: 520, marker: 'sentence' }
  const physicalLines = [{ contentPage: 0, top: 40, bottom: 62, left: 28, right: 640 }]
  const merged = model.mergeWithCanonicalLineGeometry(sentenceLine, physicalLines)
  assert.equal(merged.left, 28)
  assert.equal(merged.right, 640)
  assert.equal(merged.marker, 'sentence')
})

test('canonical geometry never crosses into an adjacent rendered line', () => {
  const sentenceLine = { contentPage: 0, top: 70, bottom: 92, left: 260, right: 520 }
  const physicalLines = [
    { contentPage: 0, top: 40, bottom: 62, left: 20, right: 640 },
    { contentPage: 0, top: 70, bottom: 92, left: 24, right: 630 },
  ]
  const merged = model.mergeWithCanonicalLineGeometry(sentenceLine, physicalLines)
  assert.equal(merged.left, 24)
  assert.equal(merged.top, 70)
})

test('ordinary movement in the same column is smooth while discontinuities snap', () => {
  const previous = { x: 100, generation: 4, column: 0, viewIndex: 2 }
  assert.equal(model.cursorTransitionKind(previous, { x: 100, generation: 4, column: 0, viewIndex: 2 }), 'smooth')
  assert.equal(model.cursorTransitionKind(previous, { x: 790, generation: 4, column: 1, viewIndex: 2 }), 'snap')
  assert.equal(model.cursorTransitionKind(previous, { x: 100, generation: 5, column: 0, viewIndex: 2 }), 'snap')
  assert.equal(model.cursorTransitionKind(previous, { x: 100, generation: 4, column: 0, viewIndex: 3 }), 'snap')
})

test('debug tracing reads live playback through refs without destabilising rebuild callbacks', () => {
  assert.match(hookSource, /const traceContextRef = useRef\(/)
  assert.match(hookSource, /const trace = useCallback\([\s\S]*?\n  }, \[\]\)/)
  assert.doesNotMatch(hookSource, /}, \[activeChapterIndex, currentSentence, rawProgress, sessionId, viewPage\]\)/)
})
"""
test_path.write_text(tests, encoding="utf-8")

print("Applied follow-along cursor stability, geometry and motion polish.")
