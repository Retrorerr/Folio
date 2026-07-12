import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { apiFetch, apiResourceUrl, isAndroidRuntime } from '../api'
import { mobileAudioStatus, mobileControlAudio, mobileStartAudio } from '../mobileApi'
import {
  clampSpeedForEngine,
  defaultSpeed,
  defaultTtsEngine,
  defaultVoiceForEngine,
  normalizeEngineVoices,
  normalizeTtsEngine,
  normalizeVoiceForEngine,
} from '../ttsVoices'
import type { AudioInfo, BookState, PageText, Position, PreloadState, TtsGenerateResponse } from '../types'
import { classifyNativeQueueProgress, fillSpectrumLevels, findAdjacentReadablePosition, rememberBoundedSetEntry, setBoundedMapEntry } from './audioPlaybackState'

function dispatchModelRequired(engine, install) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent('folio:model-required', { detail: { engine, install } }))
}

const READ_AHEAD_SENTENCES = 12
const LEAD_PREFETCH_SENTENCES = 4
const STARTUP_READY_LEAD_SENTENCES = 2
const REFILL_READY_LEAD_SENTENCES = 1
const STARTUP_LEAD_WAIT_MS = 9000
const REFILL_LEAD_WAIT_MS = 6000
const BUFFER_POLL_MS = 120
const UNDERRUN_WAIT_MS = 350
const DEFAULT_SPEED = defaultSpeed
const CHUNK_PROGRESS_MIN_DELTA = 0.008
const CHUNK_PROGRESS_MAX_INTERVAL_MS = 50
const AUDIO_INFO_CACHE_LIMIT = 160
const PAGE_TEXT_CACHE_LIMIT = 24
const READ_AHEAD_KEY_LIMIT = 256
const AUDIO_SPECTRUM_BARS = 64
const AUDIO_SPECTRUM_INTERVAL_MS = 40

type LeadPosition = { page: number; sentence: number }
type AudioPlaybackResult = 'done' | 'error' | 'paused' | 'cancelled'
type SeekOptions = { progress?: number; preserveView?: boolean; pageData?: PageText | null }
export type AudioSpectrumSubscriber = (levels: Float32Array) => void
type BufferState = {
  state: 'idle' | 'warming' | 'prebuffering' | 'playing'
  ready: number
  target: number
  scheduled: number
  current: LeadPosition | null
  reason: string
  updatedAt: number
}

function idleBufferState(): BufferState {
  return {
    state: 'idle',
    ready: 0,
    target: 0,
    scheduled: 0,
    current: null,
    reason: '',
    updatedAt: Date.now(),
  }
}

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

function audioSettingsKey(bookId, engine, voice, speed) {
  return `${bookId}|${normalizeTtsEngine(engine)}|${voice}|${Number(speed).toFixed(4)}`
}

function resolveBookAudioSettings(book: BookState | null) {
  if (!book) return null
  const engine = normalizeTtsEngine(book.tts_engine || defaultTtsEngine)
  const voices = normalizeEngineVoices(book.tts_voices)
  voices[engine] = normalizeVoiceForEngine(
    engine,
    book.voice || voices[engine] || defaultVoiceForEngine(engine),
  )
  const voice = voices[engine]
  const speed = clampSpeedForEngine(engine, book.speed ?? DEFAULT_SPEED)
  return {
    engine,
    voices,
    voice,
    speed,
    key: audioSettingsKey(book.id, engine, voice, speed),
  }
}

interface UseAudioPlaybackArgs {
  book: BookState | null
  pageData: PageText | null
  currentPage: number
  goToPage: (page: number) => Promise<PageText | null> | undefined
  savePosition: (page: number | Position, sentenceIdx?: number, options?: Partial<Position> & { keepalive?: boolean }) => Promise<void> | undefined
  applyBookSettings?: (settings: Partial<Pick<BookState, 'tts_engine' | 'voice' | 'tts_voices' | 'speed'>>) => void
}

export default function useAudioPlayback({ book, pageData, currentPage, goToPage, savePosition, applyBookSettings }: UseAudioPlaybackArgs) {
  const bookId = book?.id
  const bookAudioSettings = useMemo(() => resolveBookAudioSettings(book), [book])
  const initialEngine = bookAudioSettings?.engine || defaultTtsEngine
  const initialEngineVoices = bookAudioSettings?.voices || normalizeEngineVoices(undefined)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentSentence, setCurrentSentence] = useState(0)
  const [speed, setSpeed] = useState(clampSpeedForEngine(initialEngine, book?.speed ?? DEFAULT_SPEED))
  const [ttsEngine, setTtsEngineRaw] = useState(initialEngine)
  const [engineVoices, setEngineVoices] = useState(initialEngineVoices)
  const [voice, setVoiceRaw] = useState(initialEngineVoices[initialEngine])
  const [volume, setVolume] = useState(() => clampNumber(localStorage.getItem('volume'), 0, 1, 1))
  const [sleepTimer, setSleepTimer] = useState<number | null>(null)
  const [preloadState, setPreloadState] = useState<PreloadState>({ state: 'idle', ready: 0, total: 0, failed: [] })
  const [readingPage, setReadingPage] = useState<number | null>(null)
  const [readingSentenceCount, setReadingSentenceCount] = useState(0)
  const [isGenerating, setIsGenerating] = useState(false)
  const [generationError, setGenerationError] = useState('')
  const [bufferState, setBufferState] = useState<BufferState>(() => idleBufferState())
  const [settingsReady, setSettingsReady] = useState(false)
  // Fraction (0..1) of the way through the current sentence's audio. Drives the
  // line cursor, intra-chunk start offsets, and Follow Along page advancement.
  const [chunkProgress, setChunkProgress] = useState(0)

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const audioGraphRef = useRef<{
    context: AudioContext | null
    analyser: AnalyserNode | null
    sources: WeakMap<HTMLAudioElement, MediaElementAudioSourceNode>
    bins: Uint8Array<ArrayBuffer> | null
    levels: Float32Array
    lastSampleAt: number
  }>({
    context: null,
    analyser: null,
    sources: new WeakMap(),
    bins: null,
    levels: new Float32Array(AUDIO_SPECTRUM_BARS),
    lastSampleAt: 0,
  })
  const audioSpectrumSubscribersRef = useRef(new Set<AudioSpectrumSubscriber>())
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
  const settingsHydratedKeyRef = useRef<string | null>(null)
  const audioCacheRef = useRef<Map<string, AudioInfo | Promise<AudioInfo | null>>>(new Map())
  const pageTextCacheRef = useRef<Map<number, PageText>>(new Map())
  const readAheadRef = useRef<Set<string>>(new Set())
  const readAheadAbortRef = useRef<AbortController | null>(null)
  const lastAudioSettingsRef = useRef<{
    bookId: string
    engine: string
    voice: string
    speed: number
  } | null>(null)
  const preloadAbortRef = useRef<AbortController | null>(null)
  const pauseRef = useRef(() => {})
  const chunkProgressPublishRef = useRef({ value: 0, at: 0 })
  const pendingStartProgressRef = useRef(0)
  const playingListenerCleanupRef = useRef<null | (() => void)>(null)
  const metadataListenerCleanupRef = useRef<null | (() => void)>(null)
  const audioCompletionRef = useRef<null | {
    sessionId: number
    settle: (result: AudioPlaybackResult) => void
  }>(null)
  const activeBookIdRef = useRef(bookId)
  const nativeQueueByPositionRef = useRef(new Map<string, number>())
  const nativePositionBySessionRef = useRef(new Map<number, LeadPosition>())

  const resetNativeQueueTracking = useCallback(() => {
    nativeQueueByPositionRef.current.clear()
    nativePositionBySessionRef.current.clear()
  }, [])

  const notifyAudioSpectrum = useCallback(() => {
    const levels = audioGraphRef.current.levels
    audioSpectrumSubscribersRef.current.forEach((subscriber) => subscriber(levels))
  }, [])

  const resetAudioSpectrum = useCallback(() => {
    audioGraphRef.current.levels.fill(0)
    audioGraphRef.current.lastSampleAt = 0
    notifyAudioSpectrum()
  }, [notifyAudioSpectrum])

  const subscribeAudioSpectrum = useCallback((subscriber: AudioSpectrumSubscriber) => {
    audioSpectrumSubscribersRef.current.add(subscriber)
    subscriber(audioGraphRef.current.levels)
    return () => { audioSpectrumSubscribersRef.current.delete(subscriber) }
  }, [])

  const activateAudioAnalysis = useCallback(() => {
    if (typeof window === 'undefined') return null
    const graph = audioGraphRef.current
    if (!graph.context) {
      const AudioContextConstructor = window.AudioContext || (window as any).webkitAudioContext
      if (!AudioContextConstructor) return null
      try {
        graph.context = new AudioContextConstructor()
        graph.analyser = graph.context.createAnalyser()
        graph.analyser.fftSize = 1024
        graph.analyser.smoothingTimeConstant = 0.68
        graph.analyser.minDecibels = -82
        graph.analyser.maxDecibels = -18
        graph.analyser.connect(graph.context.destination)
        graph.bins = new Uint8Array(graph.analyser.frequencyBinCount)
      } catch {
        graph.context = null
        graph.analyser = null
        graph.bins = null
        return null
      }
    }
    if (graph.context.state === 'suspended') void graph.context.resume().catch(() => {})
    return graph
  }, [])

  const attachAudioAnalysis = useCallback(async (audio: HTMLAudioElement) => {
    const graph = activateAudioAnalysis()
    if (!graph?.context || !graph.analyser) return
    if (graph.context.state === 'suspended') await graph.context.resume().catch(() => {})
    if (graph.context.state !== 'running' || graph.sources.has(audio)) return
    try {
      const source = graph.context.createMediaElementSource(audio)
      source.connect(graph.analyser)
      graph.sources.set(audio, source)
    } catch {
      // Playback remains usable if this WebView cannot expose media analysis.
    }
  }, [activateAudioAnalysis])

  const sampleAudioSpectrum = useCallback(() => {
    const graph = audioGraphRef.current
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
    if (!graph.analyser || !graph.bins || now - graph.lastSampleAt < AUDIO_SPECTRUM_INTERVAL_MS) return
    graph.lastSampleAt = now
    graph.analyser.getByteFrequencyData(graph.bins)
    fillSpectrumLevels(graph.bins, graph.levels, 0.42, {
      sampleRate: graph.context?.sampleRate,
      fftSize: graph.analyser.fftSize,
      minFrequency: 80,
      maxFrequency: 8_000,
    })
    notifyAudioSpectrum()
  }, [notifyAudioSpectrum])

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

  useEffect(() => {
    if (activeBookIdRef.current === bookId) return
    activeBookIdRef.current = bookId
    playbackSessionRef.current += 1
    audioCompletionRef.current?.settle('cancelled')
    metadataListenerCleanupRef.current?.()
    playingListenerCleanupRef.current?.()
    metadataListenerCleanupRef.current = null
    playingListenerCleanupRef.current = null
    if (audioRef.current) {
      audioRef.current.onended = null
      audioRef.current.onerror = null
      audioRef.current.onpause = null
      audioRef.current.pause()
      audioRef.current.src = ''
      audioRef.current = null
    }
    stopProgressLoop(progressRafRef)
    isPlayingRef.current = false
    readingPageRef.current = null
    currentSentenceRef.current = 0
    setIsPlaying(false)
    setIsGenerating(false)
    setReadingPage(null)
    setReadingSentenceCount(0)
    setBufferState(idleBufferState())
    pageTextCacheRef.current.clear()
    publishChunkProgress(0, true)
    resetAudioSpectrum()
    if (isAndroidRuntime()) {
      resetNativeQueueTracking()
      void mobileControlAudio('stop').catch(() => {})
    }
  }, [bookId, publishChunkProgress, resetAudioSpectrum, resetNativeQueueTracking])

  const setTtsEngine = useCallback((nextEngine) => {
    const normalized = normalizeTtsEngine(nextEngine)
    const updatedVoices = {
      ...normalizeEngineVoices(engineVoices),
      [ttsEngine]: normalizeVoiceForEngine(ttsEngine, voice),
    }
    const nextVoice = normalizeVoiceForEngine(
      normalized,
      updatedVoices[normalized] || defaultVoiceForEngine(normalized),
    )
    updatedVoices[normalized] = nextVoice
    setEngineVoices(updatedVoices)
    setTtsEngineRaw(normalized)
    setVoiceRaw(nextVoice)
    setSpeed((prev) => clampSpeedForEngine(normalized, prev))
  }, [engineVoices, ttsEngine, voice])

  const setVoice = useCallback((nextVoice) => {
    const normalized = normalizeVoiceForEngine(ttsEngine, nextVoice)
    setVoiceRaw(normalized)
    setEngineVoices((prev) => ({
      ...normalizeEngineVoices(prev),
      [ttsEngine]: normalized,
    }))
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
    if (!bookId || !bookAudioSettings) {
      settingsHydratedKeyRef.current = null
      settingsHydratedRef.current = false
      return
    }
    if (settingsHydratedKeyRef.current === bookAudioSettings.key) return
    settingsHydratedKeyRef.current = bookAudioSettings.key
    settingsHydratedRef.current = false
    setSettingsReady(false)
    setEngineVoices(bookAudioSettings.voices)
    setSpeed(bookAudioSettings.speed)
    setTtsEngineRaw(bookAudioSettings.engine)
    setVoiceRaw(bookAudioSettings.voice)
    setCurrentSentence(book.last_position?.sentence_idx || 0)
    currentSentenceRef.current = book.last_position?.sentence_idx || 0
    const initialProgress = clampProgress(book.last_position?.chunk_progress || 0)
    pendingStartProgressRef.current = initialProgress
    publishChunkProgress(initialProgress, true)
    settingsHydratedRef.current = true
  }, [book, bookAudioSettings, bookId, publishChunkProgress])

  useEffect(() => {
    if (!bookId || !bookAudioSettings) {
      setSettingsReady(false)
      return
    }
    if (settingsReady) return
    const ready = (
      ttsEngine === bookAudioSettings.engine
      && voice === bookAudioSettings.voice
      && Math.abs(speed - bookAudioSettings.speed) < 0.001
    )
    if (ready) setSettingsReady(true)
  }, [bookAudioSettings, bookId, settingsReady, ttsEngine, voice, speed])

  useEffect(() => {
    const nextSettings = book?.id
      ? {
        bookId: book.id,
        engine: ttsEngine,
        voice,
        speed,
      }
      : null
    const previousSettings = lastAudioSettingsRef.current
    lastAudioSettingsRef.current = nextSettings

    audioCacheRef.current.clear()
    readAheadAbortRef.current?.abort()
    readAheadAbortRef.current = null
    readAheadRef.current.clear()
    setGenerationError('')

    if (
      previousSettings &&
      nextSettings &&
      previousSettings.bookId === nextSettings.bookId &&
      (
        previousSettings.engine !== nextSettings.engine ||
        previousSettings.voice !== nextSettings.voice ||
        Math.abs(previousSettings.speed - nextSettings.speed) > 0.0001
      )
    ) {
      const params = new URLSearchParams({
        book_id: previousSettings.bookId,
        page: String(currentPageRef.current),
        sentence: String(currentSentenceRef.current),
        engine: previousSettings.engine,
        voice: previousSettings.voice,
        speed: String(previousSettings.speed),
        keep_current: 'false',
      })
      apiFetch(`/api/tts/buffer/cancel?${params.toString()}`, {
        method: 'POST',
        cache: 'no-store',
      }).catch(() => {})
      if (isAndroidRuntime()) {
        resetNativeQueueTracking()
        void mobileControlAudio('stop').catch(() => {})
      }
    }
  }, [book?.id, ttsEngine, voice, speed, resetNativeQueueTracking])

  useEffect(() => {
    if (!bookId || !settingsHydratedRef.current || !settingsReady) return
    const currentBookId = bookId
    const nextSettingsKey = audioSettingsKey(currentBookId, ttsEngine, voice, speed)
    if (settingsHydratedKeyRef.current === nextSettingsKey) return
    const controller = new AbortController()
    const params = new URLSearchParams({
      tts_engine: ttsEngine,
      voice,
      speed: String(speed),
    })
    apiFetch(`/api/book/${currentBookId}/settings?${params.toString()}`, {
      method: 'POST',
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) return
        const data = await res.json().catch(() => null)
        if (data?.id === currentBookId) {
          applyBookSettings?.({
            tts_engine: data.tts_engine,
            voice: data.voice,
            tts_voices: data.tts_voices,
            speed: data.speed,
          })
        }
      })
      .catch(() => {})
    return () => controller.abort()
  }, [bookId, settingsReady, ttsEngine, voice, speed, applyBookSettings])

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

  const fetchSentenceAudio = useCallback(async (
    page,
    sentence,
    options: { promptForMissingModel?: boolean; background?: boolean } = {},
  ) => {
    if (!book) return null
    const key = getCacheKey(page, sentence)
    const cached = audioCacheRef.current.get(key)
    if (cached) {
      setBoundedMapEntry(audioCacheRef.current, key, cached, AUDIO_INFO_CACHE_LIMIT)
      return cached instanceof Promise ? cached : Promise.resolve(cached)
    }

    const qs = `book_id=${encodeURIComponent(book.id)}&page=${page}&sentence=${sentence}&engine=${encodeURIComponent(ttsEngine)}&voice=${encodeURIComponent(voice)}&speed=${speed}`

    const promise = apiFetch(`/api/tts/generate?${qs}`)
      .then(async (res) => {
        if (!res.ok) {
          audioCacheRef.current.delete(key)
          let message = 'TTS generation failed.'
          try {
            const data = await res.json()
            if (data?.error === 'model_required') {
              if (options.promptForMissingModel) {
                dispatchModelRequired(data.engine || ttsEngine, data.install || null)
              }
              message = data?.detail || `${ttsEngine} is not installed yet.`
              if (!options.background) setGenerationError(message)
              return null
            }
            message = data?.detail || message
          } catch {
            // Keep the generic error if the backend returns a non-JSON body.
          }
          if (!options.background) setGenerationError(message)
          return null
        }
        const data = await res.json() as TtsGenerateResponse
        const info = { url: apiResourceUrl(`/api/audio/${data.filename}`), duration_ms: data.duration_ms }
        setBoundedMapEntry(audioCacheRef.current, key, info, AUDIO_INFO_CACHE_LIMIT)
        if (!options.background) setGenerationError('')
        return info
      })
      .catch(() => {
        audioCacheRef.current.delete(key)
        if (!options.background) setGenerationError('TTS generation failed because the backend did not respond.')
        return null
      })

    setBoundedMapEntry(audioCacheRef.current, key, promise, AUDIO_INFO_CACHE_LIMIT)
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
    rememberBoundedSetEntry(readAheadRef.current, key, READ_AHEAD_KEY_LIMIT)

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
          if (data?.error === 'model_required' && isPlayingRef.current) {
            dispatchModelRequired(data.engine || ttsEngine, data.install || null)
          }
        }).catch(() => {})
      }
    }).catch((err) => {
      if (readAheadAbortRef.current === controller) readAheadAbortRef.current = null
      if (err?.name === 'AbortError') return
      readAheadRef.current.delete(key)
    })
  }, [book, ttsEngine, voice, speed])

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
    const cached = pageTextCacheRef.current.get(page)
    if (cached) {
      setBoundedMapEntry(pageTextCacheRef.current, page, cached, PAGE_TEXT_CACHE_LIMIT)
      return cached
    }
    const requestBookId = book.id
    try {
      const r = await apiFetch(`/api/book/${book.id}/page/${page}/text`)
      if (!r.ok) return null
      const data = await r.json() as PageText
      if (activeBookIdRef.current !== requestBookId) return null
      setBoundedMapEntry(pageTextCacheRef.current, page, data, PAGE_TEXT_CACHE_LIMIT)
      return data
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

  const isAudioReady = useCallback((page, sentence) => {
    const cached = audioCacheRef.current.get(getCacheKey(page, sentence))
    return Boolean(cached && !(cached instanceof Promise))
  }, [getCacheKey])

  const collectReadablePositions = useCallback(async (page, sentence, count): Promise<LeadPosition[]> => {
    if (!book || count <= 0) return []
    const positions: LeadPosition[] = []
    let pageNum = Math.max(0, page)
    let sentenceIdx = Math.max(0, sentence)

    while (pageNum < book.page_count && positions.length < count) {
      const data = await getPageData(pageNum)
      if (!data?.sentences?.length) {
        pageNum += 1
        sentenceIdx = 0
        continue
      }

      while (sentenceIdx < data.sentences.length && positions.length < count) {
        if (data.sentences[sentenceIdx]?.text?.trim()) {
          positions.push({ page: pageNum, sentence: sentenceIdx })
        }
        sentenceIdx += 1
      }

      pageNum += 1
      sentenceIdx = 0
    }

    return positions
  }, [book, getPageData])

  const summarizeLead = useCallback((positions: LeadPosition[]) => {
    let ready = 0
    let scheduled = 0
    let current: LeadPosition | null = null
    positions.forEach((pos) => {
      const cached = audioCacheRef.current.get(getCacheKey(pos.page, pos.sentence))
      if (cached) {
        scheduled += 1
        if (!(cached instanceof Promise)) {
          ready += 1
        } else if (!current) {
          current = pos
        }
      } else if (!current) {
        current = pos
      }
    })
    return {
      ready,
      target: positions.length,
      scheduled,
      current: current || positions[0] || null,
    }
  }, [getCacheKey])

  const publishBufferState = useCallback((
    state: BufferState['state'],
    positions: LeadPosition[],
    reason: string,
    fallbackCurrent: LeadPosition | null = null,
  ) => {
    const targets = positions.slice(0, Math.min(LEAD_PREFETCH_SENTENCES, positions.length))
    const next = summarizeLead(targets)
    setBufferState({
      state,
      ready: next.ready,
      target: next.target,
      scheduled: next.scheduled,
      current: next.current || fallbackCurrent,
      reason,
      updatedAt: Date.now(),
    })
    return next
  }, [summarizeLead])

  const primeLeadBuffer = useCallback((
    positions: LeadPosition[],
    sessionId: number,
    reason = 'Generating ahead while narration plays',
  ) => {
    const targets = positions.slice(0, Math.min(LEAD_PREFETCH_SENTENCES, positions.length))
    const publish = () => publishBufferState('playing', targets, targets.length > 0 ? reason : '')
    const summary = publish()

    targets.forEach((pos) => {
      if (!isAudioReady(pos.page, pos.sentence)) {
        void fetchSentenceAudio(pos.page, pos.sentence, { background: true }).finally(() => {
          if (playbackSessionRef.current === sessionId && isPlayingRef.current) {
            publish()
          }
        })
      }
    })

    if (summary.scheduled < summary.target) {
      publish()
    }
    return summary
  }, [fetchSentenceAudio, isAudioReady, publishBufferState])

  const waitForLeadBuffer = useCallback(async (
    positions: LeadPosition[],
    sessionId: number,
    minReady: number,
    timeoutMs: number,
    reason: string,
  ) => {
    const targets = positions.slice(0, Math.min(LEAD_PREFETCH_SENTENCES, positions.length))
    const requiredReady = Math.min(Math.max(0, minReady), targets.length)
    if (targets.length === 0 || requiredReady === 0) {
      return publishBufferState('prebuffering', targets, reason)
    }

    const publishState = () => {
      return publishBufferState('prebuffering', targets, reason)
    }

    let summary = publishState()
    if (summary.ready >= requiredReady) return summary

    targets.forEach((pos) => {
      if (!isAudioReady(pos.page, pos.sentence)) {
        void fetchSentenceAudio(pos.page, pos.sentence, { background: true })
      }
    })
    summary = publishState()

    const deadline = Date.now() + Math.max(0, timeoutMs)
    while (
      playbackSessionRef.current === sessionId &&
      isPlayingRef.current &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, BUFFER_POLL_MS))
      summary = publishState()
      if (summary.ready >= requiredReady) return summary
    }

    return summarizeLead(targets)
  }, [fetchSentenceAudio, isAudioReady, publishBufferState, summarizeLead])

  const prepareNativeQueue = useCallback(async (
    audioInfo: AudioInfo,
    position: LeadPosition,
    leadPositions: LeadPosition[],
    sessionId: number,
    startProgress: number,
  ): Promise<number> => {
    const positionKey = getCacheKey(position.page, position.sentence)
    let status = await mobileAudioStatus().catch(() => null)
    let nativeSessionId = nativeQueueByPositionRef.current.get(positionKey) || 0
    const activeIds = new Set(status?.queueSessionIds || [])
    const reusable = nativeSessionId > 0 && activeIds.has(nativeSessionId)

    if (!reusable) {
      resetNativeQueueTracking()
      status = await mobileStartAudio(
        audioInfo,
        { title: book?.title || 'Folio narration', artist: book?.author || 'Folio', album: 'Folio' },
        Number(audioInfo.duration_ms || 0) * clampProgress(startProgress),
        'replace',
      )
      if (playbackSessionRef.current !== sessionId || !isPlayingRef.current) {
        void mobileControlAudio('stop').catch(() => {})
        throw new Error('Narration start was cancelled')
      }
      nativeSessionId = Number(status.enqueuedSessionId || status.sessionId || 0)
      if (!nativeSessionId) throw new Error('Android did not return a narration session')
      nativeQueueByPositionRef.current.set(positionKey, nativeSessionId)
      nativePositionBySessionRef.current.set(nativeSessionId, position)
    } else if (status?.state === 'paused' && status.sessionId === nativeSessionId) {
      status = await mobileControlAudio('resume')
    }

    const queuedIds = new Set(status?.queueSessionIds || [])
    const targets = leadPositions.slice(0, LEAD_PREFETCH_SENTENCES)
    for (const target of targets) {
      if (playbackSessionRef.current !== sessionId || !isPlayingRef.current) break
      const key = getCacheKey(target.page, target.sentence)
      const knownSession = nativeQueueByPositionRef.current.get(key)
      if (knownSession && queuedIds.has(knownSession)) continue
      const cached = audioCacheRef.current.get(key)
      if (!cached || cached instanceof Promise) continue
      try {
        const queued = await mobileStartAudio(
          cached,
          { title: book?.title || 'Folio narration', artist: book?.author || 'Folio', album: 'Folio' },
          0,
          'append',
        )
        const queuedSessionId = Number(queued.enqueuedSessionId || 0)
        if (!queuedSessionId) continue
        nativeQueueByPositionRef.current.set(key, queuedSessionId)
        nativePositionBySessionRef.current.set(queuedSessionId, target)
        queuedIds.add(queuedSessionId)
      } catch (error) {
        // The current chunk remains playable if the bounded native lead queue
        // fills or a prefetched append fails. The next loop can refill it.
        console.warn('Could not append Android narration lead audio', error)
        break
      }
    }
    return nativeSessionId
  }, [book, getCacheKey, resetNativeQueueTracking])

  const playNativeAudio = useCallback((
    audioInfo: AudioInfo,
    sessionId: number,
    startProgress: number,
    position: LeadPosition,
    leadPositions: LeadPosition[],
  ) => {
    return new Promise<AudioPlaybackResult>((resolve) => {
      let settled = false
      let pollTimer: ReturnType<typeof setTimeout> | null = null
      let nativeSessionId = 0

      const finish = (result: AudioPlaybackResult) => {
        if (settled) return
        settled = true
        if (pollTimer) clearTimeout(pollTimer)
        if (audioCompletionRef.current?.sessionId === sessionId) audioCompletionRef.current = null
        resolve(result)
      }

      const settle = (result: AudioPlaybackResult) => {
        void mobileControlAudio(result === 'paused' ? 'pause' : 'stop').catch(() => {})
        if (result !== 'paused') resetNativeQueueTracking()
        finish(result)
      }
      audioCompletionRef.current = { sessionId, settle }

      const poll = async () => {
        if (settled) return
        if (playbackSessionRef.current !== sessionId || !isPlayingRef.current) {
          settle('cancelled')
          return
        }
        try {
          const status = await mobileAudioStatus()
          const transition = classifyNativeQueueProgress(status.state, Number(status.sessionId || 0), nativeSessionId)
          if (transition === 'current') {
            const duration = Number(status.durationMs || audioInfo.duration_ms || 0)
            const progress = duration > 0
              ? clampProgress(Number(status.positionMs || 0) / duration)
              : startProgress
            publishChunkProgress(progress)
          }
          if (transition === 'advanced' || transition === 'finished') {
            publishChunkProgress(1, true)
            finish('done')
            return
          }
          if (transition === 'error') {
            setGenerationError(status.error || 'Android audio playback failed.')
            finish('error')
            return
          }
          if (transition === 'paused' || transition === 'stopped') {
            finish(transition === 'paused' ? 'paused' : 'cancelled')
            return
          }
          pollTimer = setTimeout(() => { void poll() }, 50)
        } catch (error) {
          setGenerationError(error?.message || 'Android audio playback failed.')
          finish('error')
        }
      }

      void prepareNativeQueue(audioInfo, position, leadPositions, sessionId, startProgress).then((preparedSessionId) => {
        if (settled) return
        nativeSessionId = preparedSessionId
        publishChunkProgress(startProgress, true)
        pollTimer = setTimeout(() => { void poll() }, 20)
      }).catch((error) => {
        setGenerationError(error?.message || 'Android audio playback failed.')
        finish('error')
      })
    })
  }, [prepareNativeQueue, publishChunkProgress, resetNativeQueueTracking])

  const playAudio = useCallback((audioInfo: AudioInfo, sessionId: number, startProgress = 0) => {
    return new Promise<AudioPlaybackResult>((resolve) => {
      audioCompletionRef.current?.settle('cancelled')
      metadataListenerCleanupRef.current?.()
      playingListenerCleanupRef.current?.()
      metadataListenerCleanupRef.current = null
      playingListenerCleanupRef.current = null

      if (audioRef.current) {
        audioRef.current.onended = null
        audioRef.current.onerror = null
        audioRef.current.onpause = null
        audioRef.current.pause()
      }
      stopProgressLoop(progressRafRef)

      const audio = audioRef.current || new Audio()
      if (!audioRef.current) audio.crossOrigin = 'anonymous'
      audio.src = audioInfo.url
      audio.preload = 'auto'
      audioRef.current = audio
      const initialProgress = clampProgress(startProgress)
      publishChunkProgress(initialProgress, true)

      const debug = debugFlag('FOLIO_DEBUG_PROGRESS', 'folioDebugProgress')
      const debugTrace = debug ? [] : null
      const debugStart = debug ? performance.now() : 0
      let cleanupPlayingListener = () => {}
      let cleanupMetadataListener = () => {}
      let settled = false
      const finish = (result: AudioPlaybackResult) => {
        if (settled) return
        settled = true
        cleanupPlayingListener()
        cleanupMetadataListener()
        resetAudioSpectrum()
        if (audioCompletionRef.current?.settle === finish) audioCompletionRef.current = null
        audio.onended = null
        audio.onerror = null
        audio.onpause = null
        resolve(result)
      }
      audioCompletionRef.current = { sessionId, settle: finish }
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
        if (playbackSessionRef.current !== sessionId) {
          finish('cancelled')
          return
        }
        const a = audioRef.current
        if (!a) return
        const dur = a.duration
        if (Number.isFinite(dur) && dur > 0) {
          const p = Math.max(0, Math.min(1, a.currentTime / dur))
          publishChunkProgress(p)
          sampleAudioSpectrum()
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
        if (playbackSessionRef.current !== sessionId) {
          finish('cancelled')
          return
        }
        if (progressRafRef.current) {
          reportProgress('playing-skip-raf-already-active')
          return
        }
        reportProgress('playing-start-raf')
        progressRafRef.current = requestAnimationFrame(tick)
      }
      audio.addEventListener('playing', startTicking, { once: true })
      cleanupPlayingListener = () => {
        audio.removeEventListener('playing', startTicking)
        if (playingListenerCleanupRef.current === cleanupPlayingListener) {
          playingListenerCleanupRef.current = null
        }
      }
      playingListenerCleanupRef.current = cleanupPlayingListener

      audio.onended = () => {
        if (playbackSessionRef.current !== sessionId) {
          finish('cancelled')
          return
        }
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
        finish('done')
      }
      audio.onerror = () => {
        if (playbackSessionRef.current !== sessionId) {
          finish('cancelled')
          return
        }
        stopProgressLoop(progressRafRef)
        reportProgress('error')
        finish('error')
      }
      audio.onpause = () => {
        if (playbackSessionRef.current !== sessionId) {
          finish('cancelled')
          return
        }
        if (isPlayingRef.current) return
        stopProgressLoop(progressRafRef)
        reportProgress('paused')
        finish('paused')
      }
      const beginPlay = () => {
        if (playbackSessionRef.current !== sessionId || audioRef.current !== audio) {
          finish('cancelled')
          return
        }
        void attachAudioAnalysis(audio)
        audio.play().catch((error) => {
          if (playbackSessionRef.current !== sessionId) {
            finish('cancelled')
            return
          }
          reportProgress('play-rejected', { error: String(error?.message || error) })
          setGenerationError(error?.name === 'NotAllowedError'
            ? 'Playback was blocked. Press play again to continue.'
            : 'Audio playback failed. Press play to retry.')
          finish('error')
        })
      }
      const seekThenPlay = () => {
        if (playbackSessionRef.current !== sessionId || audioRef.current !== audio) {
          finish('cancelled')
          return
        }
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
          cleanupMetadataListener()
          seekThenPlay()
        }
        audio.addEventListener('loadedmetadata', onLoaded)
        cleanupMetadataListener = () => {
          audio.removeEventListener('loadedmetadata', onLoaded)
          if (metadataListenerCleanupRef.current === cleanupMetadataListener) {
            metadataListenerCleanupRef.current = null
          }
        }
        metadataListenerCleanupRef.current = cleanupMetadataListener
        try {
          audio.load()
        } catch {
          cleanupMetadataListener()
          seekThenPlay()
        }
      } else {
        seekThenPlay()
      }
    })
  }, [attachAudioAnalysis, publishChunkProgress, resetAudioSpectrum, sampleAudioSpectrum])

  const startPlayback = useCallback(async (startPage, startSentence, startProgress = 0) => {
    if (!book) return

    const sessionId = ++playbackSessionRef.current
    let firstChunkProgress = clampProgress(startProgress)
    setGenerationError('')
    isPlayingRef.current = true
    setIsPlaying(true)
    setBufferState({
      state: 'warming',
      ready: 0,
      target: 0,
      scheduled: 0,
      current: { page: startPage, sentence: startSentence },
      reason: 'Finding the next readable sentence',
      updatedAt: Date.now(),
    })
    let needsLeadBeforePlay = true

    let position = await findNextReadablePosition(startPage, startSentence)
    if (!position) {
      setIsPlaying(false)
      isPlayingRef.current = false
      setBufferState(idleBufferState())
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
      setReadingSentenceCount(data.sentences.length)
      // Reset chunkProgress *before* the audio load so the cursor / page-turn
      // effects don't see the previous sentence's terminal value (which would
      // place the cursor at end-of-chunk and over-advance Follow Along).
      publishChunkProgress(firstChunkProgress, true)

      const leadPositionsPromise = collectReadablePositions(page, sentence + 1, READ_AHEAD_SENTENCES)
      setBufferState({
        state: 'warming',
        ready: 0,
        target: 0,
        scheduled: 0,
        current: { page, sentence },
        reason: 'Preparing the current sentence',
        updatedAt: Date.now(),
      })
      setIsGenerating(true)
      const generationStartedAt = typeof performance !== 'undefined' ? performance.now() : Date.now()
      const audioPromise = fetchSentenceAudio(page, sentence, { promptForMissingModel: true })
      queueReadAhead(page, sentence)
      const audioInfo = await audioPromise.finally(() => {
        if (playbackSessionRef.current === sessionId) setIsGenerating(false)
      })
      const generationWaitMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - generationStartedAt
      if (playbackSessionRef.current !== sessionId) return
      const leadPositions = await leadPositionsPromise.catch(() => [])
      if (playbackSessionRef.current !== sessionId) return
      if (!audioInfo) {
        setIsPlaying(false)
        isPlayingRef.current = false
        setBufferState(idleBufferState())
        return
      }

      if (leadPositions.length > 0 && (needsLeadBeforePlay || generationWaitMs > UNDERRUN_WAIT_MS)) {
        await waitForLeadBuffer(
          leadPositions,
          sessionId,
          needsLeadBeforePlay ? STARTUP_READY_LEAD_SENTENCES : REFILL_READY_LEAD_SENTENCES,
          needsLeadBeforePlay ? STARTUP_LEAD_WAIT_MS : REFILL_LEAD_WAIT_MS,
          needsLeadBeforePlay ? 'Starting with a lead buffer' : 'Refilling after a slow generation',
        )
        if (playbackSessionRef.current !== sessionId) return
      }

      primeLeadBuffer(leadPositions, sessionId)
      needsLeadBeforePlay = false
      const result = isAndroidRuntime()
        ? await playNativeAudio(audioInfo, sessionId, firstChunkProgress, { page, sentence }, leadPositions)
        : await playAudio(audioInfo, sessionId, firstChunkProgress)
      if (playbackSessionRef.current !== sessionId) return
      firstChunkProgress = 0
      if (result !== 'done') {
        setIsPlaying(false)
        isPlayingRef.current = false
        setBufferState(idleBufferState())
        return
      }

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
      setBufferState(idleBufferState())
    }
  }, [
    book,
    collectReadablePositions,
    findNextReadablePosition,
    playAudio,
    playNativeAudio,
    fetchSentenceAudio,
    queueReadAhead,
    savePosition,
    publishChunkProgress,
    primeLeadBuffer,
    waitForLeadBuffer,
  ])

  const runPlayback = useCallback((startPage, startSentence, startProgress = 0) => {
    // startPlayback intentionally owns the session lifecycle, but a browser or
    // decoder exception must not leave the imperative ref saying "playing"
    // while React has already rendered the paused controls. Besides making the
    // play button appear unresponsive, that stale ref used to block every
    // subsequent attempt until the book was reopened.
    const expectedSession = playbackSessionRef.current + 1
    void startPlayback(startPage, startSentence, startProgress).catch((error) => {
      if (playbackSessionRef.current !== expectedSession) return
      playbackSessionRef.current += 1
      isPlayingRef.current = false
      setIsPlaying(false)
      setIsGenerating(false)
      setBufferState(idleBufferState())
      setGenerationError('Narration could not start. Please try again.')
      console.error('Narration playback failed', error)
    })
  }, [startPlayback])

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
    audioCompletionRef.current?.settle('cancelled')
    metadataListenerCleanupRef.current?.()
    metadataListenerCleanupRef.current = null
    setIsPlaying(false)
    setIsGenerating(false)
    setBufferState(idleBufferState())
    if (audioRef.current) {
      audioRef.current.onended = null
      audioRef.current.onerror = null
      audioRef.current.onpause = null
      audioRef.current.pause()
      audioRef.current.src = ''
      audioRef.current = null
    }

    const restartTimer = setTimeout(() => {
      if (isAndroidRuntime()) {
        resetNativeQueueTracking()
        void mobileControlAudio('stop').catch(() => {}).finally(() => {
          runPlayback(resumePage, resumeSentence)
        })
      } else {
        runPlayback(resumePage, resumeSentence)
      }
    }, 0)

    return () => clearTimeout(restartTimer)
  }, [bookId, ttsEngine, voice, speed, readingPage, runPlayback, resetNativeQueueTracking])

  const play = useCallback(() => {
    if (isPlayingRef.current) return
    activateAudioAnalysis()
    const startProgress = pendingStartProgressRef.current || chunkProgressPublishRef.current.value || 0
    pendingStartProgressRef.current = 0
    const startPage = readingPageRef.current ?? currentPageRef.current
    runPlayback(startPage, currentSentenceRef.current, startProgress)
  }, [activateAudioAnalysis, runPlayback])

  const seekToSentence = useCallback(async (page: number, sentence: number, options: SeekOptions = {}) => {
    if (!book || page == null || sentence == null || sentence < 0) return
    const shouldResume = isPlayingRef.current
    const startProgress = clampProgress(options?.progress)

    cancelReadAhead(page, sentence)
    playbackSessionRef.current += 1
    isPlayingRef.current = false
    audioCompletionRef.current?.settle('cancelled')
    if (isAndroidRuntime()) {
      resetNativeQueueTracking()
      await mobileControlAudio('stop').catch(() => {})
    }
    metadataListenerCleanupRef.current?.()
    metadataListenerCleanupRef.current = null
    setIsPlaying(false)
    setIsGenerating(false)
    setBufferState(idleBufferState())
    if (audioRef.current) {
      audioRef.current.onended = null
      audioRef.current.onerror = null
      audioRef.current.onpause = null
      audioRef.current.pause()
    }

    if (page !== currentPageRef.current && !options.preserveView) {
      await goToPage(page)
    }

    const targetPageData = options.pageData || await getPageData(page)

    currentSentenceRef.current = sentence
    setCurrentSentence(sentence)
    pendingStartProgressRef.current = shouldResume ? 0 : startProgress
    publishChunkProgress(startProgress, true)
    setReadingPage(page)
    readingPageRef.current = page
    setReadingSentenceCount(targetPageData?.sentences?.length || 0)

    await savePosition(page, sentence, { chunk_progress: startProgress })

    if (shouldResume) {
      runPlayback(page, sentence, startProgress)
    } else {
      queueReadAhead(page, sentence)
    }
  }, [book, getPageData, goToPage, savePosition, runPlayback, publishChunkProgress, cancelReadAhead, queueReadAhead, resetNativeQueueTracking])

  const pause = useCallback(() => {
    playbackSessionRef.current += 1
    isPlayingRef.current = false
    audioCompletionRef.current?.settle('paused')
    metadataListenerCleanupRef.current?.()
    metadataListenerCleanupRef.current = null
    setIsPlaying(false)
    setIsGenerating(false)
    setBufferState(idleBufferState())
    if (audioRef.current) {
      audioRef.current.onended = null
      audioRef.current.onerror = null
      audioRef.current.onpause = null
      audioRef.current.pause()
    }
    pendingStartProgressRef.current = chunkProgressPublishRef.current.value || 0
    stopProgressLoop(progressRafRef)
    if (book) savePosition(readingPageRef.current ?? currentPageRef.current, currentSentenceRef.current, { chunk_progress: pendingStartProgressRef.current })
  }, [book, savePosition])

  useEffect(() => {
    pauseRef.current = pause
  }, [pause])

  const stop = useCallback(() => {
    pause()
    if (isAndroidRuntime()) {
      resetNativeQueueTracking()
      void mobileControlAudio('stop').catch(() => {})
    }
    currentSentenceRef.current = 0
    setCurrentSentence(0)
    pendingStartProgressRef.current = 0
    publishChunkProgress(0, true)
  }, [pause, publishChunkProgress, resetNativeQueueTracking])

  const skipSentence = useCallback(async (delta: number) => {
    if (!book || delta === 0) return
    const direction: -1 | 1 = delta < 0 ? -1 : 1
    const anchorPage = readingPageRef.current ?? currentPageRef.current
    const target = await findAdjacentReadablePosition(
      getPageData,
      anchorPage,
      currentSentenceRef.current,
      direction,
      book.page_count,
    )
    if (!target) return
    await seekToSentence(target.page, target.sentence, {
      progress: 0,
      preserveView: true,
      pageData: target.pageData,
    })
  }, [book, getPageData, seekToSentence])

  useEffect(() => {
    const audioCache = audioCacheRef.current
    const pageTextCache = pageTextCacheRef.current
    const readAhead = readAheadRef.current
    const spectrumSubscribers = audioSpectrumSubscribersRef.current
    const audioGraph = audioGraphRef.current
    // Read refs *inside* the cleanup so unmount sees the live audio element /
    // timers, not the (null) values captured at mount.
    return () => {
      playbackSessionRef.current += 1
      audioCompletionRef.current?.settle('cancelled')
      metadataListenerCleanupRef.current?.()
      metadataListenerCleanupRef.current = null
      if (audioRef.current) {
        audioRef.current.onended = null
        audioRef.current.onerror = null
        audioRef.current.onpause = null
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
      pageTextCache.clear()
      readAhead.clear()
      resetAudioSpectrum()
      spectrumSubscribers.clear()
      void audioGraph.context?.close().catch(() => {})
    }
  }, [resetAudioSpectrum])

  useEffect(() => {
    if (typeof document === 'undefined' || document.documentElement.dataset.platform !== 'android') return
    const mediaSession = navigator.mediaSession
    if (!mediaSession || !book) return
    try {
      mediaSession.metadata = new MediaMetadata({ title: book.title, artist: book.author || 'Folio', album: 'Folio' })
      mediaSession.playbackState = isPlaying ? 'playing' : 'paused'
      const actions: Array<[MediaSessionAction, MediaSessionActionHandler]> = [
        ['play', play],
        ['pause', pause],
        ['previoustrack', () => { void skipSentence(-1) }],
        ['nexttrack', () => { void skipSentence(1) }],
      ]
      actions.forEach(([action, handler]) => {
        try { mediaSession.setActionHandler(action, handler) } catch { /* Android WebView may omit an action. */ }
      })
      return () => {
        actions.forEach(([action]) => {
          try { mediaSession.setActionHandler(action, null) } catch { /* Ignore unsupported actions. */ }
        })
      }
    } catch {
      // Media Session is optional on Android WebView versions.
    }
  }, [book, isPlaying, pause, play, skipSentence])

  return {
    isPlaying,
    isGenerating,
    bufferState,
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
    readingSentenceCount,
    chunkProgress,
    subscribeAudioSpectrum,
    play,
    pause,
    stop,
    seekToSentence,
    skipSentence,
  }
}
