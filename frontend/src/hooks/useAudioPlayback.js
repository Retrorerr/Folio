import { useState, useRef, useCallback, useEffect } from 'react'

const API = ''

export default function useAudioPlayback({ book, pageData, currentPage, goToPage, savePosition }) {
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentSentence, setCurrentSentence] = useState(0)
  const [currentWordIdx, setCurrentWordIdx] = useState(-1)
  const [speed, setSpeed] = useState(book?.speed || 1.0)
  const [voice, setVoice] = useState(book?.voice || 'af_heart')
  const [engine, setEngine] = useState(book?.engine || 'orpheus')
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
  const settingsHydratedRef = useRef(false)
  const audioCacheRef = useRef(new Map())
  const preloadAbortRef = useRef(null)
  const preloadReadyRef = useRef(false)
  const pauseRef = useRef(() => {})

  useEffect(() => { currentPageRef.current = currentPage }, [currentPage])
  useEffect(() => { pageDataRef.current = pageData }, [pageData])
  useEffect(() => { currentSentenceRef.current = currentSentence }, [currentSentence])
  useEffect(() => { isPlayingRef.current = isPlaying }, [isPlaying])
  useEffect(() => { preloadReadyRef.current = preloadState.state === 'ready' }, [preloadState.state])
  useEffect(() => { pauseRef.current = () => {} }, [])
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume
  }, [volume])

  useEffect(() => {
    if (!book) return
    setSpeed(book.speed || 1.0)
    setVoice(book.voice || 'af_heart')
    setEngine(book.engine || 'orpheus')
    setCurrentSentence(book.last_position?.sentence_idx || 0)
    currentSentenceRef.current = book.last_position?.sentence_idx || 0
    settingsHydratedRef.current = true
  }, [book])

  useEffect(() => {
    audioCacheRef.current.clear()
  }, [book?.id, voice, speed, engine])

  useEffect(() => {
    if (!book || !settingsHydratedRef.current) return
    const controller = new AbortController()
    const params = new URLSearchParams({
      voice,
      speed: String(speed),
      engine,
    })
    fetch(`${API}/api/book/${book.id}/settings?${params.toString()}`, {
      method: 'POST',
      signal: controller.signal,
    }).catch(() => {})
    return () => controller.abort()
  }, [book, voice, speed, engine])

  useEffect(() => {
    audioCacheRef.current.clear()
    if (engine === 'orpheus') {
      setVoice((v) => (v.startsWith('af_') || v.startsWith('am_') || v.startsWith('bf_') ? 'tara' : v))
    } else {
      setVoice((v) => (['tara', 'leah', 'jess', 'leo', 'dan', 'mia', 'zac', 'zoe'].includes(v) ? 'af_heart' : v))
    }
  }, [engine])

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
    return `${book?.id}|${engine}|${voice}|${speed}|${page}|${sentence}`
  }, [book?.id, engine, voice, speed])

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
      engine,
    })

    const promise = fetch(`${API}/api/tts/generate?${params.toString()}`)
      .then(async (res) => {
        if (!res.ok) {
          audioCacheRef.current.delete(key)
          return null
        }
        const data = await res.json()
        const info = { url: `${API}/api/audio/${data.filename}`, duration_ms: data.duration_ms }
        audioCacheRef.current.set(key, info)
        return info
      })
      .catch(() => {
        audioCacheRef.current.delete(key)
        return null
      })

    audioCacheRef.current.set(key, promise)
    return promise
  }, [book, getCacheKey, voice, speed, engine])

  // === Chapter preload gate ===
  // Every time the chapter/voice/speed/engine changes, check the cache.
  // If the chapter isn't fully cached, POST to start generation and poll
  // status every 500ms. `preloadState.state` drives the Pill's preload
  // button. Playback is gated on `state === 'ready'`.
  useEffect(() => {
    if (!book) {
      setPreloadState({ state: 'idle', ready: 0, total: 0, failed: [] })
      return
    }
    if (preloadAbortRef.current) preloadAbortRef.current.abort()
    const controller = new AbortController()
    preloadAbortRef.current = controller
    let cancelled = false
    let timer = null

    const qs = () => new URLSearchParams({
      page: String(currentPage),
      voice,
      speed: String(speed),
      engine,
    }).toString()

    const fetchStatus = async () => {
      const r = await fetch(`${API}/api/book/${book.id}/preload-chapter/status?${qs()}`, {
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

    const poll = async () => {
      if (cancelled) return
      try {
        const d = await fetchStatus()
        if (cancelled) return
        setPreloadState({ state: d.state, ready: d.ready, total: d.total, failed: d.failed || [] })
        if (d.state !== 'ready') timer = setTimeout(poll, 500)
      } catch {
        if (!cancelled) timer = setTimeout(poll, 1500)
      }
    }

    setPreloadState({ state: 'verifying', ready: 0, total: 0, failed: [] })
    ;(async () => {
      try {
        const d = await fetchStatus()
        if (cancelled) return
        if (d.state === 'ready') {
          setPreloadState({ state: 'ready', ready: d.ready, total: d.total, failed: d.failed || [] })
          return
        }
        await fetch(`${API}/api/book/${book.id}/preload-chapter?${qs()}`, {
          method: 'POST',
          signal: controller.signal,
          cache: 'no-store',
        }).catch(() => {})
        if (cancelled) return
        setPreloadState({ state: 'preloading', ready: d.ready, total: d.total, failed: d.failed || [] })
        poll()
      } catch {
        // Backend unreachable or endpoint 404 (e.g. backend not yet restarted).
        // Keep retrying so the UI recovers automatically once it comes back.
        if (!cancelled) timer = setTimeout(poll, 1500)
      }
    })()

    return () => {
      cancelled = true
      controller.abort()
      if (timer) clearTimeout(timer)
    }
  }, [book?.id, currentPage, voice, speed, engine])

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
    // Gate: chapter must be fully preloaded before playback starts.
    if (!preloadReadyRef.current) return

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
      const audioInfo = await fetchSentenceAudio(page, sentence)
      if (playbackSessionRef.current !== sessionId) return
      if (!audioInfo) {
        // Permanent failure for this sentence — skip.
        position = await findNextReadablePosition(page, sentence + 1)
        continue
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
  }, [book, findNextReadablePosition, goToPage, playAudio, fetchSentenceAudio, savePosition])

  const play = useCallback(() => {
    if (isPlayingRef.current) return
    if (!preloadReadyRef.current) return
    startPlayback(currentPageRef.current, currentSentenceRef.current)
  }, [startPlayback])

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
    const preloadAbort = preloadAbortRef.current
    return () => {
      if (audio) audio.pause()
      if (wordTimer) clearInterval(wordTimer)
      if (sleepTimerId) clearInterval(sleepTimerId)
      if (preloadAbort) preloadAbort.abort()
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
    engine,
    setEngine,
    sleepTimer,
    setSleepTimer,
    preloadState,
    readingPage,
    play,
    pause,
    stop,
    skipSentence,
  }
}
