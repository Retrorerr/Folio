import type { TtsEngine, Voice } from './types'

export const SUPERTONIC_ENGINE: TtsEngine = 'supertonic'
export const KOKORO_ENGINE: TtsEngine = 'kokoro'

export const defaultTtsEngine = SUPERTONIC_ENGINE
export const defaultSupertonicVoice = 'M1'
export const defaultKokoroVoice = 'af_heart'
export const defaultSpeed = 1

export const supertonicVoices: Voice[] = [
  { id: 'M1', name: 'M1', tagline: 'Default narrator', description: 'Balanced English narration for books and long-form reading.' },
  { id: 'M2', name: 'M2', tagline: 'Male voice', description: 'Clear English narration with a steady presentation.' },
  { id: 'M3', name: 'M3', tagline: 'Male voice', description: 'Natural English narration with a slightly brighter tone.' },
  { id: 'M4', name: 'M4', tagline: 'Male voice', description: 'Relaxed English narration for comfortable listening.' },
  { id: 'M5', name: 'M5', tagline: 'Male voice', description: 'Firm English narration for dense prose and articles.' },
  { id: 'F1', name: 'F1', tagline: 'Female voice', description: 'Warm English narration with a calm delivery.' },
  { id: 'F2', name: 'F2', tagline: 'Female voice', description: 'Clear English narration with an expressive style.' },
  { id: 'F3', name: 'F3', tagline: 'Female voice', description: 'Light English narration for fiction and dialogue.' },
  { id: 'F4', name: 'F4', tagline: 'Female voice', description: 'Soft English narration for slower reading sessions.' },
  { id: 'F5', name: 'F5', tagline: 'Female voice', description: 'Bright English narration for everyday listening.' },
]

export const kokoroVoices: Voice[] = [
  {
    id: 'af_heart',
    name: 'Heart',
    tagline: 'Best Kokoro voice',
    description: 'Warm, natural, and easy to follow. Recommended when using Kokoro.',
  },
  {
    id: 'af_bella',
    name: 'Bella',
    tagline: 'Expressive reader',
    description: 'Smooth and expressive, with a more lively narration style.',
  },
  {
    id: 'af_nicole',
    name: 'Nicole',
    tagline: 'Soft and calm',
    description: 'Gentle, relaxed, and comfortable over long periods.',
  },
  {
    id: 'bf_emma',
    name: 'Emma',
    tagline: 'British English',
    description: 'A clean British voice with a polished, composed tone.',
  },
  {
    id: 'af_sarah',
    name: 'Sarah',
    tagline: 'Reliable everyday',
    description: 'Clear, steady, and straightforward.',
  },
  {
    id: 'af_aoede',
    name: 'Aoede',
    tagline: 'Light alternative',
    description: 'Pleasant and slightly more distinctive.',
  },
]

export const ttsEngines: Array<{ id: TtsEngine; name: string }> = [
  { id: SUPERTONIC_ENGINE, name: 'Supertonic 3' },
  { id: KOKORO_ENGINE, name: 'Kokoro' },
]

const DEFAULT_VOICES: Record<TtsEngine, string> = {
  [SUPERTONIC_ENGINE]: defaultSupertonicVoice,
  [KOKORO_ENGINE]: defaultKokoroVoice,
}

export function normalizeTtsEngine(engine: unknown): TtsEngine {
  const value = typeof engine === 'string' ? engine : ''
  return value === KOKORO_ENGINE || value === SUPERTONIC_ENGINE ? value : defaultTtsEngine
}

export function voicesForEngine(engine: unknown): Voice[] {
  return normalizeTtsEngine(engine) === KOKORO_ENGINE ? kokoroVoices : supertonicVoices
}

export function defaultVoiceForEngine(engine: unknown): string {
  return DEFAULT_VOICES[normalizeTtsEngine(engine)]
}

export function normalizeVoiceForEngine(engine: unknown, voice: unknown): string {
  const normalizedEngine = normalizeTtsEngine(engine)
  const value = typeof voice === 'string' ? voice : ''
  return voicesForEngine(normalizedEngine).some((item) => item.id === value)
    ? value
    : defaultVoiceForEngine(normalizedEngine)
}

export function normalizeEngineVoices(value: unknown): Record<TtsEngine, string> {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const voices: Record<TtsEngine, string> = {
    supertonic: normalizeVoiceForEngine(SUPERTONIC_ENGINE, raw[SUPERTONIC_ENGINE]),
    kokoro: normalizeVoiceForEngine(KOKORO_ENGINE, raw[KOKORO_ENGINE]),
  }
  return voices
}

export function engineDisplayName(engine: unknown): string {
  return normalizeTtsEngine(engine) === KOKORO_ENGINE ? 'Kokoro' : 'Supertonic 3'
}

export function engineShortLabel(engine: unknown): string {
  return normalizeTtsEngine(engine) === KOKORO_ENGINE ? 'KOKORO' : 'SUPERTONIC'
}

export function voiceLabel(engine: unknown, voice: unknown): string {
  const normalized = normalizeVoiceForEngine(engine, voice)
  return voicesForEngine(engine).find((item) => item.id === normalized)?.name || normalized
}

export function speedRangeForEngine(engine: unknown): { min: number; max: number; presets: number[] } {
  return normalizeTtsEngine(engine) === KOKORO_ENGINE
    ? { min: 0.75, max: 1.35, presets: [0.75, 0.9, 1, 1.15, 1.3] }
    : { min: 0.7, max: 2, presets: [0.7, 0.85, 1, 1.2, 1.5, 2] }
}

export function clampSpeedForEngine(engine: unknown, speed: unknown): number {
  const range = speedRangeForEngine(engine)
  const value = Number.parseFloat(String(speed))
  if (!Number.isFinite(value)) return defaultSpeed
  return Math.min(range.max, Math.max(range.min, value))
}
