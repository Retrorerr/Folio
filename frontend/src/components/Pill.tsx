import { useState, useEffect, useMemo, useRef, useCallback, memo } from 'react'
import type React from 'react'
import { AnimatePresence, motion as m } from 'motion/react'
import { Icons } from './icons'
import { apiResourceUrl } from '../api'
import {
  buttonHover,
  buttonTap,
  controlsReveal,
  fadeIn,
  pillContentContinuity,
  pillControlHover,
  pillControlTap,
  pillMorph,
  pillShellSlowTransition,
  pillShellTransition,
  spring,
} from '../motion'

const BARS = 64
const SPEEDS = [0.75, 0.85, 0.95, 1, 1.1, 1.2, 1.35]

function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec))
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export default memo(function Pill({
  isPlaying, isGenerating, textLoading, modelLoaded, modelLoading,
  installState = null,
  downloadActive = false, downloadBytes = 0, downloadTotalBytes = 0,
  engineFallbackReason = null, engineLoadError = null,
  generationError,
  play, pause, stop, skipSentence,
  currentPage, pageCount, goToPage,
  speed, setSpeed, volume, setVolume,
  ttsEngine = 'kokoro',
  voice,
  currentSentence, sentenceCount, pageData,
  sleepTimer, setSleepTimer,
  preloadState,
  preloadChapter,
  readingPage,
  jumpToReader,
  followAlongMode = false,
  toggleFollowAlong,
  book,
}: any) {
  // Show Follow Along whenever the user has a position to follow — once you've
  // started a book you can re-enter immersive mode at will, even from pause.
  // The button morphs (compact vs prominent) based on isPlaying so the most
  // useful action for the current state is the larger target.
  const showFollowAlong = readingPage != null && toggleFollowAlong
  const [expanded, setExpanded] = useState(false)
  // Render-state machine: separates the layout (defines pill geometry) from
  // the leaving tree, which is held mounted as an overlay during the morph
  // so the user never sees an empty shell. Values:
  //   'collapsed' | 'expanded' (steady)
  //   'expanding' | 'collapsing' (during morph: BOTH trees mounted)
  const [pillMotion, setPillMotion] = useState('')
  const [pulse, setPulse] = useState(0)
  const [controlsHidden, setControlsHidden] = useState(false)
  const pillRef = useRef<HTMLDivElement | null>(null)
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pillMotionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const PILL_MORPH_MS = pillMorph.ms
  const setExpandedWithMotion = useCallback((next) => {
    if (pillMotionTimerRef.current) clearTimeout(pillMotionTimerRef.current)
    setPillMotion(next ? 'expanding' : 'collapsing')
    setExpanded(next)
    const slow = typeof window !== 'undefined' && (
      window.__SLOWPILL__ || (typeof location !== 'undefined' && /[?&]slowpill=1/.test(location.search))
    )
    pillMotionTimerRef.current = setTimeout(() => setPillMotion(''), PILL_MORPH_MS * (slow ? pillMorph.slowScale : 1))
  }, [])

  // Optional slow-mo via ?slowpill=1 in the URL (or window.__SLOWPILL__).
  // CSS and Motion both read this so the morph can be studied by eye without
  // rebuilding.
  const slowMo = typeof window !== 'undefined' && (
    window.__SLOWPILL__ || (typeof location !== 'undefined' && /[?&]slowpill=1/.test(location.search))
  )

  const revealControls = useCallback(() => {
    setControlsHidden(false)
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    if (followAlongMode && isPlaying) {
      hideTimerRef.current = setTimeout(() => setControlsHidden(true), 2000)
    }
  }, [followAlongMode, isPlaying])

  const handleKeyDown = useCallback((e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return
    switch (e.code) {
      case 'Space':
        e.preventDefault()
        if (isPlaying) pause()
        else play()
        break
      case 'ArrowRight':
        e.preventDefault()
        skipSentence(1)
        break
      case 'ArrowLeft':
        e.preventDefault()
        skipSentence(-1)
        break
      case 'PageDown':
        e.preventDefault()
        goToPage(currentPage + 1)
        break
      case 'PageUp':
        e.preventDefault()
        goToPage(currentPage - 1)
        break
    }
  }, [isPlaying, play, pause, skipSentence, goToPage, currentPage])

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  useEffect(() => () => {
    if (pillMotionTimerRef.current) clearTimeout(pillMotionTimerRef.current)
  }, [])

  useEffect(() => {
    if (!expanded) return
    const onDown = (e) => {
      if (pillRef.current && !pillRef.current.contains(e.target)) setExpandedWithMotion(false)
    }
    const onKey = (e) => { if (e.key === 'Escape') setExpandedWithMotion(false) }
    const t = setTimeout(() => {
      document.addEventListener('mousedown', onDown)
      document.addEventListener('keydown', onKey)
    }, 0)
    return () => {
      clearTimeout(t)
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [expanded, setExpandedWithMotion])

  useEffect(() => {
    if (!isPlaying) return
    const id = setInterval(() => setPulse((p) => p + 1), 200)
    return () => clearInterval(id)
  }, [isPlaying])

  useEffect(() => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    const resetTimer = setTimeout(() => setControlsHidden(false), 0)
    if (!followAlongMode || !isPlaying) return () => clearTimeout(resetTimer)

    const onActivity = () => revealControls()
    window.addEventListener('pointermove', onActivity, { passive: true })
    window.addEventListener('keydown', onActivity)
    hideTimerRef.current = setTimeout(() => setControlsHidden(true), 2000)

    return () => {
      clearTimeout(resetTimer)
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
      window.removeEventListener('pointermove', onActivity)
      window.removeEventListener('keydown', onActivity)
    }
  }, [followAlongMode, isPlaying, revealControls])

  const heights = useMemo(() => (
    Array.from({ length: BARS }).map((_, i) => {
      const a = Math.sin(i * 0.4) * 0.5 + 0.5
      const b = Math.sin(i * 0.19 + 1.2) * 0.3 + 0.5
      return Math.max(0.08, Math.min(1, a * 0.6 + b * 0.4))
    })
  ), [])

  // Progress across current page
  const progress = sentenceCount > 0 ? Math.min(1, (currentSentence + 1) / sentenceCount) : 0
  const currentIndex = Math.floor(progress * BARS)

  // Book-wide progress for timeline
  const bookProgress = pageCount > 0 ? (currentPage + progress) / pageCount : 0
  const totalMinsEstimate = pageCount * 2
  const elapsedMins = bookProgress * totalMinsEstimate

  // Teleprompter text — show prev / current / next sentence
  const sToText = (s) => s?.words?.map(w => w.text).join(' ') || ''
  const sentenceList = pageData?.sentences || []
  const currentText = sToText(sentenceList[currentSentence])
  const prevText = sToText(sentenceList[currentSentence - 1])
  const nextText = sToText(sentenceList[currentSentence + 1])

  const togglePlay = () => {
    if (isPlaying) pause()
    else play()
  }
  const SLEEP_STOPS = [null, 5, 15, 30, 60]
  const cycleSleep = () => {
    const cur = sleepTimer === null ? null : Math.ceil(sleepTimer)
    const i = SLEEP_STOPS.findIndex(s => s === cur)
    setSleepTimer(SLEEP_STOPS[(i + 1) % SLEEP_STOPS.length])
  }
  const sleepMinutes = sleepTimer !== null ? Math.ceil(sleepTimer) : null

  // Sleep timer ring math — track full circle, fill shows remaining time
  const sleepMaxFor = (mins) => {
    if (mins == null) return 60
    if (mins <= 5) return 5
    if (mins <= 15) return 15
    if (mins <= 30) return 30
    return 60
  }
  const sleepRingMax = sleepMaxFor(sleepMinutes)
  const sleepRingPct = sleepMinutes != null ? Math.min(1, sleepMinutes / sleepRingMax) : 0

  // Speed slider — snap to discrete stops on commit, but allow smooth drag
  const SPEED_MIN = 0.75
  const SPEED_MAX = 1.35
  const speedPct = ((speed - SPEED_MIN) / (SPEED_MAX - SPEED_MIN)) * 100
  const onSpeedDrag = (e) => {
    const v = parseFloat(e.target.value)
    setSpeed(v)
  }
  const onSpeedCommit = (e) => {
    // Snap to nearest preset on release for tactile feedback
    const v = parseFloat(e.target.value)
    let nearest = SPEEDS[0]
    let best = Infinity
    for (const s of SPEEDS) {
      const d = Math.abs(s - v)
      if (d < best) { best = d; nearest = s }
    }
    setSpeed(nearest)
  }

  const volumePct = Math.round(volume * 100)

  const statusLabel = () => {
    if (generationError) return generationError
    if (installState && !installState.ready) {
      if (installState.state === 'failed') return installState.error || `${ttsEngine === 'chatterbox-turbo' ? 'Chatterbox' : 'Kokoro'} install failed`
      if (installState.state === 'download_queued' || installState.state === 'downloading') {
        const total = installState.total_bytes > 0 ? installState.total_bytes : 1
        const pct = Math.min(99, Math.max(1, Math.round(((installState.downloaded_bytes || 0) / total) * 100)))
        return `Downloading ${ttsEngine === 'chatterbox-turbo' ? 'Chatterbox' : 'Kokoro'}… ${pct}%`
      }
      if (installState.state === 'verifying') return `Verifying ${ttsEngine === 'chatterbox-turbo' ? 'Chatterbox' : 'Kokoro'}…`
      return `${ttsEngine === 'chatterbox-turbo' ? 'Chatterbox' : 'Kokoro'} not installed`
    }
    // Engine-level load failure (memory pressure, missing dep, etc.) wins
    // over the generic generationError so the user gets the real reason.
    if (engineLoadError && ttsEngine === 'chatterbox-turbo' && !modelLoaded) {
      return engineLoadError
    }
    if (ttsEngine === 'chatterbox-turbo') {
      if (downloadActive) {
        const total = downloadTotalBytes > 0 ? downloadTotalBytes : 1
        const pct = Math.min(99, Math.max(0, Math.round((downloadBytes / total) * 100)))
        const mb = (downloadBytes / (1024 * 1024)).toFixed(0)
        const totalMb = (total / (1024 * 1024)).toFixed(0)
        return `Downloading Chatterbox… ${pct}% · ${mb}/${totalMb} MB`
      }
      if (modelLoading) return 'Loading Chatterbox…'
      if (isGenerating) return 'Generating audio…'
      // CPU-mode advisory once the model is ready — sticky in the subtitle so
      // the user understands why playback is slow before they assume it's broken.
      if (modelLoaded && engineFallbackReason && !isPlaying) {
        return engineFallbackReason
      }
    } else if (!modelLoaded) {
      return modelLoading ? 'Loading model…' : 'Model not ready'
    }
    if (textLoading) return 'Extracting text (OCR)…'
    if (isGenerating) return 'Generating audio…'
    if (sentenceCount === 0) return 'No text on this page'
    return null
  }
  const status = statusLabel()

  // Chapter preload state feeds the reader pill controls and subtitle line.
  const pl = preloadState || { state: 'idle', ready: 0, total: 0 }
  const plPct = pl.total > 0 ? Math.round((pl.ready / pl.total) * 100) : 0
  const preloadProgress = pl.total > 0 ? Math.max(0, Math.min(1, pl.ready / pl.total)) : 0
  const plFailed = pl.failed?.length || 0
  const plBusy = pl.state === 'verifying' || pl.state === 'preloading'
  const plActive = plBusy
  const plReady = pl.state === 'ready'
  const preloadLabel =
    pl.state === 'verifying' ? 'Verifying cache…'
    : pl.state === 'preloading' ? `Preloading ${plPct}% · ${pl.ready}/${pl.total}`
    : pl.state === 'error' ? `${plFailed || 'Some'} failed`
    : 'Ready to read'
  // r=20 in a 48×48 viewBox so the ring hugs the 40px play button
  const preloadButtonLabel =
    pl.state === 'verifying' ? 'Checking cache...'
    : pl.state === 'preloading' ? `Preloading ${plPct}% - ${pl.ready}/${pl.total}`
    : pl.state === 'ready' ? 'Chapter preloaded'
    : pl.state === 'error' ? 'Retry preload chapter'
    : pl.total > 0 && pl.ready > 0 ? `Preload chapter - ${pl.ready}/${pl.total} cached`
    : 'Preload chapter'
  const preloadShortLabel =
    pl.state === 'verifying' ? 'Check'
    : pl.state === 'preloading' ? `${plPct}%`
    : pl.state === 'ready' ? 'Ready'
    : pl.state === 'error' ? 'Retry'
    : 'Preload'

  const handlePreload = (e) => {
    e.stopPropagation()
    if (!plBusy) preloadChapter?.()
  }

  const primaryClick = () => {
    if (installState && !installState.ready && !modelLoaded) {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('folio:model-required', { detail: { engine: ttsEngine, install: installState } }))
      }
      return
    }
    togglePlay()
  }

  const coverUrl = book?.cover_url ? apiResourceUrl(book.cover_url) : null
  const coverStyle = coverUrl
    ? { backgroundImage: `url("${coverUrl}")` } as React.CSSProperties
    : undefined
  const coverClass = `pill-cover ${coverUrl ? 'has-real-cover' : ''} ${isPlaying && !coverUrl ? 'rotating' : ''}`

  const metaLine = plActive
    ? preloadLabel
    : (status || `${ttsEngine === 'chatterbox-turbo' ? 'CHATTERBOX' : 'KOKORO'} · ${voice?.toUpperCase?.() || ''} · PAGE ${currentPage + 1}/${pageCount}`)

  // Render both content trees during the morph so the pill is never empty.
  // The arriving tree drives layout (.pill grows/shrinks to fit it); the
  // leaving tree is absolutely positioned over the same area, fading out.
  const showCollapsed = !expanded || pillMotion === 'expanding'
  const showExpanded  =  expanded || pillMotion === 'collapsing'
  const collapsedClass = pillMotion === 'expanding'
    ? 'is-leaving'
    : (pillMotion === 'collapsing' ? 'is-arriving' : '')
  const expandedClass = pillMotion === 'collapsing'
    ? 'is-leaving'
    : (pillMotion === 'expanding' ? 'is-arriving' : '')

  return (
    <>
    <div
      className={`pill-reveal-zone ${followAlongMode && controlsHidden ? 'active' : ''}`}
      onPointerEnter={revealControls}
      onPointerMove={revealControls}
    />
    <m.div
      className={`pill-wrap ${followAlongMode ? 'follow-mode' : ''} ${controlsHidden ? 'auto-hidden' : ''}`}
      onPointerEnter={revealControls}
      onFocusCapture={revealControls}
    >
      <m.div
        ref={pillRef}
        className={`pill ${expanded ? 'expanded' : 'collapsed'} ${(isPlaying || isGenerating || textLoading || modelLoading || downloadActive) ? 'is-active' : ''} ${pillMotion} ${slowMo ? 'pill-slowmo' : ''}`}
        onClick={() => { if (!expanded) setExpandedWithMotion(true) }}
        layout
        transition={slowMo ? pillShellSlowTransition : pillShellTransition}
      >
        <AnimatePresence initial={false}>
        {showCollapsed && (
          <m.div
            key="pill-collapsed"
            className={`pill-content-layer pill-collapsed-content ${collapsedClass}`}
            aria-hidden={collapsedClass === 'is-leaving'}
            custom={{ state: collapsedClass, slow: slowMo }}
            variants={pillContentContinuity}
            initial="initial"
            animate="animate"
            exit="exit"
          >
            <div className="pill-now-group">
              <div className={coverClass} style={coverStyle}>
                {!coverUrl && <span className="pill-cover-title">{book?.title || 'Folio'}</span>}
              </div>
              <div className="pill-meta">
                <div className="t">{book?.title || 'Kokoro Reader'}</div>
                <div className={`a ${plActive ? `preload-meta preload-meta-${pl.state}` : ''}`}>{metaLine}</div>
              </div>

              <div className="pill-waveform">
                {heights.slice(0, 28).map((h, i) => {
                  const live = isPlaying ? (0.7 + 0.3 * Math.sin((pulse + i) * 0.7)) : 1
                  const passed = (i / 28) < progress
                  return (
                    <div
                      key={i}
                      className="wave-bar"
                      style={{ height: `${h * live * 100}%`, opacity: passed ? 1 : 0.28 }}
                    />
                  )
                })}
              </div>
            </div>

            <div className="pill-controls" onClick={(e) => e.stopPropagation()}>
              {/* Transport cluster — fixed-width and never reflows so the
                  play button stays put when prep buttons morph. */}
              <div className="pill-controls-transport">
                <m.button className="pill-btn" onClick={() => skipSentence(-1)} title="Previous sentence (Left arrow)" whileHover={buttonHover} whileTap={buttonTap}>
                  <Icons.Rewind size={16} />
                </m.button>
                <m.button
                  className={`pill-btn play ${isPlaying ? 'is-playing' : ''}`}
                  onClick={primaryClick}
                  title="Play/Pause (Space)"
                  whileTap={buttonTap}
                >
                  {isPlaying ? <Icons.Pause size={18} /> : <Icons.Play size={18} />}
                </m.button>
                <m.button className="pill-btn" onClick={() => skipSentence(1)} title="Next sentence (Right arrow)" whileHover={buttonHover} whileTap={buttonTap}>
                  <Icons.Forward size={16} />
                </m.button>
              </div>
              {/* Prep cluster — reserves width for the wider variant so morphing
                  preload ↔ follow-along never shifts the transport buttons. */}
              <div className={`pill-controls-prep ${isPlaying ? 'state-playing' : 'state-paused'}`}>
                <span className="pill-divider" aria-hidden="true" />
                <m.button
                  className={`pill-preload-control preload-${pl.state} ${isPlaying ? 'is-compact' : 'is-prominent'}`}
                  onClick={handlePreload}
                  disabled={plBusy || plReady}
                  title={preloadButtonLabel}
                  aria-label={preloadButtonLabel}
                  style={{ '--preload-progress': preloadProgress } as React.CSSProperties}
                  layout="position"
                  transition={spring.pillControl}
                  whileHover={pillControlHover}
                  whileTap={pillControlTap}
                >
                  <span className="preload-icon" aria-hidden="true">
                    <Icons.Download size={14} />
                  </span>
                  <span className="preload-short-label">{preloadShortLabel}</span>
                </m.button>
                {/* Always render follow-along so the prep cluster's width is
                    stable. Before the user has ever pressed play (no reading
                    position yet), it's hidden via .is-stub but still occupies
                    space — keeps the play button anchored from the very first
                    render. */}
                <m.button
                  className={`pill-btn follow-along-btn ${followAlongMode ? 'active' : ''} ${followAlongMode && isPlaying ? 'is-live' : ''} ${isPlaying ? 'is-prominent' : 'is-compact'} ${!showFollowAlong ? 'is-stub' : ''}`}
                  onClick={(e) => { e.stopPropagation(); if (!showFollowAlong) return; toggleFollowAlong(); if (!followAlongMode) jumpToReader?.() }}
                  disabled={!showFollowAlong}
                  title={followAlongMode ? 'Exit Follow Along' : 'Follow Along'}
                  aria-label={followAlongMode ? 'Exit Follow Along' : 'Enter Follow Along'}
                  aria-pressed={followAlongMode}
                  aria-hidden={!showFollowAlong}
                  tabIndex={!showFollowAlong ? -1 : 0}
                  layout="position"
                  transition={spring.pillControl}
                  whileHover={pillControlHover}
                  whileTap={pillControlTap}
                >
                  <span className="follow-status-mark" aria-hidden="true">
                    <span className="live-dot" />
                  </span>
                  <span className="live-label">{followAlongMode ? 'Following' : 'Follow Along'}</span>
                </m.button>
                <m.button className="pill-btn pill-expand-btn" onClick={(e) => { e.stopPropagation(); setExpandedWithMotion(true) }} title="Expand" whileTap={buttonTap}>
                  <Icons.ChevronDown size={16} style={{ transform: 'rotate(180deg)' }} />
                </m.button>
              </div>
            </div>
          </m.div>
        )}
        {showExpanded && (
          <m.div
            key="pill-expanded"
            className={`pill-content-layer pill-expanded-content ${expandedClass}`}
            aria-hidden={expandedClass === 'is-leaving'}
            custom={{ state: expandedClass, slow: slowMo }}
            variants={pillContentContinuity}
            initial="initial"
            animate="animate"
            exit="exit"
          >
            <div className="pill-expanded-head">
              <div className={coverClass} style={coverStyle}>
                {!coverUrl && <span className="pill-cover-title">{book?.title || 'Folio'}</span>}
              </div>
              <div className="meta">
                <div className={`eyebrow ${plActive ? `preload-meta preload-meta-${pl.state}` : ''}`}>
                  {plActive ? preloadLabel.toUpperCase() : (status ? status.toUpperCase() : `NOW PLAYING · PAGE ${currentPage + 1} OF ${pageCount}`)}
                </div>
                <h3>{book?.title || 'Kokoro Reader'}</h3>
                <div className="a">{book?.author ? `by ${book.author}` : ''}{voice ? ` · read by ${voice}` : ''}</div>
              </div>
              <m.button className="collapse-btn" onClick={(e) => { e.stopPropagation(); setExpandedWithMotion(false) }} whileTap={buttonTap}>
                <Icons.ChevronDown size={18} />
              </m.button>
            </div>

            <div className="tele-stack">
              <div className="tele-line tele-prev">{prevText || ''}</div>
              <AnimatePresence mode="wait">
                <m.div className={`tele-line tele-now ${!currentText ? 'tele-empty' : ''}`} key={currentSentence} variants={fadeIn} initial="initial" animate="animate" exit="exit">
                  {currentText || (isPlaying ? '' : (status || ''))}
                </m.div>
              </AnimatePresence>
              <div className="tele-line tele-next">{nextText || ''}</div>
            </div>

            <div>
              <div className="pill-wave-lg">
                {heights.map((h, i) => {
                  const passed = i <= currentIndex
                  const live = isPlaying && passed ? (0.7 + 0.3 * Math.sin((pulse + i) * 0.5)) : 1
                  return (
                    <div
                      key={i}
                      className={`wave-bar-lg ${passed ? 'passed' : 'future'}`}
                      style={{ height: `${h * live * 100}%` }}
                    />
                  )
                })}
              </div>
              <div className="pill-timeline">
                <span className="current">{fmtTime(elapsedMins * 60)}</span>
                <span>Sentence {sentenceCount ? currentSentence + 1 : 0} / {sentenceCount}</span>
                <span>-{fmtTime((totalMinsEstimate - elapsedMins) * 60)}</span>
              </div>
            </div>

            <m.div className="pill-expanded-controls" layout>
              <button className="pill-btn" onClick={() => goToPage(currentPage - 1)} disabled={currentPage <= 0} title="Previous page">
                <Icons.SkipBack size={18} />
              </button>
              <button className="pill-btn" onClick={() => skipSentence(-1)} title="Previous sentence">
                <Icons.Rewind size={18} />
              </button>
              <button
                className={`pill-btn play ${isPlaying ? 'is-playing' : ''}`}
                onClick={primaryClick}
                title="Play/Pause"
              >
                {isPlaying ? <Icons.Pause size={22} /> : <Icons.Play size={22} />}
              </button>
              <button className="pill-btn" onClick={() => skipSentence(1)} title="Next sentence">
                <Icons.Forward size={18} />
              </button>
              <button className="pill-btn" onClick={() => goToPage(currentPage + 1)} disabled={currentPage >= pageCount - 1} title="Next page">
                <Icons.SkipForward size={18} />
              </button>
              <AnimatePresence>
              {showFollowAlong && (
                <m.button
                  className={`pill-btn follow-along-btn ${followAlongMode ? 'active' : ''} ${followAlongMode && isPlaying ? 'is-live' : ''}`}
                  onClick={(e) => { e.stopPropagation(); toggleFollowAlong(); if (!followAlongMode) jumpToReader?.() }}
                  title={followAlongMode ? 'Exit Follow Along' : 'Follow Along'}
                  aria-label={followAlongMode ? 'Exit Follow Along' : 'Enter Follow Along'}
                  aria-pressed={followAlongMode}
                  variants={controlsReveal}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                  layout
                  transition={spring.pillControl}
                  whileHover={pillControlHover}
                  whileTap={pillControlTap}
                >
                  <span className="follow-status-mark" aria-hidden="true">
                    <span className="live-dot" />
                  </span>
                  <span className="live-label">{followAlongMode ? 'Following' : 'Follow Along'}</span>
                </m.button>
              )}
              </AnimatePresence>
              <button className="pill-btn" onClick={stop} title="Stop">
                <Icons.Stop size={16} />
              </button>
            </m.div>

            <div className="pill-secondary-row" onClick={(e) => e.stopPropagation()}>
              {/* Page tile — current page + visual progress */}
              <div className="pill-tile tile-page">
                <div className="tile-head">
                  <span className="tile-label">Page</span>
                  <span className="tile-value">{Math.round(bookProgress * 100)}%</span>
                </div>
                <div className="page-display">
                  {currentPage + 1}<span className="of">of</span>{pageCount}
                </div>
                <div
                  className="page-progress"
                  style={{ '--pp': `${bookProgress * 100}%` } as React.CSSProperties}
                />
              </div>

              {/* Speed tile — slider with preset chips */}
              <div className="pill-tile tile-speed">
                <div className="tile-head">
                  <span className="tile-label">Speed</span>
                  <span className="tile-value is-ember">{speed.toFixed(2)}×</span>
                </div>
                <input
                  type="range"
                  className="pill-slider"
                  min={SPEED_MIN}
                  max={SPEED_MAX}
                  step="0.01"
                  value={speed}
                  onChange={onSpeedDrag}
                  onMouseUp={onSpeedCommit}
                  onTouchEnd={onSpeedCommit}
                  style={{ '--pct': `${speedPct}%` } as React.CSSProperties}
                  aria-label="Playback speed"
                />
                <div className="pill-speed-presets">
                  {[0.85, 1.0, 1.2].map((s) => (
                    <button
                      key={s}
                      className={Math.abs(speed - s) < 0.025 ? 'is-active' : ''}
                      onClick={() => setSpeed(s)}
                    >{s.toFixed(2)}×</button>
                  ))}
                </div>
              </div>

              {/* Volume tile */}
              <div className="pill-tile tile-volume">
                <div className="tile-head">
                  <span className="tile-label"><Icons.Volume size={11} style={{ marginRight: 6, verticalAlign: -1 }} />Volume</span>
                  <span className="tile-value">{volumePct}%</span>
                </div>
                <input
                  type="range"
                  className="pill-slider"
                  min="0" max="1" step="0.01"
                  value={volume}
                  onChange={(e) => setVolume(parseFloat(e.target.value))}
                  style={{ '--pct': `${volumePct}%` } as React.CSSProperties}
                  aria-label="Volume"
                />
                <div className="pill-speed-presets">
                  {[0, 0.5, 1].map((v) => (
                    <button
                      key={v}
                      className={Math.abs(volume - v) < 0.04 ? 'is-active' : ''}
                      onClick={() => setVolume(v)}
                    >{v === 0 ? 'Mute' : v === 1 ? 'Max' : '50%'}</button>
                  ))}
                </div>
              </div>

              {/* Sleep tile — countdown ring */}
              <button
                className={`pill-tile tile-sleep tile-button ${sleepMinutes !== null ? 'is-active' : ''}`}
                onClick={cycleSleep}
                title="Cycle sleep timer"
              >
                <div className="tile-head">
                  <span className="tile-label"><Icons.Sleep size={11} style={{ marginRight: 6, verticalAlign: -1 }} />Sleep</span>
                  <span className={`tile-value ${sleepMinutes !== null ? 'is-ember' : ''}`}>
                    {sleepMinutes !== null ? `${sleepMinutes}m` : 'Off'}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <div className="sleep-ring" aria-hidden="true">
                    <svg viewBox="0 0 28 28">
                      <circle className="ring-track" cx="14" cy="14" r="11" />
                      <circle
                        className="ring-fill"
                        cx="14" cy="14" r="11"
                        strokeDasharray={2 * Math.PI * 11}
                        strokeDashoffset={(2 * Math.PI * 11) * (1 - sleepRingPct)}
                      />
                    </svg>
                  </div>
                  <span style={{ fontSize: 11, color: 'var(--ink-3)', letterSpacing: '0.06em' }}>
                    {sleepMinutes !== null ? `${sleepRingMax}m max` : 'Tap to set'}
                  </span>
                </div>
              </button>

              {/* Voice tile */}
              <div className="pill-tile tile-voice">
                <div className="tile-head">
                  <span className="tile-label">Narrator</span>
                  <span className="tile-value">{ttsEngine === 'chatterbox-turbo' ? 'CHATTERBOX' : 'KOKORO'}</span>
                </div>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <div className="voice-avatar">{(voice || '?')[0].toUpperCase()}</div>
                  <span style={{ fontFamily: 'var(--font-display)', fontStyle: 'italic', fontSize: 16, color: 'var(--paper)' }}>{voice}</span>
                </div>
              </div>

              {/* Preload tile */}
              <button
                className={`pill-tile tile-button preload-chip preload-${pl.state}`}
                onClick={handlePreload}
                disabled={plBusy || plReady}
                title={preloadButtonLabel}
                aria-label={preloadButtonLabel}
                style={{ '--preload-progress': preloadProgress } as React.CSSProperties}
              >
                <div className="tile-head">
                  <span className="tile-label"><Icons.Download size={11} style={{ marginRight: 6, verticalAlign: -1 }} />Chapter</span>
                  <span className={`tile-value ${plReady ? 'is-ember' : ''}`}>
                    {plReady ? 'Ready' : (plBusy ? `${plPct}%` : 'Preload')}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--ink-3)', letterSpacing: '0.06em' }}>
                  {pl.state === 'preloading' ? `${pl.ready}/${pl.total} cached`
                    : pl.state === 'verifying' ? 'Checking cache…'
                    : pl.state === 'ready' ? 'All sentences buffered'
                    : pl.state === 'error' ? 'Tap to retry'
                    : 'Buffer the whole chapter'}
                </div>
              </button>
            </div>
          </m.div>
        )}
        </AnimatePresence>
      </m.div>
    </m.div>
    </>
  )
})
