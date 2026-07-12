import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/systemTheme.ts', import.meta.url), 'utf8')
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2020, target: ts.ScriptTarget.ES2020 },
}).outputText
const { resolveInitialTheme } = await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`)

test('Windows dark mode defaults a fresh Folio install to Blackleaf', () => {
  assert.equal(resolveInitialTheme(null, null, true), 'blackleaf')
})

test('Windows light mode defaults a fresh Folio install to Sepia', () => {
  assert.equal(resolveInitialTheme(null, null, false), 'sepia')
})

test('an explicit Folio theme remains authoritative', () => {
  assert.equal(resolveInitialTheme('folio', null, true), 'folio')
  assert.equal(resolveInitialTheme('light', null, false), 'light')
})

test('legacy dark-mode choices remain compatible', () => {
  assert.equal(resolveInitialTheme(null, 'true', false), 'dark')
  assert.equal(resolveInitialTheme(null, 'false', true), 'sepia')
})
