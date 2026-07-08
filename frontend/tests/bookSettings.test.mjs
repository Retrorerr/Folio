import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/hooks/bookSettings.ts', import.meta.url), 'utf8')
const output = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2020,
    target: ts.ScriptTarget.ES2020,
  },
}).outputText
const helpers = await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`)
const { mergeBookSettingsIfChanged, sameBookSettings, sameVoiceMap } = helpers

function makeBook(overrides = {}) {
  return {
    id: 'book-1',
    filepath: 'book.epub',
    title: 'Test Book',
    author: 'Tester',
    page_count: 10,
    toc: [],
    format: 'epub',
    tts_engine: 'kokoro',
    voice: 'af_bella',
    tts_voices: { kokoro: 'af_bella', supertonic: 'M1' },
    speed: 0.95,
    last_position: { page: 0, sentence_idx: 0 },
    bookmarks: [],
    ...overrides,
  }
}

test('sameVoiceMap compares voice maps without relying on object identity', () => {
  assert.equal(sameVoiceMap({ kokoro: 'af_bella', supertonic: 'M1' }, { supertonic: 'M1', kokoro: 'af_bella' }), true)
  assert.equal(sameVoiceMap({ kokoro: 'af_bella' }, { kokoro: 'af_heart' }), false)
  assert.equal(sameVoiceMap({ kokoro: 'af_bella' }, { kokoro: 'af_bella', supertonic: 'M1' }), false)
})

test('sameBookSettings treats backend echoes as unchanged settings', () => {
  const book = makeBook()

  assert.equal(sameBookSettings(book, {
    tts_engine: 'kokoro',
    voice: 'af_bella',
    tts_voices: { kokoro: 'af_bella', supertonic: 'M1' },
    speed: 0.95000001,
  }), true)
})

test('mergeBookSettingsIfChanged preserves identity for unchanged settings', () => {
  const book = makeBook()
  const merged = mergeBookSettingsIfChanged(book, {
    tts_engine: 'kokoro',
    voice: 'af_bella',
    tts_voices: { kokoro: 'af_bella', supertonic: 'M1' },
    speed: 0.95,
  })

  assert.equal(merged, book)
})

test('mergeBookSettingsIfChanged creates a new book only when settings differ', () => {
  const book = makeBook()
  const merged = mergeBookSettingsIfChanged(book, { voice: 'af_heart' })

  assert.notEqual(merged, book)
  assert.equal(merged.voice, 'af_heart')
  assert.equal(book.voice, 'af_bella')
})
