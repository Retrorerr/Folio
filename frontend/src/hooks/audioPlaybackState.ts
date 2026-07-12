import type { PageText } from '../types'

export type ReadablePosition = {
  page: number
  sentence: number
  pageData: PageText
}

export type NativeQueueProgress = 'current' | 'waiting' | 'advanced' | 'finished' | 'paused' | 'stopped' | 'error'

export function classifyNativeQueueProgress(
  state: string,
  currentSessionId: number,
  expectedSessionId: number,
): NativeQueueProgress {
  if (state === 'error') return 'error'
  if (state === 'stopped' || state === 'idle') return 'stopped'
  if (state === 'paused' && currentSessionId === expectedSessionId) return 'paused'
  if (currentSessionId > expectedSessionId) return 'advanced'
  if (state === 'finished' && currentSessionId === expectedSessionId) return 'finished'
  if (currentSessionId === expectedSessionId) return 'current'
  return 'waiting'
}

type PageLoader = (page: number) => Promise<PageText | null>

export function formatPlaybackTime(seconds: number): string {
  const totalSeconds = Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor(totalSeconds / 60)
  const remainder = totalSeconds % 60
  if (hours > 0) {
    return `${hours}:${String(minutes % 60).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
  }
  return `${minutes}:${String(remainder).padStart(2, '0')}`
}

function sentenceIsReadable(pageData: PageText, sentence: number): boolean {
  return Boolean(pageData.sentences?.[sentence]?.text?.trim())
}

export async function findAdjacentReadablePosition(
  getPageData: PageLoader,
  page: number,
  sentence: number,
  direction: -1 | 1,
  pageCount: number,
): Promise<ReadablePosition | null> {
  if (pageCount <= 0) return null
  let pageNum = Math.max(0, Math.min(pageCount - 1, page))
  let sentenceIdx = sentence + direction

  while (pageNum >= 0 && pageNum < pageCount) {
    const pageData = await getPageData(pageNum)
    if (pageData?.sentences?.length) {
      if (direction > 0) {
        sentenceIdx = Math.max(0, sentenceIdx)
        for (; sentenceIdx < pageData.sentences.length; sentenceIdx += 1) {
          if (sentenceIsReadable(pageData, sentenceIdx)) {
            return { page: pageNum, sentence: sentenceIdx, pageData }
          }
        }
      } else {
        sentenceIdx = Math.min(sentenceIdx, pageData.sentences.length - 1)
        for (; sentenceIdx >= 0; sentenceIdx -= 1) {
          if (sentenceIsReadable(pageData, sentenceIdx)) {
            return { page: pageNum, sentence: sentenceIdx, pageData }
          }
        }
      }
    }

    pageNum += direction
    sentenceIdx = direction > 0 ? 0 : Number.MAX_SAFE_INTEGER
  }
  return null
}

export function setBoundedMapEntry<K, V>(map: Map<K, V>, key: K, value: V, limit: number): void {
  if (map.has(key)) map.delete(key)
  map.set(key, value)
  const boundedLimit = Math.max(1, Math.floor(limit))
  while (map.size > boundedLimit) {
    const oldest = map.keys().next().value as K | undefined
    if (oldest === undefined) break
    map.delete(oldest)
  }
}

export function rememberBoundedSetEntry<T>(set: Set<T>, value: T, limit: number): void {
  if (set.has(value)) set.delete(value)
  set.add(value)
  const boundedLimit = Math.max(1, Math.floor(limit))
  while (set.size > boundedLimit) {
    const oldest = set.values().next().value as T | undefined
    if (oldest === undefined) break
    set.delete(oldest)
  }
}

export function fillSpectrumLevels(
  bins: ArrayLike<number>,
  levels: Float32Array,
  smoothing = 0.58,
  options: {
    sampleRate?: number
    fftSize?: number
    minFrequency?: number
    maxFrequency?: number
  } = {},
): Float32Array {
  if (!bins.length || !levels.length) {
    levels.fill(0)
    return levels
  }
  const keep = Math.max(0, Math.min(0.95, smoothing))
  const update = 1 - keep
  const sampleRate = Math.max(1, Number(options.sampleRate || 48_000))
  const fftSize = Math.max(2, Number(options.fftSize || bins.length * 2))
  const binWidth = sampleRate / fftSize
  const nyquist = sampleRate / 2
  // Narration carries nearly all of its useful visual energy here. A
  // logarithmic scale matches perceived pitch and distributes fundamentals,
  // formants, and upper harmonics across the complete visualiser.
  const minFrequency = Math.max(binWidth, Number(options.minFrequency || 80))
  const maxFrequency = Math.max(
    minFrequency + binWidth,
    Math.min(nyquist, Number(options.maxFrequency || 8_000)),
  )
  const frequencyRatio = maxFrequency / minFrequency
  for (let index = 0; index < levels.length; index += 1) {
    const startRatio = index / levels.length
    const endRatio = (index + 1) / levels.length
    const startFrequency = minFrequency * frequencyRatio ** startRatio
    const endFrequency = minFrequency * frequencyRatio ** endRatio
    const start = Math.min(bins.length - 1, Math.max(0, Math.floor(startFrequency / binWidth)))
    const end = Math.max(start + 1, Math.min(bins.length, Math.ceil(endFrequency / binWidth)))
    let peak = 0
    let sum = 0
    for (let bin = start; bin < end; bin += 1) {
      const value = Number(bins[bin] || 0)
      peak = Math.max(peak, value)
      sum += value
    }
    const average = sum / Math.max(1, end - start)
    const sample = Math.max(peak * 0.7, average) / 255
    const gated = sample < 0.025 ? 0 : Math.min(1, sample * 1.32)
    levels[index] = levels[index] * keep + gated * update
  }
  return levels
}
