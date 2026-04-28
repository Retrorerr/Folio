const baseUrl = (import.meta.env.VITE_API_BASE || '').replace(/\/$/, '')

export function apiUrl(path) {
  return `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`
}

export function apiFetch(path, options) {
  return fetch(apiUrl(path), options)
}
