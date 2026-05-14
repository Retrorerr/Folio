import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import ErrorBoundary from './ErrorBoundary'

async function setTauriWindowIcon() {
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

setTauriWindowIcon()

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
