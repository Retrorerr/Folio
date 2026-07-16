import type { BookState, BookFormat } from './types'

export type EpubCoverSource = 'epub3' | 'epub2' | 'guide' | 'cover-page' | 'fallback'

export type EpubCoverCandidate = {
  path: string
  mediaType: string
  source: EpubCoverSource
  score?: number
  byteLength?: number
}

const COVER_SOURCE_PRIORITY: Record<EpubCoverSource, number> = {
  epub3: 50,
  epub2: 40,
  guide: 30,
  'cover-page': 20,
  fallback: 10,
}

/** Media types that can be handed to the WebView as a durable cover URL. */
export function normalizeCoverMediaType(value: string | null | undefined): string | null {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === 'image/jpg') return 'image/jpeg'
  if (normalized === 'image/jpeg' || normalized === 'image/png' || normalized === 'image/webp' || normalized === 'image/gif' || normalized === 'image/svg+xml') {
    return normalized
  }
  return null
}

/** URI decoding must not turn a malformed EPUB filename into an import failure. */
export function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * Selects an EPUB cover using the specification's conservative precedence.
 * The parser supplies only candidates whose bytes are present and within its
 * archive limit, so this function stays deterministic and easy to test.
 */
export function chooseEpubCoverCandidate(candidates: EpubCoverCandidate[]): EpubCoverCandidate | null {
  return candidates
    .filter((candidate) => Boolean(candidate.path) && Boolean(normalizeCoverMediaType(candidate.mediaType)))
    .sort((left, right) => {
      const sourceDelta = COVER_SOURCE_PRIORITY[right.source] - COVER_SOURCE_PRIORITY[left.source]
      if (sourceDelta) return sourceDelta
      const scoreDelta = (right.score || 0) - (left.score || 0)
      if (scoreDelta) return scoreDelta
      return (right.byteLength || 0) - (left.byteLength || 0)
    })[0] || null
}

export type NativePlaybackMetadata = {
  bookId: string
  format: BookFormat | string
  title: string
  artist: string
  album: string
  chapterTitle: string
  chapterIndex: number
  chapterCount: number
  sentenceIndex: number
  sentenceCount: number
  chunkProgress: number
  locationUri: string
  description: string
  artworkUrl?: string | null
  artworkMimeType?: string | null
}

function finiteInteger(value: unknown, fallback: number, min = 0): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.floor(parsed))
}

function finiteProgress(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 0
  return Math.min(0.98, Math.max(0, parsed))
}

/** Builds the stable book/chapter location payload sent to Android Media3. */
export function buildNativePlaybackMetadata(
  book: BookState | null | undefined,
  page: number,
  sentence: number,
  sentenceCount = 0,
  chunkProgress = 0,
): NativePlaybackMetadata {
  const pageIndex = finiteInteger(page, 0)
  const chapterCount = finiteInteger(book?.page_count, 0)
  const chapterTitle = String(book?.toc?.[pageIndex]?.title || `Chapter ${pageIndex + 1}`).trim()
  const title = String(book?.title || 'Folio narration').trim() || 'Folio narration'
  const artist = String(book?.author || 'Folio').trim() || 'Folio'
  const format = String(book?.format || 'epub').trim() || 'epub'
  const locationUri = String(book?.filepath || '').trim()
  const chapterLabel = chapterCount > 0 ? `Chapter ${pageIndex + 1} of ${chapterCount}` : `Chapter ${pageIndex + 1}`
  const description = `${chapterLabel} · ${format.toUpperCase()}`
  return {
    bookId: String(book?.id || '').trim(),
    format,
    title,
    artist,
    album: title,
    chapterTitle,
    chapterIndex: pageIndex,
    chapterCount,
    sentenceIndex: finiteInteger(sentence, 0),
    sentenceCount: finiteInteger(sentenceCount, 0),
    chunkProgress: finiteProgress(chunkProgress),
    locationUri,
    description,
    artworkUrl: book?.cover_url || null,
    artworkMimeType: null,
  }
}

