import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const [motion, androidShell, androidStyles, app, sidebar, welcome, mainActivity] = await Promise.all([
  readFile(new URL('../src/motion.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/androidShell.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/styles/android.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/Sidebar.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/Welcome.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../../src-tauri/android/MainActivity.kt', import.meta.url), 'utf8'),
])

test('Android view transitions avoid viewport-sized paint animations', () => {
  const androidViewTransition = motion.slice(
    motion.indexOf('export const androidAppViewTransition'),
    motion.indexOf('export const androidPageTransition'),
  )

  assert.doesNotMatch(androidViewTransition, /clipPath|filter|scale/)
  assert.match(androidViewTransition, /opacity/)
})

test('Android navigation uses posture-specific, non-overshooting surfaces', () => {
  assert.match(sidebar, /androidPhone \? androidBottomSheet : androidRuntime \? androidSideSheet : panelReveal/)
  assert.match(welcome, /mode=\{androidRuntime \? 'popLayout' : 'wait'\}/)
  assert.match(welcome, /androidRuntime \? androidPageTransition : pageTransition/)
})

test('Android scroll fades do not subscribe to Motion inline-style frames', () => {
  const attributeFilter = androidShell.match(/attributeFilter:\s*\[([^\]]+)\]/)?.[1] || ''
  assert.doesNotMatch(attributeFilter, /['"]style['"]/)
  assert.match(androidShell, /schedule\(element, false\)/)
  assert.match(androidShell, /refreshGeometry/)
})

test('phone playback visibility follows explicit reader state without :has()', () => {
  assert.match(app, /reader-shell.*is-sidebar-panel-open/)
  assert.match(androidStyles, /\.reader-shell\.is-sidebar-panel-open \.pill-wrap/)
  assert.doesNotMatch(androidStyles, /:has\(\.sidebar-panel\.is-open\)/)
})

test('native launch handoff fades on the compositor and requests the fastest display mode', () => {
  assert.match(mainActivity, /preferHighestRefreshRate\(\)/)
  assert.match(mainActivity, /\.alpha\(0f\)/)
  assert.match(mainActivity, /\.withLayer\(\)/)
  assert.match(mainActivity, /LAUNCH_HANDOFF_DURATION_MS = 140L/)
})
