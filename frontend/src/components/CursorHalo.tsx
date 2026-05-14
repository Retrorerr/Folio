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
    const el = haloRef.current
    if (!el) return

    let raf = 0
    let pendingX = 0, pendingY = 0
    const apply = () => {
      el.style.setProperty('--cx', `${pendingX}px`)
      el.style.setProperty('--cy', `${pendingY}px`)
      raf = 0
    }

    const onMove = (e: MouseEvent) => {
      pendingX = e.clientX
      pendingY = e.clientY
      el.classList.add('is-active')
      if (!raf) raf = requestAnimationFrame(apply)
    }
    const onLeave = () => el.classList.remove('is-active')

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseleave', onLeave)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseleave', onLeave)
      cancelAnimationFrame(raf)
    }
  }, [motion, disabled])

  if (!motion || disabled) return null
  return <div ref={haloRef} className="cursor-halo" aria-hidden="true" />
}
