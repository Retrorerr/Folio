import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import ErrorBoundary from './ErrorBoundary'

function isTauriRuntime(): boolean {
  return Boolean(
    window.__TAURI_INTERNALS__ ||
    window.__TAURI__ ||
    window.location.protocol === 'tauri:' ||
    window.location.hostname === 'tauri.localhost',
  )
}

async function setTauriWindowIcon() {
  if (!isTauriRuntime()) return
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

void setTauriWindowIcon()

const root = document.getElementById('root')

if (!root) {
  throw new Error('Folio root element was not found')
}

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
