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
  buildDashboardGreeting,
  daysSinceSession,
  greetingPeriodForDate,
  readingStreakDays,
} = await loadTypeScriptModule('../src/dashboardGreeting.ts')

const stat = (date, readingMs) => ({ date, label: '', reading_ms: readingMs, minutes: 0, pages: 0 })

test('dashboard greeting is personal, concise, and deterministic for an active book', () => {
  const now = new Date(2026, 6, 11, 19, 30)
  const input = {
    now,
    readerName: 'Maris',
    totalBooks: 3,
    book: { title: 'Take Me to Your Leader', last_opened_at: now.getTime() - 60_000 },
    progress: 0.356,
    weeklyStats: [stat('2026-07-11', 60_000)],
  }

  const first = buildDashboardGreeting(input)
  const second = buildDashboardGreeting(input)

  assert.deepEqual(first, second)
  assert.equal(first.title, 'Good evening, Maris.')
  assert.equal(first.message, '“Take Me to Your Leader” is ready at 36%.')
})

test('reading streak survives until the current day ends', () => {
  const now = new Date(2026, 6, 11, 9)
  const stats = [
    stat('2026-07-08', 1),
    stat('2026-07-09', 1),
    stat('2026-07-10', 1),
    stat('2026-07-11', 0),
  ]

  assert.equal(readingStreakDays(stats, now), 3)
  const greeting = buildDashboardGreeting({
    now,
    readerName: 'Maris',
    totalBooks: 1,
    book: { title: 'A Book', last_opened_at: new Date(2026, 6, 10).getTime() },
    progress: 0.5,
    weeklyStats: stats,
  })
  assert.equal(greeting.message, '3-day reading streak—“A Book” is ready at 50%.')
})

test('first-launch greeting has a stable fallback when library context is unavailable', () => {
  const greeting = buildDashboardGreeting({
    now: new Date(2026, 6, 11, 1),
    readerName: '',
    totalBooks: 0,
  })

  assert.equal(greeting.title, 'Good night.')
  assert.equal(greeting.message, 'Your shelf is ready for its first book.')
  assert.equal(greetingPeriodForDate(new Date(2026, 6, 11, 12)), 'afternoon')
})

test('session age compares local calendar days', () => {
  const now = new Date(2026, 6, 11, 0, 5)
  const yesterday = new Date(2026, 6, 10, 23, 55)
  assert.equal(daysSinceSession(yesterday.getTime(), now), 1)
})
