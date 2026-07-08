import type { Variants } from 'motion/react'

export const motionEase = [0.16, 1, 0.3, 1] as const

export const durations = {
  xs: 0.12,
  sm: 0.16,
  md: 0.22,
  lg: 0.32,
} as const

export const spring = {
  quick: { type: 'spring', stiffness: 560, damping: 42, mass: 0.7 },
  layout: { type: 'spring', stiffness: 430, damping: 38, mass: 0.9 },
  panel: { type: 'spring', stiffness: 380, damping: 36, mass: 0.92 },
  page: { type: 'spring', stiffness: 300, damping: 34, mass: 0.95 },
  pillControl: { type: 'spring', stiffness: 260, damping: 32, mass: 0.9 },
} as const

export const pillMorph = {
  ms: 560,
  slowScale: 4,
  contentOut: 0.18,
  contentIn: 0.26,
  contentDelay: 0.26,
} as const

export const pillShellTransition = {
  type: 'tween',
  duration: pillMorph.ms / 1000,
  ease: motionEase,
} as const

export const pillShellSlowTransition = {
  type: 'tween',
  duration: (pillMorph.ms * pillMorph.slowScale) / 1000,
  ease: motionEase,
} as const

export const fadeIn: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: durations.sm, ease: motionEase } },
  exit: { opacity: 0, transition: { duration: durations.xs, ease: motionEase } },
}

export const slideUp: Variants = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0, transition: spring.quick },
  exit: { opacity: 0, y: 8, transition: { duration: durations.sm, ease: motionEase } },
}

export const scaleIn: Variants = {
  initial: { opacity: 0, scale: 0.98 },
  animate: { opacity: 1, scale: 1, transition: spring.quick },
  exit: { opacity: 0, scale: 0.985, transition: { duration: durations.sm, ease: motionEase } },
}

export const panelReveal: Variants = {
  initial: { opacity: 0, x: -16, scale: 0.985 },
  animate: { opacity: 1, x: 0, scale: 1, transition: spring.panel },
  exit: { opacity: 0, x: -12, scale: 0.99, transition: { duration: durations.md, ease: motionEase } },
}

export const pageTransition: Variants = {
  initial: { opacity: 0, y: 8, scale: 0.996 },
  animate: { opacity: 1, y: 0, scale: 1, transition: spring.page },
  exit: { opacity: 0, y: -6, scale: 0.998, transition: { duration: durations.md, ease: motionEase } },
}

function appViewCustom(custom: unknown) {
  if (typeof custom === 'object' && custom !== null) {
    const { from = '', to = '', view = '' } = custom as { from?: string; to?: string; view?: string }
    return { from, to, view }
  }

  return { from: '', to: '', view: '' }
}

export const appViewTransition: Variants = {
  initial: (custom = {}) => {
    const { from, view } = appViewCustom(custom)
    const enteringFromStartup = from === 'loading' && view !== 'loading'
    const enteringReader = view === 'reader'

    return {
      opacity: 0,
      y: enteringFromStartup ? 18 : enteringReader ? 10 : 8,
      scale: enteringFromStartup ? 0.988 : 0.994,
    }
  },
  animate: (custom = {}) => {
    const { from, view } = appViewCustom(custom)
    const startupHandoff = from === 'loading' && view !== 'loading'

    return {
      opacity: 1,
      y: 0,
      scale: 1,
      transition: {
        delay: startupHandoff ? 0.06 : 0,
        duration: startupHandoff ? 0.42 : durations.lg,
        ease: motionEase,
      },
    }
  },
  exit: (custom = {}) => {
    const { view } = appViewCustom(custom)
    const leavingStartup = view === 'loading'

    return {
      opacity: 0,
      y: leavingStartup ? -14 : -8,
      scale: leavingStartup ? 1.01 : 0.998,
      transition: {
        duration: leavingStartup ? 0.38 : durations.lg,
        ease: motionEase,
      },
    }
  },
}

export const overlayFade: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: durations.md, ease: motionEase } },
  exit: { opacity: 0, transition: { duration: durations.sm, ease: motionEase } },
}

export const modalPanel: Variants = {
  initial: { opacity: 0, y: 18, scale: 0.97 },
  animate: { opacity: 1, y: 0, scale: 1, transition: spring.panel },
  exit: { opacity: 0, y: 10, scale: 0.985, transition: { duration: durations.md, ease: motionEase } },
}

export const controlsReveal: Variants = {
  initial: { opacity: 0, y: 18, scale: 0.98 },
  animate: { opacity: 1, y: 0, scale: 1, transition: spring.panel },
  exit: { opacity: 0, y: 14, scale: 0.985, transition: { duration: durations.md, ease: motionEase } },
}

function pillContentCustom(custom: unknown) {
  if (typeof custom === 'object' && custom !== null) {
    const { state = '', slow = false } = custom as { state?: string; slow?: boolean }
    return { state, timeScale: slow ? pillMorph.slowScale : 1 }
  }

  return { state: typeof custom === 'string' ? custom : '', timeScale: 1 }
}

export const pillContentContinuity: Variants = {
  initial: (custom = '') => {
    const { state } = pillContentCustom(custom)
    return {
      opacity: state === 'is-arriving' ? 0 : 1,
      y: state === 'is-arriving' ? 6 : 0,
      scale: state === 'is-arriving' ? 0.985 : 1,
      filter: state === 'is-arriving' ? 'blur(12px)' : 'blur(0px)',
    }
  },
  animate: (custom = '') => {
    const { state, timeScale } = pillContentCustom(custom)

    if (state === 'is-leaving') {
      return {
        opacity: 0,
        y: -3,
        scale: 0.965,
        filter: 'blur(14px)',
        transition: { duration: pillMorph.contentOut * timeScale, ease: motionEase },
      }
    }

    if (state === 'is-arriving') {
      return {
        opacity: 1,
        y: 0,
        scale: 1,
        filter: 'blur(0px)',
        transition: {
          delay: pillMorph.contentDelay * timeScale,
          duration: pillMorph.contentIn * timeScale,
          ease: motionEase,
        },
      }
    }

    return {
      opacity: 1,
      y: 0,
      scale: 1,
      filter: 'blur(0px)',
      transition: { duration: durations.sm, ease: motionEase },
    }
  },
  exit: (custom = '') => {
    const { timeScale } = pillContentCustom(custom)
    return {
      opacity: 0,
      y: 3,
      scale: 0.97,
      filter: 'blur(12px)',
      transition: { duration: pillMorph.contentOut * timeScale, ease: motionEase },
    }
  },
}

export const pillExpandedItemContinuity: Variants = {
  initial: { opacity: 0, y: 8, filter: 'blur(8px)' },
  animate: {
    opacity: 1,
    y: 0,
    filter: 'blur(0px)',
    transition: { duration: pillMorph.contentIn, ease: motionEase },
  },
}

export const listStagger: Variants = {
  initial: {},
  animate: {
    transition: {
      staggerChildren: 0.025,
      delayChildren: 0.02,
    },
  },
  exit: {
    transition: {
      staggerChildren: 0.015,
      staggerDirection: -1,
    },
  },
}

export const listItem: Variants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0, transition: spring.quick },
  exit: { opacity: 0, y: 6, transition: { duration: durations.xs, ease: motionEase } },
}

export const buttonHover = { y: -1 }
export const buttonTap = { scale: 0.985 }
export const pillControlHover = {
  y: -1,
  scale: 1.01,
  transition: { duration: durations.sm, ease: motionEase },
}
export const pillControlTap = {
  scale: 0.975,
  transition: { duration: durations.xs, ease: motionEase },
}
