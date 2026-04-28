export const kokoroVoices = [
  {
    id: 'af_heart',
    name: 'Heart',
    tagline: 'Best overall',
    description: 'Warm, natural, and easy to follow. Recommended as the default voice for books, PDFs, and long listening sessions.',
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

export function isKokoroVoice(voice) {
  return kokoroVoices.some((item) => item.id === voice)
}

export function normalizeKokoroVoice(voice) {
  return isKokoroVoice(voice) ? voice : defaultKokoroVoice
}
