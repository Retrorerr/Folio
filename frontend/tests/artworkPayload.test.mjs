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

const { readResponseBytesBounded, recentArtworkBookIds } = await loadModule('../src/artworkPayload.ts')

test('known oversized artwork aborts before allocating the response body', async () => {
  let aborted = false
  let read = false
  const response = {
    headers: { get: () => '101' },
    body: { getReader: () => { read = true; throw new Error('must not read') } },
  }
  await assert.rejects(readResponseBytesBounded(response, { abort: () => { aborted = true } }, 100))
  assert.equal(aborted, true)
  assert.equal(read, false)
})

test('streamed oversized artwork is cancelled as soon as the limit is crossed', async () => {
  let aborted = false
  let cancelled = false
  const chunks = [new Uint8Array(60), new Uint8Array(60)]
  const response = {
    headers: { get: () => null },
    body: { getReader: () => ({
      read: async () => chunks.length ? { done: false, value: chunks.shift() } : { done: true },
      cancel: async () => { cancelled = true },
    }) },
  }
  await assert.rejects(readResponseBytesBounded(response, { abort: () => { aborted = true } }, 100))
  assert.equal(aborted, true)
  assert.equal(cancelled, true)
})

test('artwork LRU protection keeps the current and most recently accessed books only', () => {
  const books = [
    { id: 'old', last_opened_at: '2020-01-01' },
    { id: 'recent', last_opened_at: '2026-01-01' },
    { id: 'current', last_opened_at: '2021-01-01' },
  ]
  assert.deepEqual(recentArtworkBookIds(books, 'current', 2), ['current', 'recent'])
})
