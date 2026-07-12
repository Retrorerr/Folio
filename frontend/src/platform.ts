export type FolioPlatform = 'android' | 'desktop' | 'web'

const configuredPlatform = String(import.meta.env.VITE_FOLIO_PLATFORM || '')
  .trim()
  .toLowerCase()

export function isTauriRuntime(): boolean {
  if (typeof window === 'undefined') return false
  return Boolean(
    (globalThis as { isTauri?: boolean }).isTauri ||
    window.__TAURI_INTERNALS__ ||
    window.__TAURI__ ||
    window.location.protocol === 'tauri:' ||
    window.location.hostname === 'tauri.localhost',
  )
}

export function isAndroidRuntime(): boolean {
  return configuredPlatform === 'android'
}

export function folioPlatform(): FolioPlatform {
  if (isAndroidRuntime()) return 'android'
  return isTauriRuntime() ? 'desktop' : 'web'
}

export type AndroidPlatformStatus = {
  platform: string
  nativeTtsAvailable: boolean
  modelRoot: string
  modelAssets: Record<string, unknown>
}

export async function requireAndroidBridge(): Promise<AndroidPlatformStatus | null> {
  if (!isAndroidRuntime()) return null
  if (!isTauriRuntime()) {
    throw new Error('This Android build could not find the Folio native runtime bridge.')
  }

  const { invoke } = await import('@tauri-apps/api/core')
  const status = await invoke<AndroidPlatformStatus>('plugin:mobile-runtime|platform_status')
  if (status?.platform !== 'android') {
    throw new Error('The Folio Android runtime returned an invalid platform status.')
  }
  try {
    await navigator.storage?.persist?.()
  } catch {
    // Android WebView app data is still sandboxed; persistence may be unavailable
    // on older providers, so this is a best-effort durability request.
  }
  return status
}
