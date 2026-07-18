import type { MobilePlaybackStatus, NativeQueueLocation } from './mobileApi'

export type NativeResumePhase = 'idle' | 'opening-book' | 'attaching-session' | 'monitoring' | 'failed'
export type NativeResumeSource = 'startup-status' | 'notification-status' | 'notification-hint'

export type NativeResumeTarget = {
  requestId: number
  source: NativeResumeSource
  authoritative: boolean
  bookId: string
  page: number
  sentence: number
  chunkProgress: number
  locationUri: string
  sessionId: number
  queueSessionIds: number[]
  queueLocations: NativeQueueLocation[]
  state: string
}

export type NativeResumeCoordinatorState = {
  phase: NativeResumePhase
  target: NativeResumeTarget | null
  error: string | null
}

export type NativeResumeAction =
  | { type: 'request'; target: NativeResumeTarget; bookAlreadyOpen: boolean }
  | { type: 'book-opened'; requestId: number }
  | { type: 'attached'; requestId: number }
  | { type: 'failed'; requestId: number; error: string }
  | { type: 'reset' }

export const initialNativeResumeState: NativeResumeCoordinatorState = { phase: 'idle', target: null, error: null }

const finiteInt = (value: unknown): number => Math.max(0, Math.floor(Number(value) || 0))
const progress = (value: unknown): number => Math.min(0.98, Math.max(0, Number(value) || 0))

function queueLocations(value: unknown): NativeQueueLocation[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 8).map((entry) => ({
    sessionId: finiteInt(entry?.sessionId),
    bookId: String(entry?.bookId || ''),
    chapterIndex: finiteInt(entry?.chapterIndex),
    sentenceIndex: finiteInt(entry?.sentenceIndex),
  })).filter((entry) => entry.sessionId > 0)
}

export function nativeResumeTargetFromStatus(
  status: MobilePlaybackStatus | null | undefined,
  requestId: number,
  source: Extract<NativeResumeSource, 'startup-status' | 'notification-status'>,
): NativeResumeTarget | null {
  const bookId = String(status?.bookId || '').trim()
  const queueSessionIds = Array.isArray(status?.queueSessionIds)
    ? status.queueSessionIds.map(finiteInt).filter((value) => value > 0).slice(0, 8)
    : []
  const locations = queueLocations(status?.queueLocations)
  const queueSize = finiteInt(status?.queueSize || queueSessionIds.length || locations.length)
  if (!bookId || queueSize <= 0) return null
  return {
    requestId,
    source,
    authoritative: true,
    bookId,
    page: finiteInt(status?.chapterIndex),
    sentence: finiteInt(status?.sentenceIndex),
    chunkProgress: progress(status?.chunkProgress),
    locationUri: String(status?.locationUri || '').trim(),
    sessionId: finiteInt(status?.sessionId),
    queueSessionIds,
    queueLocations: locations,
    state: String(status?.state || 'paused'),
  }
}

export function nativeResumeTargetFromHint(
  hint: Record<string, unknown>,
  requestId: number,
): NativeResumeTarget | null {
  const bookId = String(hint.bookId || '').trim()
  if (!bookId) return null
  return {
    requestId,
    source: 'notification-hint',
    authoritative: false,
    bookId,
    page: finiteInt(hint.page ?? hint.chapterIndex),
    sentence: finiteInt(hint.sentence ?? hint.sentenceIndex),
    chunkProgress: progress(hint.chunkProgress),
    locationUri: String(hint.locationUri || '').trim(),
    sessionId: finiteInt(hint.sessionId),
    queueSessionIds: Array.isArray(hint.queueSessionIds) ? hint.queueSessionIds.map(finiteInt).filter((value) => value > 0).slice(0, 8) : [],
    queueLocations: queueLocations(hint.queueLocations),
    state: String(hint.state || 'paused'),
  }
}

export function notificationResumeTarget(
  hint: Record<string, unknown>,
  status: MobilePlaybackStatus | null,
  requestId: number,
): NativeResumeTarget | null {
  const hintedBookId = String(hint.bookId || '').trim()
  const statusTarget = nativeResumeTargetFromStatus(status, requestId, 'notification-status')
  if (statusTarget && (!hintedBookId || statusTarget.bookId === hintedBookId)) return statusTarget
  return nativeResumeTargetFromHint(hint, requestId)
}

function sameQueue(left: NativeResumeTarget, right: NativeResumeTarget): boolean {
  if (left.bookId !== right.bookId) return false
  if (left.sessionId > 0 && right.sessionId > 0) return left.sessionId === right.sessionId
  return true
}

function mergeSameQueue(current: NativeResumeTarget, incoming: NativeResumeTarget): NativeResumeTarget {
  if (current.authoritative && !incoming.authoritative) return current
  const state = current.state === 'playing' && incoming.state === 'paused' && !incoming.authoritative
    ? current.state
    : incoming.state
  return {
    ...current,
    ...incoming,
    requestId: current.requestId,
    state,
    locationUri: incoming.locationUri || current.locationUri,
    queueSessionIds: incoming.queueSessionIds.length ? incoming.queueSessionIds : current.queueSessionIds,
    queueLocations: incoming.queueLocations.length ? incoming.queueLocations : current.queueLocations,
  }
}

export function nativeResumeReducer(
  state: NativeResumeCoordinatorState,
  action: NativeResumeAction,
): NativeResumeCoordinatorState {
  if (action.type === 'reset') return initialNativeResumeState
  if (action.type === 'request') {
    const current = state.target
    if (current && sameQueue(current, action.target)) {
      // Once attachment starts, the observer's first status read becomes the
      // authoritative update path. Replacing the target object here would
      // retrigger the hydration effect with the same request identity and let
      // one duplicate invalidate the other.
      if (state.phase === 'attaching-session' || state.phase === 'monitoring') return state
      const merged = mergeSameQueue(current, action.target)
      return merged === current ? state : { ...state, target: merged, error: null }
    }
    if (current?.authoritative && state.phase === 'monitoring' && !action.target.authoritative) return state
    return {
      phase: action.bookAlreadyOpen ? 'attaching-session' : 'opening-book',
      target: action.target,
      error: null,
    }
  }
  if (!state.target || state.target.requestId !== action.requestId) return state
  if (action.type === 'book-opened') return { ...state, phase: 'attaching-session', error: null }
  if (action.type === 'attached') return { ...state, phase: 'monitoring', error: null }
  return { ...state, phase: 'failed', error: action.error }
}

export class NativeBookOpenRegistry {
  private readonly inFlight = new Map<string, Promise<boolean>>()
  private tail: Promise<unknown> = Promise.resolve()

  open(
    target: NativeResumeTarget,
    latestTarget: () => NativeResumeTarget | null,
    openBook: (location: string) => Promise<unknown>,
  ): Promise<boolean> {
    const existing = this.inFlight.get(target.bookId)
    if (existing) return existing
    const operation = this.tail.catch(() => {}).then(async () => {
      const attempted = new Set<string>()
      const tryOpen = async (location: string): Promise<boolean> => {
        const value = location.trim()
        if (!value || attempted.has(value)) return false
        attempted.add(value)
        try {
          return Boolean(await openBook(value))
        } catch {
          return false
        }
      }
      if (await tryOpen(target.locationUri)) return true
      const latest = latestTarget()
      if (latest?.bookId === target.bookId && await tryOpen(latest.locationUri)) return true
      return tryOpen(target.bookId)
    }).finally(() => {
      if (this.inFlight.get(target.bookId) === operation) this.inFlight.delete(target.bookId)
    })
    this.inFlight.set(target.bookId, operation)
    this.tail = operation
    return operation
  }
}
