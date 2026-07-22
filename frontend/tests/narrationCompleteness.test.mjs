import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const reflowViewer = await readFile(new URL('../src/components/ReflowViewer.tsx', import.meta.url), 'utf8')
const cursorHook = await readFile(new URL('../src/followAlong/usePlaybackLineCursor.tsx', import.meta.url), 'utf8')
const lineMap = await readFile(new URL('../src/followAlong/visualLineMap.ts', import.meta.url), 'utf8')
const playback = await readFile(new URL('../src/hooks/useAudioPlayback.ts', import.meta.url), 'utf8')
const mobileApi = await readFile(new URL('../src/mobileApi.ts', import.meta.url), 'utf8')

test('chapter labels, titles, and headings join the indexed visual sentence stream', () => {
  assert.match(reflowViewer, /data-narration-kind="chapter-label"/)
  assert.match(reflowViewer, /data-narration-kind="chapter-title"/)
  assert.match(reflowViewer, /data-narration-kind={`heading-\$\{block\.level \|\| 2\}`}/)
  assert.match(reflowViewer, /data-local-sent-idx=\{localIdx\}/)
})

test('desktop uses one click while Android retains its double-tap path', () => {
  assert.match(reflowViewer, /onClick=\{handleLineClick\}/)
  assert.doesNotMatch(reflowViewer, /onDoubleClick=/)
  assert.match(cursorHook, /if \(androidRuntime \|\| event\.button !== 0 \|\| isPageTurning\) return/)
  assert.match(cursorHook, /const isDoubleTap =/)
})

test('leading glyph geometry and model-agnostic chunk pauses are wired', () => {
  assert.match(lineMap, /function applyLeadingGlyphGeometry/)
  assert.match(lineMap, /function applyDropCapCursorGeometry/)
  assert.match(lineMap, /candidate\.height > best\.height/)
  assert.match(playback, /const INTER_CHUNK_PAUSE_MS = 500/)
  assert.match(playback, /sentenceInfo\.pause_after_ms/)
  assert.match(mobileApi, /v4-narration-pauses/)
  assert.match(mobileApi, /appendPcmSilence\(decoded\.audio, Math\.max/)
  assert.match(mobileApi, /pauseAfterMs: Number\(sentence\.pause_after_ms/)
})
