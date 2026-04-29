import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { Icons } from './icons'

const BARS = 64
const SPEEDS = [0.75, 0.85, 0.95, 1, 1.1, 1.2, 1.35]

function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec))
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export default function Pill({
  isPlaying, isGenerating, textLoading, modelLoaded, modelLoading,
  play, pause, stop, skipSentence,
  currentPage, pageCount, goToPage,
  speed, setSpeed, volume, setVolume,
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
}) {
  const showFollowAlong = isPlaying && readingPage != null && toggleFollowAlong
  const [expanded, setExpanded] = useState(false)
  const [pillMotion, setPillMotion] = useState('')
  const [pulse, setPulse] = useState(0)
  const [controlsHidden, setControlsHidden] = useState(false)
  const pillRef = useRef(null)
  const hideTimerRef = useRef(null)
  const pillMotionTimerRef = useRef(null)

  const setExpandedWithMotion = useCallback((next) => {
    clearTimeout(pillMotionTimerRef.current)
    setPillMotion(next ? 'expanding' : 'collapsing')
    setExpanded(next)
    pillMotionTimerRef.current = setTimeout(() => setPillMotion(''), 360)
  }, [])

  const revealControls = useCallback(() => {
    setControlsHidden(false)
    clearTimeout(hideTimerRef.current)
    if (followAlongMode && isPlaying) {
      hideTimerRef.current = setTimeout(() => setControlsHidden(true), 2000)
    }
  }, [followAlongMode, isPlaying])

  const handleKeyDown = useCallback((e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return
    switch (e.code) {
      case 'Space':
        e.preventDefault()
        isPlaying ? pause() : play()
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

  useEffect(() => () => clearTimeout(pillMotionTimerRef.current), [])

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
    const id = setInterval(() => setPulse((p) => p + 1), 120)
    return () => clearInterval(id)
  }, [isPlaying])

  useEffect(() => {
    clearTimeout(hideTimerRef.current)
    const resetTimer = setTimeout(() => setControlsHidden(false), 0)
    if (!followAlongMode || !isPlaying) return

    const onActivity = () => revealControls()
    window.addEventListener('pointermove', onActivity, { passive: true })
    window.addEventListener('keydown', onActivity)
    hideTimerRef.current = setTimeout(() => setControlsHidden(true), 2000)

    return () => {
      clearTimeout(resetTimer)
      clearTimeout(hideTimerRef.current)
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

  // Teleprompter text for current sentence
  const currentText = pageData?.sentences?.[currentSentence]?.words?.map(w => w.text).join(' ') || ''

  const togglePlay = () => { isPlaying ? pause() : play() }
  const cycleSpeed = () => {
    const idx = SPEEDS.findIndex(s => Math.abs(s - speed) < 0.01)
    setSpeed(SPEEDS[(idx + 1) % SPEEDS.length])
  }
  const cycleSleep = () => {
    const stops = [null, 5, 15, 30, 60]
    const cur = sleepTimer === null ? null : Math.ceil(sleepTimer)
    const i = stops.findIndex(s => s === cur)
    setSleepTimer(stops[(i + 1) % stops.length])
  }
  const sleepMinutes = sleepTimer !== null ? Math.ceil(sleepTimer) : null

  const statusLabel = () => {
    if (!modelLoaded) return modelLoading ? 'Loading model…' : 'Model not ready'
    if (textLoading) return 'Extracting text (OCR)…'
    if (isGenerating) return 'Generating audio…'
    if (sentenceCount === 0) return 'No text on this page'
    return null
  }
  const status = statusLabel()

  // Chapter preload state — fused into the pill's play button + subtitle line.
  // The play button gets a progress ring while preloading, pulses when ready,
  // and is gated until the whole chapter is cached.
  const pl = preloadState || { state: 'idle', ready: 0, total: 0 }
  const plPct = pl.total > 0 ? Math.round((pl.ready / pl.total) * 100) : 0
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
    togglePlay()
  }

  const metaLine = plActive
    ? preloadLabel
    : (status || `${voice?.toUpperCase?.() || ''} · PAGE ${currentPage + 1}/${pageCount}`)

  return (
    <>
    <div
      className={`pill-reveal-zone ${followAlongMode && controlsHidden ? 'active' : ''}`}
      onPointerEnter={revealControls}
      onPointerMove={revealControls}
    />
    <div
      className={`pill-wrap ${followAlongMode ? 'follow-mode' : ''} ${controlsHidden ? 'auto-hidden' : ''}`}
      onPointerEnter={revealControls}
      onFocusCapture={revealControls}
    >
      <div
        ref={pillRef}
        className={`pill ${expanded ? 'expanded' : 'collapsed'} ${pillMotion}`}
        onClick={() => { if (!expanded) setExpandedWithMotion(true) }}
      >
        {!expanded ? (
          <div className="pill-collapsed-content">
            <div className={`pill-cover ${isPlaying ? 'rotating' : ''}`} />
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

            <div className="pill-controls" onClick={(e) => e.stopPropagation()}>
              <button className="pill-btn" onClick={() => skipSentence(-1)} title="Previous sentence (Left arrow)">
                <Icons.Rewind size={16} />
              </button>
              <button
                className={`pill-btn play ${isPlaying ? 'is-playing' : ''}`}
                onClick={primaryClick}
                title="Play/Pause (Space)"
              >
                {isPlaying ? <Icons.Pause size={18} /> : <Icons.Play size={18} />}
              </button>
              <button className="pill-btn" onClick={() => skipSentence(1)} title="Next sentence (Right arrow)">
                <Icons.Forward size={16} />
              </button>
              <button
                className={`pill-preload-control preload-${pl.state}`}
                onClick={handlePreload}
                disabled={plBusy || plReady}
                title={preloadButtonLabel}
                aria-label="Preload chapter"
              >
                <Icons.Download size={14} />
                <span>{preloadShortLabel}</span>
              </button>
              {showFollowAlong && (
                <button
                  className={`pill-btn follow-along-btn ${followAlongMode ? 'active' : ''}`}
                  onClick={(e) => { e.stopPropagation(); toggleFollowAlong(); if (!followAlongMode) jumpToReader?.() }}
                  title={followAlongMode ? 'Exit Follow Along' : 'Follow Along'}
                  aria-label={followAlongMode ? 'Exit Follow Along' : 'Enter Follow Along'}
                  aria-pressed={followAlongMode}
                >
                  <span className="live-dot" aria-hidden="true" />
                  <span className="live-label">{followAlongMode ? 'Following' : 'Follow Along'}</span>
                </button>
              )}
              <button className="pill-btn" onClick={(e) => { e.stopPropagation(); setExpandedWithMotion(true) }} title="Expand">
                <Icons.ChevronDown size={16} style={{ transform: 'rotate(180deg)' }} />
              </button>
            </div>
          </div>
        ) : (
          <div className="pill-expanded-content">
            <div className="pill-expanded-head">
              <div className={`pill-cover ${isPlaying ? 'rotating' : ''}`} />
              <div className="meta">
                <div className={`eyebrow ${plActive ? `preload-meta preload-meta-${pl.state}` : ''}`}>
                  {plActive ? preloadLabel.toUpperCase() : (status ? status.toUpperCase() : `NOW PLAYING · PAGE ${currentPage + 1} OF ${pageCount}`)}
                </div>
                <h3>{book?.title || 'Kokoro Reader'}</h3>
                <div className="a">{book?.author ? `by ${book.author}` : ''}{voice ? ` · read by ${voice}` : ''}</div>
              </div>
              <button className="collapse-btn" onClick={(e) => { e.stopPropagation(); setExpandedWithMotion(false) }}>
                <Icons.ChevronDown size={18} />
              </button>
            </div>

            <div className="teleprompter">
              {currentText ? (
                <span className="now">{currentText}</span>
              ) : (
                <span style={{ color: 'var(--ink-3)' }}>{status || 'Ready.'}</span>
              )}
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

            <div className="pill-expanded-controls">
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
              {showFollowAlong && (
                <button
                  className={`pill-btn follow-along-btn ${followAlongMode ? 'active' : ''}`}
                  onClick={(e) => { e.stopPropagation(); toggleFollowAlong(); if (!followAlongMode) jumpToReader?.() }}
                  title={followAlongMode ? 'Exit Follow Along' : 'Follow Along'}
                  aria-label={followAlongMode ? 'Exit Follow Along' : 'Enter Follow Along'}
                  aria-pressed={followAlongMode}
                >
                  <span className="live-dot" aria-hidden="true" />
                  <span className="live-label">{followAlongMode ? 'Following' : 'Follow Along'}</span>
                </button>
              )}
              <button className="pill-btn" onClick={stop} title="Stop">
                <Icons.Stop size={16} />
              </button>
            </div>

            <div className="pill-secondary-row" onClick={(e) => e.stopPropagation()}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <div className="pill-voice">
                  <div className="voice-avatar">{(voice || '?')[0].toUpperCase()}</div>
                  <span>{voice}</span>
                </div>
              </div>

              <button className="pill-chip" onClick={cycleSpeed}>
                <span className="v">{speed.toFixed(2)}×</span> <span style={{ opacity: 0.6 }}>SPEED</span>
              </button>

              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
                <button
                  className={`pill-chip preload-chip preload-${pl.state}`}
                  onClick={handlePreload}
                  disabled={plBusy || plReady}
                  title={preloadButtonLabel}
                >
                  <Icons.Download size={12} /> {preloadShortLabel.toUpperCase()}
                </button>
                <button
                  className={`pill-chip${sleepMinutes !== null ? ' active' : ''}`}
                  onClick={cycleSleep}
                  title="Cycle sleep timer"
                >
                  <Icons.Sleep size={12} /> {sleepMinutes !== null ? `${sleepMinutes}M` : 'SLEEP'}
                </button>
                <label className="pill-chip" style={{ cursor: 'pointer' }}>
                  <Icons.Volume size={12} />
                  <input
                    type="range" min="0" max="1" step="0.05" value={volume}
                    onChange={(e) => setVolume(parseFloat(e.target.value))}
                    style={{ width: 64 }}
                  />
                </label>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
    </>
  )
}
