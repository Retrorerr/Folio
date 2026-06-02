import { useState, useRef, useCallback, useEffect } from 'react'
import { apiFetch, apiResourceUrl } from '../api'
import {
  defaultKokoroVoice,
  defaultTtsEngine,
  normalizeTtsEngine,
  normalizeVoiceForEngine,
} from '../kokoroVoices'
import type { AudioInfo, BookState, PageText, Position, PreloadState, TtsGenerateResponse } from '../types'

function dispatchModelRequired(engine, install) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent('folio:model-required', { detail: { engine, install } }))
}

const READ_AHEAD_SENTENCES = 6
const DEFAULT_SPEED = 0.95
const CHUNK_PROGRESS_MIN_DELTA = 0.008
const CHUNK_PROGRESS_MAX_INTERVAL_MS = 50

function clampNumber(value, min, max, fallback) {
  const parsed = Number.parseFloat(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

function clampProgress(value) {
  return clampNumber(value, 0, 0.98, 0)
}

function stopProgressLoop(progressRafRef) {
  if (progressRafRef.current != null) {
    cancelAnimationFrame(progressRafRef.current)
    progressRafRef.current = null
  }
}

function debugFlag(globalName, storageKey) {
  if (typeof window === 'undefined') return false
  return Boolean(window[globalName]) || window.localStorage?.getItem(storageKey) === '1'
}

interface UseAudioPlaybackArgs {
  book: BookState | null
  pageData: PageText | null
  currentPage: number
  goToPage: (page: number) => Promise<PageText | null> | undefined
  savePosition: (page: number | Position, sentenceIdx?: number, options?: Partial<Position> & { keepalive?: boolean }) => Promise<void> | undefined
}

export default function useAudioPlayback({ book, pageData, currentPage, goToPage, savePosition }: UseAudioPlaybackArgs) {
  const bookId = book?.id
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentSentence, setCurrentSentence] = useState(0)
  const [speed, setSpeed] = useState(book?.speed ?? DEFAULT_SPEED)
  const [ttsEngine, setTtsEngineRaw] = useState(normalizeTtsEngine(book?.tts_engine || defaultTtsEngine))
  const [voice, setVoiceRaw] = useState(normalizeVoiceForEngine(book?.tts_engine || defaultTtsEngine, book?.voice || defaultKokoroVoice))
  const [volume, setVolume] = useState(() => clampNumber(localStorage.getItem('volume'), 0, 1, 1))
  const [sleepTimer, setSleepTimer] = useState<number | null>(null)
  const [preloadState, setPreloadState] = useState<PreloadState>({ state: 'idle', ready: 0, total: 0, failed: [] })
  const [readingPage, setReadingPage] = useState<number | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [generationError, setGenerationError] = useState('')
  const [settingsReady, setSettingsReady] = useState(false)
  // Fraction (0..1) of the way through the current sentence's audio. Drives the
  // line cursor, intra-chunk start offsets, and Follow Along page advancement.
  const [chunkProgress, setChunkProgress] = useState(0)

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const progressRafRef = useRef<number | null>(null)
  const sleepTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const currentPageRef = useRef(currentPage)
  const currentSentenceRef = useRef(0)
  const readingPageRef = useRef<number | null>(null)
  const pageDataRef = useRef<PageText | null>(pageData)
  const isPlayingRef = useRef(false)
  const playbackSessionRef = useRef(0)
  const playbackSettingsKeyRef = useRef<string | null>(null)
  const settingsHydratedRef = useRef(false)
  const audioCacheRef = useRef<Map<string, AudioInfo | Promise<AudioInfo | null>>>(new Map())
  const readAheadRef = useRef<Set<string>>(new Set())
  const readAheadAbortRef = useRef<AbortController | null>(null)
  const preloadAbortRef = useRef<AbortController | null>(null)
  const pauseRef = useRef(() => {})
  const preparedAudioKeyRef = useRef<string | null>(null)
  const prepareCurrentTokenRef = useRef(0)
  const chunkProgressPublishRef = useRef({ value: 0, at: 0 })
  const pendingStartProgressRef = useRef(0)
  const playingListenerCleanupRef = useRef<null | (() => void)>(null)

  const publishChunkProgress = useCallback((next, force = false) => {
    const value = Math.max(0, Math.min(1, next))
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
    const last = chunkProgressPublishRef.current
    if (
      force ||
      value === 0 ||
      value === 1 ||
      Math.abs(value - last.value) >= CHUNK_PROGRESS_MIN_DELTA ||
      now - last.at >= CHUNK_PROGRESS_MAX_INTERVAL_MS
    ) {
      chunkProgressPublishRef.current = { value, at: now }
      setChunkProgress(value)
    }
  }, [])

  const setTtsEngine = useCallback((nextEngine) => {
    const normalized = normalizeTtsEngine(nextEngine)
    setTtsEngineRaw(normalized)
    setVoiceRaw((prev) => normalizeVoiceForEngine(normalized, prev))
  }, [])

  const setVoice = useCallback((nextVoice) => {
    setVoiceRaw(normalizeVoiceForEngine(ttsEngine, nextVoice))
  }, [ttsEngine])

  useEffect(() => { currentPageRef.current = currentPage }, [currentPage])
  useEffect(() => { pageDataRef.current = pageData }, [pageData])
  useEffect(() => { currentSentenceRef.current = currentSentence }, [currentSentence])
  useEffect(() => { readingPageRef.current = readingPage }, [readingPage])
  useEffect(() => { isPlayingRef.current = isPlaying }, [isPlaying])
  // pauseRef is initialized via useRef(() => {}) above and rewired below in the
  // [pause]-keyed effect. The previous empty-deps "reset to noop" was dead code
  // that briefly clobbered the wired callback during re-renders.
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume
  }, [volume])

  useEffect(() => {
    if (!bookId) return
    setSettingsReady(false)
    const engine = normalizeTtsEngine(book.tts_engine || defaultTtsEngine)
    setSpeed(book.speed ?? DEFAULT_SPEED)
    setTtsEngineRaw(engine)
    setVoiceRaw(normalizeVoiceForEngine(engine, book.voice || defaultKokoroVoice))
    setCurrentSentence(book.last_position?.sentence_idx || 0)
    currentSentenceRef.current = book.last_position?.sentence_idx || 0
    const initialProgress = clampProgress(book.last_position?.chunk_progress || 0)
    pendingStartProgressRef.current = initialProgress
    publishChunkProgress(initialProgress, true)
    settingsHydratedRef.current = true
  }, [book, bookId, publishChunkProgress])

  useEffect(() => {
    if (!bookId) {
      setSettingsReady(false)
      return
    }
    if (settingsReady) return
    const engine = normalizeTtsEngine(book.tts_engine || defaultTtsEngine)
    const expectedSpeed = book.speed ?? DEFAULT_SPEED
    const ready = (
      ttsEngine === engine
      && voice === normalizeVoiceForEngine(engine, book.voice || defaultKokoroVoice)
      && Math.abs(speed - expectedSpeed) < 0.001
    )
    if (ready) setSettingsReady(true)
  }, [book, bookId, settingsReady, ttsEngine, voice, speed])

  useEffect(() => {
    audioCacheRef.current.clear()
    readAheadAbortRef.current?.abort()
    readAheadAbortRef.current = null
    readAheadRef.current.clear()
    preparedAudioKeyRef.current = null
    setGenerationError('')
  }, [book?.id, ttsEngine, voice, speed])

  useEffect(() => {
    if (!book || !settingsHydratedRef.current || !settingsReady) return
    const controller = new AbortController()
    const params = new URLSearchParams({
      tts_engine: ttsEngine,
      voice,
      speed: String(speed),
    })
    apiFetch(`/api/book/${book.id}/settings?${params.toString()}`, {
      method: 'POST',
      signal: controller.signal,
    }).catch(() => {})
    return () => controller.abort()
  }, [book, settingsReady, ttsEngine, voice, speed])

  useEffect(() => {
    if (sleepTimerRef.current) clearInterval(sleepTimerRef.current)
    if (sleepTimer !== null && sleepTimer > 0) {
      sleepTimerRef.current = setInterval(() => {
        setSleepTimer((prev) => {
          if (prev <= 1 / 60) {
            pauseRef.current()
            return null
          }
          return prev - 1 / 60
        })
      }, 1000)
    }
    return () => {
      if (sleepTimerRef.current) clearInterval(sleepTimerRef.current)
    }
  }, [sleepTimer !== null]) // eslint-disable-line

  useEffect(() => {
    const sentenceCount = pageData?.sentences?.length || 0
    if (sentenceCount > 0 && currentSentence >= sentenceCount) {
      currentSentenceRef.current = 0
      setCurrentSentence(0)
    }
  }, [pageData, currentSentence])

  const getCacheKey = useCallback((page, sentence) => {
    return `${book?.id}|${ttsEngine}|${voice}|${speed}|${page}|${sentence}`
  }, [book?.id, ttsEngine, voice, speed])

  const fetchSentenceAudio = useCallback(async (page, sentence) => {
    if (!book) return null
    const key = getCacheKey(page, sentence)
    const cached = audioCacheRef.current.get(key)
    if (cached) return cached instanceof Promise ? cached : Promise.resolve(cached)

    const qs = `book_id=${encodeURIComponent(book.id)}&page=${page}&sentence=${sentence}&engine=${encodeURIComponent(ttsEngine)}&voice=${encodeURIComponent(voice)}&speed=${speed}`

    const promise = apiFetch(`/api/tts/generate?${qs}`)
      .then(async (res) => {
        if (!res.ok) {
          audioCacheRef.current.delete(key)
          let message = 'TTS generation failed.'
          try {
            const data = await res.json()
            if (data?.error === 'model_required') {
              dispatchModelRequired(data.engine || ttsEngine, data.install || null)
              message = data?.detail || `${ttsEngine} is not installed yet.`
              setGenerationError(message)
              return null
            }
            message = data?.detail || message
          } catch {
            // Keep the generic error if the backend returns a non-JSON body.
          }
          setGenerationError(message)
          return null
        }
        const data = await res.json() as TtsGenerateResponse
        const info = { url: apiResourceUrl(`/api/audio/${data.filename}`), duration_ms: data.duration_ms }
        audioCacheRef.current.set(key, info)
        setGenerationError('')
        return info
      })
      .catch(() => {
        audioCacheRef.current.delete(key)
        setGenerationError('TTS generation failed because the backend did not respond.')
        return null
      })

    audioCacheRef.current.set(key, promise)
    return promise
  }, [book, getCacheKey, ttsEngine, voice, speed])

  const cancelReadAhead = useCallback((page = currentPageRef.current, sentence = currentSentenceRef.current) => {
    readAheadAbortRef.current?.abort()
    readAheadAbortRef.current = null
    readAheadRef.current.clear()
    if (!book) return

    const params = new URLSearchParams({
      book_id: book.id,
      page: String(page),
      sentence: String(sentence),
      engine: ttsEngine,
      voice,
      speed: String(speed),
    })
    apiFetch(`/api/tts/buffer/cancel?${params.toString()}`, {
      method: 'POST',
      cache: 'no-store',
    }).catch(() => {})
  }, [book, ttsEngine, voice, speed])

  const queueReadAhead = useCallback((page, sentence) => {
    if (!book) return
    const key = `${book.id}|${ttsEngine}|${voice}|${speed}|${page}|${sentence}|${READ_AHEAD_SENTENCES}`
    if (readAheadRef.current.has(key)) return
    readAheadAbortRef.current?.abort()
    const controller = new AbortController()
    readAheadAbortRef.current = controller
    readAheadRef.current.add(key)

    const params = new URLSearchParams({
      book_id: book.id,
      page: String(page),
      sentence: String(sentence),
      count: String(READ_AHEAD_SENTENCES),
      engine: ttsEngine,
      voice,
      speed: String(speed),
    })

    apiFetch(`/api/tts/buffer?${params.toString()}`, {
      method: 'POST',
      cache: 'no-store',
      signal: controller.signal,
    }).then((res) => {
      if (readAheadAbortRef.current === controller) readAheadAbortRef.current = null
      // Drop the key on any non-success so a transient backend hiccup doesn't
      // permanently block re-queueing this window.
      if (!res.ok) {
        readAheadRef.current.delete(key)
        res.clone().json().then((data) => {
          if (data?.error === 'model_required') dispatchModelRequired(data.engine || ttsEngine, data.install || null)
        }).catch(() => {})
      }
    }).catch((err) => {
      if (readAheadAbortRef.current === controller) readAheadAbortRef.current = null
      if (err?.name === 'AbortError') return
      readAheadRef.current.delete(key)
    })
  }, [book, ttsEngine, voice, speed])

  const primePausedAudio = useCallback((audioInfo, key) => {
    if (!audioInfo?.url || isPlayingRef.current) return
    if (preparedAudioKeyRef.current === key && audioRef.current?.src === audioInfo.url) return

    const audio = audioRef.current || new Audio()
    audio.pause()
    audio.onended = null
    audio.onerror = null
    audio.onpause = null
    audio.src = audioInfo.url
    audio.preload = 'auto'
    audio.volume = volume
    audioRef.current = audio
    preparedAudioKeyRef.current = key

    try {
      audio.load()
    } catch {
      // The generated URL is still in the app cache; playback will retry load.
    }
  }, [volume])

  const prepareCurrentChunk = useCallback(async () => {
    if (!bookId || !pageData?.sentences?.length) return
    if (currentSentenceRef.current < 0 || currentSentenceRef.current >= pageData.sentences.length) return

    const page = currentPageRef.current
    const sentence = currentSentenceRef.current
    const key = getCacheKey(page, sentence)
    const token = ++prepareCurrentTokenRef.current

    setIsGenerating(true)
    try {
      const audioInfo = await fetchSentenceAudio(page, sentence)
      if (prepareCurrentTokenRef.current !== token) return
      if (!audioInfo) return
      primePausedAudio(audioInfo, key)
      queueReadAhead(page, sentence)
      setPreloadState((prev) => (
        prev.state === 'idle' || prev.state === 'verifying'
          ? { ...prev, state: 'current-ready', ready: Math.max(prev.ready || 0, 1), readyIndices: [sentence], total: prev.total || 1 }
          : prev
      ))
    } finally {
      if (prepareCurrentTokenRef.current === token) {
        setIsGenerating(false)
      }
    }
  }, [bookId, pageData, getCacheKey, fetchSentenceAudio, primePausedAudio, queueReadAhead])

  useEffect(() => {
    if (!bookId || !settingsHydratedRef.current || !settingsReady) return
    prepareCurrentChunk()
  }, [bookId, settingsReady, currentPage, currentSentence, pageData, ttsEngine, voice, speed, prepareCurrentChunk])

  // Check whether the current chapter/page is already cached, but do not start
  // generation. Preload is intentionally user-triggered from the pill.
  useEffect(() => {
    if (!bookId) {
      setPreloadState({ state: 'idle', ready: 0, total: 0, failed: [] })
      return
    }
    if (preloadAbortRef.current) preloadAbortRef.current.abort()
    const controller = new AbortController()
    preloadAbortRef.current = controller
    let cancelled = false

    const qs = () => new URLSearchParams({
      page: String(currentPage),
      engine: ttsEngine,
      voice,
      speed: String(speed),
    }).toString()

    const fetchStatus = async () => {
      const r = await apiFetch(`/api/book/${bookId}/preload-chapter/status?${qs()}`, {
        signal: controller.signal,
        cache: 'no-store',
      })
      if (r.status === 409 || r.status === 423) {
        const data = await r.json().catch(() => null)
        if (data?.error === 'model_required') dispatchModelRequired(data.engine || ttsEngine, data.install || null)
        throw new Error(data?.detail || `status ${r.status}`)
      }
      // Defensive: when the dev proxy can't reach the backend, Vite may serve
      // the SPA index.html with a 200; the browser then caches that as the
      // canonical response. Reject non-JSON responses so we keep retrying.
      if (!r.ok) throw new Error(`status ${r.status}`)
      const ct = r.headers.get('content-type') || ''
      if (!ct.includes('application/json')) throw new Error(`non-json ${ct}`)
      return await r.json()
    }

    setPreloadState({ state: 'verifying', ready: 0, total: 0, failed: [] })
    ;(async () => {
      try {
        const d = await fetchStatus()
        if (cancelled) return
        setPreloadState({
          state: d.state === 'ready' ? 'ready' : d.state === 'error' ? 'error' : 'idle',
          ready: d.ready,
          readyIndices: Array.isArray(d.ready_indices) ? d.ready_indices : [],
          total: d.total,
          failed: d.failed || [],
        })
      } catch {
        // Backend unreachable or endpoint 404 (e.g. backend not yet restarted).
        if (!cancelled) setPreloadState({ state: 'idle', ready: 0, total: 0, failed: [] })
      }
    })()

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [bookId, currentPage, ttsEngine, voice, speed])

  const preloadChapter = useCallback(async () => {
    if (!bookId) return
    if (preloadAbortRef.current) preloadAbortRef.current.abort()

    const controller = new AbortController()
    preloadAbortRef.current = controller
    const page = currentPageRef.current

    const qs = () => new URLSearchParams({
      page: String(page),
      engine: ttsEngine,
      voice,
      speed: String(speed),
    }).toString()

    const fetchStatus = async () => {
      const r = await apiFetch(`/api/book/${bookId}/preload-chapter/status?${qs()}`, {
        signal: controller.signal,
        cache: 'no-store',
      })
      if (r.status === 409 || r.status === 423) {
        const data = await r.json().catch(() => null)
        if (data?.error === 'model_required') dispatchModelRequired(data.engine || ttsEngine, data.install || null)
        throw new Error(data?.detail || `status ${r.status}`)
      }
      if (!r.ok) throw new Error(`status ${r.status}`)
      const ct = r.headers.get('content-type') || ''
      if (!ct.includes('application/json')) throw new Error(`non-json ${ct}`)
      return await r.json()
    }

    const applyStatus = (d, active = false) => {
      setPreloadState({
        state: d.state === 'ready' ? 'ready' : d.state === 'error' ? 'error' : (active ? 'preloading' : 'idle'),
        ready: d.ready,
        readyIndices: Array.isArray(d.ready_indices) ? d.ready_indices : [],
        total: d.total,
        failed: d.failed || [],
      })
    }

    setPreloadState((prev) => ({ state: 'verifying', ready: prev.ready || 0, total: prev.total || 0, failed: prev.failed || [] }))
    try {
      const initial = await fetchStatus()
      if (controller.signal.aborted) return
      if (initial.state === 'ready') {
        applyStatus(initial)
        return
      }

      const queued = await apiFetch(`/api/book/${bookId}/preload-chapter?${qs()}`, {
        method: 'POST',
        signal: controller.signal,
        cache: 'no-store',
      })
      if (queued.status === 409 || queued.status === 423) {
        const data = await queued.json().catch(() => null)
        if (data?.error === 'model_required') dispatchModelRequired(data.engine || ttsEngine, data.install || null)
        throw new Error(data?.detail || `preload ${queued.status}`)
      }
      if (!queued.ok) throw new Error(`preload ${queued.status}`)
      if (controller.signal.aborted) return
      applyStatus(initial, true)

      while (!controller.signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 500))
        if (controller.signal.aborted) return
        const next = await fetchStatus()
        if (controller.signal.aborted) return
        applyStatus(next, next.state !== 'ready')
        if (next.state === 'ready' || next.state === 'error') return
      }
    } catch {
      if (!controller.signal.aborted) {
        setPreloadState((prev) => ({ ...prev, state: prev.ready >= prev.total && prev.total > 0 ? 'ready' : 'idle' }))
      }
    }
  }, [bookId, ttsEngine, voice, speed])

  // Fetch page text WITHOUT navigating the view. Used by the playback loop
  // when scanning ahead for the next readable sentence — auto page navigation
  // is owned by App.jsx's Follow Along effect and must not happen here.
  const fetchPageText = useCallback(async (page) => {
    if (!book) return null
    try {
      const r = await apiFetch(`/api/book/${book.id}/page/${page}/text`)
      if (!r.ok) return null
      return await r.json()
    } catch {
      return null
    }
  }, [book])

  const getPageData = useCallback(async (page) => {
    if (page === currentPageRef.current && pageDataRef.current) {
      return pageDataRef.current
    }
    return await fetchPageText(page)
  }, [fetchPageText])

  const findNextReadablePosition = useCallback(async (page, sentence) => {
    if (!book) return null
    let pageNum = page
    let sentenceIdx = sentence

    while (pageNum < book.page_count) {
      const data = await getPageData(pageNum)
      if (!data || !data.sentences) {
        pageNum += 1
        sentenceIdx = 0
        continue
      }
      if (sentenceIdx < data.sentences.length) {
        return { page: pageNum, sentence: sentenceIdx, pageData: data }
      }
      pageNum += 1
      sentenceIdx = 0
    }

    return null
  }, [book, getPageData])

  const playAudio = useCallback((audioInfo, sessionId, startProgress = 0) => {
    return new Promise((resolve) => {
      if (audioRef.current) {
        audioRef.current.pause()
        audioRef.current.onended = null
        audioRef.current.onerror = null
        audioRef.current.onpause = null
      }
      stopProgressLoop(progressRafRef)
      playingListenerCleanupRef.current?.()
      playingListenerCleanupRef.current = null

      const audio = audioRef.current || new Audio()
      audio.src = audioInfo.url
      audio.preload = 'auto'
      audioRef.current = audio
      const initialProgress = clampProgress(startProgress)
      publishChunkProgress(initialProgress, true)

      const debug = debugFlag('FOLIO_DEBUG_PROGRESS', 'folioDebugProgress')
      const debugTrace = debug ? [] : null
      const debugStart = debug ? performance.now() : 0
      const reportProgress = (state, extra = {}) => {
        if (typeof window === 'undefined') return
        const entry = {
          state,
          sessionId,
          page: currentPageRef.current,
          sentence: currentSentenceRef.current,
          audioReadyState: audio.readyState,
          paused: audio.paused,
          currentTime: audio.currentTime,
          duration: audio.duration,
          rafActive: progressRafRef.current != null,
          ...extra,
        }
        window.__folioProgressDebug = entry
        if (debug) console.debug('[progress]', entry)
      }
      if (debug) {
        window.__folioProgressTrace = debugTrace
        // Reported duration from the backend; compared to audio.duration to
        // detect WAV-header / decoder discrepancies.
        console.debug('[progress] start', {
          sessionId,
          reportedDurationMs: audioInfo.duration_ms,
          url: audioInfo.url,
        })
      }
      reportProgress('created', { reportedDurationMs: audioInfo.duration_ms, url: audioInfo.url })

      // Sample audio progress at frame rate, but publish React state at a
      // coarser cadence so playback does not re-render the whole reader every
      // animation frame.
      const tick = () => {
        progressRafRef.current = null
        if (playbackSessionRef.current !== sessionId) return
        const a = audioRef.current
        if (!a) return
        const dur = a.duration
        if (Number.isFinite(dur) && dur > 0) {
          const p = Math.max(0, Math.min(1, a.currentTime / dur))
          publishChunkProgress(p)
          if (typeof window !== 'undefined') {
            window.__folioProgressDebug = {
              state: 'tick',
              sessionId,
              page: currentPageRef.current,
              sentence: currentSentenceRef.current,
              currentTime: a.currentTime,
              duration: dur,
              progress: p,
              rafActive: true,
            }
          }
          if (debug) {
            debugTrace.push({
              wallMs: performance.now() - debugStart,
              currentTime: a.currentTime,
              duration: dur,
              progress: p,
            })
          }
        }
        progressRafRef.current = requestAnimationFrame(tick)
      }
      const startTicking = () => {
        if (progressRafRef.current) {
          reportProgress('playing-skip-raf-already-active')
          return
        }
        reportProgress('playing-start-raf')
        progressRafRef.current = requestAnimationFrame(tick)
      }
      audio.addEventListener('playing', startTicking, { once: true })
      const cleanupPlayingListener = () => {
        audio.removeEventListener('playing', startTicking)
        if (playingListenerCleanupRef.current === cleanupPlayingListener) {
          playingListenerCleanupRef.current = null
        }
      }
      playingListenerCleanupRef.current = cleanupPlayingListener

      audio.onended = () => {
        cleanupPlayingListener()
        if (playbackSessionRef.current !== sessionId) return
        stopProgressLoop(progressRafRef)
        // The 'ended' event fires when currentTime stops advancing (typically
        // ~30ms before duration). Snap progress to 1 so any downstream
        // "finished?" check sees a clean terminal value.
        publishChunkProgress(1, true)
        reportProgress('ended')
        if (debug) {
          console.debug('[progress] ended', {
            sessionId,
            wallMs: performance.now() - debugStart,
            traceCount: debugTrace.length,
            lastSample: debugTrace[debugTrace.length - 1],
          })
        }
        resolve('done')
      }
      audio.onerror = () => {
        cleanupPlayingListener()
        if (playbackSessionRef.current !== sessionId) return
        stopProgressLoop(progressRafRef)
        reportProgress('error')
        resolve('error')
      }
      audio.onpause = () => {
        cleanupPlayingListener()
        if (isPlayingRef.current) return
        stopProgressLoop(progressRafRef)
        reportProgress('paused')
        resolve('paused')
      }
      const beginPlay = () => {
        audio.play().catch((error) => {
          cleanupPlayingListener()
          reportProgress('play-rejected', { error: String(error?.message || error) })
          resolve('error')
        })
      }
      const seekThenPlay = () => {
        if (initialProgress > 0) {
          const duration = Number.isFinite(audio.duration) && audio.duration > 0
            ? audio.duration
            : (Number(audioInfo.duration_ms || 0) / 1000)
          if (duration > 0) {
            try {
              audio.currentTime = Math.min(Math.max(0, duration * initialProgress), Math.max(0, duration - 0.08))
              publishChunkProgress(initialProgress, true)
              reportProgress('start-offset-applied', { initialProgress, startTime: audio.currentTime, duration })
            } catch {
              reportProgress('start-offset-failed', { initialProgress, duration })
            }
          }
        }
        beginPlay()
      }
      if (initialProgress > 0 && audio.readyState < 1) {
        const onLoaded = () => {
          audio.removeEventListener('loadedmetadata', onLoaded)
          seekThenPlay()
        }
        audio.addEventListener('loadedmetadata', onLoaded)
        try {
          audio.load()
        } catch {
          audio.removeEventListener('loadedmetadata', onLoaded)
          seekThenPlay()
        }
      } else {
        seekThenPlay()
      }
    })
  }, [publishChunkProgress])

  const startPlayback = useCallback(async (startPage, startSentence, startProgress = 0) => {
    if (!book) return

    const sessionId = ++playbackSessionRef.current
    let firstChunkProgress = clampProgress(startProgress)
    setGenerationError('')
    isPlayingRef.current = true
    setIsPlaying(true)

    let position = await findNextReadablePosition(startPage, startSentence)
    if (!position) {
      setIsPlaying(false)
      isPlayingRef.current = false
      return
    }

    // The view does NOT auto-follow the playback cursor here. App.jsx owns
    // page/sub-page advancement via the Follow Along effect, so pages turn
    // only when Follow Along is active. Outside Follow Along, audio keeps
    // playing while the visible page stays put — the user can re-sync via
    // the "jump to reader" pill button or by entering Follow Along.
    while (isPlayingRef.current && playbackSessionRef.current === sessionId && position) {
      const { page, sentence, pageData: data } = position
      const sentenceInfo = data.sentences[sentence]
      if (!sentenceInfo) {
        position = await findNextReadablePosition(page, sentence + 1)
        continue
      }

      setCurrentSentence(sentence)
      currentSentenceRef.current = sentence
      setReadingPage(page)
      readingPageRef.current = page
      // Reset chunkProgress *before* the audio load so the cursor / page-turn
      // effects don't see the previous sentence's terminal value (which would
      // place the cursor at end-of-chunk and over-advance Follow Along).
      publishChunkProgress(firstChunkProgress, true)

      const audioPromise = fetchSentenceAudio(page, sentence)
      queueReadAhead(page, sentence)
      const audioInfo = await audioPromise
      if (playbackSessionRef.current !== sessionId) return
      if (!audioInfo) {
        setIsPlaying(false)
        isPlayingRef.current = false
        return
      }

      const result = await playAudio(audioInfo, sessionId, firstChunkProgress)
      firstChunkProgress = 0
      if (result !== 'done') {
        if (result === 'error') {
          setIsPlaying(false)
          isPlayingRef.current = false
        }
        return
      }

      await new Promise(res => setTimeout(res, 200))
      if (playbackSessionRef.current !== sessionId) return

      if (sentence % 3 === 0) {
        // Fire-and-forget: don't block the next-sentence latency on a slow
        // backend write. Errors are swallowed because position is also saved
        // on pause/stop and on every navigation.
        Promise.resolve(savePosition(page, sentence, { chunk_progress: 0 })).catch(() => {})
      }
      position = await findNextReadablePosition(page, sentence + 1)
    }

    if (playbackSessionRef.current === sessionId && isPlayingRef.current) {
      setIsPlaying(false)
      isPlayingRef.current = false
    }
  }, [book, findNextReadablePosition, playAudio, fetchSentenceAudio, queueReadAhead, savePosition, publishChunkProgress])

  useEffect(() => {
    if (!bookId || !settingsHydratedRef.current) return

    const settingsKey = `${bookId}|${ttsEngine}|${voice}|${speed}`
    if (playbackSettingsKeyRef.current === null || playbackSettingsKeyRef.current === settingsKey) {
      playbackSettingsKeyRef.current = settingsKey
      return
    }
    playbackSettingsKeyRef.current = settingsKey

    if (!isPlayingRef.current) return

    const resumePage = readingPage ?? currentPageRef.current
    const resumeSentence = currentSentenceRef.current

    playbackSessionRef.current += 1
    isPlayingRef.current = false
    setIsPlaying(false)
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
    }

    const restartTimer = setTimeout(() => {
      startPlayback(resumePage, resumeSentence)
    }, 0)

    return () => clearTimeout(restartTimer)
  }, [bookId, ttsEngine, voice, speed, readingPage, startPlayback])

  const play = useCallback(() => {
    if (isPlayingRef.current) return
    const startProgress = pendingStartProgressRef.current || chunkProgressPublishRef.current.value || 0
    pendingStartProgressRef.current = 0
    startPlayback(currentPageRef.current, currentSentenceRef.current, startProgress)
  }, [startPlayback])

  const seekToSentence = useCallback(async (page, sentence, options: any = {}) => {
    if (!book || page == null || sentence == null || sentence < 0) return
    const shouldResume = isPlayingRef.current
    const startProgress = clampProgress(options?.progress)

    cancelReadAhead(page, sentence)
    playbackSessionRef.current += 1
    isPlayingRef.current = false
    setIsPlaying(false)
    if (audioRef.current) audioRef.current.pause()

    if (page !== currentPageRef.current) {
      await goToPage(page)
    }

    currentSentenceRef.current = sentence
    setCurrentSentence(sentence)
    pendingStartProgressRef.current = shouldResume ? 0 : startProgress
    publishChunkProgress(startProgress, true)
    setReadingPage(page)
    readingPageRef.current = page

    await savePosition(page, sentence, { chunk_progress: startProgress })

    if (shouldResume) {
      startPlayback(page, sentence, startProgress)
    } else {
      queueReadAhead(page, sentence)
    }
  }, [book, goToPage, savePosition, startPlayback, publishChunkProgress, cancelReadAhead, queueReadAhead])

  const pause = useCallback(() => {
    playbackSessionRef.current += 1
    setIsPlaying(false)
    isPlayingRef.current = false
    if (audioRef.current) audioRef.current.pause()
    pendingStartProgressRef.current = chunkProgressPublishRef.current.value || 0
    stopProgressLoop(progressRafRef)
    if (book) savePosition(readingPageRef.current ?? currentPageRef.current, currentSentenceRef.current, { chunk_progress: pendingStartProgressRef.current })
  }, [book, savePosition])

  useEffect(() => {
    pauseRef.current = pause
  }, [pause])

  const stop = useCallback(() => {
    pause()
    currentSentenceRef.current = 0
    setCurrentSentence(0)
    pendingStartProgressRef.current = 0
    publishChunkProgress(0, true)
  }, [pause, publishChunkProgress])

  const skipSentence = useCallback((delta) => {
    const sentenceCount = pageDataRef.current?.sentences?.length || 0
    const nextSentence = Math.max(0, Math.min(currentSentenceRef.current + delta, Math.max(sentenceCount - 1, 0)))
    cancelReadAhead(currentPageRef.current, nextSentence)
    currentSentenceRef.current = nextSentence
    setCurrentSentence(nextSentence)
    pendingStartProgressRef.current = 0
    publishChunkProgress(0, true)

    if (isPlayingRef.current) {
      pause()
      startPlayback(currentPageRef.current, nextSentence)
    } else {
      queueReadAhead(currentPageRef.current, nextSentence)
    }
  }, [pause, startPlayback, publishChunkProgress, cancelReadAhead, queueReadAhead])

  useEffect(() => {
    const audioCache = audioCacheRef.current
    const readAhead = readAheadRef.current
    // Read refs *inside* the cleanup so unmount sees the live audio element /
    // timers, not the (null) values captured at mount.
    return () => {
      if (audioRef.current) {
        audioRef.current.pause()
        audioRef.current.src = ''
        audioRef.current = null
      }
      playingListenerCleanupRef.current?.()
      playingListenerCleanupRef.current = null
      stopProgressLoop(progressRafRef)
      if (sleepTimerRef.current) clearInterval(sleepTimerRef.current)
      if (preloadAbortRef.current) preloadAbortRef.current.abort()
      if (readAheadAbortRef.current) readAheadAbortRef.current.abort()
      audioCache.clear()
      readAhead.clear()
    }
  }, [])

  return {
    isPlaying,
    isGenerating,
    generationError,
    currentSentence,
    speed,
    setSpeed,
    ttsEngine,
    setTtsEngine,
    voice,
    setVoice,
    volume,
    setVolume,
    sleepTimer,
    setSleepTimer,
    preloadState,
    preloadChapter,
    readingPage,
    chunkProgress,
    play,
    pause,
    stop,
    seekToSentence,
    skipSentence,
  }
}
