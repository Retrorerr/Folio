import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'
import { Buffer } from 'node:buffer'

const lineMap = await readFile(new URL('../src/followAlong/visualLineMap.ts', import.meta.url), 'utf8')
const hook = await readFile(new URL('../src/followAlong/usePlaybackLineCursor.tsx', import.meta.url), 'utf8')
const indexSource = await readFile(new URL('../src/followAlong/textNodeIndex.ts', import.meta.url), 'utf8')

async function loadIndexModule() {
  const output = ts.transpileModule(indexSource, {
    compilerOptions: { module: ts.ModuleKind.ES2020, target: ts.ScriptTarget.ES2020 },
  }).outputText
  return import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`)
}

test('follow-along resolves token offsets from one reusable text-node index', () => {
  assert.doesNotMatch(lineMap, /document\.createTreeWalker/)
  assert.match(lineMap, /buildTextNodeIndex\(sentence\)/)
  assert.match(lineMap, /rangeForTextOffsets/)
  assert.match(lineMap, /getClientRectsCount/)
})

test('layout invalidations coalesce and unchanged foreground layout is retained', () => {
  assert.match(hook, /const alreadyScheduled = rebuildFrameRef\.current != null/)
  assert.match(hook, /currentVisualLineMapLayoutKey/)
  assert.match(hook, /layout-not-invalidated/)
})

test('sentence-to-page lookup builds geometry once per measured layout', async () => {
  const reflow = await readFile(new URL('../src/components/ReflowViewer.tsx', import.meta.url), 'utf8')
  assert.match(reflow, /MEASURED_SENTENCE_PAGE_INDEX/)
  assert.match(reflow, /measuredSentencePageIndex\(measure,/)
  assert.match(reflow, /\.get\(contentPage\) \?\? 0/)
})

test('indexed offset boundaries preserve the old preceding-node Range rule', async () => {
  const { resolveTextNodeSegment } = await loadIndexModule()
  const first = { node: { id: 'first' }, start: 0, end: 5 }
  const second = { node: { id: 'second' }, start: 5, end: 11 }
  const index = { segments: [first, second], totalLength: 11 }
  assert.equal(resolveTextNodeSegment(index, 0), first)
  assert.equal(resolveTextNodeSegment(index, 5), first)
  assert.equal(resolveTextNodeSegment(index, 11), second)
  assert.equal(resolveTextNodeSegment(index, 12), null)
})

test('spectrum setup is demand-driven and bypasses Android Web Audio', async () => {
  const playback = await readFile(new URL('../src/hooks/useAudioPlayback.ts', import.meta.url), 'utf8')
  assert.match(playback, /audioSpectrumSubscribersRef\.current\.size === 0\) return null/)
  assert.match(playback, /typeof window === 'undefined' \|\| isAndroidRuntime\(\)/)
  assert.match(playback, /if \(!isAndroidRuntime\(\)\) activateAudioAnalysis\(\)/)
})
