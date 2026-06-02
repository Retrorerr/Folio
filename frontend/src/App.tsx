import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { AnimatePresence, MotionConfig, motion as m } from 'motion/react'
import type { GlobalSettings, ModelInstallInfo, Position, SearchResult, TtsRuntimeInfo, TtsStatus } from './types'
import useBookState from './hooks/useBookState'
import useAudioPlayback from './hooks/useAudioPlayback'
import Welcome from './components/Welcome'
import LoadingScreen from './components/LoadingScreen'
import ReflowViewer from './components/ReflowViewer'
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
  sendPreviewHeartbeat,
  startBackend,
  stopBackend,
  takePendingOpenFile,
} from './api'
import CursorHalo from './components/CursorHalo'
import TitleBar from './components/TitleBar'
import { fadeIn, pageTransition, spring } from './motion'
import './App.css'

const THEMES = ['sepia', 'light', 'dark', 'folio']
const PAGE_TOTAL_DEBOUNCE_MS = 500
const PAGE_TOTAL_STABILITY_MS = 6000

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number.parseFloat(String(value))
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

export default function App() {
  const [theme, setTheme] = useState(() => {
    const t = localStorage.getItem('theme')
    if (THEMES.includes(t)) return t
    return localStorage.getItem('darkMode') === 'true' ? 'dark' : 'sepia'
  })
  const [motion, setMotion] = useState(() => localStorage.getItem('motion') !== 'false')
  const [wheelPaging, setWheelPaging] = useState(() => localStorage.getItem('wheelPaging') === 'true')
  const [sidebarTab, setSidebarTab] = useState(() => {
    const t = localStorage.getItem('sidebarTab')
    return t === 'null' || t === '' ? null : (t || null)
  })
  const [searchTarget, setSearchTarget] = useState<any>(null)
  const [followAlongMode, setFollowAlongMode] = useState(false)
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
  const [startupMinElapsed, setStartupMinElapsed] = useState(false)
  const [startupTimedOut, setStartupTimedOut] = useState(false)
  const [backendStartCommandFailed, setBackendStartCommandFailed] = useState(false)
  const [backendLogPath, setBackendLogPath] = useState<string | null>(null)
  const [pendingOpenFile, setPendingOpenFile] = useState<string | null>(null)
  const settingsHydrated = useRef(false)

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
      try {
        const r = await apiFetch('/api/status')
        const d = await r.json() as TtsStatus
        if (cancelled) return
        setBackendReachable(true)
        setGpuEnabled(d.gpu)
        setModelLoaded(d.model_loaded)
        setModelLoading(d.model_loading)
        setTtsStatus(d)
        setTtsEngineStatus(d.tts_engines || {})
        setModelStatus(d.models || {})
      } catch {
        if (!cancelled) {
          setBackendReachable(false)
          setModelLoaded(false)
          setModelLoading(false)
          setTtsStatus(null)
          setTtsEngineStatus({})
          setModelStatus({})
        }
      } finally {
        if (!cancelled) timer = setTimeout(poll, 1000)
      }
    }
    startBackend()
      .then((started) => {
        if (!started && isTauriRuntime()) setBackendStartCommandFailed(true)
      })
      .catch(() => {
        if (isTauriRuntime()) setBackendStartCommandFailed(true)
      })
      .finally(poll)
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
    const onBeforeUnload = () => {
      if (isTauriRuntime()) stopBackend().catch(() => {})
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
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
    const minTimer = setTimeout(() => setStartupMinElapsed(true), 1400)
    const timeoutTimer = setTimeout(() => setStartupTimedOut(true), 30000)
    return () => {
      clearTimeout(minTimer)
      clearTimeout(timeoutTimer)
    }
  }, [])

  const [reflow, setReflow] = useState<any>(null)
  const [reflowProgress, setReflowProgress] = useState<any>(null) // {current, total}
  const reflowNavRef = useRef<any>({})
  const latestVisualPositionRef = useRef<Position | null>(null)
  const visualPageCountPersistRef = useRef<Record<string, number>>({})
  const visualPageCountTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const visualPageCountPendingRef = useRef<{ bookId: string; total: number; stable: boolean } | null>(null)

  const bookState = useBookState()
  const {
    book, pageData, currentPage, loading, textLoading, recentBooks, recentLoaded,
    openBook, uploadBook, goToPage, savePosition, addBookmark, removeBookmark, closeBook, deleteBook,
  } = bookState
  const activeBookId = book?.id ?? null

  useEffect(() => {
    if (!pendingOpenFile || !backendReachable) return
    const filepath = pendingOpenFile
    setPendingOpenFile(null)
    openBook(filepath).catch((error) => {
      const message = error instanceof Error ? error.message : 'Could not open that EPUB.'
      window.alert(message)
    })
  }, [backendReachable, openBook, pendingOpenFile])

  const audio = useAudioPlayback({ book, pageData, currentPage, goToPage, savePosition })
  const { setVolume: setAudioVolume, seekToSentence, stop: stopAudio } = audio
  const audioChunkProgressRef = useRef(0)
  const activeTtsStatus = ttsEngineStatus?.[audio.ttsEngine] || null
  const activeModelLoaded = audio.ttsEngine === 'chatterbox-turbo'
    ? (activeTtsStatus?.model_loaded ?? false)
    : (activeTtsStatus?.model_loaded ?? modelLoaded)
  const activeModelLoading = activeTtsStatus?.model_loading ?? modelLoading
  const activeGpuEnabled = audio.ttsEngine === 'chatterbox-turbo'
    ? (activeTtsStatus?.selected_device ? activeTtsStatus.selected_device === 'cuda' : null)
    : gpuEnabled
  const activeRuntime = activeTtsStatus || ttsStatus?.tts_runtime || null
  const activeInstall = modelStatus?.[audio.ttsEngine] || null
  const startupReady = backendReachable && startupMinElapsed && (recentLoaded || startupTimedOut)

  useEffect(() => {
    audioChunkProgressRef.current = audio.chunkProgress || 0
  }, [audio.chunkProgress])

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
    let cancelled = false
    setReflow(null)
    setReflowProgress(null)
    apiFetch(`/api/book/${activeBookId}/reflow`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled) setReflow(d) })
      .catch(() => { if (!cancelled) setReflow(null) })
    return () => { cancelled = true }
  }, [activeBookId])

  useEffect(() => {
    latestVisualPositionRef.current = book?.last_position || null
  }, [activeBookId]) // eslint-disable-line react-hooks/exhaustive-deps

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
    const result = goToPage(page)
    savePosition(page, 0)
    return result
  }, [exitFollowAlong, flushCurrentVisualPosition, goToPage, savePosition])

  const seekToSentenceFromUser = useCallback((page: number, sentence: number, options: any = {}) => {
    flushCurrentVisualPosition()
    seekToSentence(page, sentence, options)
  }, [seekToSentence, flushCurrentVisualPosition])

  useEffect(() => {
    if (!followAlongMode) return
    setSidebarTab(null)
  }, [followAlongMode])

  useEffect(() => {
    if (!followAlongMode) return
    if (!audio.isPlaying) {
      setFollowAlongMode(false)
      return
    }
    jumpToReader()
  }, [followAlongMode, audio.isPlaying, audio.readingPage, audio.currentSentence, jumpToReader])

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
    window.addEventListener('mousemove', onActivity, { passive: true })
    window.addEventListener('keydown', onActivity)
    window.addEventListener('touchstart', onActivity, { passive: true })
    window.addEventListener('wheel', onActivity, { passive: true })
    return () => {
      window.removeEventListener('mousemove', onActivity)
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
        if (typeof s.theme === 'string' && THEMES.includes(s.theme)) { setTheme(s.theme); localStorage.setItem('theme', s.theme) }
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

  const handleReflowProgress = useCallback((next: { current: number; total: number; stable?: boolean; allChaptersMeasured?: boolean }) => {
    setReflowProgress((prev: any) => (
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

  const statusBadges = useMemo(() => (
    <>
      <span className={`gpu-badge ${backendReachable ? 'gpu-on' : 'gpu-off'}`}>
        {backendReachable ? 'Backend Ready' : 'Starting Backend'}
      </span>
      {backendReachable && activeModelLoading && (
        <span className="gpu-badge">Voice Model Loading</span>
      )}
      {backendReachable && activeModelLoaded && (
        <span className="gpu-badge gpu-on">Voice Model Ready</span>
      )}
      {activeGpuEnabled !== null && activeGpuEnabled !== undefined && (
        <span className={`gpu-badge ${activeGpuEnabled ? 'gpu-on' : 'gpu-off'}`}>
          {activeGpuEnabled ? 'GPU Accelerated' : 'CPU Mode'}
        </span>
      )}
    </>
  ), [backendReachable, activeModelLoading, activeModelLoaded, activeGpuEnabled])

  const appView = !book && !startupReady ? 'loading' : !book ? 'library' : 'reader'

  const renderReader = () => {
    if (!book) return null
    const progressCurrent = reflowProgress?.current ?? currentPage + 1
    const progressTotal = reflowProgress?.total ?? book.page_count

    return (
      <m.div key="reader" className="app-motion-view" variants={pageTransition} initial="initial" animate="animate" exit="exit">
        <div className={`app-shell theme-${theme} grain ${followAlongMode ? 'follow-along-active' : ''}`}>
          <TitleBar
            bookTitle={book.title}
            author={book.author}
            progress={{ current: progressCurrent, total: progressTotal }}
            gpuEnabled={activeGpuEnabled}
            followAlong={followAlongMode}
            onBookmark={() => addBookmark(currentPage, audio.currentSentence, `Page ${currentPage + 1}`)}
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
              speed={audio.speed}
              theme={theme}
              setTheme={setTheme}
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

            <m.div className={`reader-main ${followAlongMode ? 'follow-along' : ''}`} layout transition={spring.layout}>
              <ReflowViewer
                bookId={book.id}
                reflow={reflow}
                chapterIdx={currentPage}
                setChapterIdx={goToPageFromUser}
                runningHead={book.title}
                currentSentence={audio.currentSentence}
                activeChapterIdx={audio.readingPage ?? currentPage}
                chunkProgress={audio.chunkProgress}
                isPlaying={audio.isPlaying}
                onProgress={handleReflowProgress}
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
                onPointerEnter={revealPageNav}
                onFocus={revealPageNav}
                onClick={() => { exitFollowAlong(); reflowNavRef.current.goPrev?.() }}
              >
                <Icons.ChevronLeft size={18} />
              </m.button>
              <m.button
                layout
                transition={spring.quick}
                whileHover={{ y: -1, scale: 1.03 }}
                whileTap={{ scale: 0.97 }}
                className={`page-nav next ${followAlongMode ? 'follow-mode' : ''} ${pageNavHidden ? 'auto-hidden' : ''}`}
                onPointerEnter={revealPageNav}
                onFocus={revealPageNav}
                onClick={() => { exitFollowAlong(); reflowNavRef.current.goNext?.() }}
              >
                <Icons.ChevronRight size={18} />
              </m.button>
            </m.div>
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
            play={audio.play}
            pause={audio.pause}
            stop={audio.stop}
            skipSentence={audio.skipSentence}
            currentPage={currentPage}
            pageCount={book.page_count}
            goToPage={goToPageFromUser}
            speed={audio.speed}
            setSpeed={audio.setSpeed}
            volume={audio.volume}
            setVolume={setVolume}
            ttsEngine={audio.ttsEngine}
            voice={audio.voice}
            currentSentence={audio.currentSentence}
            sentenceCount={pageData?.sentences?.length || 0}
            pageData={pageData}
            sleepTimer={audio.sleepTimer}
            setSleepTimer={audio.setSleepTimer}
            preloadState={audio.preloadState}
            preloadChapter={audio.preloadChapter}
            readingPage={audio.readingPage}
            jumpToReader={jumpToReader}
            followAlongMode={followAlongMode}
            toggleFollowAlong={toggleFollowAlong}
            book={book}
          />
        </div>
      </m.div>
    )
  }

  const appContent = appView === 'loading' ? (
    <m.div key="loading" className="app-motion-view" variants={pageTransition} initial="initial" animate="animate" exit="exit">
      <LoadingScreen
        theme={theme}
        motion={motion}
        status={ttsStatus}
        backendReachable={backendReachable}
        recentLoaded={recentLoaded}
        recentBooks={recentBooks}
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
    <m.div key="library" className="app-motion-view" variants={pageTransition} initial="initial" animate="animate" exit="exit">
      <div className={`app-shell app-enter theme-${theme} grain`}>
        <TitleBar />
        <CursorHalo motion={motion} />
        <Welcome
          theme={theme}
          setTheme={setTheme}
          motion={motion}
          setMotion={setMotion}
          onUpload={uploadBook}
          recentBooks={recentBooks}
          onOpenRecent={openBook}
          onDeleteRecent={deleteBook}
          statusBadges={statusBadges}
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
      <AnimatePresence mode="wait" initial={false}>
        {appContent}
      </AnimatePresence>
    </MotionConfig>
  )
}
