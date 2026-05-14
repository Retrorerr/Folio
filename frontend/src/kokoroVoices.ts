import type { TtsEngine, Voice } from './types'

export const kokoroVoices: Voice[] = [
  {
    id: 'af_heart',
    name: 'Heart',
    tagline: 'Best overall',
    description: 'Warm, natural, and easy to follow. Recommended as the default voice for EPUBs, books, and long listening sessions.',
  },
  {
    id: 'af_bella',
    name: 'Bella',
    tagline: 'Expressive reader',
    description: 'Smooth and expressive, with a more lively narration style. A great choice for fiction, dialogue, and immersive reading.',
  },
  {
    id: 'af_nicole',
    name: 'Nicole',
    tagline: 'Soft and calm',
    description: 'Gentle, relaxed, and comfortable over long periods. Ideal for study, quiet reading, and slower-paced material.',
  },
  {
    id: 'bf_emma',
    name: 'Emma',
    tagline: 'British English',
    description: 'A clean British voice with a polished, composed tone. Works well for novels, essays, academic texts, and formal prose.',
  },
  {
    id: 'af_sarah',
    name: 'Sarah',
    tagline: 'Reliable everyday',
    description: 'Clear, steady, and straightforward. A dependable American voice for articles, notes, documents, and general reading.',
  },
  {
    id: 'af_aoede',
    name: 'Aoede',
    tagline: 'Light alternative',
    description: 'Pleasant and slightly more distinctive. A nice softer option when you want something different from the default voices.',
  },
]

export const defaultKokoroVoice = 'af_heart'
export const KOKORO_ENGINE: TtsEngine = 'kokoro'
export const CHATTERBOX_ENGINE: TtsEngine = 'chatterbox-turbo'
export const defaultTtsEngine = KOKORO_ENGINE
export const defaultChatterboxVoice = 'default'

export const ttsEngines: Array<{ id: TtsEngine; name: string }> = [
  { id: KOKORO_ENGINE, name: 'Kokoro' },
  { id: CHATTERBOX_ENGINE, name: 'Chatterbox Turbo (Quality)' },
]

export const chatterboxVoices: Voice[] = [
  {
    id: 'default',
    name: 'Default',
    tagline: 'Quality engine',
    description: 'Chatterbox Turbo, expressive English. Supports inline tags like [laugh], [chuckle], [sigh].',
  },
]

export function isKokoroVoice(voice: unknown): voice is string {
  return kokoroVoices.some((item) => item.id === voice)
}

export function normalizeKokoroVoice(voice: unknown): string {
  return isKokoroVoice(voice) ? voice : defaultKokoroVoice
}

export function isChatterboxVoice(voice: unknown): voice is string {
  return chatterboxVoices.some((item) => item.id === voice)
}

export function normalizeChatterboxVoice(voice: unknown): string {
  return isChatterboxVoice(voice) ? voice : defaultChatterboxVoice
}

export function normalizeTtsEngine(engine: unknown): TtsEngine {
  if (engine === CHATTERBOX_ENGINE) return CHATTERBOX_ENGINE
  // Migrate legacy persisted "vibevoice" identifier to Chatterbox Turbo.
  if (engine === 'vibevoice') return CHATTERBOX_ENGINE
  return KOKORO_ENGINE
}

export function voicesForEngine(engine: unknown): Voice[] {
  return normalizeTtsEngine(engine) === CHATTERBOX_ENGINE ? chatterboxVoices : kokoroVoices
}

export function normalizeVoiceForEngine(engine: unknown, voice: unknown): string {
  return normalizeTtsEngine(engine) === CHATTERBOX_ENGINE
    ? normalizeChatterboxVoice(voice)
    : normalizeKokoroVoice(voice)
}
