export type AndroidShellMode = 'phone-portrait' | 'phone-landscape' | 'tablet-portrait' | 'tablet-landscape'
export type AndroidSwipeDirection = 'left' | 'right'

export type AndroidWindowInsets = {
  top?: number
  right?: number
  bottom?: number
  left?: number
  imeBottom?: number
}

export type AndroidPlatformMetrics = {
  windowInsets?: AndroidWindowInsets
  density?: number
  refreshRate?: number
}

function isAndroidDocument(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dataset.platform === 'android'
}

export function androidShellMode(): AndroidShellMode {
  if (!isAndroidDocument() || typeof window === 'undefined') return 'tablet-portrait'
  const portrait = window.matchMedia?.('(orientation: portrait)').matches ?? window.innerHeight >= window.innerWidth
  // WebView CSS pixels track Android density-independent pixels. The shortest
  // usable side is therefore the stable posture signal: the tablet emulator
  // is 800dp wide in portrait while a 1080px phone is roughly 411dp wide.
  // This also keeps compact phone navigation in phone landscape instead of
  // introducing a desktop rail simply because the device rotated.
  const compact = Math.min(window.innerWidth, window.innerHeight) < 600
  if (compact) return portrait ? 'phone-portrait' : 'phone-landscape'
  return portrait ? 'tablet-portrait' : 'tablet-landscape'
}

export function isAndroidPhoneMode(mode = androidShellMode()): boolean {
  return mode === 'phone-portrait' || mode === 'phone-landscape'
}

export function applyAndroidShellMode(): AndroidShellMode {
  const mode = androidShellMode()
  if (isAndroidDocument()) {
    const previous = document.documentElement.dataset.androidShell
    document.documentElement.dataset.androidShell = mode
    if (previous && previous !== mode) {
      window.dispatchEvent(new CustomEvent('folio:android-shell-change', { detail: { mode } }))
    }
  }
  return mode
}

export function applyAndroidPlatformMetrics(metrics?: AndroidPlatformMetrics | null): void {
  if (!isAndroidDocument() || !metrics) return
  const root = document.documentElement
  const insets = metrics.windowInsets || {}
  const setPixels = (name: string, value: unknown) => {
    const parsed = Number(value)
    root.style.setProperty(name, `${Number.isFinite(parsed) ? Math.max(0, parsed) : 0}px`)
  }
  setPixels('--android-inset-top', insets.top)
  setPixels('--android-inset-right', insets.right)
  setPixels('--android-inset-bottom', insets.bottom)
  setPixels('--android-inset-left', insets.left)
  setPixels('--android-ime-bottom', insets.imeBottom)
  if (Number.isFinite(Number(metrics.refreshRate))) {
    root.style.setProperty('--android-refresh-rate', String(metrics.refreshRate))
  }
}

export async function syncAndroidSystemBars(theme: string): Promise<void> {
  if (!isAndroidDocument()) return
  const darkBackground = theme === 'dark' || theme === 'folio' || theme === 'blackleaf'
  const backgroundColor = ({
    light: '#edf0f2',
    sepia: '#ede0c4',
    dark: '#10171d',
    folio: '#0c0d0f',
    blackleaf: '#030303',
  } as Record<string, string>)[theme] || '#ede0c4'
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('plugin:mobile-runtime|set_system_bars', { payload: { darkBackground, backgroundColor } })
  } catch {
    // Older debug APKs do not expose the command. The next native preview
    // rebuild installs it; CSS still paints a safe matching background.
  }
}

export async function performAndroidHaptic(kind: 'selection' | 'confirm' = 'selection'): Promise<void> {
  if (!isAndroidDocument()) return
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('plugin:mobile-runtime|perform_haptic', { payload: { kind } })
  } catch {
    // Haptics are an enhancement and may be disabled by the user or device.
  }
}

/**
 * Keeps CSS breakpoints and the React shell on the same device classification.
 * Android WebView can change its viewport class after rotation without a full
 * page reload, so this is intentionally installed at boot.
 */
export function installAndroidShellModeListener(): () => void {
  if (!isAndroidDocument()) return () => {}
  applyAndroidShellMode()
  const onViewportChange = () => applyAndroidShellMode()
  window.addEventListener('resize', onViewportChange, { passive: true })
  window.addEventListener('orientationchange', onViewportChange, { passive: true })
  return () => {
    window.removeEventListener('resize', onViewportChange)
    window.removeEventListener('orientationchange', onViewportChange)
  }
}

/**
 * Shared horizontal navigation gesture for the Android shell. Buttons remain
 * swipeable so a gesture can begin on the minimized rail; text-entry controls
 * are excluded so horizontal cursor selection is never hijacked.
 */
export function installAndroidHorizontalSwipeListener(
  onSwipe: (direction: AndroidSwipeDirection) => void,
): () => void {
  if (!isAndroidDocument()) return () => {}
  const gesture = {
    pointerId: -1,
    x: 0,
    y: 0,
    allowed: false,
    lastDispatchAt: 0,
    suppressClickUntil: 0,
  }
  const dispatch = (x: number, y: number, minDistance: number) => {
    const dx = x - gesture.x
    const dy = y - gesture.y
    if (!gesture.allowed || Math.abs(dx) < minDistance || Math.abs(dx) < Math.abs(dy) * 1.35) return
    const now = Date.now()
    if (now - gesture.lastDispatchAt < 400) return
    gesture.lastDispatchAt = now
    gesture.suppressClickUntil = now + 420
    gesture.allowed = false
    onSwipe(dx > 0 ? 'right' : 'left')
  }
  const onPointerDown = (event: PointerEvent) => {
    if (isAndroidPhoneMode() || !event.isPrimary) return
    const target = event.target as HTMLElement | null
    if (target?.closest('input, textarea, select, [contenteditable="true"], .settings-overlay, .model-install-overlay')) return
    const navigationSurface = target?.closest('.sidebar-wrap, .icon-rail, .sidebar-panel, .dash-sidebar')
    gesture.pointerId = event.pointerId
    gesture.x = event.clientX
    gesture.y = event.clientY
    // A right-open gesture may begin in the minimized rail/edge. A left-close
    // gesture must begin on the navigation surface, never in reader content.
    gesture.allowed = event.clientX <= 96 || Boolean(navigationSurface)
  }
  const onPointerUp = (event: PointerEvent) => {
    if (event.pointerId !== gesture.pointerId) return
    gesture.pointerId = -1
    dispatch(event.clientX, event.clientY, 64)
  }
  const onPointerMove = (event: PointerEvent) => {
    if (event.pointerId !== gesture.pointerId) return
    // Android may issue pointercancel as soon as WebView hands a gesture to its
    // scroll recognizer. Recognize the horizontal intent as it crosses the
    // threshold so the drawer does not depend on receiving a final pointerup.
    // WebView can cancel the pointer after its first ~40 px move. Recognize a
    // clearly horizontal navigation swipe before that hand-off.
    dispatch(event.clientX, event.clientY, 36)
  }
  const onPointerCancel = () => {
    gesture.pointerId = -1
    gesture.allowed = false
  }
  const onClick = (event: MouseEvent) => {
    if (Date.now() >= gesture.suppressClickUntil) return
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  document.addEventListener('pointerdown', onPointerDown, { passive: true })
  document.addEventListener('pointermove', onPointerMove, { passive: true })
  document.addEventListener('pointerup', onPointerUp, { passive: true })
  document.addEventListener('pointercancel', onPointerCancel, { passive: true })
  document.addEventListener('click', onClick, true)
  return () => {
    document.removeEventListener('pointerdown', onPointerDown)
    document.removeEventListener('pointermove', onPointerMove)
    document.removeEventListener('pointerup', onPointerUp)
    document.removeEventListener('pointercancel', onPointerCancel)
    document.removeEventListener('click', onClick, true)
  }
}
