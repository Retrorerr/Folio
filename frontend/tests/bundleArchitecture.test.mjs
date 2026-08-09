import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
const playback = await readFile(new URL('../src/hooks/useAudioPlayback.ts', import.meta.url), 'utf8')
const bridge = await readFile(new URL('../src/mobilePlaybackBridge.ts', import.meta.url), 'utf8')

test('desktop startup does not eagerly load the Android document adapter', () => {
  assert.doesNotMatch(app, /from ['"]\.\/mobileApi['"]/)
  assert.doesNotMatch(playback, /from ['"]\.\.\/mobileApi['"]/)
  assert.match(bridge, /await import\(['"]\.\/mobileApi['"]\)/)
})
