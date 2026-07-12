import type { WeeklyStat } from './types'

export interface GreetingBook {
  title: string
  last_opened_at?: number | null
  updated_at?: number | null
}

export interface DashboardGreetingInput {
  now: Date | number
  readerName?: string
  book?: GreetingBook | null
  progress?: number | null
  weeklyStats?: WeeklyStat[]
  totalBooks?: number
}

export interface DashboardGreeting {
  title: string
  message: string
  period: 'morning' | 'afternoon' | 'evening' | 'night'
  streakDays: number
}

const DAY_MS = 24 * 60 * 60 * 1000

function asDate(value: Date | number): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value)
  return Number.isFinite(date.getTime()) ? date : new Date()
}

function startOfLocalDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate())
}

function localDateKey(value: Date): string {
  const year = value.getFullYear()
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function greetingPeriodForDate(value: Date | number): DashboardGreeting['period'] {
  const hour = asDate(value).getHours()
  if (hour >= 5 && hour < 12) return 'morning'
  if (hour >= 12 && hour < 17) return 'afternoon'
  if (hour >= 17 && hour < 21) return 'evening'
  return 'night'
}

export function readingStreakDays(stats: WeeklyStat[] | undefined, value: Date | number): number {
  if (!stats?.length) return 0
  const activeDates = new Set(
    stats
      .filter((row) => Number(row.reading_ms || 0) > 0)
      .map((row) => row.date),
  )
  let cursor = startOfLocalDay(asDate(value))
  // A streak remains alive until the current day ends, even if the reader has
  // not opened a book yet today.
  if (!activeDates.has(localDateKey(cursor))) {
    cursor = new Date(cursor.getTime() - DAY_MS)
  }
  let streak = 0
  while (activeDates.has(localDateKey(cursor))) {
    streak += 1
    cursor = new Date(cursor.getTime() - DAY_MS)
  }
  return streak
}

export function daysSinceSession(timestamp: number | null | undefined, value: Date | number): number | null {
  const parsed = Number(timestamp)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  const now = startOfLocalDay(asDate(value)).getTime()
  const then = startOfLocalDay(new Date(parsed)).getTime()
  if (!Number.isFinite(then)) return null
  return Math.max(0, Math.floor((now - then) / DAY_MS))
}

function compactBookTitle(value: string): string {
  const title = String(value || 'Your book').replace(/\s+/g, ' ').trim()
  return title.length <= 48 ? title : `${title.slice(0, 45).trimEnd()}…`
}

function bookMessage(book: GreetingBook, progress: number, sessionDays: number | null, streakDays: number): string {
  const title = `“${compactBookTitle(book.title)}”`
  const percent = Math.max(0, Math.min(100, Math.round(progress * 100)))
  let continuation: string
  if (percent >= 98) continuation = `${title} is in its final pages.`
  else if (percent > 0) continuation = `${title} is ready at ${percent}%.`
  else continuation = `${title} is ready when you are.`

  if (streakDays >= 2) return `${streakDays}-day reading streak—${continuation}`
  if (sessionDays === 1) return `Welcome back—${continuation}`
  if (sessionDays != null && sessionDays >= 2 && sessionDays <= 13) {
    return `It’s been ${sessionDays} days—${continuation}`
  }
  if (sessionDays != null && sessionDays >= 14) return `${title} is waiting whenever you’re ready.`
  return continuation
}

export function buildDashboardGreeting(input: DashboardGreetingInput): DashboardGreeting {
  const now = asDate(input.now)
  const period = greetingPeriodForDate(now)
  const name = String(input.readerName || '').replace(/\s+/g, ' ').trim()
  const title = name ? `Good ${period}, ${name}.` : `Good ${period}.`
  const streakDays = readingStreakDays(input.weeklyStats, now)

  if (!input.book || Number(input.totalBooks || 0) <= 0) {
    return {
      title,
      message: 'Your shelf is ready for its first book.',
      period,
      streakDays,
    }
  }

  const progress = Math.max(0, Math.min(1, Number(input.progress) || 0))
  const sessionDays = daysSinceSession(input.book.last_opened_at || input.book.updated_at, now)
  return {
    title,
    message: bookMessage(input.book, progress, sessionDays, streakDays),
    period,
    streakDays,
  }
}
