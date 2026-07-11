import { useEffect, useRef } from 'react'

/**
 * Soft ember-tinted halo that follows the cursor. CSS handles the
 * appearance — this component only writes --cx/--cy custom properties
 * onto a fixed-position element. Hidden under reduced-motion or when
 * `motion` is false. Auto-hides over interactive surfaces so the halo
 * doesn't compete with hover affordances.
 */
export default function CursorHalo({ motion = true, disabled = false }: { motion?: boolean; disabled?: boolean }) {
  const haloRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!motion || disabled) return
    if (typeof window === 'undefined') return
    const pointerQuery = window.matchMedia('(pointer: fine) and (prefers-reduced-motion: no-preference)')
    if (!pointerQuery.matches) return
    const el = haloRef.current
    if (!el) return

    let raf = 0
    let hideTimer: ReturnType<typeof window.setTimeout> | null = null
    let lastMoveAt = 0
    let pendingX = 0, pendingY = 0
    const apply = () => {
      el.style.setProperty('--cx', `${pendingX}px`)
      el.style.setProperty('--cy', `${pendingY}px`)
      raf = 0
    }
    const ensureHideTimer = () => {
      if (hideTimer) return
      const hideWhenIdle = () => {
        const remaining = 700 - (performance.now() - lastMoveAt)
        if (remaining > 0) {
          hideTimer = window.setTimeout(hideWhenIdle, remaining)
          return
        }
        el.classList.remove('is-active')
        hideTimer = null
      }
      hideTimer = window.setTimeout(hideWhenIdle, 700)
    }

    const onMove = (e: PointerEvent) => {
      pendingX = e.clientX
      pendingY = e.clientY
      lastMoveAt = performance.now()
      el.classList.add('is-active')
      ensureHideTimer()
      if (!raf) raf = requestAnimationFrame(apply)
    }
    const onLeave = () => {
      if (hideTimer) window.clearTimeout(hideTimer)
      hideTimer = null
      el.classList.remove('is-active')
    }

    window.addEventListener('pointermove', onMove, { passive: true })
    window.addEventListener('mouseleave', onLeave)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('mouseleave', onLeave)
      if (hideTimer) window.clearTimeout(hideTimer)
      cancelAnimationFrame(raf)
    }
  }, [motion, disabled])

  if (!motion || disabled) return null
  return <div ref={haloRef} className="cursor-halo" aria-hidden="true" />
}
