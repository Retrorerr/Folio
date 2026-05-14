export {}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown
    __TAURI__?: unknown
    __SLOWPILL__?: boolean | number | string
    __folioProgressDebug?: unknown
    __folioProgressTrace?: unknown
    __folioCursorDebug?: unknown
    __folioCursorWords?: unknown
    FOLIO_DEBUG_PAGE_TURN?: boolean
  }
}
