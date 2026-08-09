import type { AudioInfo } from './types'
import type { MobilePlaybackStatus } from './mobileApi'

export type { MobilePlaybackStatus, NativeQueueLocation } from './mobileApi'

export type MobilePlaybackMetadata = {
  title?: string
  artist?: string
  album?: string
  bookId?: string
  format?: string
  chapterTitle?: string
  chapterIndex?: number
  chapterCount?: number
  sentenceIndex?: number
  sentenceCount?: number
  chunkProgress?: number
  locationUri?: string
  description?: string
  artworkUrl?: string | null
}

/**
 * Keep Android's large EPUB/PDF adapter out of the desktop startup bundle.
 * The browser caches the dynamic module after the first native playback call.
 */
export async function mobileStartAudio(
  audioInfo: AudioInfo,
  metadata: MobilePlaybackMetadata = {},
  positionMs = 0,
  mode: 'replace' | 'append' = 'replace',
): Promise<MobilePlaybackStatus> {
  const mobileApi = await import('./mobileApi')
  return mobileApi.mobileStartAudio(audioInfo, metadata, positionMs, mode)
}

export async function mobileAudioStatus(): Promise<MobilePlaybackStatus> {
  const mobileApi = await import('./mobileApi')
  return mobileApi.mobileAudioStatus()
}

export async function mobileControlAudio(
  action: 'pause' | 'resume' | 'stop' | 'seek',
  positionMs?: number,
): Promise<MobilePlaybackStatus> {
  const mobileApi = await import('./mobileApi')
  return mobileApi.mobileControlAudio(action, positionMs)
}
