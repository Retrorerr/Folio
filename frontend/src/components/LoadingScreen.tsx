import { AnimatePresence, motion as m } from 'motion/react'
import TitleBar from './TitleBar'
import { Icons } from './icons'
import { fadeIn, listItem, listStagger, slideUp } from '../motion'
import { buildStartupPresentation } from '../startupPresentation'
import { isAndroidRuntime } from '../api'
import type { BookState, TtsRuntimeInfo } from '../types'

type LoadingScreenProps = {
  theme: string
  motion: boolean
  backendLaunchStarted?: boolean
  backendLaunchSettled?: boolean
  backendReachable: boolean
  recentLoaded: boolean
  recentBooks: BookState[]
  interfaceReady: boolean
  activeRuntime: TtsRuntimeInfo | null
  activeModelLoaded: boolean
  activeModelLoading: boolean
  timedOut: boolean
  backendStartCommandFailed?: boolean
  backendLogPath?: string | null
  onOpenBackendLog?: () => Promise<boolean>
}

function formatDownload(bytes?: number): string {
  if (!bytes || bytes <= 0) return '0 MB'
  const mb = bytes / (1024 ** 2)
  return mb < 1024 ? `${mb.toFixed(mb >= 100 ? 0 : 1)} MB` : `${(mb / 1024).toFixed(1)} GB`
}

type StartupStage = {
  icon: (props: { size?: number }) => React.ReactNode
  title: string
  detail: string
  state: 'done' | 'active' | 'pending'
}

function state(done: boolean, active: boolean): StartupStage['state'] {
  return done ? 'done' : active ? 'active' : 'pending'
}

export default function LoadingScreen({
  theme,
  motion,
  backendLaunchStarted = false,
  backendLaunchSettled = false,
  backendReachable,
  recentLoaded,
  recentBooks,
  interfaceReady,
  activeRuntime,
  activeModelLoaded,
  activeModelLoading,
  timedOut,
  backendStartCommandFailed = false,
  backendLogPath,
  onOpenBackendLog,
}: LoadingScreenProps) {
  const androidRuntime = isAndroidRuntime()
  const useGoldLogo = theme === 'light' || theme === 'sepia'
  const logoSrc = useGoldLogo ? '/folio-icon.png' : '/folio-monochrome-icon.png'
  const downloadActive = Boolean(activeRuntime?.download_active)
  const downloadBytes = Number(activeRuntime?.download_bytes || 0)
  const downloadTotalBytes = Number(activeRuntime?.download_total_bytes || 0)
  const downloadPct = downloadTotalBytes > 0
    ? Math.min(99, Math.max(1, (downloadBytes / downloadTotalBytes) * 100))
    : 0
  const backendIssue = !backendReachable && (timedOut || backendStartCommandFailed)
  const runtimeIssue = typeof activeRuntime?.last_load_error === 'string' && activeRuntime.last_load_error.length > 0
  const startupIssue = backendIssue || runtimeIssue
  const bookCount = recentBooks.length

  const { ready, progress, headline, statusText } = buildStartupPresentation({
    interfaceReady,
    backendLaunchStarted,
    backendLaunchSettled,
    backendReachable,
    recentLoaded,
    bookCount,
    startupIssue,
  })

  const stages: StartupStage[] = [
    {
      icon: Icons.Library,
      title: 'Library',
      detail: recentLoaded
        ? `${bookCount} ${bookCount === 1 ? 'book' : 'books'} ready`
        : backendReachable ? 'Restoring your shelf' : 'Connecting locally',
      state: state(recentLoaded, backendReachable),
    },
    {
      icon: Icons.Bookmark,
      title: 'Reading state',
      detail: recentLoaded ? 'Progress and bookmarks restored' : 'Picking up where you left off',
      state: state(recentLoaded, backendReachable),
    },
    {
      icon: downloadActive ? Icons.Download : Icons.Volume,
      title: 'Narration',
      detail: downloadActive
        ? `Finishing voice setup${downloadPct ? ` · ${Math.round(downloadPct)}%` : ''}`
        : activeModelLoading ? 'Preparing your voice' : activeModelLoaded ? 'Ready when you are' : 'Available on demand',
      state: state(!downloadActive && !activeModelLoading, downloadActive || activeModelLoading),
    },
  ]

  const progressValue = downloadActive && downloadPct ? downloadPct : progress
  const progressLabel = downloadActive ? 'Voice setup progress' : headline

  return (
    <div
      className={`loading-screen theme-${theme}${motion ? ' motion-enabled' : ' motion-reduced'}`}
      aria-busy={!ready}
    >
      <TitleBar />
      {motion && !androidRuntime && <div className="loading-aurora" aria-hidden="true" />}
      <main className="loading-stage">
        <m.section className="loading-card" variants={slideUp} initial={androidRuntime ? false : 'initial'} animate="animate">
          <div className="loading-brand-lockup">
            <img className="loading-logo" src={logoSrc} alt="" draggable={false} />
            <div>
              <span className="loading-kicker">Your reading room</span>
              <h1>Folio</h1>
            </div>
          </div>

          <div className="loading-copy" role="status" aria-live="polite">
            <h2>{headline}</h2>
            <p>{statusText}</p>
          </div>

          <div
            className="loading-progress"
            role="progressbar"
            aria-label={progressLabel}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progressValue)}
          >
            <div style={{ width: `${progressValue}%` }} />
          </div>

          <m.div className="loading-stages" variants={listStagger} initial="initial" animate="animate">
            {stages.map(({ icon: Icon, title, detail, state: stageState }) => (
              <m.div className={`loading-stage-item ${stageState}`} key={title} variants={listItem}>
                <span className="loading-stage-icon"><Icon size={17} /></span>
                <span className="loading-stage-copy"><strong>{title}</strong><small>{detail}</small></span>
                <span className="loading-stage-state" aria-hidden="true" />
              </m.div>
            ))}
          </m.div>

          <AnimatePresence>
            {downloadActive && (
              <m.p className="loading-download" variants={fadeIn} initial="initial" animate="animate" exit="exit">
                {formatDownload(downloadBytes)} of {downloadTotalBytes ? formatDownload(downloadTotalBytes) : 'the voice package'}
              </m.p>
            )}
          </AnimatePresence>

          <p className="loading-privacy">Your books, progress and narration stay on this device.</p>

          <AnimatePresence>
            {startupIssue && (
              <m.div className="startup-alert" variants={slideUp} initial="initial" animate="animate" exit="exit">
                <strong>{runtimeIssue ? 'Narration could not start' : 'The local library did not respond'}</strong>
                <span>{runtimeIssue ? activeRuntime.last_load_error : 'Try reopening Folio. If it still does not connect, the startup log can help.'}</span>
                <button
                  type="button"
                  className="view-logs-btn"
                  onClick={async () => {
                    const opened = await onOpenBackendLog?.()
                    if (!opened) window.alert(backendLogPath ? `Backend logs:\n${backendLogPath}` : 'Backend logs are not available in this runtime.')
                  }}
                >
                  View startup log
                </button>
              </m.div>
            )}
          </AnimatePresence>

        </m.section>
      </main>
    </div>
  )
}
