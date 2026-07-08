import type { BookState } from '../types'

export type BookSettingsPatch = Partial<Pick<BookState, 'tts_engine' | 'voice' | 'tts_voices' | 'speed'>>

type BookSettingsShape = Pick<BookState, 'tts_engine' | 'voice' | 'tts_voices' | 'speed'>

export function sameVoiceMap(a: BookState['tts_voices'], b: BookState['tts_voices']) {
  const left = a || {}
  const right = b || {}
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  for (const key of keys) {
    if (left[key] !== right[key]) return false
  }
  return true
}

export function sameBookSettings(book: BookSettingsShape, settings: BookSettingsPatch) {
  return (
    (settings.tts_engine === undefined || book.tts_engine === settings.tts_engine) &&
    (settings.voice === undefined || book.voice === settings.voice) &&
    (settings.speed === undefined || Math.abs(Number(book.speed) - Number(settings.speed)) < 0.0001) &&
    (settings.tts_voices === undefined || sameVoiceMap(book.tts_voices, settings.tts_voices))
  )
}

export function mergeBookSettingsIfChanged<T extends BookSettingsShape>(book: T, settings: BookSettingsPatch): T {
  return sameBookSettings(book, settings) ? book : { ...book, ...settings } as T
}
