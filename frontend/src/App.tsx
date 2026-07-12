import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { AnimatePresence, MotionConfig, motion as m } from 'motion/react'
import type {
  GlobalSettings,
  ModelInstallInfo,
  Position,
  ReaderNavHandle,
  ReaderSearchTarget,
  ReflowDocument,
  ReflowProgress,
  SearchResult,
  TtsRuntimeInfo,
  TtsStatus,
} from './types'
import type { ReaderPageNavigationState } from './readerNavigation'
import useBookState from './hooks/useBookState'
import useAudioPlayback from './hooks/useAudioPlayback'
import LoadingScreen from './components/LoadingScreen'
import Welcome from './components/Welcome'
import ReflowViewer from './components/ReflowViewer'
import PdfViewer from './components/PdfViewer'
import Pill from './components/Pill'
import Sidebar from './components/Sidebar'
import { Icons } from './components/icons'
import {
  apiFetch,
  getBackendLogPath,
  isPreviewWatchdogEnabled,
  isTauriRuntime,
  listenForOpenFile,
  openBackendLog,
  sendAppHeartbeat,
  sendPreviewHeartbeat,
  startBackend,
  takePendingOpenFile,
} from './api'
import CursorHalo from './components/CursorHalo'
import TitleBar from './components/TitleBar'
import { appViewTransition, fadeIn, spring } from './motion'
import { isFolioTheme, resolveInitialTheme } from './systemTheme'
import './App.css'

const PAGE_TOTAL_DEBOUNCE_MS = 500
const PAGE_TOTAL_STABILITY_MS = 6000
const STATUS_POLL_FAST_MS = 1000
const STATUS_POLL_IDLE_MS = 2500
const ACTIVE_MODEL_STATES = new Set(['download_queued', 'downloading', 'verifying'])
const APP_HEARTBEAT_ACTIVE_WORK_MS = 30_000
const APP_HEARTBEAT_THROTTLE_MS = 5_000
const BACKEND_RESTART_THROTTLE_MS = 5_000
const STARTUP_MINIMUM_MS = 480
const STARTUP_ASSET_TIMEOUT_MS = 2200

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number.parseFloat(String(value))
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

function statusHasActiveWork(status: TtsStatus | null): boolean {
  if (!status) return true
  const runtimes = Object.values(status.tts_engines || {})
  const models = Object.values(status.models || {})
  const activity = status.tts_activity
  return Boolean(
    status.model_loading ||
    activity?.active ||
    activity?.running?.length ||
    activity?.pending?.length ||
    runtimes.some((runtime) => runtime.model_loading || runtime.download_active) ||
    models.some((model) => model.download_active || ACTIVE_MODEL_STATES.has(model.state))
  )
}

export default function App() {
  const [theme, setTheme] = useState(() => {
    return resolveInitialTheme(
      localStorage.getItem('theme'),
      localStorage.getItem('darkMode'),
      window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false,
    )
  })
  const [motion, setMotion] = useState(() => localStorage.getItem('motion') !== 'false')
  const [wheelPaging, setWheelPaging] = useState(() => localStorage.getItem('wheelPaging') === 'true')
  const [sidebarTab, setSidebarTab] = useState(() => {
    const t = localStorage.getItem('sidebarTab')
    return t === 'null' || t === '' ? null : (t || null)
  })
  const [searchTarget, setSearchTarget] = useState<ReaderSearchTarget | null>(null)
  const [followAlongMode, setFollowAlongMode] = useState(false)
  const [hasSelectedReaderLine, setHasSelectedReaderLine] = useState(false)
  const [pageNavHidden, setPageNavHidden] = useState(false)
  const pageNavHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [gpuEnabled, setGpuEnabled] = useState<boolean | null>(null)
  const [backendReachable, setBackendReachable] = useState(false)
  const [modelLoaded, setModelLoaded] = useState(false)
  const [modelLoading, setModelLoading] = useState(false)
  const [ttsStatus, setTtsStatus] = useState<TtsStatus | null>(null)
  const [ttsEngineStatus, setTtsEngineStatus] = useState<Record<string, TtsRuntimeInfo>>({})
  const [modelStatus, setModelStatus] = useState<Record<string, ModelInstallInfo>>({})
  const [installPromptEngine, setInstallPromptEngine] = useState<string | null>(null)
  const [startupTimedOut, setStartupTimedOut] = useState(false)
  const [backendLaunchStarted, setBackendLaunchStarted] = useState(false)
  const [backendLaunchSettled, setBackendLaunchSettled] = useState(false)
  const [backendStartCommandFailed, setBackendStartCommandFailed] = useState(false)
  const [backendLogPath, setBackendLogPath] = useState<string | null>(null)
  const [interfaceReady, setInterfaceReady] = useState(false)
  const [pendingOpenFile, setPendingOpenFile] = useState<string | null>(null)
  const settingsHydrated = useRef(false)
  const setThemeFromUi = useCallback((nextTheme: string) => {
    if (isFolioTheme(nextTheme)) setTheme(nextTheme)
  }, [])

  useEffect(() => {
    let cancelled = false
    const startedAt = performance.now()
    const loadImage = (src: string) => new Promise<void>((resolve) => {
      const image = new Image()
      image.onload = () => resolve()
      image.onerror = () => resolve()
      image.src = src
      if (image.complete) resolve()
    })
    const assetWork = Promise.allSettled([
      document.fonts?.ready ?? Promise.resolve(),
      loadImage('/folio-icon.png'),
      loadImage('/folio-monochrome-icon.png'),
    ])
    const timeout = new Promise<void>((resolve) => {
      window.setTimeout(resolve, STARTUP_ASSET_TIMEOUT_MS)
    })

    void Promise.race([assetWork, timeout]).then(() => {
      const remaining = Math.max(0, STARTUP_MINIMUM_MS - (performance.now() - startedAt))
      window.setTimeout(() => {
        if (!cancelled) setInterfaceReady(true)
      }, remaining)
    })

    return () => { cancelled = true }
  }, [])

  const saveSetting = useCallback((key: string, value: unknown) => {
    if (!settingsHydrated.current) return
    localStorage.setItem(key, String(value))
    apiFetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [key]: value }),
    }).catch(() => {})
  }, [])

  useEffect(() => { saveSetting('theme', theme) }, [theme, saveSetting])
  useEffect(() => { saveSetting('motion', motion) }, [motion, saveSetting])
  useEffect(() => { saveSetting('wheelPaging', wheelPaging) }, [wheelPaging, saveSetting])
  useEffect(() => { saveSetting('sidebarTab', sidebarTab ?? '') }, [sidebarTab, saveSetting])

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const poll = async () => {
      if (cancelled) return
      let nextPollDelay = STATUS_POLL_FAST_MS
      try {
        const r = await apiFetch('/api/status')
        if (!r.ok) throw new Error(`Backend status failed (${r.status})`)
        const d = await r.json() as TtsStatus
        if (cancelled) return
        nextPollDelay = statusHasActiveWork(d) ? STATUS_POLL_FAST_MS : STATUS_POLL_IDLE_MS
        setBackendReachable(prev => prev || true)
        setGpuEnabled(prev => prev === d.gpu ? prev : d.gpu)
        setModelLoaded(prev => prev === d.model_loaded ? prev : d.model_loaded)
        setModelLoading(prev => prev === d.model_loading ? prev : d.model_loading)
        setTtsStatus(d)
        setTtsEngineStatus(d.tts_engines || {})
        setModelStatus(d.models || {})
      } catch {
        nextPollDelay = STATUS_POLL_FAST_MS
        if (!cancelled) {
          setBackendReachable(prev => prev ? false : prev)
          setModelLoaded(prev => prev ? false : prev)
          setModelLoading(prev => prev ? false : prev)
          setTtsStatus(null)
          setTtsEngineStatus({})
          setModelStatus({})
        }
      } finally {
        if (!cancelled) timer = setTimeout(poll, nextPollDelay)
      }
    }
    poll()
    setBackendLaunchStarted(true)
    startBackend()
      .then((started) => {
        if (started) sendAppHeartbeat()?.catch(() => {})
        if (!cancelled && !started && isTauriRuntime()) setBackendStartCommandFailed(true)
      })
      .catch(() => {
        if (!cancelled && isTauriRuntime()) setBackendStartCommandFailed(true)
      })
      .finally(() => {
        if (!cancelled) setBackendLaunchSettled(true)
      })
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [])

  useEffect(() => {
    getBackendLogPath().then(setBackendLogPath).catch(() => {})
  }, [])

  useEffect(() => {
    let unlisten: (() => void) | null = null
    let cancelled = false

    takePendingOpenFile().then((filepath) => {
      if (!cancelled && filepath) setPendingOpenFile(filepath)
    })

    listenForOpenFile((filepath) => {
      setPendingOpenFile(filepath)
    }).then((dispose) => {
      if (cancelled) dispose()
      else unlisten = dispose
    })

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  useEffect(() => {
    if (!isPreviewWatchdogEnabled()) return

    sendPreviewHeartbeat()?.catch(() => {})
    const heartbeat = window.setInterval(() => {
      sendPreviewHeartbeat()?.catch(() => {})
    }, 3000)

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        sendPreviewHeartbeat()?.catch(() => {})
      }
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.clearInterval(heartbeat)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])

  useEffect(() => {
    const timeoutTimer = setTimeout(() => setStartupTimedOut(true), 30000)
    return () => {
      clearTimeout(timeoutTimer)
    }
  }, [])

  const [reflow, setReflow] = useState<ReflowDocument | null>(null)
  const [reflowProgress, setReflowProgress] = useState<ReflowProgress | null>(null)
  const reflowNavRef = useRef<ReaderNavHandle>({})
  const [pageNavigation, setPageNavigation] = useState<ReaderPageNavigationState>({
    canGoPrevious: false,
    canGoNext: false,
  })
  const latestVisualPositionRef = useRef<Position | null>(null)
  const visualPageCountPersistRef = useRef<Record<string, number>>({})
  const visualPageCountTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const visualPageCountPendingRef = useRef<{ bookId: string; total: number; stable: boolean } | null>(null)

  const bookState = useBookState()
  const {
    book, pageData, currentPage, loading, textLoading, recentBooks, recentLoaded,
    openBook, uploadBook, goToPage, savePosition, applyBookSettings, addBookmark, removeBookmark, closeBook, deleteBook,
  } = bookState
  const activeBookId = book?.id ?? null

  useEffect(() => {
    setHasSelectedReaderLine(false)
    setPageNavigation({ canGoPrevious: false, canGoNext: false })
  }, [activeBookId])

  useEffect(() => {
    if (!pendingOpenFile || !backendReachable) return
    const filepath = pendingOpenFile
    setPendingOpenFile(null)
    openBook(filepath).catch((error) => {
      const message = error instanceof Error ? error.message : 'Could not open that book.'
      window.alert(message)
    })
  }, [backendReachable, openBook, pendingOpenFile])

  const audio = useAudioPlayback({ book, pageData, currentPage, goToPage, savePosition, applyBookSettings })
  const { setVolume: setAudioVolume, seekToSentence, stop: stopAudio } = audio
  const audioChunkProgressRef = useRef(0)
  const activeTtsStatus = ttsEngineStatus?.[audio.ttsEngine] || null
  const activeModelLoaded = activeTtsStatus?.model_loaded ?? modelLoaded
  const activeModelLoading = activeTtsStatus?.model_loading ?? modelLoading
  const activeGpuEnabled = activeTtsStatus?.selected_device
    ? activeTtsStatus.selected_device === 'cuda'
    : (String(activeTtsStatus?.selected_provider || '').toLowerCase().includes('cuda') || gpuEnabled)
  const activeRuntime = activeTtsStatus || ttsStatus?.tts_runtime || null
  const activeInstall = modelStatus?.[audio.ttsEngine] || null
  const startupReady = interfaceReady && backendReachable && (recentLoaded || startupTimedOut)
  const appLifecycleRef = useRef({
    backendReachable: false,
    busy: true,
    isGenerating: false,
    isPlaying: false,
  })
  const appLastHeartbeatRef = useRef(0)
  const backendRestartAttemptRef = useRef(0)

  useEffect(() => {
    audioChunkProgressRef.current = audio.chunkProgress || 0
  }, [audio.chunkProgress])

  useEffect(() => {
    appLifecycleRef.current = {
      backendReachable,
      busy: Boolean(loading || textLoading || !backendLaunchSettled || (backendReachable && statusHasActiveWork(ttsStatus))),
      isGenerating: audio.isGenerating,
      isPlaying: audio.isPlaying,
    }
  }, [audio.isGenerating, audio.isPlaying, backendLaunchSettled, backendReachable, loading, textLoading, ttsStatus])

  useEffect(() => {
    const sendHeartbeat = (force = false) => {
      const now = Date.now()
      if (!force && now - appLastHeartbeatRef.current < APP_HEARTBEAT_THROTTLE_MS) return
      appLastHeartbeatRef.current = now
      sendAppHeartbeat()?.catch(() => {})
    }

    const ensureBackendStarted = () => {
      const now = Date.now()
      if (!isTauriRuntime() || appLifecycleRef.current.backendReachable) return
      if (now - backendRestartAttemptRef.current < BACKEND_RESTART_THROTTLE_MS) return
      backendRestartAttemptRef.current = now
      startBackend()
        .then((started) => {
          if (started) sendHeartbeat(true)
        })
        .catch(() => {})
    }

    const markUiActivity = () => {
      if (document.visibilityState === 'hidden') return
      sendHeartbeat()
      ensureBackendStarted()
    }

    const activityEvents = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'focus']
    const listenerOptions: AddEventListenerOptions = { passive: true }
    activityEvents.forEach((eventName) => {
      window.addEventListener(eventName, markUiActivity, listenerOptions)
    })

    const activeWorkHeartbeat = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return
      const state = appLifecycleRef.current
      if (state.busy || state.isGenerating || state.isPlaying) {
        sendHeartbeat(true)
      }
    }, APP_HEARTBEAT_ACTIVE_WORK_MS)

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') markUiActivity()
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    markUiActivity()

    return () => {
      window.clearInterval(activeWorkHeartbeat)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      activityEvents.forEach((eventName) => {
        window.removeEventListener(eventName, markUiActivity, listenerOptions)
      })
    }
  }, [])

  useEffect(() => {
    const onModelRequired = (event: Event) => {
      const detail = (event as CustomEvent<{ engine?: string }>).detail
      setInstallPromptEngine(typeof detail?.engine === 'string' ? detail.engine : audio.ttsEngine)
      setSidebarTab('settings')
    }
    window.addEventListener('folio:model-required', onModelRequired as EventListener)
    return () => window.removeEventListener('folio:model-required', onModelRequired as EventListener)
  }, [audio.ttsEngine])

  // Fetch reflow JSON for the active EPUB.
  useEffect(() => {
    if (!activeBookId) {
      setReflow(null)
      setReflowProgress(null)
      return
    }
    const controller = new AbortController()
    setReflow(null)
    setReflowProgress(null)
    apiFetch(`/api/book/${activeBookId}/reflow`, { signal: controller.signal })
      .then(r => r.ok ? r.json() : null)
      .then((data: ReflowDocument | null) => { if (!controller.signal.aborted) setReflow(data) })
      .catch((error) => {
        if (!controller.signal.aborted && !(error instanceof DOMException && error.name === 'AbortError')) {
          setReflow(null)
        }
      })
    return () => controller.abort()
  }, [activeBookId])

  useEffect(() => {
    latestVisualPositionRef.current = book?.last_position || null
  }, [book?.last_position])

  const handleVisualPositionChange = useCallback((position: Position) => {
    latestVisualPositionRef.current = position
    Promise.resolve(savePosition(position)).catch(() => {})
  }, [savePosition])

  const flushCurrentVisualPosition = useCallback((keepalive = false) => {
    if (!activeBookId) return Promise.resolve()
    const livePosition = reflowNavRef.current?.getVisualPosition?.()
    const latest = livePosition || latestVisualPositionRef.current
    if (!latest) return Promise.resolve()
    const position = { ...latest, saved_at: Date.now() }
    latestVisualPositionRef.current = position
    return Promise.resolve(savePosition(position, 0, { keepalive })).catch(() => {})
  }, [activeBookId, savePosition])

  useEffect(() => {
    const flushKeepalive = () => flushCurrentVisualPosition(true)
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flushKeepalive()
    }

    window.addEventListener('beforeunload', flushKeepalive, { capture: true })
    window.addEventListener('pagehide', flushKeepalive, { capture: true })
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.removeEventListener('beforeunload', flushKeepalive, { capture: true })
      window.removeEventListener('pagehide', flushKeepalive, { capture: true })
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [flushCurrentVisualPosition])

  const setVolume = useCallback((v: unknown) => {
    const next = clampNumber(v, 0, 1, 1)
    setAudioVolume(next)
    saveSetting('volume', next)
  }, [setAudioVolume, saveSetting])

  // Snaps the view to the exact chapter + subPage the audio is currently
  // reading. Follow Along reuses this for continuous auto-follow.
  const jumpToReader = useCallback(() => {
    const p = audio.readingPage
    const s = audio.currentSentence
    if (p == null) return
    reflowNavRef.current?.goToReadingPosition?.(p, s, audioChunkProgressRef.current)
  }, [audio.readingPage, audio.currentSentence])

  const exitFollowAlong = useCallback(() => {
    setFollowAlongMode(false)
  }, [])

  const handlePageNavigationState = useCallback((next: ReaderPageNavigationState) => {
    setPageNavigation((prev) => (
      prev.canGoPrevious === next.canGoPrevious && prev.canGoNext === next.canGoNext
        ? prev
        : next
    ))
  }, [])

  const goToPreviousVisualPage = useCallback(() => {
    exitFollowAlong()
    reflowNavRef.current.goPrev?.()
  }, [exitFollowAlong])

  const goToNextVisualPage = useCallback(() => {
    exitFollowAlong()
    reflowNavRef.current.goNext?.()
  }, [exitFollowAlong])

  const toggleFollowAlong = useCallback(() => {
    if (followAlongMode) {
      setFollowAlongMode(false)
      return
    }
    setSidebarTab(null)
    setFollowAlongMode(true)
    requestAnimationFrame(jumpToReader)
  }, [followAlongMode, jumpToReader])

  const handleSidebarTab = useCallback((nextTab: string | null) => {
    if (nextTab) exitFollowAlong()
    setSidebarTab(nextTab)
  }, [exitFollowAlong])

  const goToPageFromUser = useCallback((page: number) => {
    flushCurrentVisualPosition()
    exitFollowAlong()
    setHasSelectedReaderLine(false)
    const result = goToPage(page)
    savePosition(page, 0)
    return result
  }, [exitFollowAlong, flushCurrentVisualPosition, goToPage, savePosition])

  const goToPageFromViewer = useCallback((page: number) => {
    if (!followAlongMode) flushCurrentVisualPosition()
    const result = goToPage(page)
    if (!followAlongMode) savePosition(page, 0)
    return result
  }, [flushCurrentVisualPosition, followAlongMode, goToPage, savePosition])

  const seekToSentenceFromUser = useCallback((page: number, sentence: number, options: { progress?: number } = {}) => {
    flushCurrentVisualPosition()
    setHasSelectedReaderLine(true)
    seekToSentence(page, sentence, options)
  }, [seekToSentence, flushCurrentVisualPosition])

  useEffect(() => {
    if (!followAlongMode) return
    setSidebarTab(null)
  }, [followAlongMode])

  useEffect(() => {
    if (!followAlongMode) return
    if (audio.readingPage == null) {
      setFollowAlongMode(false)
    }
  }, [followAlongMode, audio.readingPage])

  useEffect(() => {
    if (!followAlongMode) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setFollowAlongMode(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [followAlongMode])

  const revealPageNav = useCallback(() => {
    setPageNavHidden(false)
    if (pageNavHideTimerRef.current) {
      clearTimeout(pageNavHideTimerRef.current)
      pageNavHideTimerRef.current = null
    }
    if (followAlongMode && audio.isPlaying) {
      pageNavHideTimerRef.current = setTimeout(() => {
        setPageNavHidden(true)
      }, 2000)
    }
  }, [audio.isPlaying, followAlongMode])

  useEffect(() => {
    if (!followAlongMode || !audio.isPlaying) {
      setPageNavHidden(false)
      if (pageNavHideTimerRef.current) {
        clearTimeout(pageNavHideTimerRef.current)
        pageNavHideTimerRef.current = null
      }
      return
    }

    revealPageNav()
    const onActivity = () => revealPageNav()
    window.addEventListener('pointermove', onActivity, { passive: true })
    window.addEventListener('pointerdown', onActivity, { passive: true })
    window.addEventListener('keydown', onActivity)
    window.addEventListener('touchstart', onActivity, { passive: true })
    window.addEventListener('wheel', onActivity, { passive: true })
    return () => {
      window.removeEventListener('pointermove', onActivity)
      window.removeEventListener('pointerdown', onActivity)
      window.removeEventListener('keydown', onActivity)
      window.removeEventListener('touchstart', onActivity)
      window.removeEventListener('wheel', onActivity)
      if (pageNavHideTimerRef.current) {
        clearTimeout(pageNavHideTimerRef.current)
        pageNavHideTimerRef.current = null
      }
    }
  }, [audio.isPlaying, followAlongMode, revealPageNav])

  useEffect(() => {
    apiFetch('/api/settings')
      .then(r => r.ok ? r.json() : {})
      .then((s: GlobalSettings) => {
        if (isFolioTheme(s.theme)) { setTheme(s.theme); localStorage.setItem('theme', s.theme) }
        else if (s.darkMode !== undefined) { const t = s.darkMode ? 'dark' : 'sepia'; setTheme(t); localStorage.setItem('theme', t) }
        if (s.motion !== undefined) { setMotion(!!s.motion); localStorage.setItem('motion', String(!!s.motion)) }
        if (s.wheelPaging !== undefined) { setWheelPaging(!!s.wheelPaging); localStorage.setItem('wheelPaging', String(!!s.wheelPaging)) }
        if (s.sidebarTab !== undefined) {
          const t = typeof s.sidebarTab === 'string' && s.sidebarTab !== '' ? s.sidebarTab : null
          setSidebarTab(t); localStorage.setItem('sidebarTab', t ?? '')
        }
        if (s.volume !== undefined) {
          const v = clampNumber(s.volume, 0, 1, 1)
          audio.setVolume(v); localStorage.setItem('volume', String(v))
        }
      })
      .catch(() => {})
      .finally(() => { settingsHydrated.current = true })
  }, []) // eslint-disable-line

  const onHome = useCallback(() => {
    exitFollowAlong()
    stopAudio()
    void flushCurrentVisualPosition().finally(() => closeBook())
  }, [closeBook, exitFollowAlong, flushCurrentVisualPosition, stopAudio])

  const handleSearchNavigate = useCallback(async (result: SearchResult) => {
    if (!result || result.page == null) return

    flushCurrentVisualPosition()
    exitFollowAlong()
    setHasSelectedReaderLine(false)
    await goToPage(result.page)
    setSearchTarget({
      bookId: book?.id,
      page: result.page,
      sentenceIdx: result.sentence_idx ?? null,
      globalSentenceIdx: result.global_sentence_idx ?? null,
      nonce: `${result.page}:${result.sentence_idx ?? ''}:${result.global_sentence_idx ?? ''}:${Date.now()}`,
    })
  }, [book?.id, exitFollowAlong, flushCurrentVisualPosition, goToPage])

  const persistVisualPageCount = useCallback((bookId: string, visualPageCount: number) => {
    if (visualPageCountPersistRef.current[bookId] === visualPageCount) return
    visualPageCountPersistRef.current[bookId] = visualPageCount
    apiFetch(`/api/book/${bookId}/metadata`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visual_page_count: visualPageCount }),
    }).catch(() => {
      delete visualPageCountPersistRef.current[bookId]
    })
  }, [])

  const handleReflowProgress = useCallback((next: ReflowProgress) => {
    setReflowProgress((prev) => (
      prev?.current === next.current && prev?.total === next.total ? prev : next
    ))
    const visualPageCount = Math.max(1, Math.round(Number(next?.total || 0)))
    if (!activeBookId || visualPageCountPersistRef.current[activeBookId] === visualPageCount) return

    if (visualPageCountTimerRef.current) clearTimeout(visualPageCountTimerRef.current)
    const stable = Boolean(next?.stable || next?.allChaptersMeasured)
    visualPageCountPendingRef.current = { bookId: activeBookId, total: visualPageCount, stable }
    visualPageCountTimerRef.current = setTimeout(() => {
      const pending = visualPageCountPendingRef.current
      visualPageCountTimerRef.current = null
      visualPageCountPendingRef.current = null
      if (!pending) return
      persistVisualPageCount(pending.bookId, pending.total)
    }, stable ? PAGE_TOTAL_DEBOUNCE_MS : PAGE_TOTAL_STABILITY_MS)
  }, [activeBookId, persistVisualPageCount])

  useEffect(() => () => {
    if (visualPageCountTimerRef.current) clearTimeout(visualPageCountTimerRef.current)
  }, [])

  const appView = !book && !startupReady ? 'loading' : !book ? 'library' : 'reader'
  const previousAppViewRef = useRef(appView)
  const appTransition = useMemo(
    () => ({ from: previousAppViewRef.current, to: appView }),
    [appView],
  )

  useEffect(() => {
    previousAppViewRef.current = appView
  }, [appView])

  const renderReader = () => {
    if (!book) return null
    const progressCurrent = reflowProgress?.current ?? currentPage + 1
    const progressTotal = reflowProgress?.total ?? book.page_count
    const pageNavAutoHidden = followAlongMode && pageNavHidden
    const pageNavMotion = pageNavAutoHidden
      ? { opacity: 0, y: 80, scale: 0.96 }
      : { opacity: 1, y: 0, scale: 1 }

    return (
      <m.div
        key="reader"
        className="app-motion-view app-motion-reader"
        custom={{ ...appTransition, view: 'reader' }}
        variants={appViewTransition}
        initial="initial"
        animate="animate"
        exit="exit"
      >
        <div className={`app-shell theme-${theme} grain ${followAlongMode ? 'follow-along-active' : ''}`}>
          <TitleBar
            bookTitle={book.title}
            author={book.author}
            progress={{ current: progressCurrent, total: progressTotal }}
            gpuEnabled={activeGpuEnabled}
            followAlong={followAlongMode}
            onBookmark={() => addBookmark(currentPage, audio.currentSentence, `Page ${progressCurrent}`, progressCurrent)}
          />
          <CursorHalo motion={motion} disabled={followAlongMode} />
          <AnimatePresence>
            {loading && (
              <m.div className="loading-bar" variants={fadeIn} initial="initial" animate="animate" exit="exit" />
            )}
          </AnimatePresence>

          <m.div className="reader-shell" layout transition={spring.layout}>
              <Sidebar
                book={book}
                reflow={reflow}
                currentPage={currentPage}
                visualPageCurrent={progressCurrent}
                currentSentence={audio.currentSentence}
                goToPage={goToPageFromUser}
                addBookmark={addBookmark}
                removeBookmark={removeBookmark}
                voice={audio.voice}
                setVoice={audio.setVoice}
                ttsEngine={audio.ttsEngine}
                setTtsEngine={audio.setTtsEngine}
                modelStatus={modelStatus}
                installPromptEngine={installPromptEngine}
                clearInstallPrompt={() => setInstallPromptEngine(null)}
                theme={theme}
                setTheme={setThemeFromUi}
                motion={motion}
                setMotion={setMotion}
                wheelPaging={wheelPaging}
                setWheelPaging={setWheelPaging}
                tab={sidebarTab}
                setTab={handleSidebarTab}
                onNavigateSearchResult={handleSearchNavigate}
                onHome={onHome}
                hidden={followAlongMode}
              />

              <m.main className={`reader-main ${followAlongMode ? 'follow-along' : ''}`} layout transition={spring.layout}>
                {book.format === 'pdf' ? (
                  <PdfViewer
                    bookId={book.id}
                    pageIdx={currentPage}
                    pageCount={book.page_count}
                    setPageIdx={goToPageFromViewer}
                    pageText={pageData}
                    currentSentence={audio.currentSentence}
                    activePageIdx={audio.readingPage ?? currentPage}
                    isPlaying={audio.isPlaying}
                    onProgress={handleReflowProgress}
                    onNavigationState={handlePageNavigationState}
                    navRef={reflowNavRef}
                    searchTarget={searchTarget?.bookId === book?.id ? searchTarget : null}
                    onSentenceSelect={seekToSentenceFromUser}
                    onVisualPositionChange={handleVisualPositionChange}
                  />
                ) : (
                  <ReflowViewer
                    bookId={book.id}
                    reflow={reflow}
                    chapterIdx={currentPage}
                    setChapterIdx={goToPageFromViewer}
                    runningHead={book.title}
                    currentSentence={audio.currentSentence}
                    activeChapterIdx={audio.readingPage ?? currentPage}
                    chunkProgress={audio.chunkProgress}
                    isPlaying={audio.isPlaying}
                    onProgress={handleReflowProgress}
                    onNavigationState={handlePageNavigationState}
                    navRef={reflowNavRef}
                    motion={motion}
                    wheelPaging={followAlongMode ? false : wheelPaging}
                    searchTarget={searchTarget?.bookId === book?.id ? searchTarget : null}
                    followAlongMode={followAlongMode}
                    onSentenceSelect={seekToSentenceFromUser}
                    theme={theme}
                    resumePosition={book.last_position}
                    onVisualPositionChange={handleVisualPositionChange}
                  />
                )}

                <div
                  className={`page-nav-reveal-zone ${followAlongMode && pageNavHidden ? 'active' : ''}`}
                  onPointerEnter={revealPageNav}
                  onPointerMove={revealPageNav}
                />
                <m.button
                  layout
                  transition={spring.quick}
                  whileHover={{ y: -1, scale: 1.03 }}
                  whileTap={{ scale: 0.97 }}
                  className={`page-nav prev ${followAlongMode ? 'follow-mode' : ''} ${pageNavHidden ? 'auto-hidden' : ''}`}
                  animate={pageNavMotion}
                  style={{ pointerEvents: pageNavAutoHidden ? 'none' : undefined }}
                  aria-hidden={pageNavAutoHidden || undefined}
                  onPointerEnter={revealPageNav}
                  onFocus={revealPageNav}
                  aria-label="Previous page"
                  title="Previous page"
                  disabled={!pageNavigation.canGoPrevious}
                  onClick={goToPreviousVisualPage}
                >
                  <Icons.ChevronLeft size={18} />
                </m.button>
                <m.button
                  layout
                  transition={spring.quick}
                  whileHover={{ y: -1, scale: 1.03 }}
                  whileTap={{ scale: 0.97 }}
                  className={`page-nav next ${followAlongMode ? 'follow-mode' : ''} ${pageNavHidden ? 'auto-hidden' : ''}`}
                  animate={pageNavMotion}
                  style={{ pointerEvents: pageNavAutoHidden ? 'none' : undefined }}
                  aria-hidden={pageNavAutoHidden || undefined}
                  onPointerEnter={revealPageNav}
                  onFocus={revealPageNav}
                  aria-label="Next page"
                  title="Next page"
                  disabled={!pageNavigation.canGoNext}
                  onClick={goToNextVisualPage}
                >
                  <Icons.ChevronRight size={18} />
                </m.button>
              </m.main>
          </m.div>

            <Pill
              isPlaying={audio.isPlaying}
              isGenerating={audio.isGenerating}
              generationError={audio.generationError}
              textLoading={textLoading}
              modelLoaded={activeModelLoaded}
              modelLoading={activeModelLoading}
              installState={activeInstall}
              downloadActive={!!activeTtsStatus?.download_active}
              downloadBytes={activeTtsStatus?.download_bytes ?? 0}
              downloadTotalBytes={activeTtsStatus?.download_total_bytes ?? 0}
              engineFallbackReason={activeTtsStatus?.fallback_reason ?? null}
              engineLoadError={activeTtsStatus?.last_load_error ?? null}
              engineRuntime={activeRuntime}
              ttsActivity={ttsStatus?.tts_activity ?? null}
              bufferState={audio.bufferState}
              play={audio.play}
              pause={audio.pause}
              stop={audio.stop}
              skipSentence={audio.skipSentence}
              currentPage={currentPage}
              pageCount={book.page_count}
              goToPage={goToPageFromUser}
              goToPreviousPage={goToPreviousVisualPage}
              goToNextPage={goToNextVisualPage}
              canGoPreviousPage={pageNavigation.canGoPrevious}
              canGoNextPage={pageNavigation.canGoNext}
              visualPageCurrent={progressCurrent}
              visualPageTotal={progressTotal}
              speed={audio.speed}
              setSpeed={audio.setSpeed}
              volume={audio.volume}
              setVolume={setVolume}
              ttsEngine={audio.ttsEngine}
              voice={audio.voice}
              currentSentence={audio.currentSentence}
              sentenceCount={audio.readingSentenceCount || pageData?.sentences?.length || 0}
              subscribeAudioSpectrum={audio.subscribeAudioSpectrum}
              playRequiresLineSelection={!audio.isPlaying && audio.readingPage == null && !hasSelectedReaderLine}
              sleepTimer={audio.sleepTimer}
              setSleepTimer={audio.setSleepTimer}
              preloadState={audio.preloadState}
              preloadChapter={audio.preloadChapter}
              readingPage={audio.readingPage}
              followAlongMode={followAlongMode}
              toggleFollowAlong={toggleFollowAlong}
              book={book}
            />
        </div>
      </m.div>
    )
  }

  const appContent = appView === 'loading' ? (
    <m.div
      key="loading"
      className="app-motion-view app-motion-loading"
      custom={{ ...appTransition, view: 'loading' }}
      variants={appViewTransition}
      initial="initial"
      animate="animate"
      exit="exit"
    >
      <LoadingScreen
        theme={theme}
        motion={motion}
        backendLaunchStarted={backendLaunchStarted}
        backendLaunchSettled={backendLaunchSettled}
        backendReachable={backendReachable}
        recentLoaded={recentLoaded}
        recentBooks={recentBooks}
        interfaceReady={interfaceReady}
        activeRuntime={activeRuntime}
        activeModelLoaded={activeModelLoaded}
        activeModelLoading={activeModelLoading}
        timedOut={startupTimedOut}
        backendStartCommandFailed={backendStartCommandFailed}
        backendLogPath={backendLogPath}
        onOpenBackendLog={openBackendLog}
      />
    </m.div>
  ) : appView === 'library' ? (
    <m.div
      key="library"
      className="app-motion-view app-motion-library"
      custom={{ ...appTransition, view: 'library' }}
      variants={appViewTransition}
      initial="initial"
      animate="animate"
      exit="exit"
    >
      <div className={`app-shell app-enter theme-${theme} grain`}>
        <TitleBar />
        <CursorHalo motion={motion} />
        <Welcome
            theme={theme}
            setTheme={setThemeFromUi}
            motion={motion}
            setMotion={setMotion}
            onUpload={uploadBook}
            recentBooks={recentBooks}
            onOpenRecent={openBook}
            onDeleteRecent={deleteBook}
            settingsPanelProps={{
              wheelPaging,
              setWheelPaging,
              voice: audio.voice,
              setVoice: audio.setVoice,
              ttsEngine: audio.ttsEngine,
              setTtsEngine: audio.setTtsEngine,
              modelStatus,
              installPromptEngine,
              clearInstallPrompt: () => setInstallPromptEngine(null),
            }}
        />
      </div>
    </m.div>
  ) : renderReader()

  return (
    <MotionConfig reducedMotion={motion ? 'user' : 'always'} transition={spring.quick}>
      <div className={`app-transition-stage theme-${theme} ${motion ? 'motion-enabled' : 'motion-reduced'}`}>
        <AnimatePresence mode="sync" initial={false}>
          {appContent}
        </AnimatePresence>
      </div>
    </MotionConfig>
  )
}
