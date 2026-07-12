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

const { buildStartupPresentation } = await loadTypeScriptModule('../src/startupPresentation.ts')

const input = (overrides = {}) => ({
  interfaceReady: false,
  backendLaunchStarted: false,
  backendLaunchSettled: false,
  backendReachable: false,
  recentLoaded: false,
  bookCount: 0,
  startupIssue: false,
  ...overrides,
})

test('startup progress follows actual milestones and never moves backwards', () => {
  const phases = [
    input(),
    input({ backendLaunchStarted: true }),
    input({ backendLaunchStarted: true, backendLaunchSettled: true }),
    input({ backendLaunchStarted: true, backendLaunchSettled: true, backendReachable: true }),
    input({ backendLaunchStarted: true, backendLaunchSettled: true, backendReachable: true, recentLoaded: true }),
    input({ backendLaunchStarted: true, backendLaunchSettled: true, backendReachable: true, recentLoaded: true, interfaceReady: true }),
  ]
  assert.deepEqual(phases.map((phase) => buildStartupPresentation(phase).progress), [14, 30, 48, 72, 94, 100])
})

test('startup is ready only after the library, backend, and interface assets are ready', () => {
  assert.equal(buildStartupPresentation(input({ interfaceReady: true, backendReachable: true })).ready, false)
  const ready = buildStartupPresentation(input({ interfaceReady: true, backendReachable: true, recentLoaded: true, bookCount: 1 }))
  assert.equal(ready.ready, true)
  assert.equal(ready.headline, 'Your library is ready')
  assert.equal(ready.statusText, '1 book is ready where you left off.')
})

test('startup errors stay reassuring and avoid exposing technical details', () => {
  const issue = buildStartupPresentation(input({ startupIssue: true, bookCount: 4 }))
  assert.equal(issue.headline, 'Folio needs a moment')
  assert.match(issue.statusText, /books are safe/i)
  assert.doesNotMatch(issue.statusText, /backend|127\.0\.0\.1|provider/i)
})
