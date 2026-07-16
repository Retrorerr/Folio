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
  buildNativePlaybackMetadata,
  chooseEpubCoverCandidate,
  normalizeCoverMediaType,
} = await loadTypeScriptModule('../src/mobileMetadata.ts')

test('cover selection gives EPUB3 metadata precedence over legacy and filename guesses', () => {
  const selected = chooseEpubCoverCandidate([
    { path: 'images/cover.png', mediaType: 'image/png', source: 'fallback', byteLength: 9000 },
    { path: 'images/legacy.jpg', mediaType: 'image/jpg', source: 'epub2', byteLength: 1000 },
    { path: 'images/declared.webp', mediaType: 'image/webp', source: 'epub3', byteLength: 10 },
  ])
  assert.equal(selected?.path, 'images/declared.webp')
  assert.equal(normalizeCoverMediaType(' IMAGE/JPG '), 'image/jpeg')
  assert.equal(normalizeCoverMediaType('image/bmp'), null)
})

test('native metadata uses book identity consistently across Media3 and reopen state', () => {
  const metadata = buildNativePlaybackMetadata({
    id: 'book-123',
    filepath: 'android://book-123/novel.epub',
    title: 'The Novel',
    author: 'A. Writer',
    page_count: 4,
    format: 'epub',
    toc: [
      { title: 'Opening', page: 0 },
      { title: 'The Turning Point', page: 1 },
    ],
    cover_url: 'data:image/png;base64,cover',
  }, 1, 12, 20, 0.44)

  assert.deepEqual(metadata, {
    bookId: 'book-123',
    format: 'epub',
    title: 'The Novel',
    artist: 'A. Writer',
    album: 'The Novel',
    chapterTitle: 'The Turning Point',
    chapterIndex: 1,
    chapterCount: 4,
    sentenceIndex: 12,
    sentenceCount: 20,
    chunkProgress: 0.44,
    locationUri: 'android://book-123/novel.epub',
    description: 'Chapter 2 of 4 · EPUB',
    artworkUrl: 'data:image/png;base64,cover',
    artworkMimeType: null,
  })
})

test('metadata clamps stale queue positions and supplies safe defaults', () => {
  const metadata = buildNativePlaybackMetadata(null, -4, -2, -1, 9)
  assert.equal(metadata.title, 'Folio narration')
  assert.equal(metadata.artist, 'Folio')
  assert.equal(metadata.album, 'Folio narration')
  assert.equal(metadata.chapterIndex, 0)
  assert.equal(metadata.sentenceIndex, 0)
  assert.equal(metadata.sentenceCount, 0)
  assert.equal(metadata.chunkProgress, 0.98)
  assert.equal(metadata.description, 'Chapter 1 · EPUB')
})
