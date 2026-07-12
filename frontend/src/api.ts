import { isAndroidRuntime, isTauriRuntime } from './platform'

const runtimeBase = isTauriRuntime() && !isAndroidRuntime() ? 'http://127.0.0.1:8000' : ''
let baseUrl = (import.meta.env.VITE_API_BASE || runtimeBase).replace(/\/$/, '')
const previewWatchdogEnabled = import.meta.env.VITE_PREVIEW_WATCHDOG === '1'
const envApiToken = String(import.meta.env.VITE_FOLIO_API_TOKEN || '').trim()
const apiTokenHeader = 'X-Folio-Api-Token'
const apiTokenQuery = 'folio_token'
let cachedApiToken: string | null = envApiToken || null
let apiTokenPromise: Promise<string | null> | null = null

export { isAndroidRuntime, isTauriRuntime } from './platform'

async function resolveApiToken(): Promise<string | null> {
  if (cachedApiToken) return cachedApiToken
  if (!isTauriRuntime()) return null
  if (!apiTokenPromise) {
    apiTokenPromise = import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke<string>('get_api_token'))
      .then((token) => {
        cachedApiToken = String(token || '').trim() || null
        return cachedApiToken
      })
      .catch((error) => {
        console.warn('Folio API token command failed', error)
        return null
      })
  }
  return apiTokenPromise
}

function cachedToken(): string | null {
  return cachedApiToken
}

function withApiToken(options: RequestInit | undefined, token: string | null): RequestInit | undefined {
  if (!token) return options
  const headers = new Headers(options?.headers)
  headers.set(apiTokenHeader, token)
  return { ...options, headers }
}

function apiUrlWithToken(path: string): string {
  const token = cachedToken()
  const url = new URL(apiUrl(path), window.location.href)
  if (token && url.pathname.startsWith('/api/')) {
    url.searchParams.set(apiTokenQuery, token)
  }
  return url.toString()
}

export async function startBackend(): Promise<boolean> {
  if (!isTauriRuntime()) return false
  if (isAndroidRuntime()) return true
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const port = await invoke<number>('start_backend')
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Folio returned an invalid backend port: ${port}`)
    }
    baseUrl = `http://127.0.0.1:${port}`
    await resolveApiToken()
    return true
  } catch (error) {
    console.warn('Folio backend start command failed', error)
    return false
  }
}

export async function stopBackend(): Promise<boolean> {
  if (!isTauriRuntime()) return false
  if (isAndroidRuntime()) return true
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    return await invoke<boolean>('stop_backend')
  } catch (error) {
    console.warn('Folio backend stop command failed', error)
    return false
  }
}

export async function takePendingOpenFile(): Promise<string | null> {
  if (!isTauriRuntime()) return null
  if (isAndroidRuntime()) return null
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    return await invoke<string | null>('take_pending_open_file')
  } catch (error) {
    console.warn('Folio pending file command failed', error)
    return null
  }
}

export async function listenForOpenFile(handler: (filepath: string) => void): Promise<() => void> {
  if (!isTauriRuntime()) return () => {}
  if (isAndroidRuntime()) return () => {}
  try {
    const { listen } = await import('@tauri-apps/api/event')
    return await listen<string>('folio-open-file', (event) => {
      if (typeof event.payload === 'string' && event.payload.toLowerCase().endsWith('.epub')) {
        handler(event.payload)
      }
    })
  } catch (error) {
    console.warn('Folio file-open listener failed', error)
    return () => {}
  }
}

export async function getBackendLogPath(): Promise<string | null> {
  if (!isTauriRuntime()) return null
  if (isAndroidRuntime()) return null
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    return await invoke<string>('backend_log_path')
  } catch {
    return null
  }
}

export async function openBackendLog(): Promise<boolean> {
  if (!isTauriRuntime()) return false
  if (isAndroidRuntime()) return false
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    return await invoke<boolean>('open_backend_log')
  } catch (error) {
    console.warn('Folio backend log command failed', error)
    return false
  }
}

export async function selectLibraryFolder(initialDir?: string | null): Promise<string | null> {
  if (!isTauriRuntime()) return null
  if (isAndroidRuntime()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const selected = await invoke<{ uri?: string; persisted?: boolean }>('plugin:mobile-runtime|pick_folder', { payload: { initialUri: initialDir || null } })
      if (selected?.uri && selected.persisted === false) {
        throw new Error('That provider did not grant persistent folder access. Choose a different location.')
      }
      return selected?.uri || null
    } catch (error) {
      console.warn('Folio Android folder picker failed', error)
      throw error instanceof Error ? error : new Error('The Android folder picker failed.')
    }
  }
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const selected = await invoke<string | null>('select_library_folder', { initialDir: initialDir || null })
    return typeof selected === 'string' && selected.trim() ? selected : null
  } catch (error) {
    console.warn('Folio library folder picker failed', error)
    return null
  }
}

export function isPreviewWatchdogEnabled(): boolean {
  return previewWatchdogEnabled
}

export function sendPreviewHeartbeat(): Promise<Response> | null {
  if (!previewWatchdogEnabled) return null
  return apiFetch('/api/preview/heartbeat', { method: 'POST', keepalive: true })
}

export function sendAppHeartbeat(): Promise<Response> | null {
  if (typeof window === 'undefined') return null
  if (isAndroidRuntime()) return null
  return apiFetch('/api/app/heartbeat', { method: 'POST', keepalive: true })
}

export function notifyPreviewDisconnect(): boolean {
  if (!previewWatchdogEnabled) return false
  const payload = new Blob(['disconnect'], { type: 'text/plain' })
  return navigator.sendBeacon(apiUrlWithToken('/api/preview/disconnect'), payload)
}

export function apiUrl(path: string): string {
  return `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`
}

export function apiResourceUrl(path: string): string {
  if (isAndroidRuntime()) {
    // Android resources are kept in the local adapter. Audio URLs are cached
    // synchronously after generation, while EPUB covers are data URLs.
    const mobilePath = path
    if (mobilePath.startsWith('data:') || mobilePath.startsWith('blob:')) return mobilePath
    const cached = (globalThis as { __folioMobileResourceUrl?: (value: string) => string }).__folioMobileResourceUrl
    return cached ? cached(mobilePath) : mobilePath
  }
  return apiUrlWithToken(path)
}

export async function apiFetch(path: string, options?: RequestInit): Promise<Response> {
  if (isAndroidRuntime()) {
    const { mobileApiFetch } = await import('./mobileApi')
    return mobileApiFetch(path, options)
  }
  const token = await resolveApiToken()
  return fetch(apiUrl(path), withApiToken(options, token))
}

export async function apiJson<T = unknown>(path: string, options?: RequestInit): Promise<T> {
  const url = apiUrl(path)
  const res = await apiFetch(path, options)
  const contentType = res.headers.get('content-type') || ''
  const text = await res.text()

  if (!res.ok) {
    let message = text || `Request failed (${res.status})`
    if (contentType.toLowerCase().includes('application/json') && text) {
      try {
        const data = JSON.parse(text)
        if (typeof data?.detail === 'string') message = data.detail
        else if (typeof data?.message === 'string') message = data.message
      } catch {
        // Keep the raw response text if the server labels non-JSON as JSON.
      }
    }
    throw new Error(message)
  }

  if (!contentType.toLowerCase().includes('application/json')) {
    const preview = text.replace(/\s+/g, ' ').slice(0, 160)
    throw new Error(`Expected JSON from ${url}, got ${contentType || 'unknown content type'}: ${preview}`)
  }

  try {
    return JSON.parse(text) as T
  } catch (error) {
    const preview = text.replace(/\s+/g, ' ').slice(0, 160)
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Could not parse JSON from ${url}: ${message}. Response starts: ${preview}`)
  }
}
