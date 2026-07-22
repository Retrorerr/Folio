import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { Buffer } from 'node:buffer'
import ts from 'typescript'

const sourceUrl = new URL('../src/followAlong/playbackModel.ts', import.meta.url)
const source = await readFile(sourceUrl, 'utf8')
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2020,
    target: ts.ScriptTarget.ES2020,
  },
}).outputText
const model = await import(`data:text/javascript;base64,${Buffer.from(transpiled).toString('base64')}`)

const placement = (key = 'p') => ({ x: 10, y: 20, width: 2, height: 22, key, column: 0 })
const visualLine = (overrides = {}) => ({
  lineId: 'c0:s4:l0',
  chapterIndex: 0,
  sentenceIndex: 4,
  globalSentenceIndex: 17,
  lineIndex: 0,
  firstTokenIndex: 0,
  lastTokenIndex: 3,
  progressStart: 0,
  progressEnd: 0.5,
  contentPage: 0,
  viewIndex: 0,
  pageX: 20,
  pageY: 30,
  lineWidth: 200,
  lineHeight: 22,
  generation: 3,
  ...overrides,
})

function visualMap(lines = [visualLine(), visualLine({
  lineId: 'c0:s4:l1',
  lineIndex: 1,
  firstTokenIndex: 4,
  lastTokenIndex: 8,
  progressStart: 0.5,
  progressEnd: 1,
  pageY: 58,
})]) {
  return {
    bookId: 'book-a',
    chapterIndex: 0,
    generation: 3,
    layoutKey: 'layout-3',
    pagesPerView: 1,
    lines,
    bySentence: new Map([[4, lines]]),
    metrics: {
      rootContentX: 100,
      rootContentY: 50,
      scaleX: 1,
      scaleY: 1,
      pageStride: 680,
      pagesPerView: 1,
    },
    createdAt: 1,
  }
}

function anchor(overrides = {}) {
  return {
    bookId: 'book-a',
    chapterIndex: 0,
    sentenceIndex: 4,
    globalSentenceIndex: 17,
    lineIndex: 0,
    viewIndex: 0,
    lineId: 'c0:s4:l0',
    placement: placement(),
    progressStart: 0,
    progressEnd: 0.5,
    generation: 3,
    ...overrides,
  }
}

test('speech weighting gives punctuation a deliberate pause cost', () => {
  assert.ok(model.wordWeight('finished.') > model.wordWeight('finished'))
  assert.ok(model.wordWeight('however,') > model.wordWeight('however'))
  assert.ok(model.wordWeight('Dr.') > model.wordWeight('Dr'))
})

test('visual-line ranges are contiguous and cover the full sentence', () => {
  const ranges = model.assignVisualLineProgress([
    { tokenWeight: 2 },
    { tokenWeight: 3 },
    { tokenWeight: 5 },
  ])
  assert.equal(ranges[0].progressStart, 0)
  assert.equal(ranges.at(-1).progressEnd, 1)
  assert.equal(ranges[0].progressEnd, ranges[1].progressStart)
  assert.equal(ranges[1].progressEnd, ranges[2].progressStart)
})

test('an exact boundary resolves to the next visual line', () => {
  const lines = visualMap().lines
  assert.equal(model.lineForProgress(lines, 0.4999).lineIndex, 0)
  assert.equal(model.lineForProgress(lines, 0.5).lineIndex, 1)
})

test('ordinary native timing correction cannot move stable progress backwards', () => {
  const first = model.updateStableProgress(null, { sessionKey: 'a', progress: 0.63 })
  const corrected = model.updateStableProgress(first, { sessionKey: 'a', progress: 0.58 })
  assert.equal(corrected.rawProgress, 0.58)
  assert.equal(corrected.stableProgress, 0.63)
})

test('an explicit backward seek reset accepts the lower progress', () => {
  const first = model.updateStableProgress(null, { sessionKey: 'a', progress: 0.75, resetToken: 1 })
  const seek = model.updateStableProgress(first, {
    sessionKey: 'a',
    progress: 0.2,
    resetToken: 2,
    allowBackward: true,
  })
  assert.equal(seek.stableProgress, 0.2)
})

test('sentence or playback-session changes reset monotonic progress', () => {
  const first = model.updateStableProgress(null, { sessionKey: 'sentence-4', progress: 0.92 })
  const nextSentence = model.updateStableProgress(first, { sessionKey: 'sentence-5', progress: 0.03 })
  assert.equal(nextSentence.stableProgress, 0.03)
})

test('anchor resolution returns the visual line and destination view from one map', () => {
  const resolved = model.resolvePlaybackAnchor(visualMap(), {
    bookId: 'book-a',
    chapterIndex: 0,
    sentenceIndex: 4,
    progress: 0.7,
    visibleViewIndex: 0,
  })
  assert.equal(resolved.lineId, 'c0:s4:l1')
  assert.equal(resolved.viewIndex, 0)
  assert.equal(resolved.placement.key.includes('c0:s4:l1'), true)
})

test('two-page maps resolve content pages to a single spread index', () => {
  const line = visualLine({ contentPage: 3, viewIndex: 1, generation: 9 })
  const map = {
    ...visualMap([line]),
    generation: 9,
    pagesPerView: 2,
    bySentence: new Map([[4, [line]]]),
    metrics: {
      ...visualMap().metrics,
      pagesPerView: 2,
    },
  }
  const resolved = model.resolvePlaybackAnchor(map, {
    bookId: 'book-a',
    chapterIndex: 0,
    sentenceIndex: 4,
    progress: 0.2,
    visibleViewIndex: 1,
  })
  assert.equal(resolved.viewIndex, 1)
  assert.equal(resolved.placement.column, 1)
})

test('stale layout generations are rejected', () => {
  const resolved = model.resolvePlaybackAnchor(visualMap(), {
    bookId: 'book-a',
    chapterIndex: 0,
    sentenceIndex: 4,
    progress: 0.2,
    visibleViewIndex: 0,
    expectedGeneration: 2,
  })
  assert.equal(resolved, null)
})

test('selection hands ownership to playback immediately', () => {
  const selected = model.followAlongReducer(model.INITIAL_FOLLOW_ALONG_STATE, {
    type: 'SELECT',
    anchor: anchor(),
  })
  assert.equal(selected.status, 'selected')
  const playing = model.followAlongReducer(selected, {
    type: 'PLAYBACK_ANCHOR',
    anchor: anchor({ lineIndex: 1, lineId: 'c0:s4:l1' }),
    playing: true,
  })
  assert.equal(playing.status, 'playing')
  assert.equal(playing.selectedAnchor, null)
  assert.equal(playing.anchor.lineId, 'c0:s4:l1')
})

test('page synchronization is an explicit request and commit transition', () => {
  const target = anchor({ viewIndex: 2, lineId: 'c0:s4:l3' })
  const changing = model.followAlongReducer(model.INITIAL_FOLLOW_ALONG_STATE, {
    type: 'REQUEST_VIEW',
    anchor: target,
    reason: 'playback-anchor-view',
  })
  assert.equal(changing.status, 'changing-view')
  assert.equal(changing.pendingAnchor.viewIndex, 2)
  const committed = model.followAlongReducer(changing, {
    type: 'VIEW_COMMITTED',
    anchor: target,
    playing: true,
  })
  assert.equal(committed.status, 'playing')
  assert.equal(committed.pendingAnchor, null)
  assert.equal(committed.anchor.viewIndex, 2)
})

test('missing-map state recovers when a layout generation commits', () => {
  const unavailable = model.followAlongReducer(model.INITIAL_FOLLOW_ALONG_STATE, {
    type: 'UNAVAILABLE',
    reason: 'missing-current-layout',
  })
  assert.equal(unavailable.status, 'unavailable')
  const ready = model.followAlongReducer(unavailable, { type: 'LAYOUT_READY', generation: 7 })
  assert.equal(ready.status, 'idle')
  assert.equal(ready.layoutGeneration, 7)
})

test('pause keeps the last meaningful playback anchor', () => {
  const playing = model.followAlongReducer(model.INITIAL_FOLLOW_ALONG_STATE, {
    type: 'PLAYBACK_ANCHOR',
    anchor: anchor(),
    playing: true,
  })
  const paused = model.followAlongReducer(playing, { type: 'PAUSE', anchor: anchor() })
  assert.equal(paused.status, 'paused')
  assert.equal(paused.anchor.lineId, 'c0:s4:l0')
})

test('reset clears anchors from the previous book', () => {
  const playing = model.followAlongReducer(model.INITIAL_FOLLOW_ALONG_STATE, {
    type: 'PLAYBACK_ANCHOR',
    anchor: anchor(),
    playing: true,
  })
  const reset = model.followAlongReducer(playing, { type: 'RESET' })
  assert.deepEqual(reset, model.INITIAL_FOLLOW_ALONG_STATE)
})

test('a regressing sample cannot drive the selected visual line backwards', () => {
  const map = visualMap()
  const first = model.updateStableProgress(null, { sessionKey: 'a', progress: 0.72 })
  const firstAnchor = model.resolvePlaybackAnchor(map, {
    bookId: 'book-a', chapterIndex: 0, sentenceIndex: 4,
    progress: first.stableProgress, visibleViewIndex: 0,
  })
  const correction = model.updateStableProgress(first, { sessionKey: 'a', progress: 0.45 })
  const correctedAnchor = model.resolvePlaybackAnchor(map, {
    bookId: 'book-a', chapterIndex: 0, sentenceIndex: 4,
    progress: correction.stableProgress, visibleViewIndex: 0,
  })
  assert.equal(firstAnchor.lineId, 'c0:s4:l1')
  assert.equal(correctedAnchor.lineId, 'c0:s4:l1')
})
