import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

async function loadTypeScriptModule(relativePath) {
  const source = await readFile(new URL(relativePath, import.meta.url), 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2020, target: ts.ScriptTarget.ES2020 },
  }).outputText
  return import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`)
}

const {
  remapMobileReadingPosition,
  structureMobileSpineDocuments,
} = await loadTypeScriptModule('../src/mobileChapterStructure.ts')

test('one EPUB spine document can produce several real mobile chapters', () => {
  const chapters = structureMobileSpineDocuments([[
    { type: 'heading', level: 1, text: 'Chapter I — Arrival' },
    { type: 'paragraph', text: 'The first chapter begins.' },
    { type: 'heading', level: 1, text: 'Chapter II: Crossing' },
    { type: 'paragraph', text: 'The second chapter begins.' },
  ]])

  assert.deepEqual(chapters.map(({ number, title }) => ({ number, title })), [
    { number: 'I', title: 'Arrival' },
    { number: 'II', title: 'Crossing' },
  ])
})

test('an untitled spine continuation stays in the preceding chapter', () => {
  const chapters = structureMobileSpineDocuments([
    [
      { type: 'heading', level: 1, text: 'Chapter 1 — Before' },
      { type: 'paragraph', text: 'First half.' },
    ],
    [
      { type: 'paragraph', text: 'Second half.' },
      { type: 'heading', level: 1, text: 'Chapter 2 — After' },
      { type: 'paragraph', text: 'A new chapter.' },
    ],
  ])

  assert.equal(chapters.length, 2)
  assert.deepEqual(chapters[0].blocks.map((block) => block.text), ['First half.', 'Second half.'])
})

test('separate untitled spine documents remain separate chapters', () => {
  const chapters = structureMobileSpineDocuments([
    [{ type: 'paragraph', text: 'First independently packaged chapter.' }],
    [{ type: 'paragraph', text: 'Second independently packaged chapter.' }],
  ])

  assert.equal(chapters.length, 2)
  assert.deepEqual(chapters.map((chapter) => chapter.blocks[0].text), [
    'First independently packaged chapter.',
    'Second independently packaged chapter.',
  ])
})

test('explicit chapter headings outrank a one-off document title', () => {
  const chapters = structureMobileSpineDocuments([[
    { type: 'heading', level: 1, text: 'The Complete Novel' },
    { type: 'heading', level: 2, text: 'Chapter I — Arrival' },
    { type: 'paragraph', text: 'The first chapter begins.' },
    { type: 'heading', level: 2, text: 'Chapter II — Crossing' },
    { type: 'paragraph', text: 'The second chapter begins.' },
  ]])

  assert.deepEqual(chapters.map(({ number, title }) => ({ number, title })), [
    { number: 'I', title: 'Arrival' },
    { number: 'II', title: 'Crossing' },
  ])
})

test('short real opening chapters survive while explicit copyright matter is removed', () => {
  const chapters = structureMobileSpineDocuments([
    [
      { type: 'heading', level: 1, text: 'Copyright' },
      { type: 'paragraph', text: 'Copyright © 2026. All rights reserved. ISBN 123.' },
    ],
    [
      { type: 'heading', level: 1, text: 'Prologue' },
      { type: 'paragraph', text: 'A very short beginning.' },
    ],
  ])

  assert.equal(chapters.length, 1)
  assert.equal(chapters[0].title, 'Prologue')
})

test('saved mobile positions follow their sentence when chapter boundaries change', () => {
  const oldPages = [{ sentences: [
    { text: 'Chapter one.', global_sentence_idx: 0 },
    { text: 'First body.', global_sentence_idx: 1 },
    { text: 'Chapter two.', global_sentence_idx: 2 },
    { text: 'Second body.', global_sentence_idx: 3 },
  ] }]
  const newPages = [
    { sentences: [{ text: 'Chapter one.', global_sentence_idx: 0 }, { text: 'First body.', global_sentence_idx: 1 }] },
    { sentences: [{ text: 'Chapter two.', global_sentence_idx: 2 }, { text: 'Second body.', global_sentence_idx: 3 }] },
  ]

  const mapped = remapMobileReadingPosition(
    { page: 0, sentence_idx: 3, content_page: 4, visual_page: 9, pages_per_view: 2, layout_key: 'stale-layout', chunk_progress: 0.6 },
    oldPages,
    newPages,
  )

  assert.deepEqual(mapped, {
    page: 1,
    sentence_idx: 1,
    content_page: null,
    visual_page: null,
    pages_per_view: null,
    layout_key: null,
    chunk_progress: 0,
  })
})
