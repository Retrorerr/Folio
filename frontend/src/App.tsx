import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import type { GlobalSettings, SearchResult, TtsRuntimeInfo, TtsStatus } from './types'
import useBookState from './hooks/useBookState'
import useAudioPlayback from './hooks/useAudioPlayback'
import Welcome from './components/Welcome'
import LoadingScreen from './components/LoadingScreen'
import ReflowViewer from './components/ReflowViewer'
import Pill from './components/Pill'
import Sidebar from './components/Sidebar'
import { Icons } from './components/icons'
import { apiFetch } from './api'
import CursorHalo from './components/CursorHalo'
import TitleBar from './components/TitleBar'
import './App.css'

const THEMES = ['sepia', 'light', 'dark', 'folio']

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
  const [highlightStyle, setHighlightStyle] = useState(() => localStorage.getItem('highlightStyle') || 'dim')
  const [sidebarTab, setSidebarTab] = useState(() => {
    const t = localStorage.getItem('sidebarTab')
    return t === 'null' || t === '' ? null : (t || null)
  })
  const [searchTarget, setSearchTarget] = useState<any>(null)
  const [followAlongMode, setFollowAlongMode] = useState(false)

  const [gpuEnabled, setGpuEnabled] = useState<boolean | null>(null)
  const [backendReachable, setBackendReachable] = useState(false)
  const [modelLoaded, setModelLoaded] = useState(false)
  const [modelLoading, setModelLoading] = useState(false)
  const [ttsStatus, setTtsStatus] = useState<TtsStatus | null>(null)
  const [ttsEngineStatus, setTtsEngineStatus] = useState<Record<string, TtsRuntimeInfo>>({})
  const [startupMinElapsed, setStartupMinElapsed] = useState(false)
  const [startupTimedOut, setStartupTimedOut] = useState(false)
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
  useEffect(() => { saveSetting('highlightStyle', highlightStyle) }, [highlightStyle, saveSetting])
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
      } catch {
        if (!cancelled) {
          setBackendReachable(false)
          setModelLoaded(false)
          setModelLoading(false)
          setTtsStatus(null)
          setTtsEngineStatus({})
        }
      } finally {
        if (!cancelled) timer = setTimeout(poll, 1000)
      }
    }
    poll()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
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

  const bookState = useBookState()
  const {
    book, pageData, currentPage, loading, textLoading, recentBooks, recentLoaded,
    openBook, uploadBook, goToPage, savePosition, addBookmark, removeBookmark, closeBook, deleteBook,
  } = bookState

  const audio = useAudioPlayback({ book, pageData, currentPage, goToPage, savePosition })
  const { setVolume: setAudioVolume, seekToSentence } = audio
  const activeTtsStatus = ttsEngineStatus?.[audio.ttsEngine] || null
  const activeModelLoaded = audio.ttsEngine === 'chatterbox-turbo'
    ? (activeTtsStatus?.model_loaded ?? false)
    : (activeTtsStatus?.model_loaded ?? modelLoaded)
  const activeModelLoading = activeTtsStatus?.model_loading ?? modelLoading
  const activeGpuEnabled = audio.ttsEngine === 'chatterbox-turbo'
    ? (activeTtsStatus?.selected_device ? activeTtsStatus.selected_device === 'cuda' : null)
    : gpuEnabled
  const activeRuntime = activeTtsStatus || ttsStatus?.tts_runtime || null
  const startupLoadFailed = Boolean(activeRuntime?.last_load_error)
  const startupModelSettled = activeModelLoaded || startupLoadFailed || startupTimedOut
  const startupReady = backendReachable && recentLoaded && startupModelSettled && startupMinElapsed

  // Fetch reflow JSON for the active EPUB.
  useEffect(() => {
    if (!book) return
    let cancelled = false
    setReflow(null)
    setReflowProgress(null)
    apiFetch(`/api/book/${book.id}/reflow`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled) setReflow(d) })
      .catch(() => { if (!cancelled) setReflow(null) })
    return () => { cancelled = true }
  }, [book])

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
    reflowNavRef.current?.goToSentence?.(p, s)
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
    exitFollowAlong()
    return goToPage(page)
  }, [exitFollowAlong, goToPage])

  const seekToSentenceFromUser = useCallback((page: number, sentence: number) => {
    exitFollowAlong()
    seekToSentence(page, sentence)
  }, [seekToSentence, exitFollowAlong])

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

  // Page-turn animation overlay
  const [turning, setTurning] = useState<'next' | 'prev' | null>(null)
  const turnTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const triggerTurn = useCallback((direction: 'next' | 'prev') => {
    if (!motion) return
    setTurning(direction)
    if (turnTimeoutRef.current) clearTimeout(turnTimeoutRef.current)
    turnTimeoutRef.current = setTimeout(() => setTurning(null), 720)
  }, [motion])
  useEffect(() => {
    apiFetch('/api/settings')
      .then(r => r.ok ? r.json() : {})
      .then((s: GlobalSettings) => {
        if (typeof s.theme === 'string' && THEMES.includes(s.theme)) { setTheme(s.theme); localStorage.setItem('theme', s.theme) }
        else if (s.darkMode !== undefined) { const t = s.darkMode ? 'dark' : 'sepia'; setTheme(t); localStorage.setItem('theme', t) }
        if (s.motion !== undefined) { setMotion(!!s.motion); localStorage.setItem('motion', String(!!s.motion)) }
        if (s.wheelPaging !== undefined) { setWheelPaging(!!s.wheelPaging); localStorage.setItem('wheelPaging', String(!!s.wheelPaging)) }
        if (typeof s.highlightStyle === 'string') { setHighlightStyle(s.highlightStyle); localStorage.setItem('highlightStyle', s.highlightStyle) }
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
    audio.stop()
    closeBook()
  }, [audio.stop, closeBook, exitFollowAlong])

  const handleSearchNavigate = useCallback(async (result: SearchResult) => {
    if (!result || result.page == null) return

    exitFollowAlong()
    await goToPage(result.page)
    setSearchTarget({
      bookId: book?.id,
      page: result.page,
      sentenceIdx: result.sentence_idx ?? null,
      globalSentenceIdx: result.global_sentence_idx ?? null,
      nonce: `${result.page}:${result.sentence_idx ?? ''}:${result.global_sentence_idx ?? ''}:${Date.now()}`,
    })
  }, [book?.id, exitFollowAlong, goToPage])

  const handleReflowProgress = useCallback((next: { current: number; total: number }) => {
    setReflowProgress((prev: any) => (
      prev?.current === next.current && prev?.total === next.total ? prev : next
    ))
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

  if (!book && !startupReady) {
    return (
      <LoadingScreen
        theme={theme}
        status={ttsStatus}
        backendReachable={backendReachable}
        recentLoaded={recentLoaded}
        recentBooks={recentBooks}
        activeRuntime={activeRuntime}
        activeModelLoaded={activeModelLoaded}
        activeModelLoading={activeModelLoading}
        timedOut={startupTimedOut}
      />
    )
  }

  if (!book) {
    return (
      <div className={`app-shell app-enter theme-${theme} grain`}>
        <TitleBar />
        <CursorHalo motion={motion} />
        <Welcome
          onUpload={uploadBook}
          recentBooks={recentBooks}
          onOpenRecent={openBook}
          onDeleteRecent={deleteBook}
          statusBadges={statusBadges}
        />
      </div>
    )
  }

  return (
    <div className={`app-shell theme-${theme} grain ${followAlongMode ? 'follow-along-active' : ''}`}>
      <TitleBar />
      <CursorHalo motion={motion} disabled={followAlongMode} />
      {loading && <div className="loading-bar" />}

      <div className="reader-shell">
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
          speed={audio.speed}
          theme={theme}
          setTheme={setTheme}
          motion={motion}
          setMotion={setMotion}
          wheelPaging={wheelPaging}
          setWheelPaging={setWheelPaging}
          highlightStyle={highlightStyle}
          setHighlightStyle={setHighlightStyle}
          tab={sidebarTab}
          setTab={handleSidebarTab}
          onNavigateSearchResult={handleSearchNavigate}
          onHome={onHome}
          hidden={followAlongMode}
        />

        <div className={`reader-main ${followAlongMode ? 'follow-along' : ''}`}>
          <div className="reader-topbar">
            <div className="topbar-title">
              <span className="t">{book.title}</span>
              {book.author && <><span className="dot" /><span className="a">{book.author}</span></>}
            </div>

            <div className="reading-progress">
              {(() => {
                const cur = reflowProgress?.current ?? currentPage + 1
                const tot = reflowProgress?.total ?? book.page_count
                const pct = tot ? (cur / tot) * 100 : 0
                return (
                  <>
                    <div className="bar"><div className="fill" style={{ width: `${pct}%` }} /></div>
                    <div className="lbl">
                      <span>P. {cur} / {tot}</span>
                      <span>{Math.round(pct)}%</span>
                    </div>
                  </>
                )
              })()}
            </div>

            <div className="topbar-actions">
              {activeGpuEnabled !== null && activeGpuEnabled !== undefined && (
                <span className={`gpu-badge small ${activeGpuEnabled ? 'gpu-on' : 'gpu-off'}`}>
                  {activeGpuEnabled ? 'GPU' : 'CPU'}
                </span>
              )}
              <button
                className="icon-btn"
                onClick={() => addBookmark(currentPage, audio.currentSentence, `Page ${currentPage + 1}`)}
                title="Add bookmark"
              ><Icons.Bookmark size={17} /></button>
            </div>
          </div>

          <ReflowViewer
            reflow={reflow}
            chapterIdx={currentPage}
            setChapterIdx={goToPage}
            runningHead={book.title}
            currentSentence={audio.currentSentence}
            activeChapterIdx={audio.readingPage ?? currentPage}
            chunkProgress={audio.chunkProgress}
            isPlaying={audio.isPlaying}
            onProgress={handleReflowProgress}
            navRef={reflowNavRef}
            onPageTurn={triggerTurn}
            pageTurn={turning}
            motion={motion}
            wheelPaging={followAlongMode ? false : wheelPaging}
            searchTarget={searchTarget?.bookId === book?.id ? searchTarget : null}
            followAlongMode={followAlongMode}
            onSentenceSelect={seekToSentenceFromUser}
          />

          <button
            className="page-nav prev"
            onClick={() => { exitFollowAlong(); reflowNavRef.current.goPrev?.() }}
          >
            <Icons.ChevronLeft size={18} />
          </button>
          <button
            className="page-nav next"
            onClick={() => { exitFollowAlong(); reflowNavRef.current.goNext?.() }}
          >
            <Icons.ChevronRight size={18} />
          </button>
        </div>
      </div>

      <Pill
        isPlaying={audio.isPlaying}
        isGenerating={audio.isGenerating}
        generationError={audio.generationError}
        textLoading={textLoading}
        modelLoaded={activeModelLoaded}
        modelLoading={activeModelLoading}
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
  )
}
