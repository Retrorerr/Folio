function isTauriRuntime(): boolean {
  if (typeof window === 'undefined') return false
  return Boolean(
    window.__TAURI_INTERNALS__ ||
    window.__TAURI__ ||
    window.location.protocol === 'tauri:' ||
    window.location.hostname === 'tauri.localhost',
  )
}

const runtimeBase = isTauriRuntime() ? 'http://127.0.0.1:8000' : ''
const baseUrl = (import.meta.env.VITE_API_BASE || runtimeBase).replace(/\/$/, '')
const previewWatchdogEnabled = import.meta.env.VITE_PREVIEW_WATCHDOG === '1'
const envApiToken = String(import.meta.env.VITE_FOLIO_API_TOKEN || '').trim()
const apiTokenHeader = 'X-Folio-Api-Token'
const apiTokenQuery = 'folio_token'
let cachedApiToken: string | null = envApiToken || null
let apiTokenPromise: Promise<string | null> | null = null

export { isTauriRuntime }

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
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const started = await invoke<boolean>('start_backend')
    await resolveApiToken()
    return started
  } catch (error) {
    console.warn('Folio backend start command failed', error)
    return false
  }
}

export async function stopBackend(): Promise<boolean> {
  if (!isTauriRuntime()) return false
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
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    return await invoke<string>('backend_log_path')
  } catch {
    return null
  }
}

export async function openBackendLog(): Promise<boolean> {
  if (!isTauriRuntime()) return false
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    return await invoke<boolean>('open_backend_log')
  } catch (error) {
    console.warn('Folio backend log command failed', error)
    return false
  }
}

export function isPreviewWatchdogEnabled(): boolean {
  return previewWatchdogEnabled
}

export function sendPreviewHeartbeat(): Promise<Response> | null {
  if (!previewWatchdogEnabled) return null
  return apiFetch('/api/preview/heartbeat', { method: 'POST', keepalive: true })
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
  return apiUrlWithToken(path)
}

export async function apiFetch(path: string, options?: RequestInit): Promise<Response> {
  const token = await resolveApiToken()
  return fetch(apiUrl(path), withApiToken(options, token))
}

export async function apiJson<T = unknown>(path: string, options?: RequestInit): Promise<T> {
  const url = apiUrl(path)
  const res = await apiFetch(path, options)
  const contentType = res.headers.get('content-type') || ''
  const text = await res.text()

  if (!res.ok) {
    throw new Error(text || `Request failed (${res.status})`)
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
