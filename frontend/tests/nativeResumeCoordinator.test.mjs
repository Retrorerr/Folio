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

const {
  NativeBookOpenRegistry,
  initialNativeResumeState,
  nativeResumeReducer,
  nativeResumeTargetFromHint,
  nativeResumeTargetFromStatus,
  notificationResumeTarget,
} = await loadModule('../src/nativeResumeCoordinator.ts')

const status = (overrides = {}) => ({
  state: 'playing', sessionId: 11, queueSize: 2, queueSessionIds: [11, 12],
  bookId: 'book-a', chapterIndex: 2, sentenceIndex: 5, chunkProgress: 0.42,
  locationUri: 'android://book-a/a.epub',
  queueLocations: [
    { sessionId: 11, bookId: 'book-a', chapterIndex: 2, sentenceIndex: 5 },
    { sessionId: 12, bookId: 'book-a', chapterIndex: 2, sentenceIndex: 6 },
  ],
  ...overrides,
})

test('hydration lifecycle survives its own rerenders and ignores stale failures', () => {
  const first = nativeResumeTargetFromStatus(status(), 1, 'startup-status')
  let state = nativeResumeReducer(initialNativeResumeState, { type: 'request', target: first, bookAlreadyOpen: false })
  state = nativeResumeReducer(state, { type: 'book-opened', requestId: 1 })
  state = nativeResumeReducer(state, { type: 'attached', requestId: 1 })
  assert.equal(state.phase, 'monitoring')

  const second = nativeResumeTargetFromStatus(status({ bookId: 'book-b', sessionId: 20 }), 2, 'notification-status')
  state = nativeResumeReducer(state, { type: 'request', target: second, bookAlreadyOpen: false })
  state = nativeResumeReducer(state, { type: 'failed', requestId: 1, error: 'stale' })
  assert.equal(state.target.requestId, 2)
  assert.equal(state.phase, 'opening-book')
})

test('duplicate startup and notification events are idempotent and hints cannot downgrade playing status', () => {
  const authoritative = nativeResumeTargetFromStatus(status(), 1, 'startup-status')
  let state = nativeResumeReducer(initialNativeResumeState, { type: 'request', target: authoritative, bookAlreadyOpen: true })
  const attachingDuplicate = nativeResumeTargetFromStatus(status({ chunkProgress: 0.6 }), 3, 'notification-status')
  assert.equal(nativeResumeReducer(state, { type: 'request', target: attachingDuplicate, bookAlreadyOpen: true }), state)
  state = nativeResumeReducer(state, { type: 'attached', requestId: 1 })
  const hint = nativeResumeTargetFromHint({ bookId: 'book-a', sessionId: 11, state: 'paused' }, 2)
  assert.equal(nativeResumeReducer(state, { type: 'request', target: hint, bookAlreadyOpen: true }), state)
  const duplicate = nativeResumeTargetFromStatus(status({ chunkProgress: 0.7 }), 4, 'notification-status')
  assert.equal(nativeResumeReducer(state, { type: 'request', target: duplicate, bookAlreadyOpen: true }), state)
})

test('notification hint is replaced by matching authoritative queue status', () => {
  const target = notificationResumeTarget({ bookId: 'book-a', sentenceIndex: 1 }, status(), 4)
  assert.equal(target.authoritative, true)
  assert.equal(target.sentence, 5)
  assert.equal(target.queueLocations.length, 2)
})

test('duplicate book opens join one promise and stable id retries a failed location URI', async () => {
  const registry = new NativeBookOpenRegistry()
  const target = nativeResumeTargetFromHint({ bookId: 'book-a', locationUri: 'bad://source' }, 1)
  const calls = []
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const openBook = async (location) => {
    calls.push(location)
    await gate
    return location === 'book-a'
  }
  const first = registry.open(target, () => target, openBook)
  const duplicate = registry.open(target, () => target, openBook)
  assert.equal(first, duplicate)
  release()
  assert.equal(await first, true)
  assert.deepEqual(calls, ['bad://source', 'book-a'])
})

test('a superseding book open is serialized after the older in-flight open', async () => {
  const registry = new NativeBookOpenRegistry()
  const first = nativeResumeTargetFromHint({ bookId: 'book-a' }, 1)
  const second = nativeResumeTargetFromHint({ bookId: 'book-b' }, 2)
  const calls = []
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const firstOpen = registry.open(first, () => second, async (location) => {
    calls.push(location)
    await gate
    return true
  })
  const secondOpen = registry.open(second, () => second, async (location) => {
    calls.push(location)
    return true
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(calls, ['book-a'])
  release()
  await Promise.all([firstOpen, secondOpen])
  assert.deepEqual(calls, ['book-a', 'book-b'])
})
