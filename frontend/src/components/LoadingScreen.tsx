import { AnimatePresence, motion as m } from 'motion/react'
import TitleBar from './TitleBar'
import { Icons } from './icons'
import { fadeIn, listItem, listStagger, slideUp, spring } from '../motion'
import type { BookState, TtsRuntimeInfo, TtsStatus } from '../types'

type LoadingScreenProps = {
  theme: string
  motion: boolean
  status: TtsStatus | null
  backendReachable: boolean
  recentLoaded: boolean
  recentBooks: BookState[]
  activeRuntime: TtsRuntimeInfo | null
  activeModelLoaded: boolean
  activeModelLoading: boolean
  timedOut: boolean
  backendStartCommandFailed?: boolean
  backendLogPath?: string | null
  onOpenBackendLog?: () => Promise<boolean>
}

function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return 'Unavailable'
  const gb = bytes / (1024 ** 3)
  return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`
}

function formatDownload(bytes?: number): string {
  if (!bytes || bytes <= 0) return '0 MB'
  const mb = bytes / (1024 ** 2)
  if (mb < 1024) return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`
  return `${(mb / 1024).toFixed(1)} GB`
}

function providerLabel(runtime: TtsRuntimeInfo | null, status: TtsStatus | null): string {
  const selectedDevice = String(runtime?.selected_device || '').toLowerCase()
  const selectedProvider = String(runtime?.selected_provider || runtime?.provider || '').toLowerCase()
  if (selectedDevice === 'cuda' || selectedProvider.includes('cuda') || status?.gpu) return 'CUDA'
  if (selectedProvider.includes('tensorrt')) return 'TensorRT'
  if (selectedProvider.includes('cpu')) return 'CPU'
  return status ? 'Detecting' : 'Starting'
}

function modelName(runtime: TtsRuntimeInfo | null): string {
  const selected = runtime?.selected_model || runtime?.model_id || runtime?.hf_repo_id
  if (typeof selected === 'string' && selected) return selected.replace(/\.onnx$/i, '')
  return 'Kokoro v1.0'
}

function precisionLabel(runtime: TtsRuntimeInfo | null): string {
  const dtype = runtime?.onnx_dtype
  if (typeof dtype === 'string' && dtype) return dtype.toUpperCase()
  if (runtime?.int8_fallback_used) return 'INT8'
  return 'FP16'
}

function stageState(done: boolean, active: boolean): 'done' | 'active' | 'pending' {
  if (done) return 'done'
  if (active) return 'active'
  return 'pending'
}

export default function LoadingScreen({
  theme,
  motion,
  status,
  backendReachable,
  recentLoaded,
  recentBooks,
  activeRuntime,
  activeModelLoaded,
  activeModelLoading,
  timedOut,
  backendStartCommandFailed = false,
  backendLogPath,
  onOpenBackendLog,
}: LoadingScreenProps) {
  const useGoldLogo = theme === 'light' || theme === 'sepia'
  const logoSrc = useGoldLogo ? '/folio-icon.png' : '/folio-monochrome-icon.png'
  const ram = status?.system?.ram
  const gpu = status?.system?.gpu
  const provider = providerLabel(activeRuntime, status)
  const hasRuntime = backendReachable && !!status
  const hasProvider = hasRuntime && provider !== 'Detecting'
  const hasVoices = (status?.voices ?? 0) > 0
  const downloadActive = !!activeRuntime?.download_active
  const downloadBytes = Number(activeRuntime?.download_bytes || 0)
  const downloadTotalBytes = Number(activeRuntime?.download_total_bytes || 0)
  const downloadPct = downloadTotalBytes > 0
    ? Math.min(99, Math.max(1, (downloadBytes / downloadTotalBytes) * 100))
    : 0
  const downloadLabel = typeof activeRuntime?.download_label === 'string' && activeRuntime.download_label
    ? activeRuntime.download_label
    : 'Kokoro voice model'
  const modelSettled = activeModelLoaded || !activeModelLoading
  const ready = backendReachable && recentLoaded
  const startupIssue = (!backendReachable && (timedOut || backendStartCommandFailed)) || !!activeRuntime?.last_load_error

  const stages = [
    {
      icon: Icons.Settings,
      title: 'Checking system',
      detail: backendReachable ? 'Requirements verified' : (backendStartCommandFailed ? 'Backend did not start cleanly' : 'Waiting for local services'),
      state: stageState(backendReachable, !backendReachable),
    },
    {
      icon: Icons.Locate,
      title: 'Detecting hardware',
      detail: gpu?.name ? `${gpu.name} detected` : (hasRuntime ? `${provider} execution path` : 'Scanning providers'),
      state: stageState(hasProvider, backendReachable && !hasProvider),
    },
    {
      icon: Icons.Download,
      title: downloadActive ? 'Downloading model' : 'Voice models',
      detail: downloadActive
        ? `${downloadLabel} ${downloadPct ? `${Math.round(downloadPct)}%` : 'starting'}`
        : activeModelLoaded
          ? `${modelName(activeRuntime)} ready`
          : 'Install a voice engine when you want narration',
      state: stageState(activeModelLoaded || !downloadActive, backendReachable && downloadActive && !activeModelLoaded),
    },
    {
      icon: Icons.Speed,
      title: 'Initializing ONNX Runtime',
      detail: activeRuntime?.selected_provider ? String(activeRuntime.selected_provider) : 'Setting up execution provider',
      state: stageState(hasRuntime && !!activeRuntime?.selected_provider, backendReachable && !activeRuntime?.selected_provider),
    },
    {
      icon: Icons.Volume,
      title: 'Preparing voices',
      detail: hasVoices ? `${status?.voices} voices available` : 'Voices appear after an engine is installed',
      state: stageState(hasVoices || !activeModelLoaded, activeModelLoaded && !hasVoices),
    },
    {
      icon: Icons.Feather,
      title: 'Warming up engine',
      detail: ready ? `${recentBooks.length} EPUB${recentBooks.length === 1 ? '' : 's'} indexed` : 'Optimizing the first reading pass',
      state: stageState(ready, backendReachable && recentLoaded && modelSettled && !ready),
    },
  ]
  const completed = stages.filter(s => s.state === 'done').length
  const bootProgress = Math.min(96, Math.max(6, (completed / stages.length) * 100 + (ready ? 4 : 0)))
  const progressValue = downloadActive && downloadPct ? downloadPct : bootProgress
  const progressLabel = downloadActive && downloadPct ? `${Math.round(downloadPct)}%` : `${Math.round(bootProgress)}%`
  const backendPhase = !backendReachable
    ? 'Waiting for backend process'
    : !hasProvider
      ? 'Resolving execution provider'
      : !recentLoaded
        ? 'Loading EPUB library'
        : activeModelLoading
          ? 'Loading voice model'
          : 'Ready'
  const statusText = !backendReachable
    ? (startupIssue ? 'Folio could not reach the backend.' : 'Starting Folio backend...')
    : downloadActive
      ? `Downloading ${downloadLabel}...`
    : !activeModelLoaded && activeModelLoading
      ? `Loading ${modelName(activeRuntime)} model to ${provider === 'CUDA' ? 'GPU' : provider}...`
      : !recentLoaded
        ? 'Loading your EPUB library...'
        : ready
          ? 'Opening your reading room...'
          : 'Preparing your library...'

  return (
    <m.div className={`loading-screen theme-${theme}${motion ? ' motion-enabled' : ' motion-reduced'}`} aria-busy={!ready} layout transition={spring.layout}>
      <TitleBar />
      {motion && <div className="loading-aurora" aria-hidden="true" />}
      <m.main className="loading-stage" variants={listStagger} initial="initial" animate="animate">
        <m.section className="loading-hero" variants={slideUp}>
          <div className="loading-brand-lockup">
            <img className="loading-logo" src={logoSrc} alt="" draggable={false} />
            <h1>Folio</h1>
          </div>
          <div className="loading-kicker">Preparing your reading experience</div>
          <p>{statusText}</p>
          <AnimatePresence>
            {startupIssue && (
              <m.div className="startup-alert" role="status" variants={slideUp} initial="initial" animate="animate" exit="exit">
                <strong>Startup needs attention</strong>
                <span>
                  {activeRuntime?.last_load_error
                    ? activeRuntime.last_load_error
                    : backendLogPath
                      ? `Backend logs: ${backendLogPath}`
                      : 'The local backend did not answer before the startup timeout.'}
                </span>
              </m.div>
            )}
          </AnimatePresence>

          <div className="hardware-card">
            <div>
              <span>Active Provider</span>
              <strong><i className={`status-dot ${backendReachable ? 'online' : ''}`} />{provider}</strong>
              <small>{gpu?.name || (provider === 'CPU' ? 'Local CPU fallback' : 'Detecting hardware')}</small>
            </div>
            <div>
              <span>Model</span>
              <strong>{modelName(activeRuntime)} <b>{precisionLabel(activeRuntime)}</b></strong>
            </div>
          </div>
        </m.section>

        <m.section className="loading-checklist" aria-label="Initialization progress" variants={listStagger}>
          {stages.map(({ icon: Icon, title, detail, state }) => (
            <m.div className={`loading-step ${state}`} key={title} variants={listItem} layout>
              <div className="loading-step-icon"><Icon size={17} /></div>
              <div>
                <strong>{title}</strong>
                <span>{detail}</span>
              </div>
              <div className="loading-step-state" aria-hidden="true" />
            </m.div>
          ))}
        </m.section>
      </m.main>

      <m.footer className="loading-footer" variants={fadeIn} initial="initial" animate="animate">
        <div className="loading-status-row">
          <span>{statusText}</span>
          <strong>{progressLabel}</strong>
        </div>
        <div
          className="loading-progress"
          role="progressbar"
          aria-label={downloadActive ? `Downloading ${downloadLabel}` : backendPhase}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progressValue)}
        >
          <div style={{ width: `${progressValue}%` }} />
        </div>
        <div className="loading-metrics">
          <div><Icons.Speed size={15} /><span>VRAM Usage</span><strong>{gpu ? `${(gpu.vram_used_mb / 1024).toFixed(1)} GB / ${(gpu.vram_total_mb / 1024).toFixed(0)} GB` : 'Unavailable'}</strong></div>
          <div><Icons.Library size={15} /><span>System RAM</span><strong>{ram ? `${formatBytes(ram.used_bytes)} / ${formatBytes(ram.total_bytes)}` : 'Unavailable'}</strong></div>
          <AnimatePresence>
            {downloadActive && (
              <m.div variants={slideUp} initial="initial" animate="animate" exit="exit">
                <Icons.Download size={15} /><span>Download</span><strong>{formatDownload(downloadBytes)} / {downloadTotalBytes ? formatDownload(downloadTotalBytes) : 'calculating'}</strong>
              </m.div>
            )}
          </AnimatePresence>
          <div><i className={`status-dot ${backendReachable ? 'online' : ''}`} /><span>Backend</span><strong>{backendReachable ? 'Connected' : 'Starting'}</strong></div>
          <div><Icons.Locate size={15} /><span>Current Step</span><strong>{backendPhase}</strong></div>
          <button
            type="button"
            className="view-logs-btn"
            onClick={async () => {
              const opened = await onOpenBackendLog?.()
              if (!opened) window.alert(backendLogPath ? `Backend logs:\n${backendLogPath}` : 'Backend logs are not available in this runtime.')
            }}
          >
            <span>›_</span> View Logs
          </button>
        </div>
      </m.footer>
    </m.div>
  )
}
