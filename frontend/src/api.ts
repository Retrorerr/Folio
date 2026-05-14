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

export function apiUrl(path: string): string {
  return `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`
}

export function apiFetch(path: string, options?: RequestInit): Promise<Response> {
  return fetch(apiUrl(path), options)
}

export async function apiJson<T = unknown>(path: string, options?: RequestInit): Promise<T> {
  const url = apiUrl(path)
  const res = await fetch(url, options)
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
