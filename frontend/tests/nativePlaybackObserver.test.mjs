import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

async function loadModule(path) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2020, target: ts.ScriptTarget.ES2020 },
  }).outputText
  return import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`)
}

const { createNativePlaybackObserver, interpretNativePlaybackStatus } = await loadModule('../src/nativePlaybackObserver.ts')

const status = (overrides = {}) => ({
  state: 'playing', sessionId: 1, queueSize: 2, bookId: 'book-a',
  positionMs: 500, durationMs: 1000, chapterIndex: 0, sentenceIndex: 2,
  queueLocations: [
    { sessionId: 1, bookId: 'book-a', chapterIndex: 0, sentenceIndex: 2 },
    { sessionId: 2, bookId: 'book-a', chapterIndex: 1, sentenceIndex: 0 },
  ],
  ...overrides,
})

test('status interpretation preserves monotonic progress across transient preparing zero', () => {
  const first = interpretNativePlaybackStatus(status(), null, { initialSessionId: 1 })
  const preparing = interpretNativePlaybackStatus(status({ state: 'preparing', positionMs: 0, durationMs: 0, chunkProgress: 0 }), first)
  assert.equal(first.progress, 0.5)
  assert.equal(preparing.progress, 0.5)
})

test('session transition resolves the queued sentence and page without guessing', () => {
  const first = interpretNativePlaybackStatus(status(), null, { initialSessionId: 1 })
  const next = interpretNativePlaybackStatus(status({ sessionId: 2, positionMs: 100, durationMs: 1000 }), first, { keepPaused: true })
  assert.equal(next.sessionChanged, true)
  assert.deepEqual(next.location, { sessionId: 2, bookId: 'book-a', chapterIndex: 1, sentenceIndex: 0 })
  assert.equal(next.progress, 0.1)
})

test('restored observer continues through pause, resume, page transition and finish', async () => {
  const samples = [
    status(),
    status({ state: 'paused', positionMs: 600 }),
    status({ sessionId: 2, chapterIndex: 1, sentenceIndex: 0, positionMs: 50 }),
    status({ state: 'finished', sessionId: 2, chapterIndex: null, sentenceIndex: null, queueLocations: [], queueSize: 0, positionMs: 1000 }),
  ]
  const observations = []
  let terminal = null
  const done = new Promise((resolve) => {
    const observer = createNativePlaybackObserver({
      readStatus: async () => samples.shift() || status({ state: 'finished', sessionId: 2 }),
      initialSessionId: 1,
      expectedBookId: 'book-a',
      keepPaused: true,
      pollIntervalMs: 80,
      scheduler: {
        now: () => Date.now(),
        setTimeout: (callback) => setTimeout(callback, 0),
        clearTimeout,
        requestFrame: () => 1,
        cancelFrame: () => {},
      },
      onObservation: (sample) => observations.push(sample),
      onTerminal: (value) => { terminal = value; resolve() },
    })
    observer.start()
  })
  await done
  assert.equal(terminal, 'finished')
  assert.equal(observations.some((sample) => sample.status.state === 'paused'), true)
  assert.equal(observations.some((sample) => sample.location?.chapterIndex === 1), true)
  assert.deepEqual(observations.at(-1).location, { sessionId: 2, bookId: 'book-a', chapterIndex: 1, sentenceIndex: 0 })
})
