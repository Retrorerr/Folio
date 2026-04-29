import { useState, useEffect, useRef, useCallback } from 'react'
import useBookState from './hooks/useBookState'
import useAudioPlayback from './hooks/useAudioPlayback'
import Welcome from './components/Welcome'
import PdfViewer from './components/PdfViewer'
import ReflowViewer from './components/ReflowViewer'
import Pill from './components/Pill'
import Sidebar from './components/Sidebar'
import { Icons } from './components/icons'
import { apiFetch } from './api'
import './App.css'

const THEMES = ['sepia', 'light', 'dark']

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
  const [zoom, setZoom] = useState(() => parseFloat(localStorage.getItem('zoom') ?? '1'))
  const [searchTarget, setSearchTarget] = useState(null)
  const [followAlongMode, setFollowAlongMode] = useState(false)

  const [gpuEnabled, setGpuEnabled] = useState(null)
  const [modelLoaded, setModelLoaded] = useState(false)
  const [modelLoading, setModelLoading] = useState(false)
  const settingsHydrated = useRef(false)

  const saveSetting = useCallback((key, value) => {
    if (!settingsHydrated.current) return
    localStorage.setItem(key, value)
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
  useEffect(() => { saveSetting('zoom', zoom) }, [zoom, saveSetting])
  useEffect(() => { saveSetting('sidebarTab', sidebarTab ?? '') }, [sidebarTab, saveSetting])

  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      try {
        const r = await apiFetch('/api/status')
        const d = await r.json()
        setGpuEnabled(d.gpu)
        setModelLoaded(d.model_loaded)
        setModelLoading(d.model_loading)
      } catch {
        // Ignore transient backend startup failures while polling status.
      } finally {
        if (!cancelled) setTimeout(poll, 2000)
      }
    }
    poll()
    return () => { cancelled = true }
  }, [])

  const [reflow, setReflow] = useState(null)
  const [reflowProgress, setReflowProgress] = useState(null) // {current, total}
  const reflowNavRef = useRef({})

  const bookState = useBookState()
  const {
    book, pageData, pageImageUrl, facingPageImageUrl, facingPageNum, currentPage, loading, textLoading, recentBooks,
    openBook, uploadBook, goToPage, savePosition, addBookmark, removeBookmark, closeBook, deleteBook,
  } = bookState
  const isEpub = book?.format === 'epub'

  const audio = useAudioPlayback({ book, pageData, currentPage, goToPage, savePosition })

  // Fetch reflow JSON for EPUB books
  useEffect(() => {
    if (!isEpub) return
    let cancelled = false
    apiFetch(`/api/book/${book.id}/reflow`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled) setReflow(d) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [book?.id, isEpub])

  const setVolume = (v) => {
    audio.setVolume(v)
    saveSetting('volume', v)
  }

  // Snaps the view to the exact chapter + subPage (or PDF page) the audio is
  // currently reading. Follow Along reuses this for continuous auto-follow.
  const jumpToReader = useCallback(() => {
    const p = audio.readingPage
    const s = audio.currentSentence
    if (p == null) return
    if (book?.format === 'epub') {
      reflowNavRef.current?.goToSentence?.(p, s)
    } else if (p !== currentPage) {
      goToPage(p)
    }
  }, [audio.readingPage, audio.currentSentence, book?.format, currentPage, goToPage])

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

  const handleSidebarTab = useCallback((nextTab) => {
    if (nextTab) exitFollowAlong()
    setSidebarTab(nextTab)
  }, [exitFollowAlong])

  const goToPageFromUser = useCallback((page) => {
    exitFollowAlong()
    return goToPage(page)
  }, [exitFollowAlong, goToPage])

  const seekToSentenceFromUser = useCallback((page, sentence) => {
    exitFollowAlong()
    audio.seekToSentence(page, sentence)
  }, [audio, exitFollowAlong])

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
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setFollowAlongMode(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [followAlongMode])

  // Page-turn animation overlay
  const [turning, setTurning] = useState(null)
  const turnTimeoutRef = useRef(null)
  const triggerTurn = useCallback((direction) => {
    if (!motion) return
    setTurning(direction)
    clearTimeout(turnTimeoutRef.current)
    turnTimeoutRef.current = setTimeout(() => setTurning(null), 720)
  }, [motion])
  const lastPageRef = useRef(currentPage)
  useEffect(() => {
    const prev = lastPageRef.current
    if (prev !== currentPage) {
      // For PDFs this drives the animation; for EPUBs the ReflowViewer
      // triggers triggerTurn directly (so within-chapter flips animate too).
      if (book?.format !== 'epub') {
        const direction = currentPage > prev ? 'next' : 'prev'
        requestAnimationFrame(() => triggerTurn(direction))
      }
      lastPageRef.current = currentPage
    }
  }, [currentPage, book?.format, triggerTurn])

  useEffect(() => {
    if (isEpub) return
    setReflow(null)
    setReflowProgress(null)
  }, [isEpub])

  useEffect(() => {
    apiFetch('/api/settings')
      .then(r => r.ok ? r.json() : {})
      .then(s => {
        if (s.theme !== undefined && THEMES.includes(s.theme)) { setTheme(s.theme); localStorage.setItem('theme', s.theme) }
        else if (s.darkMode !== undefined) { const t = s.darkMode ? 'dark' : 'sepia'; setTheme(t); localStorage.setItem('theme', t) }
        if (s.motion !== undefined) { setMotion(!!s.motion); localStorage.setItem('motion', !!s.motion) }
        if (s.wheelPaging !== undefined) { setWheelPaging(!!s.wheelPaging); localStorage.setItem('wheelPaging', !!s.wheelPaging) }
        if (s.highlightStyle !== undefined) { setHighlightStyle(s.highlightStyle); localStorage.setItem('highlightStyle', s.highlightStyle) }
        if (s.zoom !== undefined) { setZoom(s.zoom); localStorage.setItem('zoom', s.zoom) }
        if (s.sidebarTab !== undefined) {
          const t = s.sidebarTab === '' ? null : s.sidebarTab
          setSidebarTab(t); localStorage.setItem('sidebarTab', t ?? '')
        }
        if (s.volume !== undefined) { audio.setVolume(s.volume); localStorage.setItem('volume', s.volume) }
      })
      .catch(() => {})
      .finally(() => { settingsHydrated.current = true })
  }, []) // eslint-disable-line

  const onHome = () => {
    exitFollowAlong()
    audio.stop()
    closeBook()
  }

  const handleSearchNavigate = useCallback(async (result) => {
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

  const statusBadges = (
    <>
      {gpuEnabled !== null && (
        <span className={`gpu-badge ${gpuEnabled ? 'gpu-on' : 'gpu-off'}`}>
          {gpuEnabled ? 'GPU Accelerated' : 'CPU Mode'}
        </span>
      )}
    </>
  )

  if (!book) {
    return (
      <div className={`app-shell theme-${theme} grain`}>
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
                const isEpub = book.format === 'epub' && reflowProgress
                const cur = isEpub ? reflowProgress.current : currentPage + 1
                const tot = isEpub ? reflowProgress.total : book.page_count
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
              {gpuEnabled !== null && (
                <span className={`gpu-badge small ${gpuEnabled ? 'gpu-on' : 'gpu-off'}`}>
                  {gpuEnabled ? 'GPU' : 'CPU'}
                </span>
              )}
              <button
                className="icon-btn"
                onClick={() => addBookmark(currentPage, audio.currentSentence, `Page ${currentPage + 1}`)}
                title="Add bookmark"
              ><Icons.Bookmark size={17} /></button>
              <button className="icon-btn" onClick={onHome} title="Close book">
                <Icons.X size={17} />
              </button>
            </div>
          </div>

          {book.format === 'epub' ? (
            <ReflowViewer
              reflow={reflow}
              chapterIdx={currentPage}
              setChapterIdx={goToPage}
              runningHead={book.title}
              currentSentence={audio.currentSentence}
              activeChapterIdx={audio.readingPage ?? currentPage}
              onProgress={setReflowProgress}
              navRef={reflowNavRef}
              onPageTurn={triggerTurn}
              pageTurn={turning}
              motion={motion}
              wheelPaging={followAlongMode ? false : wheelPaging}
              searchTarget={searchTarget?.bookId === book?.id ? searchTarget : null}
              followAlongMode={followAlongMode}
              onSentenceSelect={seekToSentenceFromUser}
            />
          ) : (
            <PdfViewer
              pageImageUrl={pageImageUrl}
              facingPageImageUrl={facingPageImageUrl}
              facingPageNum={facingPageNum}
              pageData={pageData}
              currentSentence={audio.currentSentence}
              currentWordIdx={audio.currentWordIdx}
              activePage={audio.readingPage ?? currentPage}
              currentPage={currentPage}
              pageCount={book.page_count}
              zoom={zoom}
              setZoom={setZoom}
              highlightStyle={highlightStyle}
              searchTarget={searchTarget?.bookId === book?.id ? searchTarget : null}
              followAlongMode={followAlongMode}
              onSentenceSelect={seekToSentenceFromUser}
            />
          )}

          {motion && turning && book.format !== 'epub' && (
            <>
              <div className={`flipper flipper-${turning}`} style={{ pointerEvents: 'none' }}>
                <div className="flip-face flip-front"><div className="flip-face-inner" /><div className="flip-shade flip-shade-front" /></div>
                <div className="flip-face flip-back"><div className="flip-face-inner" /><div className="flip-shade flip-shade-back" /></div>
              </div>
              <div className={`flip-cast flip-cast-${turning}`} />
            </>
          )}

          <button
            className="page-nav prev"
            onClick={() => book.format === 'epub'
              ? (exitFollowAlong(), reflowNavRef.current.goPrev?.())
              : goToPageFromUser(Math.max(0, currentPage - 2))}
            disabled={book.format !== 'epub' && currentPage <= 0}
          >
            <Icons.ChevronLeft size={18} />
          </button>
          <button
            className="page-nav next"
            onClick={() => book.format === 'epub'
              ? (exitFollowAlong(), reflowNavRef.current.goNext?.())
              : goToPageFromUser(Math.min(book.page_count - 1, currentPage + 2))}
            disabled={book.format !== 'epub' && currentPage >= book.page_count - 1}
          >
            <Icons.ChevronRight size={18} />
          </button>
        </div>
      </div>

      <Pill
        isPlaying={audio.isPlaying}
        isGenerating={audio.isGenerating}
        textLoading={textLoading}
        modelLoaded={modelLoaded}
        modelLoading={modelLoading}
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
