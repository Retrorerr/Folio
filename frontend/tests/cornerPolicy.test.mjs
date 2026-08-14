import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const [tokens, androidStyles, readerStyles, appStyles, androidConfig, cargo, nativeMain] =
  await Promise.all([
    readFile(new URL('../src/styles/tokens.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/styles/android.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/styles/reader.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/App.css', import.meta.url), 'utf8'),
    readFile(new URL('../../src-tauri/tauri.android.conf.json', import.meta.url), 'utf8'),
    readFile(new URL('../../src-tauri/Cargo.toml', import.meta.url), 'utf8'),
    readFile(new URL('../../src-tauri/src/main.rs', import.meta.url), 'utf8'),
  ])

function cssRule(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return source.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`))?.[1] || ''
}

test('the web app surface stays square so the host owns the outer window shape', () => {
  assert.match(cssRule(tokens, '.app-shell'), /border-radius:\s*0/)
})

test('Android is explicitly square, edge-to-edge, and fullscreen', () => {
  const shellRule = cssRule(androidStyles, "html[data-platform='android'] .app-shell")
  const config = JSON.parse(androidConfig)

  assert.match(shellRule, /width:\s*100%/)
  assert.match(shellRule, /height:\s*100%/)
  assert.match(shellRule, /border-radius:\s*0/)
  assert.equal(config.app.windows[0].fullscreen, true)
  assert.equal(config.app.windows[0].decorations, false)
})

test('reader pages and animated page faces stay square', () => {
  for (const selector of [
    '.page-sheet.verso',
    '.page-sheet.recto',
    '.flipper-next .flip-front',
    '.flipper-next .flip-back',
    '.flipper-prev .flip-front',
    '.flipper-prev .flip-back',
  ]) {
    assert.match(cssRule(readerStyles, selector), /border-radius:\s*0/, selector)
  }

  assert.match(cssRule(appStyles, '.reflow-spread.pages-1 .page-sheet'), /border-radius:\s*0/)
})

test('Windows requests native DWM corner policy instead of CSS simulation', () => {
  assert.match(cargo, /"Win32_Graphics_Dwm"/)
  assert.match(nativeMain, /DwmSetWindowAttribute/)
  assert.match(nativeMain, /DWMWA_WINDOW_CORNER_PREFERENCE/)
  assert.match(nativeMain, /DWMWCP_ROUND/)
  assert.match(nativeMain, /window\.hwnd\(\)/)
})
