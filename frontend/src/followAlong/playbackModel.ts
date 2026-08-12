export type CursorPlacement = {
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

export type WeightedToken = {
  text: string
  start: number
  end: number
  weight: number
  weightStart: number
  weightEnd: number
}

export type VisualLine = {
  lineId: string
  chapterIndex: number
  sentenceIndex: number
  globalSentenceIndex: number | null
  lineIndex: number
  firstTokenIndex: number
  lastTokenIndex: number
  progressStart: number
  progressEnd: number
  contentPage: number
  viewIndex: number
  pageX: number
  pageY: number
  lineWidth: number
  lineHeight: number
  cursorPageY?: number
  cursorLineHeight?: number
  generation: number
}

export type VisualLineMapMetrics = {
  rootContentX: number
  rootContentY: number
  scaleX: number
  scaleY: number
  pageStride: number
  pagesPerView: number
  buildDurationMs?: number
  sentenceCount?: number
  tokenCount?: number
  textNodeCount?: number
  rangeCount?: number
  getClientRectsCount?: number
}

export type VisualLineMap = {
  bookId: string
  chapterIndex: number
  generation: number
  layoutKey: string
  pagesPerView: number
  lines: VisualLine[]
  bySentence: Map<number, VisualLine[]>
  metrics: VisualLineMapMetrics
  createdAt: number
}

export type PlaybackAnchor = {
  bookId: string
  chapterIndex: number
  sentenceIndex: number
  globalSentenceIndex: number | null
  lineIndex: number
  viewIndex: number
  lineId: string
  placement: CursorPlacement
  progressStart: number
  progressEnd: number
  generation: number
}

export type ProgressGuardState = {
  sessionKey: string
  rawProgress: number
  stableProgress: number
  resetToken: number
}

export type FollowAlongStatus =
  | 'idle'
  | 'hovering'
  | 'selected'
  | 'playing'
  | 'changing-view'
  | 'waiting-for-layout'
  | 'paused'
  | 'unavailable'

export type FollowAlongState = {
  status: FollowAlongStatus
  anchor: PlaybackAnchor | null
  selectedAnchor: PlaybackAnchor | null
  hoverAnchor: PlaybackAnchor | null
  pendingAnchor: PlaybackAnchor | null
  reason: string | null
  layoutGeneration: number | null
}

export type FollowAlongEvent =
  | { type: 'RESET' }
  | { type: 'LAYOUT_INVALIDATED'; reason: string }
  | { type: 'LAYOUT_READY'; generation: number }
  | { type: 'HOVER'; anchor: PlaybackAnchor }
  | { type: 'CLEAR_HOVER' }
  | { type: 'SELECT'; anchor: PlaybackAnchor }
  | { type: 'PLAYBACK_ANCHOR'; anchor: PlaybackAnchor; playing: boolean }
  | { type: 'REQUEST_VIEW'; anchor: PlaybackAnchor; reason: string }
  | { type: 'WAIT_FOR_LAYOUT'; anchor: PlaybackAnchor; reason: string }
  | { type: 'VIEW_COMMITTED'; anchor: PlaybackAnchor; playing: boolean }
  | { type: 'PAUSE'; anchor: PlaybackAnchor | null }
  | { type: 'UNAVAILABLE'; reason: string }
  | { type: 'STOP' }

export type FollowAlongTraceEntry = {
  at: number
  sessionId: string
  chapterIndex: number | null
  sentenceIndex: number | null
  rawProgress: number | null
  stableProgress: number | null
  lineId: string | null
  targetView: number | null
  visibleView: number | null
  layoutGeneration: number | null
  state: FollowAlongStatus
  reason: string
  detail?: Record<string, unknown>
}

const clamp01 = (value: number) => {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

export function wordWeight(token: string) {
  const core = token.replace(/[^\p{L}\p{N}]/gu, '')
  const coreLength = core.length || token.length || 1
  let weight = Math.max(1, Math.pow(coreLength, 0.82))

  if (/[.!?]["'’”\])}]*$/u.test(token)) weight += 3.2
  else if (/[,;:]["'’”\])}]*$/u.test(token)) weight += 1.35
  else if (/(?:--|—|–|-)$/.test(token)) weight += 0.65

  if (/^(?:\d+[\d,.]*|£\d|\$\d|€\d)/u.test(token)) weight += Math.min(2.2, coreLength * 0.12)
  if (/^(?:Mr|Mrs|Ms|Dr|Prof|St|No|vs|etc)\.$/iu.test(token)) weight += 0.65

  return weight
}

export function tokenizeWeighted(text: string): WeightedToken[] {
  const tokens: WeightedToken[] = []
  const expression = /\S+/gu
  let match: RegExpExecArray | null
  let cumulativeWeight = 0

  while ((match = expression.exec(text))) {
    const weight = wordWeight(match[0])
    const nextWeight = cumulativeWeight + weight
    tokens.push({
      text: match[0],
      start: match.index,
      end: match.index + match[0].length,
      weight,
      weightStart: cumulativeWeight,
      weightEnd: nextWeight,
    })
    cumulativeWeight = nextWeight
  }

  return tokens
}

export function assignVisualLineProgress<T extends {
  tokenWeight: number
}>(lines: T[]): Array<T & { progressStart: number; progressEnd: number }> {
  if (!lines.length) return []
  const totalWeight = lines.reduce((sum, line) => sum + Math.max(0.001, line.tokenWeight), 0)
  let cumulative = 0

  return lines.map((line, index) => {
    const progressStart = index === 0 ? 0 : cumulative / totalWeight
    cumulative += Math.max(0.001, line.tokenWeight)
    const progressEnd = index === lines.length - 1 ? 1 : cumulative / totalWeight
    return {
      ...line,
      progressStart: clamp01(progressStart),
      progressEnd: clamp01(Math.max(progressStart, progressEnd)),
    }
  })
}

export function lineForProgress(lines: VisualLine[], progress: number): VisualLine | null {
  if (!lines.length) return null
  const normalized = clamp01(progress)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (normalized < line.progressEnd || index === lines.length - 1) return line
  }
  return lines[lines.length - 1]
}

export function mergeWithCanonicalLineGeometry<T extends PhysicalLineGeometry>(
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
): 'smooth' {
  void previous
  void next
  // Every cursor relocation now uses the same continuous motion contract.
  // Page turns still hide the cursor while the paper animation owns the view,
  // but columns, headings, layout rebuilds, and resumed playback never snap.
  return 'smooth'
}

export function placementForLine(
  map: VisualLineMap,
  line: VisualLine,
  visibleViewIndex: number,
  gutter = 26,
): CursorPlacement | null {
  if (line.generation !== map.generation) return null
  if (line.viewIndex !== visibleViewIndex) return null

  const slot = line.contentPage - visibleViewIndex * map.pagesPerView
  if (slot < 0 || slot >= map.pagesPerView) return null

  const { rootContentX, rootContentY, scaleX, scaleY, pageStride } = map.metrics
  const x = rootContentX + (slot * pageStride + line.pageX - gutter) * scaleX
  const usesMeasuredGlyph = Number.isFinite(line.cursorPageY) && Number.isFinite(line.cursorLineHeight)
  const cursorPageY = usesMeasuredGlyph ? line.cursorPageY! : line.pageY - 2
  const cursorLineHeight = usesMeasuredGlyph ? line.cursorLineHeight! : line.lineHeight + 4
  const y = rootContentY + cursorPageY * scaleY
  const height = Math.max(18, cursorLineHeight * scaleY)

  return {
    x: Math.max(0, x),
    y: Math.max(0, y),
    width: 2,
    height,
    column: slot,
    key: `${map.generation}:${line.lineId}:${visibleViewIndex}:${Math.round(x * 2) / 2}:${Math.round(y * 2) / 2}:${Math.round(height * 2) / 2}`,
  }
}

export function resolvePlaybackAnchor(
  map: VisualLineMap | null,
  input: {
    bookId: string
    chapterIndex: number
    sentenceIndex: number
    progress: number
    visibleViewIndex: number
    expectedGeneration?: number | null
  },
): PlaybackAnchor | null {
  if (!map) return null
  if (map.bookId !== input.bookId || map.chapterIndex !== input.chapterIndex) return null
  if (input.expectedGeneration != null && map.generation !== input.expectedGeneration) return null

  const lines = map.bySentence.get(input.sentenceIndex) || []
  const line = lineForProgress(lines, input.progress)
  if (!line || line.generation !== map.generation) return null
  const placement = placementForLine(map, line, input.visibleViewIndex)
  if (!placement) {
    return {
      bookId: input.bookId,
      chapterIndex: input.chapterIndex,
      sentenceIndex: input.sentenceIndex,
      globalSentenceIndex: line.globalSentenceIndex,
      lineIndex: line.lineIndex,
      viewIndex: line.viewIndex,
      lineId: line.lineId,
      placement: {
        x: 0,
        y: 0,
        width: 2,
        height: Math.max(18, line.lineHeight),
        key: `${map.generation}:${line.lineId}:pending`,
        column: line.contentPage % map.pagesPerView,
      },
      progressStart: line.progressStart,
      progressEnd: line.progressEnd,
      generation: map.generation,
    }
  }

  return {
    bookId: input.bookId,
    chapterIndex: input.chapterIndex,
    sentenceIndex: input.sentenceIndex,
    globalSentenceIndex: line.globalSentenceIndex,
    lineIndex: line.lineIndex,
    viewIndex: line.viewIndex,
    lineId: line.lineId,
    placement,
    progressStart: line.progressStart,
    progressEnd: line.progressEnd,
    generation: map.generation,
  }
}

export function updateStableProgress(
  previous: ProgressGuardState | null,
  input: {
    sessionKey: string
    progress: number
    resetToken?: number
    allowBackward?: boolean
  },
): ProgressGuardState {
  const rawProgress = clamp01(input.progress)
  const resetToken = input.resetToken || 0
  const shouldReset = (
    !previous ||
    previous.sessionKey !== input.sessionKey ||
    previous.resetToken !== resetToken ||
    Boolean(input.allowBackward)
  )

  return {
    sessionKey: input.sessionKey,
    rawProgress,
    stableProgress: shouldReset ? rawProgress : Math.max(previous.stableProgress, rawProgress),
    resetToken,
  }
}

export const INITIAL_FOLLOW_ALONG_STATE: FollowAlongState = {
  status: 'idle',
  anchor: null,
  selectedAnchor: null,
  hoverAnchor: null,
  pendingAnchor: null,
  reason: null,
  layoutGeneration: null,
}

export function followAlongReducer(
  state: FollowAlongState,
  event: FollowAlongEvent,
): FollowAlongState {
  switch (event.type) {
    case 'RESET':
      return INITIAL_FOLLOW_ALONG_STATE
    case 'LAYOUT_INVALIDATED':
      return {
        ...state,
        status: state.anchor || state.selectedAnchor ? 'waiting-for-layout' : 'unavailable',
        pendingAnchor: state.anchor || state.pendingAnchor,
        reason: event.reason,
      }
    case 'LAYOUT_READY':
      return {
        ...state,
        status: state.anchor
          ? (state.status === 'paused' ? 'paused' : 'playing')
          : (state.selectedAnchor ? 'selected' : 'idle'),
        reason: null,
        layoutGeneration: event.generation,
      }
    case 'HOVER':
      if (state.status === 'playing' || state.status === 'paused') return state
      return { ...state, status: 'hovering', hoverAnchor: event.anchor, reason: null }
    case 'CLEAR_HOVER':
      return {
        ...state,
        status: state.selectedAnchor ? 'selected' : (state.anchor ? 'paused' : 'idle'),
        hoverAnchor: null,
      }
    case 'SELECT':
      return {
        ...state,
        status: 'selected',
        selectedAnchor: event.anchor,
        hoverAnchor: null,
        pendingAnchor: null,
        reason: null,
      }
    case 'PLAYBACK_ANCHOR':
      return {
        ...state,
        status: event.playing ? 'playing' : 'paused',
        anchor: event.anchor,
        selectedAnchor: null,
        hoverAnchor: null,
        pendingAnchor: null,
        reason: null,
        layoutGeneration: event.anchor.generation,
      }
    case 'REQUEST_VIEW':
      return {
        ...state,
        status: 'changing-view',
        pendingAnchor: event.anchor,
        hoverAnchor: null,
        reason: event.reason,
      }
    case 'WAIT_FOR_LAYOUT':
      return {
        ...state,
        status: 'waiting-for-layout',
        pendingAnchor: event.anchor,
        hoverAnchor: null,
        reason: event.reason,
      }
    case 'VIEW_COMMITTED':
      return {
        ...state,
        status: event.playing ? 'playing' : 'paused',
        anchor: event.anchor,
        selectedAnchor: null,
        hoverAnchor: null,
        pendingAnchor: null,
        reason: null,
        layoutGeneration: event.anchor.generation,
      }
    case 'PAUSE':
      return {
        ...state,
        status: event.anchor ? 'paused' : (state.selectedAnchor ? 'selected' : 'idle'),
        anchor: event.anchor || state.anchor,
        pendingAnchor: null,
        reason: null,
      }
    case 'UNAVAILABLE':
      return {
        ...state,
        status: 'unavailable',
        hoverAnchor: null,
        reason: event.reason,
      }
    case 'STOP':
      return {
        ...state,
        status: state.selectedAnchor ? 'selected' : (state.anchor ? 'paused' : 'idle'),
        pendingAnchor: null,
        hoverAnchor: null,
        reason: null,
      }
    default:
      return state
  }
}

export function appendBoundedTrace(
  trace: FollowAlongTraceEntry[],
  entry: FollowAlongTraceEntry,
  limit = 120,
) {
  const next = [...trace, entry]
  return next.length > limit ? next.slice(next.length - limit) : next
}
