export type AndroidShellMode = 'phone-portrait' | 'phone-landscape' | 'tablet-portrait' | 'tablet-landscape'
export type AndroidSwipeDirection = 'left' | 'right'

export type AndroidWindowInsets = {
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
  setPixels('--android-ime-bottom', insets.imeBottom)
  if (Number.isFinite(Number(metrics.refreshRate))) {
    root.style.setProperty('--android-refresh-rate', String(metrics.refreshRate))
  }
}

export async function syncAndroidSystemBars(theme: string): Promise<void> {
  if (!isAndroidDocument()) return
  const darkBackground = theme === 'dark' || theme === 'folio' || theme === 'blackleaf'
  const backgroundColor = ({
    light: '#f7f4ed',
    sepia: '#f3e7cf',
    dark: '#111417',
    folio: '#090a0c',
    blackleaf: '#000000',
  } as Record<string, string>)[theme] || '#f3e7cf'
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('plugin:mobile-runtime|set_system_bars', {
      payload: { theme, darkBackground, backgroundColor },
    })
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

export async function backgroundAndroidApp(): Promise<boolean> {
  if (!isAndroidDocument()) return false
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const result = await invoke<{ backgrounded?: boolean }>('plugin:mobile-runtime|background_app')
    return result.backgrounded === true
  } catch (error) {
    console.warn('Android native background command failed', error)
    return false
  }
}

const ANDROID_SCROLL_FADE_SELECTOR = '[data-android-scroll-fade]'

type AndroidScrollFadeOverlay = {
  top: HTMLDivElement
  bottom: HTMLDivElement
}

/**
 * Applies edge fades only to declared vertical scroll viewports, and only in
 * directions where more content exists. Persistent chrome deliberately lives
 * outside these viewports, so navigation bars and playback controls never get
 * washed out by a screen-wide overlay.
 */
export function installAndroidScrollFades(): () => void {
  if (!isAndroidDocument()) return () => {}

  const tracked = new Set<HTMLElement>()
  const pending = new Set<HTMLElement>()
  const overlays = new Map<HTMLElement, AndroidScrollFadeOverlay>()
  const overlayLayer = document.createElement('div')
  overlayLayer.className = 'android-scroll-fade-layer'
  overlayLayer.setAttribute('aria-hidden', 'true')
  document.body.append(overlayLayer)

  let animationFrame = 0
  let pendingAll = false
  let disposed = false
  let resizeObserver: ResizeObserver | null = null

  const createOverlay = (): AndroidScrollFadeOverlay => {
    const top = document.createElement('div')
    const bottom = document.createElement('div')
    top.className = 'android-scroll-fade-band android-scroll-fade-band-top'
    bottom.className = 'android-scroll-fade-band android-scroll-fade-band-bottom'
    top.hidden = true
    bottom.hidden = true
    overlayLayer.append(top, bottom)
    return { top, bottom }
  }

  const setStyle = (element: HTMLElement, property: string, value: string) => {
    if (element.style.getPropertyValue(property) !== value) element.style.setProperty(property, value)
  }

  const clearFadeState = (element: HTMLElement) => {
    delete element.dataset.androidScrollFadeUp
    delete element.dataset.androidScrollFadeDown
  }

  const untrack = (element: HTMLElement) => {
    resizeObserver?.unobserve(element)
    clearFadeState(element)
    const overlay = overlays.get(element)
    overlay?.top.remove()
    overlay?.bottom.remove()
    overlays.delete(element)
    tracked.delete(element)
    pending.delete(element)
  }

  const updateFadeState = (element: HTMLElement) => {
    if (!element.isConnected || !element.matches(ANDROID_SCROLL_FADE_SELECTOR)) {
      untrack(element)
      return
    }

    const style = window.getComputedStyle(element)
    const overflowY = style.overflowY
    const acceptsVerticalScroll = overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay'
    const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight)
    const hasOverflow = acceptsVerticalScroll && maxScrollTop > 2
    const canScrollUp = hasOverflow && element.scrollTop > 1
    const canScrollDown = hasOverflow && element.scrollTop < maxScrollTop - 1
    const rect = element.getBoundingClientRect()
    const left = Math.max(0, rect.left)
    const right = Math.min(window.innerWidth, rect.right)
    const top = Math.max(0, rect.top)
    const bottom = Math.min(window.innerHeight, rect.bottom)
    const visible = style.display !== 'none' && style.visibility !== 'hidden' && right - left > 1 && bottom - top > 1
    const ownsViewportPoint = (x: number, y: number) => {
      const frontmost = document.elementFromPoint(x, y)
      return frontmost?.closest<HTMLElement>(ANDROID_SCROLL_FADE_SELECTOR) === element
    }
    const sampleX = left + ((right - left) / 2)
    const sampleDepth = Math.min(24, Math.max(1, (bottom - top) / 4))
    const topIsFrontmost = visible && ownsViewportPoint(sampleX, Math.min(bottom - 1, top + sampleDepth))
    const bottomIsFrontmost = visible && ownsViewportPoint(sampleX, Math.max(top + 1, bottom - sampleDepth))
    const showTop = canScrollUp && topIsFrontmost
    const showBottom = canScrollDown && bottomIsFrontmost
    const fadeColor = style.getPropertyValue('--android-scroll-fade-color').trim()
      || (style.backgroundColor !== 'rgba(0, 0, 0, 0)' ? style.backgroundColor : window.getComputedStyle(document.body).backgroundColor)
    const overlay = overlays.get(element) || createOverlay()
    overlays.set(element, overlay)

    const geometry: Array<[string, string]> = [
      ['left', `${left}px`],
      ['width', `${Math.max(0, right - left)}px`],
      ['max-height', `${Math.max(0, (bottom - top) / 2)}px`],
      ['--android-scroll-fade-color', fadeColor],
    ]
    geometry.forEach(([property, value]) => {
      setStyle(overlay.top, property, value)
      setStyle(overlay.bottom, property, value)
    })
    setStyle(overlay.top, 'top', `${top}px`)
    setStyle(overlay.bottom, 'bottom', `${Math.max(0, window.innerHeight - bottom)}px`)
    overlay.top.hidden = !showTop
    overlay.bottom.hidden = !showBottom

    if (showTop) element.dataset.androidScrollFadeUp = 'true'
    else delete element.dataset.androidScrollFadeUp
    if (showBottom) element.dataset.androidScrollFadeDown = 'true'
    else delete element.dataset.androidScrollFadeDown
  }

  const flush = () => {
    animationFrame = 0
    const elements = pendingAll ? Array.from(tracked) : Array.from(pending)
    pendingAll = false
    pending.clear()
    elements.forEach(updateFadeState)
  }

  const schedule = (element?: HTMLElement | null) => {
    if (disposed) return
    if (element) pending.add(element)
    else pendingAll = true
    if (!animationFrame) animationFrame = window.requestAnimationFrame(flush)
  }

  resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver((entries) => {
    entries.forEach((entry) => schedule(entry.target as HTMLElement))
  })

  const track = (element: HTMLElement) => {
    if (tracked.has(element)) return
    tracked.add(element)
    resizeObserver?.observe(element)
    schedule(element)
  }

  const discover = (root: ParentNode) => {
    if (root instanceof HTMLElement && root.matches(ANDROID_SCROLL_FADE_SELECTOR)) track(root)
    root.querySelectorAll<HTMLElement>(ANDROID_SCROLL_FADE_SELECTOR).forEach(track)
  }

  discover(document)

  const mutationObserver = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if (mutation.target === overlayLayer || overlayLayer.contains(mutation.target)) return

      if (mutation.type === 'childList') {
        mutation.addedNodes.forEach((node) => {
          if (node instanceof HTMLElement) discover(node)
        })
        const viewport = mutation.target instanceof Element
          ? mutation.target.closest<HTMLElement>(ANDROID_SCROLL_FADE_SELECTOR)
          : mutation.target.parentElement?.closest<HTMLElement>(ANDROID_SCROLL_FADE_SELECTOR)
        if (viewport) schedule(viewport)
        schedule()
        return
      }

      const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement
      if (mutation.type === 'attributes' && target === document.documentElement) {
        schedule()
        return
      }
      if (mutation.type === 'attributes' && target instanceof HTMLElement && target.matches(ANDROID_SCROLL_FADE_SELECTOR)) {
        track(target)
        schedule(target)
        return
      }
      const viewport = target?.closest<HTMLElement>(ANDROID_SCROLL_FADE_SELECTOR)
      if (viewport) schedule(viewport)
    })

    tracked.forEach((element) => {
      if (!element.isConnected || !element.matches(ANDROID_SCROLL_FADE_SELECTOR)) {
        untrack(element)
      }
    })
  })
  mutationObserver.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'data-android-scroll-fade', 'data-folio-theme'],
  })

  const onScroll = (event: Event) => {
    const element = event.target instanceof HTMLElement ? event.target : null
    if (!element?.matches(ANDROID_SCROLL_FADE_SELECTOR)) return
    schedule(element)
    element.querySelectorAll<HTMLElement>(ANDROID_SCROLL_FADE_SELECTOR).forEach(schedule)
  }
  const scheduleAll = () => schedule()
  const scheduleClosest = (event: Event) => {
    const target = event.target instanceof Element ? event.target : null
    const viewport = target?.closest<HTMLElement>(ANDROID_SCROLL_FADE_SELECTOR)
    if (viewport) schedule(viewport)
  }

  document.addEventListener('scroll', onScroll, true)
  document.addEventListener('load', scheduleClosest, true)
  document.addEventListener('transitionend', scheduleClosest, true)
  document.addEventListener('animationend', scheduleClosest, true)
  window.addEventListener('resize', scheduleAll, { passive: true })
  window.addEventListener('orientationchange', scheduleAll, { passive: true })
  window.addEventListener('folio:android-shell-change', scheduleAll)
  void document.fonts?.ready.then(scheduleAll)

  return () => {
    disposed = true
    if (animationFrame) window.cancelAnimationFrame(animationFrame)
    mutationObserver.disconnect()
    resizeObserver?.disconnect()
    document.removeEventListener('scroll', onScroll, true)
    document.removeEventListener('load', scheduleClosest, true)
    document.removeEventListener('transitionend', scheduleClosest, true)
    document.removeEventListener('animationend', scheduleClosest, true)
    window.removeEventListener('resize', scheduleAll)
    window.removeEventListener('orientationchange', scheduleAll)
    window.removeEventListener('folio:android-shell-change', scheduleAll)
    tracked.forEach(clearFadeState)
    tracked.clear()
    pending.clear()
    overlays.clear()
    overlayLayer.remove()
    pendingAll = false
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
