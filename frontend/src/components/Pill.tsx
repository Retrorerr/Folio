import { useState, useEffect, useMemo, useRef, useCallback, memo } from 'react'
import type React from 'react'
import { AnimatePresence, motion as m } from 'motion/react'
import { Icons } from './icons'
import { apiResourceUrl } from '../api'
import { formatPlaybackTime } from '../hooks/audioPlaybackState'
import { engineDisplayName, engineShortLabel, speedRangeForEngine, voiceLabel } from '../ttsVoices'
import type { BookState, ModelInstallInfo, PreloadState, TtsActivity, TtsRuntimeInfo } from '../types'
import {
  buttonHover,
  buttonTap,
  controlsReveal,
  pillContentContinuity,
  pillControlHover,
  pillControlTap,
  pillMorph,
  pillShellSlowTransition,
  pillShellTransition,
  spring,
} from '../motion'

const BARS = 64
const COMPACT_WAVE_BARS = 18
const PILL_MORPH_MS = pillMorph.ms

interface PillBufferState {
  state: 'idle' | 'warming' | 'prebuffering' | 'playing'
  ready: number
  target: number
  scheduled: number
  current: { page: number; sentence: number } | null
  reason: string
  updatedAt: number
}

interface PillProps {
  isPlaying: boolean
  isGenerating: boolean
  textLoading: boolean
  modelLoaded: boolean
  modelLoading: boolean
  installState?: ModelInstallInfo | null
  downloadActive?: boolean
  downloadBytes?: number
  downloadTotalBytes?: number
  engineFallbackReason?: string | null
  engineLoadError?: string | null
  engineRuntime?: TtsRuntimeInfo | null
  ttsActivity?: TtsActivity | null
  bufferState?: PillBufferState | null
  generationError?: string | null
  play: () => void
  pause: () => void
  stop: () => void
  skipSentence: (delta: number) => void | Promise<void>
  currentPage: number
  pageCount: number
  goToPage: (page: number) => unknown
  goToPreviousPage?: () => void
  goToNextPage?: () => void
  canGoPreviousPage?: boolean
  canGoNextPage?: boolean
  visualPageCurrent?: number
  visualPageTotal?: number
  speed: number
  setSpeed: (speed: number) => void
  volume: number
  setVolume: (volume: number) => void
  ttsEngine?: string
  voice: string
  currentSentence: number
  sentenceCount: number
  playRequiresLineSelection?: boolean
  sleepTimer: number | null
  setSleepTimer: (minutes: number | null) => void
  preloadState?: PreloadState
  preloadChapter: () => void
  readingPage: number | null
  followAlongMode?: boolean
  toggleFollowAlong?: () => void
  book?: BookState | null
  subscribeAudioSpectrum?: (subscriber: (levels: Float32Array) => void) => () => void
}

function isInteractiveShortcutTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return false
  return Boolean(target.closest(
    'button, input, select, textarea, a[href], [contenteditable="true"], [role="button"], [role="radio"], [role="switch"]',
  ))
}

function fmtBytes(bytes) {
  const safe = Number(bytes || 0)
  if (safe >= 1024 ** 3) return `${(safe / (1024 ** 3)).toFixed(1)} GB`
  if (safe >= 1024 ** 2) return `${(safe / (1024 ** 2)).toFixed(0)} MB`
  if (safe >= 1024) return `${(safe / 1024).toFixed(0)} KB`
  return `${safe} B`
}

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function compactText(value, max = 150) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1)).trim()}…`
}

export default memo(function Pill({
  isPlaying, isGenerating, textLoading, modelLoaded, modelLoading,
  installState = null,
  downloadActive = false, downloadBytes = 0, downloadTotalBytes = 0,
  engineFallbackReason = null, engineLoadError = null,
  engineRuntime = null,
  ttsActivity = null,
  bufferState = null,
  generationError,
  play, pause, stop, skipSentence,
  currentPage, pageCount, goToPage,
  goToPreviousPage, goToNextPage,
  canGoPreviousPage, canGoNextPage,
  visualPageCurrent, visualPageTotal,
  speed, setSpeed, volume, setVolume,
  ttsEngine = 'supertonic',
  voice,
  currentSentence, sentenceCount,
  playRequiresLineSelection = false,
  sleepTimer, setSleepTimer,
  preloadState,
  preloadChapter,
  readingPage,
  followAlongMode = false,
  toggleFollowAlong,
  book,
  subscribeAudioSpectrum,
}: PillProps) {
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
  const [controlsHidden, setControlsHidden] = useState(false)
  const [selectionHintVisible, setSelectionHintVisible] = useState(false)
  const pillRef = useRef<HTMLDivElement | null>(null)
  const compactWaveBarsRef = useRef<Array<HTMLDivElement | null>>([])
  const expandedWaveBarsRef = useRef<Array<HTMLDivElement | null>>([])
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pillMotionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const selectionHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const previousVisualPage = useCallback(() => {
    if (goToPreviousPage) goToPreviousPage()
    else goToPage(currentPage - 1)
  }, [currentPage, goToPage, goToPreviousPage])
  const nextVisualPage = useCallback(() => {
    if (goToNextPage) goToNextPage()
    else goToPage(currentPage + 1)
  }, [currentPage, goToNextPage, goToPage])
  const previousVisualPageAvailable = canGoPreviousPage ?? currentPage > 0
  const nextVisualPageAvailable = canGoNextPage ?? currentPage < pageCount - 1

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

  const showSelectionHint = useCallback(() => {
    setSelectionHintVisible(true)
    if (selectionHintTimerRef.current) clearTimeout(selectionHintTimerRef.current)
    selectionHintTimerRef.current = setTimeout(() => {
      setSelectionHintVisible(false)
      selectionHintTimerRef.current = null
    }, 3200)
  }, [])

  const togglePlay = useCallback(() => {
    if (isPlaying) {
      setSelectionHintVisible(false)
      pause()
      return
    }
    if (playRequiresLineSelection) {
      showSelectionHint()
      return
    }
    play()
  }, [isPlaying, pause, play, playRequiresLineSelection, showSelectionHint])

  useEffect(() => {
    if (!playRequiresLineSelection) setSelectionHintVisible(false)
  }, [playRequiresLineSelection])

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (
      e.defaultPrevented ||
      e.altKey ||
      e.ctrlKey ||
      e.metaKey ||
      isInteractiveShortcutTarget(e.target)
    ) return
    switch (e.code) {
      case 'Space':
        e.preventDefault()
        togglePlay()
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
        if (nextVisualPageAvailable) nextVisualPage()
        break
      case 'PageUp':
        e.preventDefault()
        if (previousVisualPageAvailable) previousVisualPage()
        break
    }
  }, [nextVisualPage, nextVisualPageAvailable, previousVisualPage, previousVisualPageAvailable, skipSentence, togglePlay])

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  useEffect(() => () => {
    if (pillMotionTimerRef.current) clearTimeout(pillMotionTimerRef.current)
    if (selectionHintTimerRef.current) clearTimeout(selectionHintTimerRef.current)
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

  const applyAudioSpectrum = useCallback((levels: Float32Array) => {
    const updateBars = (bars: Array<HTMLDivElement | null>) => {
      const lastLevel = Math.max(0, levels.length - 1)
      const lastBar = Math.max(1, bars.length - 1)
      bars.forEach((bar, index) => {
        if (!bar) return
        const sourceIndex = Math.round((index / lastBar) * lastLevel)
        const level = Math.max(0, Math.min(1, levels[sourceIndex] || 0))
        bar.style.transform = `scaleY(${Math.max(0.07, level).toFixed(3)})`
        bar.style.opacity = `${Math.max(0.24, Math.min(1, 0.28 + level * 0.82)).toFixed(3)}`
      })
    }
    updateBars(compactWaveBarsRef.current)
    updateBars(expandedWaveBarsRef.current)
  }, [])

  useEffect(() => {
    if (!subscribeAudioSpectrum) return
    return subscribeAudioSpectrum(applyAudioSpectrum)
  }, [applyAudioSpectrum, subscribeAudioSpectrum])

  // Progress across current page
  const progress = sentenceCount > 0 ? Math.min(1, (currentSentence + 1) / sentenceCount) : 0

  // Book-wide progress for timeline
  const displayPageTotal = Math.max(1, Math.round(Number(visualPageTotal || pageCount || 1)))
  const displayPageCurrent = Math.max(1, Math.min(displayPageTotal, Math.round(Number(visualPageCurrent || currentPage + 1))))
  const bookProgress = displayPageTotal > 0 ? displayPageCurrent / displayPageTotal : 0
  const totalMinsEstimate = displayPageTotal * 2
  const elapsedMins = bookProgress * totalMinsEstimate

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
  const speedRange = speedRangeForEngine(ttsEngine)
  const speedPct = ((speed - speedRange.min) / (speedRange.max - speedRange.min)) * 100
  const onSpeedDrag = (e) => {
    const v = parseFloat(e.target.value)
    setSpeed(v)
  }
  const onSpeedCommit = (e) => {
    // Snap to nearest preset on release for tactile feedback
    const v = parseFloat(e.target.value)
    let nearest = speedRange.presets[0]
    let best = Infinity
    for (const s of speedRange.presets) {
      const d = Math.abs(s - v)
      if (d < best) { best = d; nearest = s }
    }
    setSpeed(nearest)
  }

  const volumePct = Math.round(volume * 100)

  const statusLabel = () => {
    const engineName = engineDisplayName(ttsEngine)
    if (generationError) return generationError
    if (installState && !installState.ready) {
      if (installState.state === 'failed') return installState.error || `${engineName} install failed`
      if (installState.state === 'download_queued' || installState.state === 'downloading') {
        const total = installState.total_bytes > 0 ? installState.total_bytes : 1
        const pct = Math.min(99, Math.max(1, Math.round(((installState.downloaded_bytes || 0) / total) * 100)))
        return `Downloading ${engineName}… ${pct}%`
      }
      if (installState.state === 'verifying') return `Verifying ${engineName}…`
      return `${engineName} not installed`
    }
    // Engine-level load failure (memory pressure, missing dep, etc.) wins
    // over the generic generationError so the user gets the real reason.
    if (engineLoadError && !modelLoaded) {
      return engineLoadError
    }
    if (downloadActive) {
      const total = downloadTotalBytes > 0 ? downloadTotalBytes : 1
      const pct = Math.min(99, Math.max(0, Math.round((downloadBytes / total) * 100)))
      const mb = (downloadBytes / (1024 * 1024)).toFixed(0)
      const totalMb = (total / (1024 * 1024)).toFixed(0)
      return `Downloading ${engineName}… ${pct}% · ${mb}/${totalMb} MB`
    }
    if (modelLoading) return `Loading ${engineName}…`
    if (!modelLoaded) {
      return `${engineName} ready on demand`
    }
    if (modelLoaded && engineFallbackReason && !isPlaying) {
      return engineFallbackReason
    }
    if (textLoading) return 'Extracting text (OCR)…'
    if (isGenerating) return 'Generating audio…'
    if (sentenceCount === 0) return 'No text on this page'
    return null
  }
  const status = statusLabel()

  // Chapter preload state feeds the reader pill controls and subtitle line.
  const pl = preloadState || { state: 'idle', ready: 0, total: 0, failed: [] }
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

  const modelActivity = useMemo(() => {
    const engineName = engineDisplayName(ttsEngine)
    const provider = engineRuntime?.selected_provider || engineRuntime?.provider || engineRuntime?.selected_device || null
    const installProgress = installState?.total_bytes > 0
      ? (installState.downloaded_bytes || 0) / installState.total_bytes
      : Number(installState?.progress || 0)
    const runtimeDownloadProgress = downloadTotalBytes > 0 ? downloadBytes / downloadTotalBytes : 0
    const playbackPage = readingPage ?? currentPage
    const audioDetail = sentenceCount > 0
      ? `Sentence ${currentSentence + 1}/${sentenceCount} · chapter ${playbackPage + 1}/${pageCount}`
      : `Chapter ${playbackPage + 1}/${pageCount}`
    const runningJob = ttsActivity?.running?.[0] || null
    const pendingJob = ttsActivity?.pending?.[0] || null
    const activityJob = runningJob || ttsActivity?.active || pendingJob || null
    const activityStatus = runningJob ? 'running' : (activityJob?.status || (pendingJob ? 'pending' : null))
    const activityMeta = activityJob?.metadata || {}
    const activityPage = finiteNumber(
      activityMeta.page_number,
      finiteNumber(activityMeta.page, playbackPage) + 1,
    )
    const activitySentence = finiteNumber(
      activityMeta.sentence_number,
      finiteNumber(activityMeta.sentence, currentSentence) + 1,
    )
    const activitySentenceCount = finiteNumber(activityMeta.sentence_count, sentenceCount)
    const activityTargetLabel = `S${activitySentence}${activitySentenceCount > 0 ? `/${activitySentenceCount}` : ''} · ch ${activityPage}/${pageCount}`
    const activitySnippet = compactText(activityMeta.text, 132)
    const activityMatchesCurrent = (
      finiteNumber(activityMeta.page, playbackPage) === playbackPage
      && finiteNumber(activityMeta.sentence, currentSentence) === currentSentence
    )
    const leadReady = finiteNumber(bufferState?.ready, 0)
    const leadTarget = finiteNumber(bufferState?.target, 0)
    const leadScheduled = Math.max(leadReady, finiteNumber(bufferState?.scheduled, 0))
    const leadProgress = leadTarget > 0 ? Math.max(0.04, Math.min(0.96, leadReady / leadTarget)) : 0
    const runningCount = Array.isArray(ttsActivity?.running) ? ttsActivity.running.length : (runningJob ? 1 : 0)
    const pendingCount = Array.isArray(ttsActivity?.pending) ? ttsActivity.pending.length : (pendingJob ? 1 : 0)
    const queueDetail = runningCount > 0 || pendingCount > 0
      ? `${runningCount} generating · ${pendingCount} queued`
      : 'No backend queue reported'
    const leadSentence = bufferState?.current
      ? `sentence ${finiteNumber(bufferState.current.sentence, 0) + 1} · chapter ${finiteNumber(bufferState.current.page, playbackPage) + 1}/${pageCount}`
      : 'next sentence'
    const bufferLabel = leadTarget > 0 ? `${leadReady}/${leadTarget} ready` : 'Idle'
    const bufferDetail = leadTarget > 0
      ? `${leadScheduled}/${leadTarget} scheduled · ${queueDetail}`
      : queueDetail
    const bufferBadge = leadTarget > 0
      ? `${leadReady}/${leadTarget} ready${leadScheduled > leadReady ? ` · ${leadScheduled}/${leadTarget} queued` : ''}`
      : null
    const playbackBadge = sentenceCount > 0
      ? `Reading S${currentSentence + 1}/${sentenceCount} · ch ${playbackPage + 1}/${pageCount}`
      : `Chapter ${playbackPage + 1}/${pageCount}`
    const leadDetail = leadTarget > 0
      ? `${bufferState?.reason || 'Preparing lead audio'} while checking ${leadSentence}.`
      : `${bufferState?.reason || 'Preparing lead audio'}.`

    let headline = 'Ready'
    let detail = 'Selected model is waiting.'
    let tone = 'ready'
    let progressValue = modelLoaded ? 1 : 0
    let progressMode = modelLoaded ? 'known' : 'idle'
    let badges: string[] = []

    if (generationError) {
      headline = 'Attention needed'
      detail = generationError
      tone = 'error'
      progressMode = 'idle'
      badges = []
    } else if (installState && !installState.ready) {
      tone = installState.state === 'failed' ? 'error' : 'busy'
      progressValue = Math.max(0, Math.min(0.99, installProgress || 0))
      badges = [engineName]
      if (installState.state === 'failed') {
        headline = 'Install failed'
        detail = installState.error || `${engineName} could not finish installing.`
        progressMode = 'idle'
      } else if (installState.state === 'download_queued') {
        headline = 'Queued download'
        detail = `${engineName} is waiting for the model download slot.`
        progressMode = 'indeterminate'
      } else if (installState.state === 'downloading') {
        headline = 'Downloading model'
        detail = installState.total_bytes > 0
          ? `${fmtBytes(installState.downloaded_bytes)} of ${fmtBytes(installState.total_bytes)}`
          : `${Math.round(progressValue * 100)}% downloaded`
        progressMode = 'known'
      } else if (installState.state === 'verifying') {
        headline = 'Verifying model'
        detail = `${engineName} assets are being checked before use.`
        progressMode = 'indeterminate'
      } else {
        headline = 'Model not installed'
        detail = `${engineName} needs a local model before narration can start.`
        progressMode = 'idle'
      }
    } else if (engineLoadError && !modelLoaded) {
      headline = 'Load failed'
      detail = engineLoadError
      tone = 'error'
      progressMode = 'idle'
      badges = [engineName]
    } else if (downloadActive) {
      headline = 'Downloading model data'
      detail = downloadTotalBytes > 0
        ? `${fmtBytes(downloadBytes)} of ${fmtBytes(downloadTotalBytes)}`
        : 'Receiving model assets from the backend.'
      tone = 'busy'
      progressValue = Math.max(0, Math.min(0.99, runtimeDownloadProgress))
      progressMode = downloadTotalBytes > 0 ? 'known' : 'indeterminate'
      badges = [engineName]
    } else if (modelLoading) {
      headline = 'Loading model'
      detail = provider ? `Loading on ${provider}.` : 'Loading selected model into memory.'
      tone = 'busy'
      progressValue = 0.58
      progressMode = 'indeterminate'
      badges = [provider].filter(Boolean)
    } else if (textLoading) {
      headline = 'Extracting text'
      detail = 'Preparing readable sentence data for this page.'
      tone = 'busy'
      progressValue = 0.35
      progressMode = 'indeterminate'
      badges = [playbackBadge]
    } else if (activityStatus === 'running') {
      headline = isPlaying && !isGenerating && !activityMatchesCurrent
        ? 'Playing and generating ahead'
        : 'Generating audio'
      detail = activitySnippet || 'Preparing sentence audio for the playback buffer.'
      tone = 'busy'
      progressValue = 0.72
      progressMode = 'indeterminate'
      badges = [activityTargetLabel, bufferBadge, queueDetail].filter(Boolean)
    } else if (isPlaying && activityStatus === 'pending') {
      headline = 'Queued for buffer'
      detail = activitySnippet || 'The next sentence is waiting for a synthesis slot.'
      tone = 'busy'
      progressValue = leadTarget > 0 ? leadProgress : progress
      progressMode = leadTarget > 0 ? 'known' : 'indeterminate'
      badges = [activityTargetLabel, bufferBadge, queueDetail].filter(Boolean)
    } else if (bufferState?.state === 'prebuffering') {
      headline = 'Filling playback buffer'
      detail = leadDetail
      tone = 'busy'
      progressValue = leadTarget > 0 ? leadProgress : 0.42
      progressMode = leadTarget > 0 ? 'known' : 'indeterminate'
      badges = [playbackBadge, bufferBadge, queueDetail].filter(Boolean)
    } else if (isGenerating) {
      headline = 'Generating audio'
      detail = `Synthesizing ${audioDetail.toLowerCase()}.`
      tone = 'busy'
      progressValue = Math.max(0.08, Math.min(0.95, progress))
      progressMode = 'indeterminate'
      badges = [playbackBadge]
    } else if (isPlaying && leadTarget > 0) {
      const building = leadReady < leadTarget || leadScheduled < leadTarget
      headline = building ? 'Building buffer' : 'Playing from buffer'
      detail = building
        ? 'Narration is playing while the next sentences are prepared.'
        : 'Lead audio is ready for uninterrupted playback.'
      tone = building ? 'busy' : 'live'
      progressValue = building ? leadProgress : progress
      progressMode = building ? 'known' : 'known'
      badges = [playbackBadge, bufferBadge].filter(Boolean)
    } else if (isPlaying) {
      headline = 'Playing narration'
      detail = audioDetail
      tone = 'live'
      progressValue = progress
      progressMode = 'known'
      badges = [playbackBadge]
    } else if (!modelLoaded) {
      headline = 'Model ready on demand'
      detail = 'The selected model will load when playback starts.'
      tone = 'idle'
      progressValue = 0
      progressMode = 'idle'
      badges = []
    } else if (engineFallbackReason) {
      headline = 'Ready with fallback'
      detail = engineFallbackReason
      tone = 'ready'
      progressValue = 1
      progressMode = 'known'
      badges = []
    }

    const modelTrackValue = activityStatus === 'running'
      ? 'Generating'
      : activityStatus === 'pending'
        ? 'Queued'
      : modelLoading || downloadActive ? 'Loading'
      : modelLoaded ? 'Ready' : 'On demand'
    const modelTrackDetail = activityStatus === 'running' || activityStatus === 'pending'
      ? activityTargetLabel
      : provider || 'Runtime selected'
    const audioTrackDetail = isPlaying
      ? audioDetail
      : sentenceCount > 0 ? `Paused at ${audioDetail.toLowerCase()}` : audioDetail
    const chapterValue = pl.total > 0 ? `${pl.ready}/${pl.total}` : preloadShortLabel
    const chapterTrackDetail = pl.total > 0
      ? `${plFailed ? `${plFailed} failed · ` : ''}${preloadLabel}`
      : 'Tap preload to cache the chapter'

    const tracks = [
      {
        key: 'model',
        label: 'Model',
        value: modelTrackValue,
        detail: modelTrackDetail,
        progress: progressValue,
        mode: progressMode,
      },
      {
        key: 'buffer',
        label: 'Buffer',
        value: bufferLabel,
        detail: bufferDetail,
        progress: leadTarget > 0 ? leadProgress : 0,
        mode: leadTarget > 0 ? ((leadReady < leadTarget || leadScheduled < leadTarget) ? 'known' : 'known') : (runningCount > 0 || pendingCount > 0 ? 'indeterminate' : 'idle'),
      },
      {
        key: 'audio',
        label: 'Playback',
        value: isGenerating ? 'Generating current' : isPlaying ? 'Playing' : 'Standing by',
        detail: audioTrackDetail,
        progress,
        mode: sentenceCount > 0 ? 'known' : 'idle',
      },
      {
        key: 'chapter',
        label: 'Chapter',
        value: chapterValue,
        detail: chapterTrackDetail,
        progress: preloadProgress,
        mode: plBusy && pl.total === 0 ? 'indeterminate' : (pl.total > 0 ? 'known' : 'idle'),
      },
    ]

    return { headline, detail, tone, progress: progressValue, progressMode, badges, tracks }
  }, [
    currentPage,
    currentSentence,
    downloadActive,
    downloadBytes,
    downloadTotalBytes,
    engineFallbackReason,
    engineLoadError,
    engineRuntime,
    generationError,
    installState,
    isGenerating,
    isPlaying,
    modelLoaded,
    modelLoading,
    pageCount,
    readingPage,
    bufferState,
    pl.total,
    pl.ready,
    plBusy,
    plFailed,
    preloadLabel,
    preloadProgress,
    preloadShortLabel,
    progress,
    sentenceCount,
    ttsActivity,
    textLoading,
    ttsEngine,
  ])

  const handlePreload = (e) => {
    e.stopPropagation()
    if (!plBusy) preloadChapter?.()
  }

  const primaryClick = () => {
    if (!isPlaying && playRequiresLineSelection) {
      togglePlay()
      return
    }
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
    : (status || `${voiceLabel(ttsEngine, voice)} voice · ${engineShortLabel(ttsEngine)}`)

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
      <AnimatePresence initial={false}>
        {selectionHintVisible && (
          <m.div
            className="pill-selection-hint"
            role="status"
            aria-live="polite"
            initial={{ opacity: 0, y: 8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={spring.quick}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <span className="pill-selection-hint-dot" aria-hidden="true" />
            <span>
              <strong>Select a line first</strong>
              <small>Click any sentence in the page, then press play.</small>
            </span>
          </m.div>
        )}
      </AnimatePresence>
      <m.div
        ref={pillRef}
        className={`pill ${expanded ? 'expanded' : 'collapsed'} ${isPlaying ? 'is-playing' : ''} ${(isPlaying || isGenerating || textLoading || modelLoading || downloadActive) ? 'is-active' : ''} ${pillMotion} ${slowMo ? 'pill-slowmo' : ''}`}
        role="region"
        aria-label="Narration playback controls"
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

            </div>

            <div className="pill-controls" onClick={(e) => e.stopPropagation()}>
              {/* Transport cluster — fixed-width and never reflows so the
                  play button stays put when prep buttons morph. */}
              <div className="pill-controls-transport">
                <m.button className="pill-btn" onClick={() => skipSentence(-1)} title="Previous sentence (Left arrow)" aria-label="Previous sentence" whileHover={buttonHover} whileTap={buttonTap}>
                  <Icons.Rewind size={16} />
                </m.button>
                <m.button
                  className={`pill-btn play ${isPlaying ? 'is-playing' : ''}`}
                  onClick={primaryClick}
                  title="Play/Pause (Space)"
                  aria-label={isPlaying ? 'Pause narration' : 'Play narration'}
                  whileTap={buttonTap}
                >
                  {isPlaying ? <Icons.Pause size={18} /> : <Icons.Play size={18} />}
                </m.button>
                <m.button className="pill-btn" onClick={() => skipSentence(1)} title="Next sentence (Right arrow)" aria-label="Next sentence" whileHover={buttonHover} whileTap={buttonTap}>
                  <Icons.Forward size={16} />
                </m.button>
              </div>
              {/* Prep cluster — reserves width for the wider variant so morphing
                  preload ↔ follow-along never shifts the transport buttons. */}
              <div className={`pill-controls-prep ${isPlaying ? 'state-playing' : 'state-paused'}`}>
                <div className="pill-waveform" aria-hidden="true">
                  {Array.from({ length: COMPACT_WAVE_BARS }, (_, i) => (
                    <div
                      key={i}
                      ref={(node) => { compactWaveBarsRef.current[i] = node }}
                      className="wave-bar"
                    />
                  ))}
                </div>
                <span className="pill-divider" aria-hidden="true" />
                <m.button
                  className={`pill-preload-control preload-${pl.state} is-compact`}
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
                  onClick={(e) => { e.stopPropagation(); if (showFollowAlong) toggleFollowAlong() }}
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
                <m.button className="pill-btn pill-expand-btn" onClick={(e) => { e.stopPropagation(); setExpandedWithMotion(true) }} title="Expand" aria-label="Expand playback controls" whileTap={buttonTap}>
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
                  {plActive ? preloadLabel.toUpperCase() : (status ? status.toUpperCase() : `NOW PLAYING · PAGE ${displayPageCurrent} OF ${displayPageTotal}`)}
                </div>
                <h2>{book?.title || 'Kokoro Reader'}</h2>
                <div className="a">{book?.author ? `by ${book.author}` : ''}{voice ? ` · read by ${voice}` : ''}</div>
              </div>
              <m.button className="collapse-btn" onClick={(e) => { e.stopPropagation(); setExpandedWithMotion(false) }} aria-label="Collapse playback controls" whileTap={buttonTap}>
                <Icons.ChevronDown size={18} />
              </m.button>
            </div>

            <div className="tele-stack tele-stack-activity">
              <section className={`pill-activity pill-activity-${modelActivity.tone}`} aria-label="Model activity">
                <div className="pill-activity-head">
                  <span className="pill-activity-dot" aria-hidden="true" />
                  <div>
                    <div className="pill-activity-kicker">Model activity</div>
                    <strong>{modelActivity.headline}</strong>
                    <p>{modelActivity.detail}</p>
                    {modelActivity.badges.length > 0 && (
                      <div className="pill-activity-badges" aria-label="Activity details">
                        {modelActivity.badges.map((badge) => (
                          <span key={badge}>{badge}</span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <div
                  className={`pill-activity-meter meter-${modelActivity.progressMode}`}
                  style={{ '--meter-progress': `${Math.max(0, Math.min(1, modelActivity.progress)) * 100}%` } as React.CSSProperties}
                  aria-hidden="true"
                >
                  <span />
                </div>
                <div className="pill-activity-grid">
                  {modelActivity.tracks.map((track) => (
                    <div className={`pill-activity-track track-${track.mode} track-key-${track.key}`} key={track.key}>
                      <div className="track-copy">
                        <span>{track.label}</span>
                        <strong>{track.value}</strong>
                        <em>{track.detail}</em>
                      </div>
                      <div
                        className={`track-meter meter-${track.mode}`}
                        style={{ '--meter-progress': `${Math.max(0, Math.min(1, track.progress || 0)) * 100}%` } as React.CSSProperties}
                        aria-hidden="true"
                      >
                        <span />
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            </div>

            <div>
              <div className="pill-wave-lg">
                {Array.from({ length: BARS }, (_, i) => (
                  <div
                    key={i}
                    ref={(node) => { expandedWaveBarsRef.current[i] = node }}
                    className="wave-bar-lg spectrum-bar"
                  />
                ))}
              </div>
              <div className="pill-timeline">
                <span className="current">{formatPlaybackTime(elapsedMins * 60)}</span>
                <span>Sentence {sentenceCount ? currentSentence + 1 : 0} / {sentenceCount}</span>
                <span>-{formatPlaybackTime((totalMinsEstimate - elapsedMins) * 60)}</span>
              </div>
            </div>

            <m.div className="pill-expanded-controls" layout>
              <div className="pill-expanded-transport">
                <button className="pill-btn" onClick={previousVisualPage} disabled={!previousVisualPageAvailable} title="Previous page" aria-label="Previous page">
                  <Icons.SkipBack size={18} />
                </button>
                <button className="pill-btn" onClick={() => skipSentence(-1)} title="Previous sentence" aria-label="Previous sentence">
                  <Icons.Rewind size={18} />
                </button>
                <button
                  className={`pill-btn play ${isPlaying ? 'is-playing' : ''}`}
                  onClick={primaryClick}
                  title="Play/Pause"
                  aria-label={isPlaying ? 'Pause narration' : 'Play narration'}
                >
                  {isPlaying ? <Icons.Pause size={22} /> : <Icons.Play size={22} />}
                </button>
                <button className="pill-btn" onClick={() => skipSentence(1)} title="Next sentence" aria-label="Next sentence">
                  <Icons.Forward size={18} />
                </button>
                <button className="pill-btn" onClick={nextVisualPage} disabled={!nextVisualPageAvailable} title="Next page" aria-label="Next page">
                  <Icons.SkipForward size={18} />
                </button>
              </div>
              <div className="pill-expanded-actions">
                <span className="pill-divider" aria-hidden="true" />
                <AnimatePresence>
                  {showFollowAlong && (
                    <m.button
                      className={`pill-btn follow-along-btn is-prominent ${followAlongMode ? 'active' : ''} ${followAlongMode && isPlaying ? 'is-live' : ''}`}
                      onClick={(e) => { e.stopPropagation(); toggleFollowAlong() }}
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
                <button className="pill-btn" onClick={stop} title="Stop" aria-label="Stop narration">
                  <Icons.Stop size={16} />
                </button>
              </div>
            </m.div>

            <div className="pill-secondary-row" onClick={(e) => e.stopPropagation()}>
              {/* Page tile — current page + visual progress */}
              <div className="pill-tile tile-page">
                <div className="tile-head">
                  <span className="tile-label">Page</span>
                  <span className="tile-value">{Math.round(bookProgress * 100)}%</span>
                </div>
                <div className="page-display">
                  {displayPageCurrent}<span className="of">of</span>{displayPageTotal}
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
                  min={speedRange.min}
                  max={speedRange.max}
                  step="0.01"
                  value={speed}
                  onChange={onSpeedDrag}
                  onMouseUp={onSpeedCommit}
                  onTouchEnd={onSpeedCommit}
                  style={{ '--pct': `${speedPct}%` } as React.CSSProperties}
                  aria-label="Playback speed"
                />
                <div className="pill-speed-presets">
                  {speedRange.presets.slice(1, 4).map((s) => (
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
                  <span className="tile-value">{engineShortLabel(ttsEngine)}</span>
                </div>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <div className="voice-avatar">{(voice || '?')[0].toUpperCase()}</div>
                  <span className="voice-name">{voiceLabel(ttsEngine, voice)}</span>
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
