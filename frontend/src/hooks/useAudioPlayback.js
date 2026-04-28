import { useState, useRef, useCallback, useEffect } from 'react'
import { apiFetch, apiUrl } from '../api'
import { defaultKokoroVoice, normalizeKokoroVoice } from '../kokoroVoices'

const READ_AHEAD_SENTENCES = 6
const DEFAULT_SPEED = 0.95

export default function useAudioPlayback({ book, pageData, currentPage, goToPage, savePosition }) {
  const bookId = book?.id
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentSentence, setCurrentSentence] = useState(0)
  const [currentWordIdx, setCurrentWordIdx] = useState(-1)
  const [speed, setSpeed] = useState(book?.speed ?? DEFAULT_SPEED)
  const [voice, setVoice] = useState(normalizeKokoroVoice(book?.voice || defaultKokoroVoice))
  const [volume, setVolume] = useState(() => parseFloat(localStorage.getItem('volume') ?? '1.0'))
  const [sleepTimer, setSleepTimer] = useState(null)
  const [preloadState, setPreloadState] = useState({ state: 'idle', ready: 0, total: 0, failed: [] })
  const [readingPage, setReadingPage] = useState(null)

  const audioRef = useRef(null)
  const wordTimerRef = useRef(null)
  const sleepTimerRef = useRef(null)
  const currentPageRef = useRef(currentPage)
  const currentSentenceRef = useRef(0)
  const pageDataRef = useRef(pageData)
  const isPlayingRef = useRef(false)
  const playbackSessionRef = useRef(0)
  const playbackSettingsKeyRef = useRef(null)
  const settingsHydratedRef = useRef(false)
  const audioCacheRef = useRef(new Map())
  const readAheadRef = useRef(new Set())
  const preloadAbortRef = useRef(null)
  const pauseRef = useRef(() => {})

  useEffect(() => { currentPageRef.current = currentPage }, [currentPage])
  useEffect(() => { pageDataRef.current = pageData }, [pageData])
  useEffect(() => { currentSentenceRef.current = currentSentence }, [currentSentence])
  useEffect(() => { isPlayingRef.current = isPlaying }, [isPlaying])
  useEffect(() => { pauseRef.current = () => {} }, [])
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume
  }, [volume])

  useEffect(() => {
    if (!bookId) return
    setSpeed(book.speed ?? DEFAULT_SPEED)
    setVoice(normalizeKokoroVoice(book.voice || defaultKokoroVoice))
    setCurrentSentence(book.last_position?.sentence_idx || 0)
    currentSentenceRef.current = book.last_position?.sentence_idx || 0
    settingsHydratedRef.current = true
  }, [book, bookId])

  useEffect(() => {
    audioCacheRef.current.clear()
    readAheadRef.current.clear()
  }, [book?.id, voice, speed])

  useEffect(() => {
    if (!book || !settingsHydratedRef.current) return
    const controller = new AbortController()
    const params = new URLSearchParams({
      voice,
      speed: String(speed),
    })
    apiFetch(`/api/book/${book.id}/settings?${params.toString()}`, {
      method: 'POST',
      signal: controller.signal,
    }).catch(() => {})
    return () => controller.abort()
  }, [book, voice, speed])

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
    if (sentenceCount === 0 && currentWordIdx !== -1) {
      setCurrentWordIdx(-1)
      return
    }
    if (sentenceCount > 0 && currentSentence >= sentenceCount) {
      currentSentenceRef.current = 0
      setCurrentSentence(0)
      setCurrentWordIdx(-1)
    }
  }, [pageData, currentSentence, currentWordIdx])

  const getCacheKey = useCallback((page, sentence) => {
    return `${book?.id}|kokoro|${voice}|${speed}|${page}|${sentence}`
  }, [book?.id, voice, speed])

  const fetchSentenceAudio = useCallback(async (page, sentence) => {
    if (!book) return null
    const key = getCacheKey(page, sentence)
    const cached = audioCacheRef.current.get(key)
    if (cached) return cached instanceof Promise ? cached : Promise.resolve(cached)

    const params = new URLSearchParams({
      book_id: book.id,
      page: String(page),
      sentence: String(sentence),
      voice,
      speed: String(speed),
    })

    const promise = apiFetch(`/api/tts/generate?${params.toString()}`)
      .then(async (res) => {
        if (!res.ok) {
          audioCacheRef.current.delete(key)
          return null
        }
        const data = await res.json()
        const info = { url: apiUrl(`/api/audio/${data.filename}`), duration_ms: data.duration_ms }
        audioCacheRef.current.set(key, info)
        return info
      })
      .catch(() => {
        audioCacheRef.current.delete(key)
        return null
      })

    audioCacheRef.current.set(key, promise)
    return promise
  }, [book, getCacheKey, voice, speed])

  const queueReadAhead = useCallback((page, sentence) => {
    if (!book) return
    const key = `${book.id}|kokoro|${voice}|${speed}|${page}|${sentence}|${READ_AHEAD_SENTENCES}`
    if (readAheadRef.current.has(key)) return
    readAheadRef.current.add(key)

    const params = new URLSearchParams({
      book_id: book.id,
      page: String(page),
      sentence: String(sentence),
      count: String(READ_AHEAD_SENTENCES),
      voice,
      speed: String(speed),
    })

    apiFetch(`/api/tts/buffer?${params.toString()}`, {
      method: 'POST',
      cache: 'no-store',
    }).catch(() => {
      readAheadRef.current.delete(key)
    })
  }, [book, voice, speed])

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
      voice,
      speed: String(speed),
    }).toString()

    const fetchStatus = async () => {
      const r = await apiFetch(`/api/book/${bookId}/preload-chapter/status?${qs()}`, {
        signal: controller.signal,
        cache: 'no-store',
      })
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
  }, [bookId, currentPage, voice, speed])

  const preloadChapter = useCallback(async () => {
    if (!bookId) return
    if (preloadAbortRef.current) preloadAbortRef.current.abort()

    const controller = new AbortController()
    preloadAbortRef.current = controller
    const page = currentPageRef.current

    const qs = () => new URLSearchParams({
      page: String(page),
      voice,
      speed: String(speed),
    }).toString()

    const fetchStatus = async () => {
      const r = await apiFetch(`/api/book/${bookId}/preload-chapter/status?${qs()}`, {
        signal: controller.signal,
        cache: 'no-store',
      })
      if (!r.ok) throw new Error(`status ${r.status}`)
      const ct = r.headers.get('content-type') || ''
      if (!ct.includes('application/json')) throw new Error(`non-json ${ct}`)
      return await r.json()
    }

    const applyStatus = (d, active = false) => {
      setPreloadState({
        state: d.state === 'ready' ? 'ready' : d.state === 'error' ? 'error' : (active ? 'preloading' : 'idle'),
        ready: d.ready,
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
  }, [bookId, voice, speed])

  const getPageData = useCallback(async (page) => {
    if (page === currentPageRef.current && pageDataRef.current) {
      return pageDataRef.current
    }
    return await goToPage(page)
  }, [goToPage])

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

  const playAudio = useCallback((audioInfo, sessionId) => {
    return new Promise((resolve) => {
      if (audioRef.current) audioRef.current.pause()
      if (wordTimerRef.current) clearInterval(wordTimerRef.current)

      const audio = new Audio(audioInfo.url)
      audio.preload = 'auto'
      audioRef.current = audio
      setCurrentWordIdx(-1)

      audio.onended = () => {
        if (playbackSessionRef.current !== sessionId) return
        resolve('done')
      }
      audio.onerror = () => {
        if (playbackSessionRef.current !== sessionId) return
        resolve('error')
      }
      audio.onpause = () => {
        if (isPlayingRef.current) return
        resolve('paused')
      }
      audio.play().catch(() => resolve('error'))
    })
  }, [])

  const startPlayback = useCallback(async (startPage, startSentence) => {
    if (!book) return

    const sessionId = ++playbackSessionRef.current
    isPlayingRef.current = true
    setIsPlaying(true)

    let position = await findNextReadablePosition(startPage, startSentence)
    if (!position) {
      setIsPlaying(false)
      isPlayingRef.current = false
      return
    }

    // Track the last page we advanced the reader to. If the view is still on
    // that page when we advance to the next, we pull the view along (auto-follow).
    // If the user has manually flipped away, we stop dragging the view and let
    // them browse freely — they can hit the "jump to reader" button in the pill.
    let lastReaderPage = null

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
      if (page !== currentPageRef.current) {
        const viewWasFollowing = lastReaderPage === null || lastReaderPage === currentPageRef.current
        if (viewWasFollowing) {
          await goToPage(page)
        }
      }
      lastReaderPage = page

      setCurrentWordIdx(0)
      const audioPromise = fetchSentenceAudio(page, sentence)
      queueReadAhead(page, sentence)
      const audioInfo = await audioPromise
      if (playbackSessionRef.current !== sessionId) return
      if (!audioInfo) {
        setIsPlaying(false)
        isPlayingRef.current = false
        setCurrentWordIdx(-1)
        return
      }

      const result = await playAudio(audioInfo, sessionId)
      if (result !== 'done') {
        if (result === 'error') {
          setIsPlaying(false)
          isPlayingRef.current = false
        }
        return
      }

      // Natural pause between sentences — mimics a reader's breath
      await new Promise(res => setTimeout(res, 300))
      if (playbackSessionRef.current !== sessionId) return

      if (sentence % 3 === 0) {
        await savePosition(page, sentence)
      }
      position = await findNextReadablePosition(page, sentence + 1)
    }
  }, [book, findNextReadablePosition, goToPage, playAudio, fetchSentenceAudio, queueReadAhead, savePosition])

  useEffect(() => {
    if (!bookId || !settingsHydratedRef.current) return

    const settingsKey = `${bookId}|kokoro|${voice}|${speed}`
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
    setCurrentWordIdx(-1)
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
    }
    if (wordTimerRef.current) {
      clearInterval(wordTimerRef.current)
      wordTimerRef.current = null
    }

    const restartTimer = setTimeout(() => {
      startPlayback(resumePage, resumeSentence)
    }, 0)

    return () => clearTimeout(restartTimer)
  }, [bookId, voice, speed, readingPage, startPlayback])

  const play = useCallback(() => {
    if (isPlayingRef.current) return
    startPlayback(currentPageRef.current, currentSentenceRef.current)
  }, [startPlayback])

  const seekToSentence = useCallback(async (page, sentence) => {
    if (!book || page == null || sentence == null || sentence < 0) return
    const shouldResume = isPlayingRef.current

    playbackSessionRef.current += 1
    isPlayingRef.current = false
    setIsPlaying(false)
    if (audioRef.current) audioRef.current.pause()
    if (wordTimerRef.current) clearInterval(wordTimerRef.current)

    if (page !== currentPageRef.current) {
      await goToPage(page)
    }

    currentSentenceRef.current = sentence
    setCurrentSentence(sentence)
    setCurrentWordIdx(-1)
    setReadingPage(page)

    await savePosition(page, sentence)

    if (shouldResume) {
      startPlayback(page, sentence)
    }
  }, [book, goToPage, savePosition, startPlayback])

  const pause = useCallback(() => {
    playbackSessionRef.current += 1
    setIsPlaying(false)
    isPlayingRef.current = false
    if (audioRef.current) audioRef.current.pause()
    if (wordTimerRef.current) clearInterval(wordTimerRef.current)
    if (book) savePosition(currentPageRef.current, currentSentenceRef.current)
  }, [book, savePosition])

  useEffect(() => {
    pauseRef.current = pause
  }, [pause])

  const stop = useCallback(() => {
    pause()
    currentSentenceRef.current = 0
    setCurrentSentence(0)
    setCurrentWordIdx(-1)
  }, [pause])

  const skipSentence = useCallback((delta) => {
    const sentenceCount = pageDataRef.current?.sentences?.length || 0
    const nextSentence = Math.max(0, Math.min(currentSentenceRef.current + delta, Math.max(sentenceCount - 1, 0)))
    currentSentenceRef.current = nextSentence
    setCurrentSentence(nextSentence)
    setCurrentWordIdx(-1)

    if (isPlayingRef.current) {
      pause()
      startPlayback(currentPageRef.current, nextSentence)
    }
  }, [pause, startPlayback])

  useEffect(() => {
    const audio = audioRef.current
    const wordTimer = wordTimerRef.current
    const sleepTimerId = sleepTimerRef.current
    return () => {
      if (audio) audio.pause()
      if (wordTimer) clearInterval(wordTimer)
      if (sleepTimerId) clearInterval(sleepTimerId)
      if (preloadAbortRef.current) preloadAbortRef.current.abort()
    }
  }, [])

  return {
    isPlaying,
    isGenerating: false,
    currentSentence,
    currentWordIdx,
    speed,
    setSpeed,
    voice,
    setVoice,
    volume,
    setVolume,
    sleepTimer,
    setSleepTimer,
    preloadState,
    preloadChapter,
    readingPage,
    play,
    pause,
    stop,
    seekToSentence,
    skipSentence,
  }
}
