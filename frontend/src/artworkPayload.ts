import type { BookState } from './types'

export async function readResponseBytesBounded(
  response: Response,
  controller: AbortController,
  maxBytes: number,
): Promise<Uint8Array> {
  const limit = Math.max(1, Math.floor(maxBytes))
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limit) {
    controller.abort()
    throw new Error('Artwork exceeds the encoded size limit')
  }
  const reader = response.body?.getReader()
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > limit) {
      controller.abort()
      throw new Error('Artwork exceeds the encoded size limit')
    }
    return bytes
  }

  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value?.byteLength) continue
      total += value.byteLength
      if (total > limit) {
        controller.abort()
        await reader.cancel('Artwork exceeds the encoded size limit').catch(() => {})
        throw new Error('Artwork exceeds the encoded size limit')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  chunks.forEach((chunk) => {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  })
  return bytes
}

export function recentArtworkBookIds(
  books: Pick<BookState, 'id' | 'last_opened_at' | 'updated_at'>[],
  currentBookId?: string | null,
  limit = 4,
): string[] {
  const current = String(currentBookId || '').trim()
  const timestamp = (value: unknown): number => {
    const numeric = Number(value)
    if (Number.isFinite(numeric) && numeric > 0) return numeric
    const parsed = Date.parse(String(value || ''))
    return Number.isFinite(parsed) ? parsed : 0
  }
  const ids = books
    .slice()
    .sort((left, right) => timestamp(right.last_opened_at || right.updated_at) - timestamp(left.last_opened_at || left.updated_at))
    .map((book) => String(book.id || '').trim())
    .filter(Boolean)
  return Array.from(new Set([current, ...ids].filter(Boolean))).slice(0, Math.max(1, limit))
}
