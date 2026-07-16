import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/fonts.css'
import './index.css'
import './styles/android.css'
import App from './App'
import ErrorBoundary from './ErrorBoundary'
import { isAndroidRuntime, isTauriRuntime, requireAndroidBridge } from './platform'
import { installAndroidScrollFades, installAndroidShellModeListener } from './androidShell'

async function setTauriWindowIcon() {
  if (!isTauriRuntime() || isAndroidRuntime()) return
  try {
    const [{ getCurrentWindow }, { Image }] = await Promise.all([
      import('@tauri-apps/api/window'),
      import('@tauri-apps/api/image'),
    ])
    const res = await fetch('/folio-icon.png')
    const bytes = new Uint8Array(await res.arrayBuffer())
    const icon = await Image.fromBytes(bytes)
    await getCurrentWindow().setIcon(icon)
  } catch (error) {
    console.warn('Unable to set Folio window icon', error)
  }
}

const root = document.getElementById('root')

if (!root) {
  throw new Error('Folio root element was not found')
}

const reactRoot = createRoot(root)

function markWebContentReady() {
  // The native Android overlay owns the visible launch surface. Signal only
  // after React has committed and the browser has crossed two paint frames, so
  // native never waits on a bootstrap DOM node that React has already replaced.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      document.documentElement.dataset.folioWebReady = 'true'
    })
  })
}

async function boot() {
  let disposeAndroidShellMode = () => {}
  let disposeAndroidScrollFades = () => {}
  if (isAndroidRuntime()) {
    document.documentElement.dataset.platform = 'android'
    disposeAndroidShellMode = installAndroidShellModeListener()
    disposeAndroidScrollFades = installAndroidScrollFades()
    window.addEventListener('pagehide', () => {
      disposeAndroidScrollFades()
      disposeAndroidShellMode()
    }, { once: true })
  }

  try {
    await requireAndroidBridge()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    reactRoot.render(
      <main className="runtime-boot-error" role="alert" data-android-scroll-fade>
        <h1>Folio could not start</h1>
        <p>{message}</p>
        <p>Reinstall this Android build. Folio will not fall back to a desktop or network backend.</p>
      </main>,
    )
    markWebContentReady()
    return
  }

  void setTauriWindowIcon()
  reactRoot.render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  )
  markWebContentReady()
}

void boot()
