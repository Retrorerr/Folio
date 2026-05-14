import TitleBar from './TitleBar'
import { Icons } from './icons'
import type { BookState, TtsRuntimeInfo, TtsStatus } from '../types'

type LoadingScreenProps = {
  theme: string
  status: TtsStatus | null
  backendReachable: boolean
  recentLoaded: boolean
  recentBooks: BookState[]
  activeRuntime: TtsRuntimeInfo | null
  activeModelLoaded: boolean
  activeModelLoading: boolean
  timedOut: boolean
}

function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return 'Unavailable'
  const gb = bytes / (1024 ** 3)
  return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`
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
  status,
  backendReachable,
  recentLoaded,
  recentBooks,
  activeRuntime,
  activeModelLoaded,
  activeModelLoading,
  timedOut,
}: LoadingScreenProps) {
  const ram = status?.system?.ram
  const gpu = status?.system?.gpu
  const provider = providerLabel(activeRuntime, status)
  const hasRuntime = backendReachable && !!status
  const hasProvider = hasRuntime && provider !== 'Detecting'
  const hasVoices = (status?.voices ?? 0) > 0
  const modelSettled = activeModelLoaded || timedOut || !!activeRuntime?.last_load_error
  const ready = backendReachable && recentLoaded && modelSettled

  const stages = [
    {
      icon: Icons.Settings,
      title: 'Checking system',
      detail: backendReachable ? 'Requirements verified' : 'Waiting for local services',
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
      title: 'Loading model',
      detail: activeModelLoaded ? `${modelName(activeRuntime)} ready` : `${modelName(activeRuntime)} warming up`,
      state: stageState(activeModelLoaded, backendReachable && activeModelLoading && !activeModelLoaded),
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
      detail: hasVoices ? `${status?.voices} voices available` : 'Loading voice embeddings',
      state: stageState(hasVoices, activeModelLoaded && !hasVoices),
    },
    {
      icon: Icons.Feather,
      title: 'Warming up engine',
      detail: ready ? `${recentBooks.length} EPUB${recentBooks.length === 1 ? '' : 's'} indexed` : 'Optimizing the first reading pass',
      state: stageState(ready, backendReachable && recentLoaded && modelSettled && !ready),
    },
  ]
  const completed = stages.filter(s => s.state === 'done').length
  const progress = Math.min(96, Math.max(8, (completed / stages.length) * 100 + (ready ? 4 : 0)))
  const statusText = !backendReachable
    ? 'Starting Folio backend...'
    : !activeModelLoaded && activeModelLoading
      ? `Loading ${modelName(activeRuntime)} model to ${provider === 'CUDA' ? 'GPU' : provider}...`
      : !recentLoaded
        ? 'Loading your EPUB library...'
        : ready
          ? 'Opening your reading room...'
          : 'Preparing local voice runtime...'

  return (
    <div className={`loading-screen theme-${theme}`}>
      <TitleBar />
      <div className="loading-aurora" aria-hidden="true" />
      <main className="loading-stage">
        <section className="loading-hero">
          <div className="loading-brand-lockup">
            <img className="loading-logo" src="/folio-icon.png" alt="" draggable={false} />
            <h1>Folio</h1>
          </div>
          <div className="loading-kicker">Preparing your reading experience</div>
          <p>Folio is initializing the local AI engine and restoring your library. This may take a few moments on first run.</p>

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
        </section>

        <section className="loading-checklist" aria-label="Initialization progress">
          {stages.map(({ icon: Icon, title, detail, state }) => (
            <div className={`loading-step ${state}`} key={title}>
              <div className="loading-step-icon"><Icon size={17} /></div>
              <div>
                <strong>{title}</strong>
                <span>{detail}</span>
              </div>
              <div className="loading-step-state" aria-hidden="true" />
            </div>
          ))}
        </section>
      </main>

      <footer className="loading-footer">
        <div className="loading-status-row">
          <span>{statusText}</span>
          <strong>{Math.round(progress)}%</strong>
        </div>
        <div className="loading-progress"><div style={{ width: `${progress}%` }} /></div>
        <div className="loading-metrics">
          <div><Icons.Speed size={15} /><span>VRAM Usage</span><strong>{gpu ? `${(gpu.vram_used_mb / 1024).toFixed(1)} GB / ${(gpu.vram_total_mb / 1024).toFixed(0)} GB` : 'Unavailable'}</strong></div>
          <div><Icons.Library size={15} /><span>System RAM</span><strong>{ram ? `${formatBytes(ram.used_bytes)} / ${formatBytes(ram.total_bytes)}` : 'Unavailable'}</strong></div>
          <div><i className={`status-dot ${backendReachable ? 'online' : ''}`} /><span>Backend</span><strong>{backendReachable ? 'Connected' : 'Starting'}</strong></div>
          <button type="button" className="view-logs-btn" onClick={() => window.alert('Folio backend logs are written beside the local backend process.')}>
            <span>›_</span> View Logs
          </button>
        </div>
      </footer>
    </div>
  )
}
