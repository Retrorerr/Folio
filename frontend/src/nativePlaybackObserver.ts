import type { MobilePlaybackStatus, NativeQueueLocation } from './mobileApi'

export type NativePlaybackTerminal = 'advanced' | 'paused' | 'finished' | 'stopped' | 'error' | 'replaced'

export type NativePlaybackObservation = {
  status: MobilePlaybackStatus
  sessionId: number
  location: NativeQueueLocation | null
  progress: number
  positionMs: number
  durationMs: number
  sessionChanged: boolean
  terminal: NativePlaybackTerminal | null
}

type NativeObserverScheduler = {
  now: () => number
  setTimeout: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void
  requestFrame: (callback: () => void) => number
  cancelFrame: (frame: number) => void
}

export type NativePlaybackObserverOptions = {
  readStatus: () => Promise<MobilePlaybackStatus>
  initialSessionId: number
  initialProgress?: number
  fallbackDurationMs?: number
  expectedBookId?: string
  keepPaused?: boolean
  stopOnSessionChange?: boolean
  pollIntervalMs?: number
  maxConsecutiveErrors?: number
  scheduler?: NativeObserverScheduler
  onObservation?: (observation: NativePlaybackObservation) => void | Promise<void>
  onProgress?: (progress: number, observation: NativePlaybackObservation) => void
  onTerminal?: (terminal: NativePlaybackTerminal, observation: NativePlaybackObservation | null, error?: unknown) => void
}

export type NativePlaybackObserver = {
  start: () => void
  stop: () => void
  allowBackwardOnce: () => void
  isStopped: () => boolean
}

const clampProgress = (value: unknown): number => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 0
  return Math.min(0.98, Math.max(0, parsed))
}

function queueLocation(status: MobilePlaybackStatus, sessionId: number): NativeQueueLocation | null {
  const queued = Array.isArray(status.queueLocations)
    ? status.queueLocations.find((entry) => Number(entry?.sessionId) === sessionId)
    : null
  if (queued) {
    return {
      sessionId,
      bookId: String(queued.bookId || status.bookId || ''),
      chapterIndex: Math.max(0, Math.floor(Number(queued.chapterIndex) || 0)),
      sentenceIndex: Math.max(0, Math.floor(Number(queued.sentenceIndex) || 0)),
    }
  }
  if (!sessionId || status.chapterIndex == null || status.sentenceIndex == null) return null
  return {
    sessionId,
    bookId: String(status.bookId || ''),
    chapterIndex: Math.max(0, Math.floor(Number(status.chapterIndex) || 0)),
    sentenceIndex: Math.max(0, Math.floor(Number(status.sentenceIndex) || 0)),
  }
}

export function interpretNativePlaybackStatus(
  status: MobilePlaybackStatus,
  previous: NativePlaybackObservation | null,
  options: {
    expectedBookId?: string
    initialSessionId?: number
    initialProgress?: number
    fallbackDurationMs?: number
    keepPaused?: boolean
    stopOnSessionChange?: boolean
    allowBackward?: boolean
  } = {},
): NativePlaybackObservation {
  const sessionId = Math.max(0, Math.floor(Number(status.sessionId) || 0))
  const previousSessionId = previous?.sessionId || Math.max(0, Math.floor(Number(options.initialSessionId) || 0))
  const sessionChanged = previousSessionId > 0 && sessionId > 0 && sessionId !== previousSessionId
  const durationMs = Math.max(0, Number(status.durationMs || options.fallbackDurationMs || 0))
  const positionMs = Math.max(0, Number(status.positionMs || 0))
  const reportedProgress = durationMs > 0
    ? clampProgress(positionMs / durationMs)
    : clampProgress(status.chunkProgress ?? options.initialProgress ?? 0)
  const explicitBackwardSeek = Boolean(
    previous &&
    !sessionChanged &&
    previous.positionMs - positionMs > 750 &&
    previous.progress - reportedProgress > 0.05,
  )
  const progress = previous && !sessionChanged && !options.allowBackward && !explicitBackwardSeek
    ? Math.max(previous.progress, reportedProgress)
    : reportedProgress
  const state = String(status.state || 'idle')
  // Media3 removes the completed item before reporting the terminal snapshot,
  // so its compact queue-location list can already be empty. Preserve the
  // last authoritative location for that same session; continuation needs to
  // advance from the sentence that actually finished.
  const location = queueLocation(status, sessionId) || (
    !sessionChanged && (state === 'finished' || state === 'stopped' || state === 'idle')
      ? previous?.location || null
      : null
  )
  const queueSize = Math.max(0, Number(status.queueSize || status.queueSessionIds?.length || status.queueLocations?.length || 0))
  let terminal: NativePlaybackTerminal | null = null
  if (options.expectedBookId && status.bookId && status.bookId !== options.expectedBookId) terminal = 'replaced'
  else if (state === 'error') terminal = 'error'
  else if (state === 'finished') terminal = 'finished'
  else if (state === 'stopped' || (state === 'idle' && queueSize === 0)) terminal = 'stopped'
  else if (sessionChanged && options.stopOnSessionChange) terminal = 'advanced'
  else if (state === 'paused' && !options.keepPaused) terminal = 'paused'

  return { status, sessionId, location, progress, positionMs, durationMs, sessionChanged, terminal }
}

function defaultScheduler(): NativeObserverScheduler {
  return {
    now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (timer) => globalThis.clearTimeout(timer),
    requestFrame: (callback) => globalThis.requestAnimationFrame(callback),
    cancelFrame: (frame) => globalThis.cancelAnimationFrame(frame),
  }
}

export function createNativePlaybackObserver(options: NativePlaybackObserverOptions): NativePlaybackObserver {
  const scheduler = options.scheduler || defaultScheduler()
  const pollIntervalMs = Math.max(80, options.pollIntervalMs ?? 160)
  const maxErrors = Math.max(1, options.maxConsecutiveErrors ?? 3)
  let stopped = false
  let started = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let frame: number | null = null
  let previous: NativePlaybackObservation | null = null
  let sampledAt = scheduler.now()
  let lastPublished = clampProgress(options.initialProgress)
  let allowBackward = false
  let consecutiveErrors = 0

  const stop = () => {
    if (stopped) return
    stopped = true
    if (timer != null) scheduler.clearTimeout(timer)
    if (frame != null) scheduler.cancelFrame(frame)
    timer = null
    frame = null
  }

  const paint = () => {
    if (stopped) return
    if (previous) {
      let progress = previous.progress
      if (previous.status.state === 'playing' && previous.durationMs > 0) {
        const estimated = previous.positionMs + Math.max(0, scheduler.now() - sampledAt)
        progress = clampProgress(estimated / previous.durationMs)
      }
      if (!allowBackward) progress = Math.max(lastPublished, progress)
      lastPublished = progress
      options.onProgress?.(progress, previous)
    }
    frame = scheduler.requestFrame(paint)
  }

  const schedulePoll = () => {
    if (!stopped) timer = scheduler.setTimeout(() => { void poll() }, pollIntervalMs)
  }

  const poll = async () => {
    if (stopped) return
    try {
      const status = await options.readStatus()
      if (stopped) return
      consecutiveErrors = 0
      const observation = interpretNativePlaybackStatus(status, previous, {
        expectedBookId: options.expectedBookId,
        initialSessionId: options.initialSessionId,
        initialProgress: options.initialProgress,
        fallbackDurationMs: options.fallbackDurationMs,
        keepPaused: options.keepPaused,
        stopOnSessionChange: options.stopOnSessionChange,
        allowBackward,
      })
      allowBackward = false
      if (observation.sessionChanged || observation.progress + 0.05 < lastPublished) lastPublished = observation.progress
      else lastPublished = Math.max(lastPublished, observation.progress)
      previous = observation
      sampledAt = scheduler.now()
      await options.onObservation?.(observation)
      if (stopped) return
      options.onProgress?.(observation.progress, observation)
      if (observation.terminal) {
        options.onTerminal?.(observation.terminal, observation)
        stop()
        return
      }
      schedulePoll()
    } catch (error) {
      if (stopped) return
      consecutiveErrors += 1
      if (consecutiveErrors >= maxErrors) {
        options.onTerminal?.('error', previous, error)
        stop()
        return
      }
      schedulePoll()
    }
  }

  return {
    start: () => {
      if (started || stopped) return
      started = true
      frame = scheduler.requestFrame(paint)
      void poll()
    },
    stop,
    allowBackwardOnce: () => { allowBackward = true },
    isStopped: () => stopped,
  }
}
