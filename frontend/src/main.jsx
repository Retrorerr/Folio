import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

async function setTauriWindowIcon() {
  if (typeof window === 'undefined' || !window.__TAURI_INTERNALS__) return

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

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
