import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

async function loadTypeScriptModule(relativePath) {
  const source = await readFile(new URL(relativePath, import.meta.url), 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2020,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText
  return import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`)
}

const {
  fillSpectrumLevels,
  classifyNativeQueueProgress,
  formatPlaybackTime,
  findAdjacentReadablePosition,
  isSpeakableText,
  rememberBoundedSetEntry,
  setBoundedMapEntry,
} = await loadTypeScriptModule('../src/hooks/audioPlaybackState.ts')
const { clampReaderViewTarget, readerPageNavigationState } = await loadTypeScriptModule('../src/readerNavigation.ts')

const page = (...texts) => ({
  page_number: 0,
  sentences: texts.map((text) => ({ text, words: [] })),
  render_width: 0,
  render_height: 0,
})

test('sentence skipping crosses empty pages in both directions', async () => {
  const pages = [page('First', '  '), page(), page('Third')]
  const getPage = async (index) => pages[index] || null

  const next = await findAdjacentReadablePosition(getPage, 0, 0, 1, pages.length)
  assert.deepEqual({ page: next.page, sentence: next.sentence }, { page: 2, sentence: 0 })

  const previous = await findAdjacentReadablePosition(getPage, 2, 0, -1, pages.length)
  assert.deepEqual({ page: previous.page, sentence: previous.sentence }, { page: 0, sentence: 0 })
})

test('punctuation-only layout separators are never sent to native TTS', () => {
  assert.equal(isSpeakableText('. . .'), false)
  assert.equal(isSpeakableText('—'), false)
  assert.equal(isSpeakableText('Chapter 2'), true)
})

test('bounded playback caches evict the least-recently-used entry', () => {
  const map = new Map()
  setBoundedMapEntry(map, 'a', 1, 2)
  setBoundedMapEntry(map, 'b', 2, 2)
  setBoundedMapEntry(map, 'a', 1, 2)
  setBoundedMapEntry(map, 'c', 3, 2)
  assert.deepEqual([...map.keys()], ['a', 'c'])

  const set = new Set()
  rememberBoundedSetEntry(set, 'a', 2)
  rememberBoundedSetEntry(set, 'b', 2)
  rememberBoundedSetEntry(set, 'c', 2)
  assert.deepEqual([...set], ['b', 'c'])
})

test('native queue transitions distinguish current, advanced, and terminal chunks', () => {
  assert.equal(classifyNativeQueueProgress('playing', 41, 41), 'current')
  assert.equal(classifyNativeQueueProgress('preparing', 42, 41), 'advanced')
  assert.equal(classifyNativeQueueProgress('finished', 42, 42), 'finished')
  assert.equal(classifyNativeQueueProgress('paused', 42, 42), 'paused')
  assert.equal(classifyNativeQueueProgress('preparing', 40, 41), 'waiting')
})

test('audio spectrum levels reflect analyser data and decay to silence', () => {
  const levels = new Float32Array(8)
  const voicedBins = new Uint8Array(32)
  voicedBins.fill(180, 1, 8)
  fillSpectrumLevels(voicedBins, levels, 0)
  assert.ok(levels.some((level) => level > 0.4))
  assert.ok(levels.slice(0, 5).some((level) => level > levels[7]))

  const silentBins = new Uint8Array(32)
  fillSpectrumLevels(silentBins, levels, 0)
  assert.deepEqual([...levels], Array(8).fill(0))
})

test('speech spectrum uses the full visual range for voice harmonics', () => {
  const levels = new Float32Array(16)
  const bins = new Uint8Array(512)
  // 48 kHz / 1024 FFT = 46.875 Hz per bin. These peaks represent a female
  // fundamental plus formants and upper harmonics through roughly 7 kHz.
  for (const bin of [5, 11, 21, 43, 85, 128, 149]) bins[bin] = 190
  fillSpectrumLevels(bins, levels, 0, { sampleRate: 48_000, fftSize: 1024 })
  assert.ok(levels.slice(0, 5).some((level) => level > 0.25))
  assert.ok(levels.slice(5, 11).some((level) => level > 0.25))
  assert.ok(levels.slice(11).some((level) => level > 0.25))
})

test('long playback estimates use readable hour timestamps', () => {
  assert.equal(formatPlaybackTime(28 * 60), '28:00')
  assert.equal(formatPlaybackTime(310 * 60), '5:10:00')
  assert.equal(formatPlaybackTime(Number.NaN), '0:00')
})

test('visual-page navigation respects spread and chapter boundaries', () => {
  assert.deepEqual(readerPageNavigationState(0, 3, 0, 2), {
    canGoPrevious: false,
    canGoNext: true,
  })
  assert.deepEqual(readerPageNavigationState(2, 3, 1, 2), {
    canGoPrevious: true,
    canGoNext: false,
  })
  assert.deepEqual(readerPageNavigationState(1, 3, 0, 2, true), {
    canGoPrevious: false,
    canGoNext: false,
  })
})

test('follow-along targets clamp measurement overflow in one- and two-page views', () => {
  assert.equal(clampReaderViewTarget(8, 8), 7)
  assert.equal(clampReaderViewTarget(4.9, 4), 3)
  assert.equal(clampReaderViewTarget(-1, 4), 0)
  assert.equal(clampReaderViewTarget(Number.NaN, 4), null)
  assert.equal(clampReaderViewTarget(0, 0), null)
})
