import { unzipSync } from 'fflate'
import { clampSpeedForEngine, normalizeTtsEngine, normalizeVoiceForEngine } from './ttsVoices'
import { applyAndroidPlatformMetrics, type AndroidPlatformMetrics } from './androidShell'
import { chooseEpubCoverCandidate, metadataRepairEligible, normalizeCoverMediaType, safeDecodeURIComponent, safeRepairedToc, type EpubCoverCandidate, type EpubCoverSource } from './mobileMetadata'
import { remapMobileReadingPosition, structureMobileSpineDocuments, type MobileRawBlock } from './mobileChapterStructure'
import { readResponseBytesBounded, recentArtworkBookIds } from './artworkPayload'
import {
  NARRATION_INDEX_VERSION,
  type BookState,
  type DashboardPayload,
  type AudioInfo,
  type ModelInstallInfo,
  type PageText,
  type ReflowChapter,
  type ReflowDocument,
  type ReflowSentence,
  type SearchResponse,
  type TtsGenerateResponse,
} from './types'

type MobileRecord = {
  book: BookState
  reflow: ReflowDocument
  pages: PageText[]
  contentRevision?: string
  source?: Blob
  mimeType?: string
}

type MobileContentRecord = Pick<MobileRecord, 'reflow' | 'pages' | 'contentRevision'> & { bookId: string }
type MobileSourceRecord = { bookId: string; source: Blob; mimeType?: string }
type MobileAudioRecord = {
  key: string
  filename: string
  bookId: string
  page: number
  sentence: number
  engine: string
  voice: string
  speed: number
  audio: Blob
  durationMs: number
  sampleRate: number
  createdAt: number
  lastAccessedAt: number
}

type StoredValue = { key: string; value: unknown }

type NativeModelAsset = {
  installed?: boolean
  loaded?: boolean
  synthesisReady?: boolean
  state?: ModelInstallInfo['state']
  downloaded_bytes?: number
  total_bytes?: number
  progress?: number
  download_active?: boolean
  download_label?: string | null
  download_error?: string | null
  approx_download_bytes?: number
  path?: string
  runner?: string
  error?: string | null
  [key: string]: unknown
}

type NativePlatformStatus = AndroidPlatformMetrics & {
  platform?: string
  nativeTtsAvailable: boolean
  modelAssets: Record<string, NativeModelAsset>
}

type MobilePreloadJob = {
  state: 'preloading' | 'ready' | 'error'
  failed: number[]
  promise: Promise<void>
}

type MobileBufferWindow = { cancelled: boolean }

type AudioRequestIdentity = {
  bookId: string
  page: number
  sentence: number
  engine: 'supertonic' | 'kokoro'
  voice: string
  speed: number
}

const DB_NAME = 'folio-android'
const DB_VERSION = 3
// Retained read-only for an in-place v1 migration.
const RECORDS_STORE = 'records'
const BOOKS_STORE = 'books'
const CONTENT_STORE = 'content'
const SOURCES_STORE = 'sources'
const VALUES_STORE = 'values'
const AUDIO_STORE = 'audio'
const MAX_EPUB_BYTES = 64 * 1024 * 1024
const MAX_EPUB_ENTRY_BYTES = 48 * 1024 * 1024
const MAX_EPUB_EXPANDED_BYTES = 192 * 1024 * 1024
const MAX_EPUB_COVER_BYTES = 8 * 1024 * 1024
const MAX_PDF_BYTES = 96 * 1024 * 1024
const MAX_PDF_PAGES = 2_000
const MAX_AUDIO_CACHE_BYTES = 256 * 1024 * 1024
const MAX_AUDIO_CACHE_RECORDS = 512
const MAX_AUDIO_RECORD_BYTES = 32 * 1024 * 1024
const MAX_PRELOAD_SENTENCES = 128
const MAX_BUFFER_SENTENCES = 24
const MAX_TRACKED_PRELOAD_JOBS = 32
const INTER_CHUNK_PAUSE_MS = 500
const MOBILE_CONTENT_REVISION = 'android-epub-chapters-v2'
const MOBILE_TTS_CACHE_REVISION = 'android-native-misaki-fba1236595f2-v4-narration-pauses-v5-logical-chapters'
const MOBILE_METADATA_REVISION = 'android-book-metadata-v3'
const resourceCache = new Map<string, string>()
const resourceCacheSizes = new Map<string, number>()
// Matches the reader's bounded AudioInfo map so we never revoke a Blob URL
// while the playback hook can still legitimately reuse it.
const RESOURCE_CACHE_LIMIT = 160
const CONTENT_CACHE_LIMIT = 6
let dbPromise: Promise<IDBDatabase> | null = null
let booksCache: BookState[] | null = null
let booksLoadPromise: Promise<BookState[]> | null = null
const contentCache = new Map<string, MobileContentRecord>()
const contentUpgradeJobs = new Map<string, Promise<MobileRecord | null>>()
const audioGenerationJobs = new Map<string, Promise<MobileAudioRecord>>()
const preloadJobs = new Map<string, MobilePreloadJob>()
const bufferWindows = new Map<string, MobileBufferWindow>()
let audioCacheEpoch = 0
let nativePlatformStatusCache: { value: NativePlatformStatus; at: number } | null = null
let nativePlatformStatusInFlight: Promise<NativePlatformStatus> | null = null
let metadataRepairScheduled = false
const NATIVE_STATUS_CACHE_MS = 900
const NATIVE_STATUS_TIMEOUT_MS = 2400

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = (event) => {
      const db = request.result
      const transaction = request.transaction
      const books = db.objectStoreNames.contains(BOOKS_STORE)
        ? transaction!.objectStore(BOOKS_STORE)
        : db.createObjectStore(BOOKS_STORE, { keyPath: 'id' })
      const content = db.objectStoreNames.contains(CONTENT_STORE)
        ? transaction!.objectStore(CONTENT_STORE)
        : db.createObjectStore(CONTENT_STORE, { keyPath: 'bookId' })
      const sources = db.objectStoreNames.contains(SOURCES_STORE)
        ? transaction!.objectStore(SOURCES_STORE)
        : db.createObjectStore(SOURCES_STORE, { keyPath: 'bookId' })
      if (!db.objectStoreNames.contains(VALUES_STORE)) db.createObjectStore(VALUES_STORE, { keyPath: 'key' })
      let audio: IDBObjectStore
      if (!db.objectStoreNames.contains(AUDIO_STORE)) {
        audio = db.createObjectStore(AUDIO_STORE, { keyPath: 'key' })
      } else {
        audio = transaction!.objectStore(AUDIO_STORE)
        if (audio.keyPath !== 'key') {
          db.deleteObjectStore(AUDIO_STORE)
          audio = db.createObjectStore(AUDIO_STORE, { keyPath: 'key' })
        }
      }
      if (!audio.indexNames.contains('filename')) audio.createIndex('filename', 'filename', { unique: true })
      if (!audio.indexNames.contains('bookId')) audio.createIndex('bookId', 'bookId')
      if (!audio.indexNames.contains('lastAccessedAt')) audio.createIndex('lastAccessedAt', 'lastAccessedAt')
      if (!db.objectStoreNames.contains(RECORDS_STORE)) {
        db.createObjectStore(RECORDS_STORE, { keyPath: 'book.id' })
      } else if ((event as IDBVersionChangeEvent).oldVersion < 2) {
        // Copy v1's heavyweight records once. Future metadata writes touch only
        // BOOKS_STORE; original files and parsed content remain in their own stores.
        transaction!.objectStore(RECORDS_STORE).openCursor().onsuccess = (event) => {
          const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result
          if (!cursor) return
          const record = cursor.value as MobileRecord
          if (record?.book?.id && record.reflow && Array.isArray(record.pages)) {
            books.put(record.book)
            content.put({ bookId: record.book.id, reflow: record.reflow, pages: record.pages } satisfies MobileContentRecord)
            if (record.source instanceof Blob) {
              sources.put({ bookId: record.book.id, source: record.source, mimeType: record.mimeType } satisfies MobileSourceRecord)
            }
          }
          cursor.continue()
        }
      }
    }
    request.onsuccess = () => {
      const db = request.result
      db.onversionchange = () => {
        db.close()
        dbPromise = null
        booksCache = null
        booksLoadPromise = null
      }
      // The v2 upgrade transaction has committed by this point, so current
      // books are ready. Reclaim legacy heavyweight copies in the background:
      // a slow or stale cleanup transaction must never hold the Android boot
      // screen open or block status/library requests.
      resolve(db)
      if (db.objectStoreNames.contains(RECORDS_STORE)) {
        try {
          const cleanup = db.transaction(RECORDS_STORE, 'readwrite')
          cleanup.objectStore(RECORDS_STORE).clear()
        } catch {
          // The next launch can retry this best-effort cleanup.
        }
      }
    }
    request.onerror = () => {
      dbPromise = null
      reject(request.error || new Error('Could not open Folio storage'))
    }
    request.onblocked = () => {
      dbPromise = null
      reject(new Error('Folio storage upgrade is blocked by another open app window.'))
    }
  })
  return dbPromise
}

async function getAllBooks(): Promise<BookState[]> {
  if (booksCache) return booksCache
  if (!booksLoadPromise) {
    // Status, dashboard and recent-book requests all start together during an
    // Android cold launch. Share one IndexedDB read rather than opening
    // competing startup transactions whose completion order can strand one
    // caller behind legacy maintenance.
    booksLoadPromise = openDb().then((db) => new Promise<BookState[]>((resolve, reject) => {
      const request = db.transaction(BOOKS_STORE, 'readonly').objectStore(BOOKS_STORE).getAll()
      request.onsuccess = () => resolve((request.result || []) as BookState[])
      request.onerror = () => reject(request.error || new Error('Could not read Folio library'))
    }))
  }
  try {
    booksCache = await booksLoadPromise
    void mobilePruneArtworkCache(recentArtworkBookIds(booksCache)).catch(() => {})
    scheduleMetadataRepair(booksCache)
    return booksCache
  } finally {
    booksLoadPromise = null
  }
}

function cacheContent(record: MobileContentRecord): void {
  contentCache.delete(record.bookId)
  contentCache.set(record.bookId, record)
  while (contentCache.size > CONTENT_CACHE_LIMIT) {
    const oldest = contentCache.keys().next().value
    if (!oldest) break
    contentCache.delete(oldest)
  }
}

async function getRecord(bookId: string): Promise<MobileRecord | null> {
  const book = (await getAllBooks()).find((entry) => entry.id === bookId)
  if (!book) return null
  let content = contentCache.get(bookId)
  if (!content) {
    const db = await openDb()
    content = await new Promise<MobileContentRecord | undefined>((resolve, reject) => {
      const request = db.transaction(CONTENT_STORE, 'readonly').objectStore(CONTENT_STORE).get(bookId)
      request.onsuccess = () => resolve(request.result as MobileContentRecord | undefined)
      request.onerror = () => reject(request.error || new Error('Could not read book content'))
    })
    if (!content) return null
    cacheContent(content)
  }
  const record: MobileRecord = { book, ...content }
  if (book.format === 'epub' && content.contentRevision !== MOBILE_CONTENT_REVISION) {
    return await upgradeMobileEpubRecord(record) || record
  }
  return record
}

async function getSourceRecord(bookId: string): Promise<MobileSourceRecord | null> {
  const db = await openDb()
  return new Promise<MobileSourceRecord | null>((resolve, reject) => {
    const request = db.transaction(SOURCES_STORE, 'readonly').objectStore(SOURCES_STORE).get(bookId)
    request.onsuccess = () => resolve((request.result as MobileSourceRecord | undefined) || null)
    request.onerror = () => reject(request.error || new Error('Could not read the original book file'))
  })
}

async function putBookState(book: BookState): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(BOOKS_STORE, 'readwrite').objectStore(BOOKS_STORE).put(book)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error || new Error('Could not save Folio book'))
  })
  const books = await getAllBooks()
  const index = books.findIndex((entry) => entry.id === book.id)
  if (index >= 0) books[index] = book
  else books.push(book)
}

async function putImportedRecord(record: MobileRecord): Promise<void> {
  const db = await openDb()
  const stores = [BOOKS_STORE, CONTENT_STORE, SOURCES_STORE]
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(stores, 'readwrite')
    transaction.objectStore(BOOKS_STORE).put(record.book)
    transaction.objectStore(CONTENT_STORE).put({
      bookId: record.book.id,
      reflow: record.reflow,
      pages: record.pages,
      contentRevision: record.contentRevision,
    } satisfies MobileContentRecord)
    if (record.source) {
      transaction.objectStore(SOURCES_STORE).put({ bookId: record.book.id, source: record.source, mimeType: record.mimeType } satisfies MobileSourceRecord)
    }
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error || new Error('Could not save imported book'))
    transaction.onabort = () => reject(transaction.error || new Error('Could not save imported book'))
  })
  await putBookStateCache(record.book)
  cacheContent({
    bookId: record.book.id,
    reflow: record.reflow,
    pages: record.pages,
    contentRevision: record.contentRevision,
  })
}

async function putBookStateCache(book: BookState): Promise<void> {
  const books = await getAllBooks()
  const index = books.findIndex((entry) => entry.id === book.id)
  if (index >= 0) books[index] = book
  else books.push(book)
}

function metadataNeedsRepair(book: BookState): boolean {
  return metadataRepairEligible(book, MOBILE_METADATA_REVISION, false)
}

function metadataTitleIsInferior(book: BookState, filename: string): boolean {
  const title = normalizeText(book.title || '')
  const fallback = filename.replace(/\.epub$/i, '').trim()
  return !title || /^unknown(?: title)?$/i.test(title) || title === fallback
}

async function repairBookMetadata(
  book: BookState,
  bytes: Uint8Array,
  filename: string,
  options: { explicit?: boolean } = {},
): Promise<BookState> {
  if (!metadataRepairEligible(book, MOBILE_METADATA_REVISION, Boolean(options.explicit))) return book
  try {
    const metadata = extractEpubMetadata(bytes, filename)
    const existingSource = String(book.cover_source || '').toLowerCase()
    const useCover = Boolean(metadata.coverUrl) && (
      !book.cover_url || !existingSource || /fallback|cover-page/.test(existingSource)
    )
    const repairedToc = safeRepairedToc(metadata.toc, book.page_count)
    const repaired: BookState = {
      ...book,
      title: metadataTitleIsInferior(book, filename) ? metadata.title : book.title,
      author: !normalizeText(book.author || '') || /^unknown$/i.test(book.author) ? metadata.author : book.author,
      toc: (!Array.isArray(book.toc) || book.toc.length < 2) && repairedToc ? repairedToc : book.toc,
      cover_url: useCover ? metadata.coverUrl : book.cover_url,
      cover_source: useCover ? metadata.coverSource : book.cover_source,
      metadata_revision: MOBILE_METADATA_REVISION,
      metadata_repair_attempted_revision: null,
    }
    await putBookState(repaired)
    return repaired
  } catch {
    if (options.explicit) return book
    // A revoked SAF grant or corrupt source must not make a usable book vanish.
    const attempted = { ...book, metadata_repair_attempted_revision: MOBILE_METADATA_REVISION }
    await putBookState(attempted).catch(() => {})
    return attempted
  }
}

function scheduleMetadataRepair(books: BookState[]): void {
  if (metadataRepairScheduled) return
  const candidate = books.find(metadataNeedsRepair)
  if (!candidate) return
  metadataRepairScheduled = true
  setTimeout(() => {
    void (async () => {
      try {
        const source = await getSourceRecord(candidate.id)
        if (source?.source) {
          const bytes = new Uint8Array(await source.source.arrayBuffer())
          await repairBookMetadata(candidate, bytes, candidate.filepath.split('/').pop() || `${candidate.id}.epub`)
        } else {
          await repairBookMetadata(candidate, new Uint8Array(), candidate.filepath.split('/').pop() || `${candidate.id}.epub`)
        }
      } catch {
        // Lazy repair is intentionally non-blocking and best effort.
      } finally {
        metadataRepairScheduled = false
        const current = booksCache || []
        const next = current.find(metadataNeedsRepair)
        if (next) scheduleMetadataRepair(current)
      }
    })()
  }, 0)
}

async function deleteRecord(bookId: string): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const stores = [BOOKS_STORE, CONTENT_STORE, SOURCES_STORE, RECORDS_STORE]
    const transaction = db.transaction(stores, 'readwrite')
    transaction.objectStore(BOOKS_STORE).delete(bookId)
    transaction.objectStore(CONTENT_STORE).delete(bookId)
    transaction.objectStore(SOURCES_STORE).delete(bookId)
    transaction.objectStore(RECORDS_STORE).delete(bookId)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error || new Error('Could not remove Folio book'))
    transaction.onabort = () => reject(transaction.error || new Error('Could not remove Folio book'))
  })
  await clearAudioRecords(bookId)
  booksCache = (await getAllBooks()).filter((entry) => entry.id !== bookId)
  contentCache.delete(bookId)
}

async function getValue<T>(key: string, fallback: T): Promise<T> {
  const db = await openDb()
  return new Promise<T>((resolve, reject) => {
    const request = db.transaction(VALUES_STORE, 'readonly').objectStore(VALUES_STORE).get(key)
    request.onsuccess = () => resolve((request.result as StoredValue | undefined)?.value as T ?? fallback)
    request.onerror = () => reject(request.error || new Error('Could not read Folio settings'))
  })
}

async function putValue(key: string, value: unknown): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(VALUES_STORE, 'readwrite').objectStore(VALUES_STORE).put({ key, value })
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error || new Error('Could not save Folio settings'))
  })
}

async function getAudioRecord(key: string): Promise<MobileAudioRecord | null> {
  const db = await openDb()
  const record = await new Promise<MobileAudioRecord | null>((resolve, reject) => {
    const request = db.transaction(AUDIO_STORE, 'readonly').objectStore(AUDIO_STORE).get(key)
    request.onsuccess = () => resolve((request.result as MobileAudioRecord | undefined) || null)
    request.onerror = () => reject(request.error || new Error('Could not read cached narration'))
  })
  if (!record?.audio || !(record.audio instanceof Blob) || !(await isValidCachedWav(record.audio, record.sampleRate))) {
    if (record?.key) void deleteAudioRecord(record.key, record.filename).catch(() => {})
    return null
  }
  if (!record.filename) {
    record.filename = await audioFilenameForKey(record.key)
    await putAudioRecordRaw(record)
  }
  if (Date.now() - Number(record.lastAccessedAt || 0) > 5 * 60 * 1000) {
    const touched = { ...record, lastAccessedAt: Date.now() }
    void putAudioRecordRaw(touched).catch(() => {})
  }
  return record
}

async function getAudioRecordByFilename(filename: string): Promise<MobileAudioRecord | null> {
  const db = await openDb()
  const record = await new Promise<MobileAudioRecord | null>((resolve, reject) => {
    const store = db.transaction(AUDIO_STORE, 'readonly').objectStore(AUDIO_STORE)
    const request = store.indexNames.contains('filename') ? store.index('filename').get(filename) : store.get(filename)
    request.onsuccess = () => resolve((request.result as MobileAudioRecord | undefined) || null)
    request.onerror = () => reject(request.error || new Error('Could not read cached narration'))
  })
  if (!record) return null
  // Route lookups use a secondary index; verify the full canonical key and WAV
  // through the normal lookup before exposing the Blob.
  return getAudioRecord(record.key)
}

async function getAllAudioRecords(): Promise<MobileAudioRecord[]> {
  const db = await openDb()
  return new Promise<MobileAudioRecord[]>((resolve, reject) => {
    const request = db.transaction(AUDIO_STORE, 'readonly').objectStore(AUDIO_STORE).getAll()
    request.onsuccess = () => resolve((request.result || []) as MobileAudioRecord[])
    request.onerror = () => reject(request.error || new Error('Could not inspect cached narration'))
  })
}

async function putAudioRecordRaw(record: MobileAudioRecord): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(AUDIO_STORE, 'readwrite')
    transaction.objectStore(AUDIO_STORE).put(record)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error || new Error('Could not cache narration'))
    transaction.onabort = () => reject(transaction.error || new Error('Could not cache narration'))
  })
}

async function deleteAudioRecord(key: string, filename?: string): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(AUDIO_STORE, 'readwrite')
    transaction.objectStore(AUDIO_STORE).delete(key)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error || new Error('Could not remove cached narration'))
    transaction.onabort = () => reject(transaction.error || new Error('Could not remove cached narration'))
  })
  if (filename) releaseResource(audioResourcePath(filename))
}

async function pruneAudioCache(): Promise<{ files: number; bytes: number; deleted: number }> {
  const records = (await getAllAudioRecords())
    .filter((record) => record?.key && record.audio instanceof Blob)
    .sort((left, right) => Number(left.lastAccessedAt || left.createdAt || 0) - Number(right.lastAccessedAt || right.createdAt || 0))
  let bytes = records.reduce((total, record) => total + record.audio.size, 0)
  let files = records.length
  const victims: MobileAudioRecord[] = []
  while (files > MAX_AUDIO_CACHE_RECORDS || bytes > MAX_AUDIO_CACHE_BYTES) {
    const victim = records.shift()
    if (!victim) break
    victims.push(victim)
    files -= 1
    bytes -= victim.audio.size
  }
  if (victims.length) {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(AUDIO_STORE, 'readwrite')
      const store = transaction.objectStore(AUDIO_STORE)
      victims.forEach((record) => store.delete(record.key))
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error || new Error('Could not prune cached narration'))
      transaction.onabort = () => reject(transaction.error || new Error('Could not prune cached narration'))
    })
    victims.forEach((record) => {
      if (record.filename) releaseResource(audioResourcePath(record.filename))
    })
  }
  return { files, bytes, deleted: victims.length }
}

async function putAudioRecord(record: MobileAudioRecord): Promise<void> {
  if (!(record.audio instanceof Blob) || !(await isValidCachedWav(record.audio, record.sampleRate))) {
    throw new Error('The generated narration chunk is not a valid PCM WAV file.')
  }
  await putAudioRecordRaw(record)
  await pruneAudioCache()
}

async function clearAudioRecords(bookId?: string): Promise<number> {
  const db = await openDb()
  return new Promise<number>((resolve, reject) => {
    const transaction = db.transaction(AUDIO_STORE, 'readwrite')
    const store = transaction.objectStore(AUDIO_STORE)
    let deleted = 0
    const resourcePaths: string[] = []
    const cursor = store.openCursor()
    cursor.onsuccess = () => {
      const current = cursor.result
      if (!current) return
      const record = current.value as MobileAudioRecord
      if (!bookId || record.bookId === bookId) {
        const deletion = current.delete()
        deletion.onerror = () => transaction.abort()
        deleted += 1
        if (record.filename) resourcePaths.push(audioResourcePath(record.filename))
      }
      current.continue()
    }
    cursor.onerror = () => transaction.abort()
    transaction.oncomplete = () => {
      resourcePaths.forEach(releaseResource)
      resolve(deleted)
    }
    transaction.onerror = () => reject(transaction.error || new Error('Could not clear cached narration'))
    transaction.onabort = () => reject(transaction.error || new Error('Could not clear cached narration'))
  })
}

function releaseResource(path: string): void {
  const previous = resourceCache.get(path)
  if (previous?.startsWith('blob:')) URL.revokeObjectURL(previous)
  resourceCache.delete(path)
  resourceCacheSizes.delete(path)
}

function cacheResource(path: string, value: string, bytes?: number): void {
  releaseResource(path)
  resourceCache.set(path, value)
  if (Number.isFinite(bytes) && Number(bytes) >= 0) resourceCacheSizes.set(path, Number(bytes))
  while (resourceCache.size > RESOURCE_CACHE_LIMIT) {
    const oldest = resourceCache.keys().next().value
    if (!oldest) break
    releaseResource(oldest)
  }
}

function releaseAllResources(): void {
  Array.from(resourceCache.keys()).forEach(releaseResource)
}

function bytesToText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

async function contentId(bytes: Uint8Array): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const input = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', input))
    return `android-${Array.from(digest.slice(0, 16), (value) => value.toString(16).padStart(2, '0')).join('')}`
  }
  let hash = 2166136261
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619)
  return `android-${(hash >>> 0).toString(16)}`
}

function normalizeAudioIdentity(
  bookId: string,
  page: number,
  sentence: number,
  engine: unknown,
  voice: unknown,
  speed: unknown,
): AudioRequestIdentity {
  const normalizedEngine = normalizeTtsEngine(engine)
  return {
    bookId,
    page,
    sentence,
    engine: normalizedEngine,
    voice: normalizeVoiceForEngine(normalizedEngine, voice),
    speed: clampSpeedForEngine(normalizedEngine, speed),
  }
}

function audioCacheKey(identity: AudioRequestIdentity): string {
  return JSON.stringify({
    revision: MOBILE_TTS_CACHE_REVISION,
    book: identity.bookId,
    page: identity.page,
    sentence: identity.sentence,
    engine: identity.engine,
    voice: identity.voice,
    speed: identity.speed.toFixed(4),
  })
}

function preloadJobKey(identity: Omit<AudioRequestIdentity, 'sentence'>): string {
  return audioCacheKey({ ...identity, sentence: -1 })
}

function bufferWindowKey(identity: AudioRequestIdentity): string {
  return audioCacheKey({ ...identity, page: -1, sentence: -1 })
}

async function audioFilenameForKey(key: string): Promise<string> {
  const digest = await contentId(new TextEncoder().encode(key))
  return `folio-${digest.slice('android-'.length)}.wav`
}

function audioResourcePath(filename: string): string {
  return `/api/audio/${filename}`
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length))
}

function inspectNativeWav(bytes: Uint8Array, totalBytes = bytes.byteLength): { sampleRate: number; durationMs: number } {
  if (totalBytes < 44 || totalBytes > MAX_AUDIO_RECORD_BYTES || bytes.byteLength < 44) {
    throw new Error('Native TTS returned a WAV file outside the safe size limit.')
  }
  if (readAscii(bytes, 0, 4) !== 'RIFF' || readAscii(bytes, 8, 4) !== 'WAVE') {
    throw new Error('Native TTS returned audio without a RIFF/WAVE header.')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(4, true) + 8 !== totalBytes) {
    throw new Error('Native TTS returned a WAV file with an inconsistent RIFF length.')
  }
  if (readAscii(bytes, 12, 4) !== 'fmt ' || view.getUint32(16, true) !== 16) {
    throw new Error('Native TTS returned an unsupported WAV format header.')
  }
  const format = view.getUint16(20, true)
  const channels = view.getUint16(22, true)
  const sampleRate = view.getUint32(24, true)
  const byteRate = view.getUint32(28, true)
  const blockAlign = view.getUint16(32, true)
  const bitsPerSample = view.getUint16(34, true)
  if (format !== 1 || channels !== 1 || bitsPerSample !== 16 || sampleRate < 8_000 || sampleRate > 192_000) {
    throw new Error('Native TTS returned audio that is not mono 16-bit PCM.')
  }
  if (blockAlign !== channels * (bitsPerSample / 8) || byteRate !== sampleRate * blockAlign) {
    throw new Error('Native TTS returned inconsistent PCM stream metadata.')
  }
  if (readAscii(bytes, 36, 4) !== 'data') {
    throw new Error('Native TTS returned a WAV file without a PCM data chunk.')
  }
  const dataBytes = view.getUint32(40, true)
  if (dataBytes <= 0 || dataBytes + 44 !== totalBytes || dataBytes % blockAlign !== 0) {
    throw new Error('Native TTS returned a truncated PCM data chunk.')
  }
  return { sampleRate, durationMs: Math.round((dataBytes / byteRate) * 1000) }
}

async function isValidCachedWav(audio: Blob, expectedSampleRate: number): Promise<boolean> {
  if (audio.size <= 0 || audio.size > MAX_AUDIO_RECORD_BYTES) return false
  try {
    const header = new Uint8Array(await audio.slice(0, 44).arrayBuffer())
    const metadata = inspectNativeWav(header, audio.size)
    return !expectedSampleRate || metadata.sampleRate === expectedSampleRate
  } catch {
    return false
  }
}

function decodeNativeWavBase64(value: string): { audio: Blob; sampleRate: number; durationMs: number } {
  const encoded = String(value || '').trim().replace(/^data:audio\/wav;base64,/i, '').replace(/\s+/g, '')
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error('Native TTS returned malformed base64 audio.')
  }
  if (Math.floor((encoded.length * 3) / 4) > MAX_AUDIO_RECORD_BYTES) {
    throw new Error('Native TTS returned an audio chunk that is too large.')
  }
  let binary: string
  try {
    binary = atob(encoded)
  } catch {
    throw new Error('Native TTS returned undecodable base64 audio.')
  }
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  const metadata = inspectNativeWav(bytes)
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  return { audio: new Blob([buffer], { type: 'audio/wav' }), ...metadata }
}

async function appendPcmSilence(audio: Blob, pauseMs = INTER_CHUNK_PAUSE_MS) {
  if (pauseMs <= 0) return { audio, ...inspectNativeWav(new Uint8Array(await audio.arrayBuffer())) }
  const source = new Uint8Array(await audio.arrayBuffer())
  inspectNativeWav(source)
  const sourceView = new DataView(source.buffer, source.byteOffset, source.byteLength)
  const byteRate = sourceView.getUint32(28, true)
  const blockAlign = sourceView.getUint16(32, true)
  const silenceBytes = Math.max(
    blockAlign,
    Math.floor((byteRate * pauseMs) / 1000 / blockAlign) * blockAlign,
  )
  if (source.byteLength + silenceBytes > MAX_AUDIO_RECORD_BYTES) {
    throw new Error('Native TTS audio plus its narration pause is too large to cache safely.')
  }

  const output = new Uint8Array(source.byteLength + silenceBytes)
  output.set(source)
  const outputView = new DataView(output.buffer)
  outputView.setUint32(4, output.byteLength - 8, true)
  outputView.setUint32(40, output.byteLength - 44, true)
  const metadata = inspectNativeWav(output)
  return { audio: new Blob([output.buffer], { type: 'audio/wav' }), ...metadata }
}

function validateEpubArchive(bytes: Uint8Array): void {
  if (bytes.byteLength < 22) throw new Error('This EPUB is not a valid ZIP archive.')
  if (bytes.byteLength > MAX_EPUB_BYTES) throw new Error('This EPUB is too large to import safely on this device.')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const minimum = Math.max(0, bytes.byteLength - 65_557)
  let eocd = -1
  for (let offset = bytes.byteLength - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) { eocd = offset; break }
  }
  if (eocd < 0) throw new Error('This EPUB has no readable ZIP directory.')
  const entryCount = view.getUint16(eocd + 10, true)
  const centralOffset = view.getUint32(eocd + 16, true)
  if (!entryCount || entryCount > 10_000) throw new Error('This EPUB contains an unsafe number of files.')
  let offset = centralOffset
  let expandedBytes = 0
  let compressedBytes = 0
  const decoder = new TextDecoder()
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error('This EPUB has a damaged ZIP directory.')
    }
    const compressed = view.getUint32(offset + 20, true)
    const expanded = view.getUint32(offset + 24, true)
    if (compressed === 0xffffffff || expanded === 0xffffffff) throw new Error('ZIP64 EPUB files are not supported.')
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const end = offset + 46 + nameLength + extraLength + commentLength
    if (end > bytes.byteLength) throw new Error('This EPUB has a truncated ZIP directory.')
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength)).replace(/\\/g, '/')
    if (name.startsWith('/') || name.split('/').some((part) => part === '..')) {
      throw new Error('This EPUB contains an unsafe file path.')
    }
    if (expanded > MAX_EPUB_ENTRY_BYTES) throw new Error('This EPUB contains an individual file that is too large.')
    expandedBytes += expanded
    compressedBytes += compressed
    if (expandedBytes > MAX_EPUB_EXPANDED_BYTES) throw new Error('This EPUB expands beyond the safe on-device limit.')
    offset = end
  }
  if (compressedBytes > 0 && expandedBytes / compressedBytes > 300) {
    throw new Error('This EPUB has an unsafe compression ratio.')
  }
}

function decodeBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

function elementByLocalName(root: ParentNode, name: string): Element[] {
  return Array.from(root.querySelectorAll('*')).filter((element) => element.localName === name)
}

function attributeByLocalName(element: Element, name: string): string {
  return element.getAttribute(name) ||
    element.getAttribute(`xlink:${name}`) ||
    element.getAttributeNS('http://www.w3.org/1999/xlink', name) ||
    element.getAttributeNS(null, name) ||
    ''
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function resolveZipPath(base: string, value: string): string {
  const raw = value.split('#', 1)[0].split('?', 1)[0]
  const decoded = safeDecodeURIComponent(raw).replace(/\\/g, '/')
  const parts = `${base}/${decoded}`.split('/')
  const result: string[] = []
  for (const part of parts) {
    if (!part || part === '.') continue
    if (part === '..') result.pop()
    else result.push(part)
  }
  return result.join('/')
}

type EpubManifestEntry = {
  id: string
  path: string
  media: string
  properties: string
}

function isRasterCoverMime(mediaType: string | null): boolean {
  return Boolean(mediaType && mediaType !== 'image/svg+xml')
}

function isCoverDocument(entry: EpubManifestEntry): boolean {
  return entry.media.toLowerCase() === 'application/xhtml+xml' ||
    entry.media.toLowerCase() === 'text/html' ||
    entry.media.toLowerCase() === 'image/svg+xml' ||
    /\.(?:xhtml?|svg)$/i.test(entry.path)
}

function localReferencePath(basePath: string, value: string): string {
  const reference = String(value || '').trim()
  if (!reference || /^(?:data|https?|mailto):/i.test(reference)) return ''
  const base = basePath.includes('/') ? basePath.slice(0, basePath.lastIndexOf('/')) : ''
  return resolveZipPath(base, reference)
}

function coverDocumentReferences(bytes: Uint8Array, entry: EpubManifestEntry): string[] {
  // A cover XHTML/SVG page is allowed to be selected, but parsing an
  // untrusted multi-megabyte document just to find an image is not worth
  // risking a renderer stall. The archive validator still protects the full
  // EPUB; this is an additional cover-discovery bound.
  if (!bytes.byteLength || bytes.byteLength > 2 * 1024 * 1024) return []
  const document = new DOMParser().parseFromString(bytesToText(bytes), 'text/html')
  const references = [
    ...elementByLocalName(document, 'img').map((element) => attributeByLocalName(element, 'src')),
    ...elementByLocalName(document, 'image').map((element) => attributeByLocalName(element, 'href')),
  ]
  return references.map((value) => localReferencePath(entry.path, value)).filter(Boolean)
}

function discoverEpubCoverCandidate(
  opf: Document,
  metadata: Element | undefined,
  manifest: Map<string, EpubManifestEntry>,
  files: Record<string, Uint8Array>,
  opfDir: string,
): EpubCoverCandidate | null {
  const candidates: EpubCoverCandidate[] = []
  const byPath = new Map(Array.from(manifest.values()).map((entry) => [entry.path, entry]))
  const seen = new Set<string>()

  const addEntry = (entry: EpubManifestEntry | undefined, source: EpubCoverSource, score: number) => {
    if (!entry || !entry.path || seen.has(`${source}:${entry.path}`)) return
    const bytes = files[entry.path]
    const mime = normalizeCoverMediaType(entry.media)
    if (!bytes || !mime || bytes.byteLength === 0 || bytes.byteLength > MAX_EPUB_COVER_BYTES) return
    seen.add(`${source}:${entry.path}`)
    if (isRasterCoverMime(mime)) {
      candidates.push({ path: entry.path, mediaType: mime, source, score, byteLength: bytes.byteLength })
      return
    }
    if (!isCoverDocument(entry)) return
    const references = coverDocumentReferences(bytes, entry)
    references.forEach((path, index) => addEntry(byPath.get(path), source, score - index))
    // A valid standalone SVG remains a useful WebView cover even if it does
    // not contain a raster <image> reference. Android will safely fall back
    // when its bitmap decoder cannot consume it.
    if (mime === 'image/svg+xml') {
      candidates.push({ path: entry.path, mediaType: mime, source, score, byteLength: bytes.byteLength })
    }
  }

  const manifestEntries = Array.from(manifest.values())
  manifestEntries
    .filter((entry) => entry.properties.toLowerCase().split(/\s+/).includes('cover-image'))
    .forEach((entry) => addEntry(entry, 'epub3', 100))

  const metaCoverId = elementByLocalName(metadata || opf, 'meta').find((element) => (
    attributeByLocalName(element, 'name').trim().toLowerCase() === 'cover'
  ))
  const metaCoverEntry = metaCoverId ? manifest.get(attributeByLocalName(metaCoverId, 'content').trim()) : undefined
  addEntry(metaCoverEntry, 'epub2', 90)

  const guideReference = elementByLocalName(opf, 'reference').find((element) => (
    attributeByLocalName(element, 'type').split(/\s+/).some((value) => value.toLowerCase() === 'cover')
  ))
  const guidePath = guideReference ? localReferencePath(`${opfDir}/package.opf`, attributeByLocalName(guideReference, 'href')) : ''
  addEntry(byPath.get(guidePath), 'guide', 80)

  const spineCoverEntry = elementByLocalName(opf, 'itemref')
    .map((item) => manifest.get(attributeByLocalName(item, 'idref')))
    .find((entry) => {
      if (!entry) return false
      const label = `${entry.id} ${entry.path} ${entry.properties}`.toLowerCase()
      return /(?:cover|front|jacket|title[-_ ]?page)/.test(label)
    })
  addEntry(spineCoverEntry, 'cover-page', 70)

  // Conservative filename/id fallback: only choose assets that look like a
  // cover and are not common chrome such as a publisher logo or icon.
  manifestEntries.forEach((entry) => {
    const mime = normalizeCoverMediaType(entry.media)
    const bytes = files[entry.path]
    if (!mime || !bytes || bytes.byteLength < 256 || bytes.byteLength > MAX_EPUB_COVER_BYTES || !isRasterCoverMime(mime)) return
    const label = `${entry.id} ${entry.path} ${entry.properties}`.toLowerCase()
    if (!/(?:cover|front|jacket|dust[-_ ]?jacket|title[-_ ]?page)/.test(label)) return
    if (/(?:logo|icon|thumb|thumbnail|sprite|ornament)/.test(label)) return
    addEntry(entry, 'fallback', 10)
  })

  return chooseEpubCoverCandidate(candidates)
}

function splitSentences(text: string): string[] {
  const normalized = normalizeText(text)
  if (!normalized) return []
  const raw = normalized.match(/[^.!?]+(?:[.!?]+|$)/g) || [normalized]
  const chunks: string[] = []
  for (const value of raw) {
    const sentence = normalizeText(value)
    if (!sentence) continue
    const previous = chunks[chunks.length - 1]
    if (previous && previous.length < 80 && `${previous} ${sentence}`.length <= 320) chunks[chunks.length - 1] = `${previous} ${sentence}`
    else chunks.push(sentence)
  }
  return chunks
}

function blockText(element: Element): string {
  return normalizeText(element.textContent || '')
}

function collectBlocks(body: Element): Array<{ type: string; text?: string; level?: number }> {
  const blocks: Array<{ type: string; text?: string; level?: number }> = []
  const semantic = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'blockquote', 'pre'])
  const visit = (element: Element) => {
    const name = element.localName.toLowerCase()
    if (/^h[1-6]$/.test(name)) {
      const text = blockText(element)
      if (text) blocks.push({ type: 'heading', text, level: Number(name.slice(1)) })
      return
    }
    if (semantic.has(name)) {
      const text = blockText(element)
      if (text) blocks.push({ type: 'paragraph', text })
      return
    }
    const children = Array.from(element.children)
    if (!children.length) {
      const text = blockText(element)
      if (text) blocks.push({ type: 'paragraph', text })
      return
    }
    children.forEach(visit)
  }
  Array.from(body.children).forEach(visit)
  return blocks
}

function wordInfo(text: string, index: number) {
  const words = text.split(/\s+/).filter(Boolean)
  return words.map((word, wordIndex) => ({
    text: word,
    x: wordIndex / Math.max(1, words.length),
    y: index,
    w: 1 / Math.max(1, words.length),
    h: 1,
    char_offset: text.indexOf(word),
    char_length: word.length,
  }))
}

function buildPages(chapters: ReflowDocument['chapters']): PageText[] {
  return chapters.map((chapter, pageNumber) => {
    const sentences = chapterNarrationSentences(chapter)
    return { page_number: pageNumber, sentences, render_width: 1, render_height: 1 }
  })
}

function spokenHeadingText(text: string): string {
  const normalized = normalizeText(text)
  return normalized && !/[.!?…;:]$/.test(normalized) ? `${normalized}.` : normalized
}

function chapterNarrationSentences(chapter: ReflowChapter): PageText['sentences'] {
  const sentences: PageText['sentences'] = []
  const add = (
    text: string,
    kind: string,
    pauseAfterMs = INTER_CHUNK_PAUSE_MS,
    globalSentenceIdx: number | null = null,
    heading = false,
  ) => {
    const spoken = heading ? spokenHeadingText(text) : normalizeText(text)
    if (!spoken) return
    sentences.push({
      text: spoken,
      words: wordInfo(spoken, sentences.length),
      kind,
      pause_after_ms: pauseAfterMs,
      global_sentence_idx: globalSentenceIdx,
    })
  }

  const number = String(chapter.number || '').trim()
  const title = String(chapter.title || '').trim()
  const label = number ? `Chapter ${number}` : ''
  if (label) add(label, 'chapter-label', INTER_CHUNK_PAUSE_MS, chapter.number_idx ?? null, true)
  if (title && title.toLowerCase().replace(/\.$/, '') !== label.toLowerCase()) {
    add(title, 'chapter-title', 700, chapter.title_idx ?? null, true)
  }

  chapter.blocks.forEach((block) => {
    if (block.type === 'heading') {
      add(String(block.text || ''), `heading-${Number(block.level) || 2}`, 700, Number.isFinite(Number(block.idx)) ? Number(block.idx) : null, true)
    } else if (block.type === 'paragraph') {
      const paragraph = block as { sentences?: ReflowSentence[]; role?: string }
      ;(paragraph.sentences || []).forEach((sentence) => {
        add(sentence.text, sentence.kind || String(paragraph.role || 'prose'), INTER_CHUNK_PAUSE_MS, sentence.idx ?? null)
      })
    } else if (block.type === 'dinkus' && sentences.length) {
      sentences[sentences.length - 1].pause_after_ms = 900
    }
  })
  return sentences
}

type RepairedBookMetadata = {
  title: string
  author: string
  toc: Array<{ title: string; page: number }>
  coverUrl: string | null
  coverSource: string | null
}

/** Reads only package metadata, spine headings and cover bytes for migration. */
function extractEpubMetadata(bytes: Uint8Array, filename: string): RepairedBookMetadata {
  validateEpubArchive(bytes)
  const files = unzipSync(bytes)
  const container = new DOMParser().parseFromString(bytesToText(files['META-INF/container.xml'] || new Uint8Array()), 'application/xml')
  const rootfile = elementByLocalName(container, 'rootfile')[0]
  const opfPath = attributeByLocalName(rootfile, 'full-path')
  if (!opfPath || !files[opfPath]) throw new Error('This EPUB has no readable package document.')
  const opf = new DOMParser().parseFromString(bytesToText(files[opfPath]), 'application/xml')
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : ''
  const metadata = elementByLocalName(opf, 'metadata')[0]
  const title = normalizeText(elementByLocalName(metadata || opf, 'title')[0]?.textContent || '') || filename.replace(/\.epub$/i, '')
  const author = normalizeText(elementByLocalName(metadata || opf, 'creator')[0]?.textContent || '') || 'Unknown'
  const manifest = new Map<string, EpubManifestEntry>()
  elementByLocalName(opf, 'item').forEach((item) => {
    const id = attributeByLocalName(item, 'id')
    if (id) manifest.set(id, {
      id,
      path: resolveZipPath(opfDir, attributeByLocalName(item, 'href')),
      media: attributeByLocalName(item, 'media-type'),
      properties: attributeByLocalName(item, 'properties'),
    })
  })
  const toc: Array<{ title: string; page: number }> = []
  elementByLocalName(opf, 'itemref').forEach((item, spineIndex) => {
    const entry = manifest.get(attributeByLocalName(item, 'idref'))
    const document = entry?.path && files[entry.path]
      ? new DOMParser().parseFromString(bytesToText(files[entry.path].subarray(0, Math.min(files[entry.path].byteLength, 2 * 1024 * 1024))), 'text/html')
      : null
    const body = document?.body || document?.documentElement
    if (!body || collectBlocks(body).length === 0) return
    const heading = document ? elementByLocalName(document, 'h1').concat(elementByLocalName(document, 'h2'))[0] : null
    const label = normalizeText(heading?.textContent || '') || normalizeText(document?.querySelector('title')?.textContent || '')
    toc.push({ title: label || `Chapter ${spineIndex + 1}`, page: toc.length })
  })
  const coverCandidate = discoverEpubCoverCandidate(opf, metadata, manifest, files, opfDir)
  const coverBytes = coverCandidate ? files[coverCandidate.path] : undefined
  const safeCoverMime = normalizeCoverMediaType(coverCandidate?.mediaType)
  const coverUrl = coverBytes && coverBytes.byteLength <= MAX_EPUB_COVER_BYTES && safeCoverMime
    ? `data:${safeCoverMime};base64,${decodeBase64(coverBytes)}`
    : null
  return {
    title,
    author,
    toc,
    coverUrl,
    coverSource: coverUrl ? `epub:${coverCandidate?.source || 'fallback'}` : null,
  }
}

function parseEpub(bytes: Uint8Array, filename: string, id: string): MobileRecord {
  validateEpubArchive(bytes)
  const files = unzipSync(bytes)
  const containerXml = bytesToText(files['META-INF/container.xml'] || new Uint8Array())
  const container = new DOMParser().parseFromString(containerXml, 'application/xml')
  const rootfile = elementByLocalName(container, 'rootfile')[0]
  const opfPath = attributeByLocalName(rootfile, 'full-path')
  if (!opfPath || !files[opfPath]) throw new Error('This EPUB has no readable package document.')
  const opf = new DOMParser().parseFromString(bytesToText(files[opfPath]), 'application/xml')
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : ''
  const metadata = elementByLocalName(opf, 'metadata')[0]
  const title = normalizeText(elementByLocalName(metadata || opf, 'title')[0]?.textContent || '') || filename.replace(/\.epub$/i, '')
  const author = normalizeText(elementByLocalName(metadata || opf, 'creator')[0]?.textContent || '') || 'Unknown'
  const manifest = new Map<string, EpubManifestEntry>()
  elementByLocalName(opf, 'item').forEach((item) => {
    const id = attributeByLocalName(item, 'id')
    if (id) manifest.set(id, {
      id,
      path: resolveZipPath(opfDir, attributeByLocalName(item, 'href')),
      media: attributeByLocalName(item, 'media-type'),
      properties: attributeByLocalName(item, 'properties'),
    })
  })
  const spine = elementByLocalName(opf, 'itemref')
  const spineDocuments: MobileRawBlock[][] = []
  spine.forEach((item) => {
    const entry = manifest.get(attributeByLocalName(item, 'idref'))
    if (!entry || !files[entry.path]) return
    const document = new DOMParser().parseFromString(bytesToText(files[entry.path]), 'text/html')
    const body = document.body || document.documentElement
    const blocks = collectBlocks(body) as MobileRawBlock[]
    if (blocks.length) spineDocuments.push(blocks)
  })

  const chapters: ReflowDocument['chapters'] = []
  let sentenceIndex = 0
  structureMobileSpineDocuments(spineDocuments).forEach((sourceChapter) => {
    const blocks: ReflowDocument['chapters'][number]['blocks'] = []
    const chapterTitle = sourceChapter.title || `Chapter ${chapters.length + 1}`
    const chapterNumber = sourceChapter.number
    const chapterLabel = chapterNumber ? `Chapter ${chapterNumber}` : ''
    let chapterNumberIdx: number | null = null
    let chapterTitleIdx: number | null = null
    if (chapterLabel) {
      chapterNumberIdx = sentenceIndex
      sentenceIndex += 1
    }
    if (!chapterLabel || chapterTitle.toLowerCase().replace(/\.$/, '') !== chapterLabel.toLowerCase()) {
      chapterTitleIdx = sentenceIndex
      sentenceIndex += 1
    } else {
      chapterTitleIdx = chapterNumberIdx
    }
    sourceChapter.blocks.forEach((raw) => {
      if (raw.type === 'heading') {
        blocks.push({ type: 'heading', level: raw.level || 1, text: raw.text || '', idx: sentenceIndex, kind: 'heading' })
        sentenceIndex += 1
        return
      }
      const sentences: ReflowSentence[] = []
      splitSentences(raw.text || '').forEach((text) => {
        sentences.push({ text, idx: sentenceIndex, source_sentences: [sentenceIndex], kind: 'prose' })
        sentenceIndex += 1
      })
      if (sentences.length) blocks.push({ type: 'paragraph', sentences })
    })
    if (blocks.length) {
      chapters.push({
        id: chapters.length,
        title: chapterTitle,
        title_idx: chapterTitleIdx,
        number: chapterNumber,
        number_idx: chapterNumberIdx,
        blocks,
      })
    }
  })
  if (!chapters.length) throw new Error('This EPUB contains no readable chapters.')
  const coverCandidate = discoverEpubCoverCandidate(opf, metadata, manifest, files, opfDir)
  const coverBytes = coverCandidate ? files[coverCandidate.path] : undefined
  const safeCoverMime = normalizeCoverMediaType(coverCandidate?.mediaType)
  const coverUrl = coverBytes && coverBytes.byteLength <= MAX_EPUB_COVER_BYTES && safeCoverMime
    ? `data:${safeCoverMime};base64,${decodeBase64(coverBytes)}`
    : null
  const reflow: ReflowDocument = {
    format: 'epub',
    version: 1,
    chunker_version: MOBILE_CONTENT_REVISION,
    metadata: { title, author, running_head: title },
    chapters,
    sentence_count: sentenceIndex,
    source: `android://${id}/${filename}`,
  }
  const now = Date.now()
  const book: BookState = {
    id,
    filepath: `android://${id}/${filename}`,
    title,
    author,
    page_count: chapters.length,
    toc: chapters.map((chapter, page) => ({ title: chapter.title || `Chapter ${page + 1}`, page })),
    format: 'epub',
    cover_url: coverUrl,
    cover_source: coverUrl ? `epub:${coverCandidate?.source || 'fallback'}` : null,
    metadata_revision: MOBILE_METADATA_REVISION,
    tts_engine: 'supertonic',
    voice: 'M1',
    speed: 1,
    last_position: { page: 0, sentence_idx: 0, narration_index_version: NARRATION_INDEX_VERSION, content_page: 0, visual_page: 0, pages_per_view: 1, chunk_progress: 0, saved_at: now },
    bookmarks: [],
    imported_at: now,
    last_opened_at: now,
    updated_at: now,
    visual_page_count: chapters.length,
    progress: 0,
    has_reading_progress: false,
  }
  return {
    book,
    reflow,
    pages: buildPages(chapters),
    contentRevision: MOBILE_CONTENT_REVISION,
    source: new Blob([bytes.slice()], { type: 'application/epub+zip' }),
    mimeType: 'application/epub+zip',
  }
}

async function nativePlaybackReferencesBook(bookId: string): Promise<boolean> {
  try {
    const status = await nativeInvoke<MobilePlaybackStatus>('audio_status')
    const hasQueuedLocation = (status.queueLocations || []).some((location) => location.bookId === bookId)
    const active = !['idle', 'finished', 'stopped', 'error'].includes(String(status.state || '').toLowerCase())
    return active && (hasQueuedLocation || status.bookId === bookId)
  } catch {
    // Fail closed: changing chapter indices while Android owns an unknown
    // native queue would make notification/process-death restoration unsafe.
    return true
  }
}

function mergeUpgradedEpubBook(
  existing: BookState,
  oldPages: PageText[],
  parsed: MobileRecord,
): BookState {
  const parsedBook = parsed.book
  const lastPosition = remapMobileReadingPosition(existing.last_position, oldPages, parsed.pages)
  const bookmarks = (existing.bookmarks || []).map((bookmark) => (
    remapMobileReadingPosition(bookmark, oldPages, parsed.pages)
  ))
  const existingSource = String(existing.cover_source || '').toLowerCase()
  const useParsedCover = Boolean(parsedBook.cover_url) && (
    !existing.cover_url || !existingSource || /fallback|cover-page/.test(existingSource)
  )
  const pageCount = Math.max(1, parsedBook.page_count)
  const sentenceCount = parsed.pages[lastPosition.page]?.sentences.length || 1
  const chapterProgress = Math.max(0, Math.min(1, Number(lastPosition.sentence_idx || 0) / sentenceCount))
  const progress = existing.has_reading_progress
    ? Math.max(0, Math.min(1, (lastPosition.page + chapterProgress) / pageCount))
    : Number(existing.progress || 0)

  return {
    ...parsedBook,
    ...existing,
    title: metadataTitleIsInferior(existing, existing.filepath.split('/').pop() || '') ? parsedBook.title : existing.title,
    author: !normalizeText(existing.author || '') || /^unknown$/i.test(existing.author) ? parsedBook.author : existing.author,
    page_count: pageCount,
    toc: parsedBook.toc,
    cover_url: useParsedCover ? parsedBook.cover_url : existing.cover_url,
    cover_source: useParsedCover ? parsedBook.cover_source : existing.cover_source,
    metadata_revision: MOBILE_METADATA_REVISION,
    metadata_repair_attempted_revision: null,
    last_position: lastPosition,
    bookmarks,
    visual_page_count: pageCount,
    progress,
    // A background schema repair is not a reading event and must not reorder
    // the user's recent/history shelves.
    updated_at: existing.updated_at ?? parsedBook.updated_at ?? Date.now(),
  }
}

async function upgradeMobileEpubRecord(
  record: MobileRecord,
  supplied?: { bytes: Uint8Array; filename: string },
): Promise<MobileRecord | null> {
  if (record.book.format !== 'epub' || record.contentRevision === MOBILE_CONTENT_REVISION) return record
  const existingJob = contentUpgradeJobs.get(record.book.id)
  if (existingJob) return existingJob

  const job = (async (): Promise<MobileRecord | null> => {
    if (await nativePlaybackReferencesBook(record.book.id)) return null
    let bytes = supplied?.bytes
    let filename = supplied?.filename || record.book.filepath.split('/').pop() || `${record.book.id}.epub`
    if (!bytes) {
      const source = await getSourceRecord(record.book.id)
      if (!source?.source || source.source.size > MAX_EPUB_BYTES) return null
      bytes = new Uint8Array(await source.source.arrayBuffer())
      filename = record.book.filepath.split('/').pop() || `${record.book.id}.epub`
    }
    const parsed = parseEpub(bytes, filename, record.book.id)
    const upgraded: MobileRecord = {
      ...parsed,
      book: mergeUpgradedEpubBook(record.book, record.pages, parsed),
    }
    await putImportedRecord(upgraded)
    return upgraded
  })().catch((error) => {
    console.warn('Could not migrate Android EPUB chapter structure', error)
    return null
  })

  contentUpgradeJobs.set(record.book.id, job)
  try {
    return await job
  } finally {
    if (contentUpgradeJobs.get(record.book.id) === job) contentUpgradeJobs.delete(record.book.id)
  }
}

async function parsePdf(bytes: Uint8Array, filename: string, id: string): Promise<MobileRecord> {
  if (bytes.byteLength < 5 || bytesToText(bytes.subarray(0, 5)) !== '%PDF-') {
    throw new Error('This file does not have a valid PDF signature.')
  }
  if (bytes.byteLength > MAX_PDF_BYTES) {
    throw new Error('This PDF is too large to import safely on this device.')
  }

  const { getDocument, standardFontDataUrl } = await import('./pdfRuntime')
  const loadingTask = getDocument({ data: bytes.slice(), standardFontDataUrl, useSystemFonts: false })
  const document = await loadingTask.promise
  if (!document.numPages || document.numPages > MAX_PDF_PAGES) {
    await loadingTask.destroy()
    throw new Error('This PDF has an unsupported number of pages.')
  }

  try {
    const metadata = await document.getMetadata().catch(() => null)
    const info = (metadata?.info || {}) as Record<string, unknown>
    const title = normalizeText(String(info.Title || '')) || filename.replace(/\.pdf$/i, '')
    const author = normalizeText(String(info.Author || '')) || 'Unknown'
    const chapters: ReflowDocument['chapters'] = []
    const pages: PageText[] = []
    let sentenceIndex = 0
    let coverUrl: string | null = null

    for (let pageIndex = 0; pageIndex < document.numPages; pageIndex += 1) {
      const page = await document.getPage(pageIndex + 1)
      const viewport = page.getViewport({ scale: 1 })
      const content = await page.getTextContent()
      let pageText = ''
      for (const item of content.items as Array<{ str?: string; hasEOL?: boolean }>) {
        const value = String(item.str || '')
        if (!value) continue
        if (pageText && !/[\s-]$/.test(pageText) && !/^\s/.test(value)) pageText += ' '
        pageText += value
        if (item.hasEOL) pageText += '\n'
      }
      const sentenceTexts = splitSentences(pageText)
      const reflowSentences: ReflowSentence[] = sentenceTexts.map((text) => {
        const current = sentenceIndex
        sentenceIndex += 1
        return { text, idx: current, source_sentences: [current], kind: 'prose' }
      })
      const blocks: ReflowDocument['chapters'][number]['blocks'] = reflowSentences.length
        ? [{ type: 'paragraph', sentences: reflowSentences }]
        : []
      chapters.push({ id: pageIndex, title: `Page ${pageIndex + 1}`, number: pageIndex + 1, blocks })
      pages.push({
        page_number: pageIndex,
        sentences: sentenceTexts.map((text, index) => ({ text, words: wordInfo(text, index) })),
        render_width: viewport.width,
        render_height: viewport.height,
      })

      if (pageIndex === 0) {
        const scale = Math.min(0.55, 320 / Math.max(1, viewport.width))
        const coverViewport = page.getViewport({ scale })
        const canvas = globalThis.document.createElement('canvas')
        canvas.width = Math.max(1, Math.ceil(coverViewport.width))
        canvas.height = Math.max(1, Math.ceil(coverViewport.height))
        await page.render({ canvas, viewport: coverViewport }).promise
        coverUrl = canvas.toDataURL('image/jpeg', 0.82)
        canvas.width = 0
        canvas.height = 0
      }
      page.cleanup()
    }

    const now = Date.now()
    const filepath = `android://${id}/${filename}`
    const reflow: ReflowDocument = {
      format: 'pdf',
      version: 1,
      chunker_version: 'android-pdfjs-v1',
      metadata: { title, author, running_head: title },
      chapters,
      sentence_count: sentenceIndex,
      source: filepath,
    }
    const book: BookState = {
      id,
      filepath,
      title,
      author,
      page_count: document.numPages,
      toc: chapters.map((chapter, page) => ({ title: chapter.title || `Page ${page + 1}`, page })),
      format: 'pdf',
      cover_url: coverUrl,
      cover_source: coverUrl ? 'pdf' : null,
      metadata_revision: MOBILE_METADATA_REVISION,
      tts_engine: 'supertonic',
      voice: 'M1',
      speed: 1,
      last_position: { page: 0, sentence_idx: 0, narration_index_version: NARRATION_INDEX_VERSION, content_page: 0, visual_page: 0, pages_per_view: 1, chunk_progress: 0, saved_at: now },
      bookmarks: [],
      imported_at: now,
      last_opened_at: now,
      updated_at: now,
      visual_page_count: document.numPages,
      progress: 0,
      has_reading_progress: false,
    }
    return {
      book,
      reflow,
      pages,
      source: new Blob([bytes.slice()], { type: 'application/pdf' }),
      mimeType: 'application/pdf',
    }
  } finally {
    await loadingTask.destroy()
  }
}

async function nativeInvoke<T>(command: string, payload?: unknown): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(`plugin:mobile-runtime|${command}`, payload === undefined ? undefined : { payload })
}

async function nativePlatformStatus(): Promise<NativePlatformStatus> {
  const now = Date.now()
  if (nativePlatformStatusCache && now - nativePlatformStatusCache.at < NATIVE_STATUS_CACHE_MS) {
    return nativePlatformStatusCache.value
  }
  if (!nativePlatformStatusInFlight) {
    const request = nativeInvoke<NativePlatformStatus>('platform_status')
      .then((value) => {
        nativePlatformStatusCache = { value, at: Date.now() }
        applyAndroidPlatformMetrics(value)
        return value
      })
    nativePlatformStatusInFlight = request
    void request.finally(() => {
      if (nativePlatformStatusInFlight === request) nativePlatformStatusInFlight = null
    }).catch(() => {})
  }

  const request = nativePlatformStatusInFlight!
  let timeout: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      request,
      new Promise<NativePlatformStatus>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Android runtime status timed out')), NATIVE_STATUS_TIMEOUT_MS)
      }),
    ])
  } catch (error) {
    // A last-known-good snapshot is stable installation evidence. A slow ONNX
    // operation must not turn verified files into a false missing-model state.
    if (nativePlatformStatusCache) return nativePlatformStatusCache.value
    throw error
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function modelInstallInfo(engine: 'supertonic' | 'kokoro', platform: NativePlatformStatus, bridgeError?: string): ModelInstallInfo {
  const native = platform.modelAssets?.[engine] || {}
  const installed = Boolean(native.installed)
  const nativeState = native.state
  const error = bridgeError || native.error || (installed && native.synthesisReady === false
    ? `${engine === 'kokoro' ? 'Kokoro' : 'Supertonic 3'} is installed but its native runtime is not ready.`
    : null)
  // Per-engine readiness is authoritative. The platform-wide flag may describe
  // optional native facilities (for example the eSpeak OOD fallback) that
  // Supertonic and Misaki-covered Kokoro text do not universally require.
  const ready = Boolean(installed && native.synthesisReady !== false && !error)
  return {
    ...native,
    engine,
    label: engine === 'kokoro' ? 'Kokoro' : 'Supertonic 3',
    state: ready
      ? 'ready'
      : nativeState || (error ? 'failed' : 'not_installed'),
    ready,
    installed,
    downloaded_bytes: Number(native.downloaded_bytes || 0),
    total_bytes: Number(native.total_bytes || native.approx_download_bytes || 0),
    progress: Number.isFinite(Number(native.progress))
      ? Number(native.progress)
      : installed ? 1 : 0,
    error,
  }
}

async function nativeModelRequirement(engine: 'supertonic' | 'kokoro'): Promise<Response | null> {
  let platform: NativePlatformStatus
  let bridgeError = ''
  try {
    platform = await nativePlatformStatus()
  } catch (error) {
    bridgeError = error instanceof Error ? error.message : String(error)
    platform = { nativeTtsAvailable: false, modelAssets: {} }
  }
  const install = modelInstallInfo(engine, platform, bridgeError || undefined)
  if (install.ready) return null
  const detail = install.error
    || (install.installed
      ? `${install.label} is installed, but its native runtime is not ready yet.`
      : `${install.label} is not installed. Download the verified Android model to use this engine.`)
  return jsonResponse({ error: 'model_required', detail, engine, install }, install.installed || bridgeError ? 423 : 409)
}

async function getOrGenerateAudioRecord(
  identity: AudioRequestIdentity,
  text: string,
  pauseAfterMs = INTER_CHUNK_PAUSE_MS,
): Promise<MobileAudioRecord> {
  const key = audioCacheKey(identity)
  const existingJob = audioGenerationJobs.get(key)
  if (existingJob) return existingJob
  const epoch = audioCacheEpoch

  const job = (async () => {
    const cached = await getAudioRecord(key)
    if (cached) return cached
    const native = await nativeInvoke<{
      audioBase64: string
      durationMs: number
      sampleRate: number
      engine: string
      fallbackReason?: string | null
    }>('synthesize', {
      text,
      engine: identity.engine,
      voice: identity.voice,
      speed: identity.speed,
    })
    if (native.engine !== identity.engine || native.fallbackReason) {
      throw new Error(native.fallbackReason || `${identity.engine} returned audio from the wrong engine.`)
    }
    const decoded = decodeNativeWavBase64(native.audioBase64)
    if (Number(native.sampleRate) !== decoded.sampleRate) {
      throw new Error('Native TTS returned inconsistent sample-rate metadata.')
    }
    const nativeDuration = Number(native.durationMs)
    if (!Number.isFinite(nativeDuration)
      || Math.abs(nativeDuration - decoded.durationMs) > Math.max(250, decoded.durationMs * 0.1)) {
      throw new Error('Native TTS returned inconsistent duration metadata.')
    }
    const paused = await appendPcmSilence(decoded.audio, Math.max(0, Math.min(1_500, pauseAfterMs)))
    const now = Date.now()
    const record: MobileAudioRecord = {
      key,
      filename: await audioFilenameForKey(key),
      ...identity,
      audio: paused.audio,
      durationMs: paused.durationMs,
      sampleRate: paused.sampleRate,
      createdAt: now,
      lastAccessedAt: now,
    }
    if (epoch !== audioCacheEpoch) {
      throw new Error('Narration cache changed while this audio was being generated.')
    }
    await putAudioRecord(record)
    return record
  })()
  audioGenerationJobs.set(key, job)
  try {
    return await job
  } finally {
    if (audioGenerationJobs.get(key) === job) audioGenerationJobs.delete(key)
  }
}

function materializeAudioResource(record: MobileAudioRecord): { filename: string; path: string; url: string } {
  const path = audioResourcePath(record.filename)
  let url = resourceCache.get(path)
  if (!url) {
    url = URL.createObjectURL(record.audio)
    cacheResource(path, url, record.audio.size)
  } else {
    // Refresh LRU order without leaking the existing Blob URL.
    resourceCache.delete(path)
    resourceCache.set(path, url)
  }
  return { filename: record.filename, path, url }
}

function chapterSentenceRefs(
  record: MobileRecord,
  page: number,
  engine: unknown,
  voice: unknown,
  speed: unknown,
): Array<{ identity: AudioRequestIdentity; text: string; pauseAfterMs: number }> {
  if (!Number.isInteger(page) || page < 0 || page >= record.pages.length) return []
  return (record.pages[page]?.sentences || [])
    .map((sentence, index) => ({
      identity: normalizeAudioIdentity(record.book.id, page, index, engine, voice, speed),
      text: String(sentence.text || '').trim(),
      pauseAfterMs: Number(sentence.pause_after_ms ?? INTER_CHUNK_PAUSE_MS),
    }))
    .filter((entry) => Boolean(entry.text))
    .slice(0, MAX_PRELOAD_SENTENCES)
}

function sentenceWindowRefs(
  record: MobileRecord,
  page: number,
  sentence: number,
  count: number,
): Array<{ page: number; sentence: number; text: string; pauseAfterMs: number }> {
  const refs: Array<{ page: number; sentence: number; text: string; pauseAfterMs: number }> = []
  let pageIndex = Math.max(0, page)
  let sentenceIndex = Math.max(0, sentence + 1)
  while (pageIndex < record.pages.length && refs.length < count) {
    const sentences = record.pages[pageIndex]?.sentences || []
    while (sentenceIndex < sentences.length && refs.length < count) {
      const text = String(sentences[sentenceIndex]?.text || '').trim()
      if (text) refs.push({
        page: pageIndex,
        sentence: sentenceIndex,
        text,
        pauseAfterMs: Number(sentences[sentenceIndex]?.pause_after_ms ?? INTER_CHUNK_PAUSE_MS),
      })
      sentenceIndex += 1
    }
    pageIndex += 1
    sentenceIndex = 0
  }
  return refs
}

async function audioKeysInCache(): Promise<Set<string>> {
  const records = await getAllAudioRecords()
  return new Set(records
    .filter((record) => record?.key && record.audio instanceof Blob && record.audio.size > 0 && record.audio.size <= MAX_AUDIO_RECORD_BYTES)
    .map((record) => record.key))
}

function rememberPreloadJob(key: string, job: MobilePreloadJob): void {
  preloadJobs.delete(key)
  preloadJobs.set(key, job)
  while (preloadJobs.size > MAX_TRACKED_PRELOAD_JOBS) {
    const removable = Array.from(preloadJobs.entries()).find(([, candidate]) => candidate.state !== 'preloading')
      || preloadJobs.entries().next().value
    if (!removable) break
    preloadJobs.delete(removable[0])
  }
}

async function chapterPreloadStatus(
  record: MobileRecord,
  page: number,
  engine: unknown,
  voice: unknown,
  speed: unknown,
): Promise<{ state: 'preloading' | 'ready' | 'error'; ready: number; ready_indices: number[]; total: number; failed: number[] }> {
  const refs = chapterSentenceRefs(record, page, engine, voice, speed)
  const canonical = normalizeAudioIdentity(record.book.id, page, -1, engine, voice, speed)
  const job = preloadJobs.get(preloadJobKey(canonical))
  const available = await audioKeysInCache()
  const readyIndices = refs
    .filter((entry) => available.has(audioCacheKey(entry.identity)))
    .map((entry) => entry.identity.sentence)
  const failed = (job?.failed || []).filter((index) => !readyIndices.includes(index))
  const state = refs.length === 0 || readyIndices.length >= refs.length
    ? 'ready'
    : job?.state === 'error' && failed.length
      ? 'error'
      : 'preloading'
  return { state, ready: readyIndices.length, ready_indices: readyIndices, total: refs.length, failed }
}

async function startChapterPreload(
  record: MobileRecord,
  page: number,
  engine: unknown,
  voice: unknown,
  speed: unknown,
): Promise<{ total: number; queued: number }> {
  const refs = chapterSentenceRefs(record, page, engine, voice, speed)
  const canonical = normalizeAudioIdentity(record.book.id, page, -1, engine, voice, speed)
  const key = preloadJobKey(canonical)
  const existing = preloadJobs.get(key)
  if (existing?.state === 'preloading') {
    const status = await chapterPreloadStatus(record, page, engine, voice, speed)
    return { total: refs.length, queued: Math.max(0, refs.length - status.ready) }
  }
  const available = await audioKeysInCache()
  const pending = refs.filter((entry) => !available.has(audioCacheKey(entry.identity)))
  const job: MobilePreloadJob = { state: 'preloading', failed: [], promise: Promise.resolve() }
  const promise = (async () => {
    for (const entry of pending) {
      try {
        await getOrGenerateAudioRecord(entry.identity, entry.text, entry.pauseAfterMs)
      } catch {
        if (!job.failed.includes(entry.identity.sentence)) job.failed.push(entry.identity.sentence)
      }
    }
    job.state = job.failed.length ? 'error' : 'ready'
  })()
  job.promise = promise
  rememberPreloadJob(key, job)
  void promise.catch(() => { job.state = 'error' })
  return { total: refs.length, queued: pending.length }
}

export type NativeQueueLocation = {
  sessionId: number
  bookId: string
  chapterIndex: number
  sentenceIndex: number
}

export type MobilePlaybackStatus = {
  state: 'idle' | 'preparing' | 'playing' | 'paused' | 'finished' | 'stopped' | 'error' | string
  positionMs: number
  durationMs: number
  sessionId: number
  enqueuedSessionId?: number
  queueSessionIds?: number[]
  queueLocations?: NativeQueueLocation[]
  currentIndex?: number
  queueSize?: number
  error?: string | null
  bookId?: string | null
  format?: string | null
  chapterTitle?: string | null
  chapterIndex?: number | null
  chapterCount?: number | null
  sentenceIndex?: number | null
  sentenceCount?: number | null
  chunkProgress?: number | null
  locationUri?: string | null
}

type NativeTreeDocument = {
  uri: string
  displayName: string
  mimeType: string
  size: number
  lastModified: number
  kind: 'epub' | 'pdf'
}

type NativeTreeScan = {
  treeUri: string
  displayName: string
  recursive: boolean
  permissionGranted: boolean
  persistedPermission: boolean
  visited: number
  truncated: boolean
  documents: NativeTreeDocument[]
  failures: Array<{ filepath: string; error: string }>
}

type MobileScanResult = {
  folder: string
  recursive: boolean
  scanned: number
  imported: number
  existing: number
  failed: number
  scanned_at: number
  truncated: boolean
  failures: Array<{ filepath: string; error: string }>
  imported_books: BookState[]
}

function decodeBase64Chunk(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

async function readNativeDocument(document: Pick<NativeTreeDocument, 'uri'>): Promise<Uint8Array> {
  const opened = await nativeInvoke<{ handle: string; size: number; displayName: string; mimeType: string }>('open_document_read', { uri: document.uri })
  const chunks: Uint8Array[] = []
  let total = 0
  let eof = false
  try {
    while (!eof) {
      const chunk = await nativeInvoke<{ dataBase64: string; bytesRead: number; eof: boolean }>('read_document_chunk', {
        handle: opened.handle,
        maxBytes: 256 * 1024,
      })
      const bytes = chunk.dataBase64 ? decodeBase64Chunk(chunk.dataBase64) : new Uint8Array()
      if (!bytes.length && !chunk.eof) throw new Error('The document provider stopped before the file was complete.')
      total += bytes.length
      if (chunk.bytesRead !== total) throw new Error('The document provider returned inconsistent read progress.')
      chunks.push(bytes)
      eof = chunk.eof
    }
  } finally {
    await nativeInvoke('close_document_read', { handle: opened.handle }).catch(() => {})
  }
  if (opened.size >= 0 && total !== opened.size) {
    throw new Error(`The document provider returned ${total} of ${opened.size} bytes.`)
  }
  const result = new Uint8Array(total)
  let offset = 0
  chunks.forEach((chunk) => { result.set(chunk, offset); offset += chunk.length })
  return result
}

type NativePickedBook = {
  uri?: string
  displayName?: string
  persisted?: boolean
}

/**
 * Open Android's Storage Access Framework and copy the selected EPUB or PDF
 * into a normal File. Tauri's WebView does not consistently surface a hidden
 * HTML file input on Android, while the native document contract preserves
 * provider access and enforces Folio's size/type policy before reading.
 */
export async function pickAndroidBookFile(): Promise<File | null> {
  const selected = await nativeInvoke<NativePickedBook>('pick_epub', { initialUri: null })
  if (!selected?.uri) return null
  const bytes = await readNativeDocument({ uri: selected.uri })
  const displayName = String(selected.displayName || '').trim()
  const filename = /\.(?:epub|pdf)$/i.test(displayName) ? displayName : 'book.epub'
  const mimeType = /\.pdf$/i.test(filename) ? 'application/pdf' : 'application/epub+zip'
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  return new File([buffer], filename, { type: mimeType, lastModified: Date.now() })
}

async function importBookBytes(
  bytes: Uint8Array,
  filename: string,
  options: { touchExisting?: boolean } = {},
): Promise<{ book: BookState; existing: boolean }> {
  const id = await contentId(bytes)
  const books = await getAllBooks()
  const existing = books.find((entry) => entry.id === id)
  if (existing) {
    let repaired = await repairBookMetadata(existing, bytes, filename, { explicit: true })
    const current = await getRecord(id)
    if (current?.contentRevision !== MOBILE_CONTENT_REVISION) {
      const upgraded = await upgradeMobileEpubRecord(current, { bytes, filename })
      if (upgraded) repaired = upgraded.book
    }
    if (options.touchExisting) {
      repaired.last_opened_at = Date.now()
      await putBookState(repaired)
    }
    return { book: repaired, existing: true }
  }
  let record: MobileRecord
  if (/\.pdf$/i.test(filename) || bytesToText(bytes.subarray(0, 5)) === '%PDF-') {
    record = await parsePdf(bytes, filename, id)
  } else if (/\.epub$/i.test(filename)) {
    record = parseEpub(bytes, filename, id)
  } else {
    throw new Error('Choose an EPUB or PDF file.')
  }
  await putImportedRecord(record)
  return { book: record.book, existing: false }
}

async function scanAndImportTree(folder: string, recursive: boolean): Promise<MobileScanResult> {
  const scannedAt = Date.now()
  const failures: Array<{ filepath: string; error: string }> = []
  const importedBooks: BookState[] = []
  let imported = 0
  let existing = 0
  if (!folder) {
    return { folder, recursive, scanned: 0, imported, existing, failed: 0, scanned_at: scannedAt, truncated: false, failures, imported_books: importedBooks }
  }
  let native: NativeTreeScan
  try {
    native = await nativeInvoke<NativeTreeScan>('scan_document_tree', { treeUri: folder, recursive })
  } catch (error) {
    failures.push({ filepath: 'Folder', error: error instanceof Error ? error.message : String(error) })
    return { folder, recursive, scanned: 0, imported, existing, failed: failures.length, scanned_at: scannedAt, truncated: false, failures, imported_books: importedBooks }
  }
  failures.push(...(native.failures || []))
  if (!native.permissionGranted || !native.persistedPermission) {
    if (!failures.some((failure) => /permission|persistent/i.test(failure.error))) {
      failures.push({ filepath: native.displayName || 'Folder', error: native.permissionGranted ? 'The provider did not grant persistent folder access.' : 'Read permission for this folder is no longer available.' })
    }
    return { folder, recursive, scanned: native.documents?.length || 0, imported, existing, failed: failures.length, scanned_at: scannedAt, truncated: native.truncated, failures, imported_books: importedBooks }
  }
  for (const document of native.documents || []) {
    try {
      const bytes = await readNativeDocument(document)
      const result = await importBookBytes(bytes, document.displayName)
      if (result.existing) existing += 1
      else { imported += 1; importedBooks.push(result.book) }
    } catch (error) {
      failures.push({ filepath: document.displayName || document.uri, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return {
    folder,
    recursive,
    scanned: native.documents?.length || 0,
    imported,
    existing,
    failed: failures.length,
    scanned_at: scannedAt,
    truncated: Boolean(native.truncated),
    failures: failures.slice(0, 100),
    imported_books: importedBooks,
  }
}

function scanResultForStorage(result: MobileScanResult): MobileScanResult {
  // Counts and bounded failures are the durable scan history. Imported books
  // already live in BOOKS_STORE; duplicating covers here can make one settings
  // record tens of megabytes.
  return { ...result, imported_books: [] }
}

async function audioUrlToBase64(url: string): Promise<string> {
  if (url.startsWith('data:')) {
    const separator = url.indexOf(',')
    if (separator < 0) throw new Error('Audio data URL is malformed')
    return url.slice(separator + 1)
  }
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Could not read audio (${response.status})`)
  return decodeBase64(new Uint8Array(await response.arrayBuffer()))
}

async function artworkFingerprint(base64: string, mimeType: string): Promise<string> {
  const input = `${mimeType}:${base64}`
  try {
    const subtle = globalThis.crypto?.subtle
    if (subtle) {
      const digest = await subtle.digest('SHA-256', new TextEncoder().encode(input))
      return Array.from(new Uint8Array(digest)).map((value) => value.toString(16).padStart(2, '0')).join('')
    }
  } catch {
    // Deterministic fallback below is sufficient for cache invalidation.
  }
  return `${mimeType}:${base64.length}:${base64.slice(0, 64)}:${base64.slice(-64)}`
}

async function artworkUrlToPayload(url: string | null | undefined): Promise<{ base64: string; mimeType: string; revision: string } | null> {
  const value = String(url || '').trim()
  if (!value) return null
  if (value.startsWith('data:')) {
    const match = value.match(/^data:([^;,]+)(?:;[^,]*)?,([\s\S]*)$/i)
    if (!match) return null
    const mimeType = normalizeCoverMediaType(match[1])
    const base64 = match[2].trim()
    if (!mimeType || mimeType === 'image/svg+xml' || !base64 || base64.length > 12 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 === 1) return null
    return { base64, mimeType, revision: await artworkFingerprint(base64, mimeType) }
  }
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 1_500)
    try {
      const response = await fetch(value, { signal: controller.signal })
      if (!response.ok) return null
      const mimeType = normalizeCoverMediaType(response.headers.get('content-type'))
      if (!mimeType || mimeType === 'image/svg+xml') return null
      const bytes = await readResponseBytesBounded(response, controller, 8 * 1024 * 1024)
      if (bytes.byteLength === 0) return null
      const base64 = decodeBase64(bytes)
      return { base64, mimeType, revision: await artworkFingerprint(base64, mimeType) }
    } finally {
      clearTimeout(timeout)
    }
  } catch {
    return null
  }
}

export async function mobileStartAudio(
  audioInfo: AudioInfo,
  metadata: { title?: string; artist?: string; album?: string; bookId?: string; format?: string; chapterTitle?: string; chapterIndex?: number; chapterCount?: number; sentenceIndex?: number; sentenceCount?: number; chunkProgress?: number; locationUri?: string; description?: string; artworkUrl?: string | null } = {},
  positionMs = 0,
  mode: 'replace' | 'append' = 'replace',
): Promise<MobilePlaybackStatus> {
  const audioBase64 = await audioUrlToBase64(audioInfo.url)
  // Audio is the critical path. Cover fetching/decoding is bounded and runs
  // after the queue item is durable, so a broken cover cannot delay narration.
  const status = await nativeInvoke<MobilePlaybackStatus>('play_audio', {
    audioBase64,
    title: metadata.title || 'Folio narration',
    artist: metadata.artist || 'Folio',
    album: metadata.album || 'Folio',
    bookId: metadata.bookId || '',
    format: metadata.format || '',
    chapterTitle: metadata.chapterTitle || '',
    chapterIndex: Number.isFinite(metadata.chapterIndex) ? metadata.chapterIndex : 0,
    chapterCount: Number.isFinite(metadata.chapterCount) ? metadata.chapterCount : 0,
    sentenceIndex: Number.isFinite(metadata.sentenceIndex) ? metadata.sentenceIndex : 0,
    sentenceCount: Number.isFinite(metadata.sentenceCount) ? metadata.sentenceCount : 0,
    chunkProgress: Number.isFinite(metadata.chunkProgress) ? metadata.chunkProgress : 0,
    locationUri: metadata.locationUri || '',
    description: metadata.description || '',
    artworkBase64: null,
    artworkMimeType: null,
    positionMs: Math.max(0, Math.round(positionMs)),
    mode,
  })
  if (mode === 'replace' && metadata.bookId && metadata.artworkUrl) {
    void artworkUrlToPayload(metadata.artworkUrl).then((artwork) => {
      if (!artwork) return
      return nativeInvoke<MobilePlaybackStatus>('update_artwork', {
        bookId: metadata.bookId,
        artworkBase64: artwork.base64,
        artworkMimeType: artwork.mimeType,
        artworkRevision: artwork.revision,
      }).catch(() => {})
    }).catch(() => {})
  }
  return status
}

export function mobileAudioStatus(): Promise<MobilePlaybackStatus> {
  return nativeInvoke<MobilePlaybackStatus>('audio_status')
}

export function mobileControlAudio(action: 'pause' | 'resume' | 'stop' | 'seek', positionMs?: number): Promise<MobilePlaybackStatus> {
  return nativeInvoke<MobilePlaybackStatus>('control_audio', {
    action,
    positionMs: positionMs == null ? null : Math.max(0, Math.round(positionMs)),
  })
}

export function mobilePruneArtworkCache(bookIds: string[]): Promise<MobilePlaybackStatus> {
  return nativeInvoke<MobilePlaybackStatus>('prune_artwork_cache', { bookIds })
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

function notFound(message: string): Response {
  return jsonResponse({ detail: message }, 404)
}

function parseBody(options?: RequestInit): Promise<Record<string, unknown>> {
  const body = options?.body
  if (!body) return Promise.resolve({})
  if (body instanceof FormData) {
    const file = body.get('file')
    if (!(file instanceof File)) return Promise.resolve({})
    return file.arrayBuffer().then((buffer) => ({
      file_name: file.name,
      file_bytes: new Uint8Array(buffer),
    }))
  }
  if (typeof body === 'string') {
    try { return Promise.resolve(JSON.parse(body) as Record<string, unknown>) } catch { return Promise.resolve({}) }
  }
  return Promise.resolve({})
}

async function handleRequest(path: string, options?: RequestInit): Promise<Response> {
  const url = new URL(path, 'https://folio.android')
  const method = (options?.method || 'GET').toUpperCase()
  const body = await parseBody(options)
  const books = await getAllBooks()
  const getBookState = (id: string) => books.find((entry) => entry.id === id)

  if (url.pathname === '/api/status') {
    let bridgeError = ''
    const platform: NativePlatformStatus = await nativePlatformStatus().catch((error): NativePlatformStatus => {
      bridgeError = error instanceof Error ? error.message : String(error)
      return { nativeTtsAvailable: false, modelAssets: {} }
    })
    const modelAssets = platform.modelAssets || {}
    const engines = ['supertonic', 'kokoro'] as const
    const models = Object.fromEntries(engines.map((engine) => [engine, modelInstallInfo(engine, platform, bridgeError || undefined)]))
    const anyLoaded = Object.values(modelAssets).some((model) => Boolean(model.loaded))
    return jsonResponse({
      gpu: false,
      voices: 10,
      model_loaded: anyLoaded,
      model_loading: false,
      active_tts_engine: 'supertonic',
      tts_runtime: { model_loaded: anyLoaded, selected_device: 'android-cpu', provider: 'onnxruntime-android', fallback_reason: null },
      tts_engines: Object.fromEntries(engines.map((engine) => {
        const native = modelAssets[engine]
        return [engine, { model_loaded: Boolean(native?.loaded), selected_device: 'android-cpu', provider: 'onnxruntime-android', error: bridgeError || native?.error || null }]
      })),
      tts_activity: { active: null, running: [], pending: [] },
      models,
      system: { ram: { used_bytes: 0, total_bytes: 0, percent: 0 }, gpu: null },
    })
  }
  if (url.pathname === '/api/models' || /^\/api\/models\/(supertonic|kokoro)(?:\/(download|retry|cancel|import|warm))?$/.test(url.pathname)) {
    const modelAction = url.pathname.match(/^\/api\/models\/(supertonic|kokoro)(?:\/(download|retry|cancel|import|warm))?$/)
    if (modelAction && !modelAction[2]) {
      const platform = await nativePlatformStatus().catch(() => ({ nativeTtsAvailable: false, modelAssets: {} }))
      return jsonResponse(modelInstallInfo(modelAction[1] as 'supertonic' | 'kokoro', platform))
    }
    if (modelAction && modelAction[2] === 'warm') {
      const result = await nativeInvoke<Record<string, unknown>>('warm_model', { engine: modelAction[1] })
      return jsonResponse(result)
    }
    if (modelAction && modelAction[2] !== 'cancel') {
      const result = await nativeInvoke<{ installed?: boolean; started?: boolean; cancelled?: boolean; state?: string; error?: string | null }>('install_model_pack', {
        engine: modelAction[1],
        download: modelAction[2] !== 'import',
      })
      nativePlatformStatusCache = null
      // Downloads/imports are allowed to be long-running. Native status is the
      // progress source of truth, so return the operation acknowledgement
      // without converting an in-flight install into a false failure.
      if (!result?.installed) {
        if (result?.cancelled) {
          return jsonResponse({ ...result, ok: true })
        }
        if (result?.started || result?.state === 'download_queued' || result?.state === 'downloading') {
          return jsonResponse({ ...result, ok: true })
        }
        const detail = result?.error || `${modelAction[1]} model installation failed.`
        return jsonResponse({ ...result, detail, error: 'model_install_failed' }, 422)
      }
      return jsonResponse(result)
    }
    if (modelAction && modelAction[2] === 'cancel') {
      await nativeInvoke('install_model_pack', { engine: modelAction[1], cancel: true })
      nativePlatformStatusCache = null
    }
    const response = await handleRequest('/api/status', options)
    const data = await response.json() as { models: Record<string, unknown> }
    return url.pathname === '/api/models' ? jsonResponse(data.models) : jsonResponse(data.models[url.pathname.split('/')[3]] || {})
  }
  if (url.pathname === '/api/settings' && method === 'GET') return jsonResponse(await getValue('settings', {}))
  if (url.pathname === '/api/settings' && method === 'POST') {
    const current = await getValue<Record<string, unknown>>('settings', {})
    await putValue('settings', { ...current, ...body })
    return jsonResponse({ ok: true, settings: { ...current, ...body } })
  }
  if (url.pathname === '/api/library/folder' && method === 'GET') {
    const settings = await getValue<Record<string, unknown>>('settings', {})
    const folder = String(settings.library_scan_folder || '')
    return jsonResponse({ folder, recursive: settings.library_scan_recursive !== false, exists: Boolean(folder), last_result: settings.library_scan_last_result || null })
  }
  if (url.pathname === '/api/library/folder' && method === 'POST') {
    const current = await getValue<Record<string, unknown>>('settings', {})
    const folder = String(body.folder || '')
    const recursive = body.recursive !== false
    const lastResult = folder ? await scanAndImportTree(folder, recursive) : null
    await putValue('settings', { ...current, library_scan_folder: folder, library_scan_recursive: recursive, library_scan_last_result: lastResult ? scanResultForStorage(lastResult) : null })
    return jsonResponse({ folder, recursive, exists: Boolean(folder), last_result: lastResult })
  }
  if (url.pathname === '/api/library/scan' && method === 'POST') {
    const current = await getValue<Record<string, unknown>>('settings', {})
    const folder = String(body.folder || current.library_scan_folder || '')
    const recursive = body.recursive == null ? current.library_scan_recursive !== false : body.recursive !== false
    const result = await scanAndImportTree(folder, recursive)
    await putValue('settings', { ...current, library_scan_folder: folder, library_scan_recursive: recursive, library_scan_last_result: scanResultForStorage(result) })
    return jsonResponse(result)
  }
  if (url.pathname === '/api/library/search') {
    const query = normalizeText(url.searchParams.get('q') || '').toLowerCase()
    const filteredBooks = books
      .filter((book) => !query || [book.title, book.author, ...(book.genres || []), ...(book.collections || [])]
        .join(' ')
        .toLowerCase()
        .includes(query))
    return jsonResponse({ query, total: filteredBooks.length, books: filteredBooks })
  }
  if (url.pathname === '/api/recent') return jsonResponse(books.slice().sort((a, b) => (b.last_opened_at || 0) - (a.last_opened_at || 0)))
  if (url.pathname === '/api/dashboard/notes' && method === 'POST') {
    const notes = await getValue<Array<Record<string, unknown>>>('dashboard-notes', [])
    const book = getBookState(String(body.book_id || ''))
    if (!book) return notFound('Book not found')
    const note = {
      id: globalThis.crypto?.randomUUID?.() || `note-${Date.now()}`,
      type: 'note',
      book_id: book.id,
      book_title: book.title,
      author: book.author,
      page: Math.max(0, Number(body.page || 0)),
      sentence_idx: 0,
      text: String(body.text || '').trim(),
      note: String(body.text || '').trim(),
      created_at: Date.now(),
    }
    if (!note.text) return jsonResponse({ detail: 'Note text is required.' }, 400)
    await putValue('dashboard-notes', [note, ...notes].slice(0, 500))
    return jsonResponse(note, 201)
  }
  if (url.pathname === '/api/dashboard/goal' && method === 'POST') {
    const settings = await getValue<Record<string, unknown>>('settings', {})
    const minutes = Math.max(1, Math.min(1440, Number(body.daily_goal_minutes || 60)))
    await putValue('settings', { ...settings, daily_goal_minutes: minutes })
    return jsonResponse({ ok: true, daily_goal_minutes: minutes })
  }
  if (url.pathname === '/api/dashboard') {
    const settings = await getValue<Record<string, unknown>>('settings', {})
    const notes = await getValue<DashboardPayload['notes']>('dashboard-notes', [])
    const dailyGoalMinutes = Math.max(1, Math.min(1440, Number(settings.daily_goal_minutes || 60)))
    const dashboard: DashboardPayload = {
      books,
      recent_books: books.slice().sort((a, b) => (b.last_opened_at || 0) - (a.last_opened_at || 0)),
      recently_added: books.slice().sort((a, b) => (b.imported_at || 0) - (a.imported_at || 0)),
      continue_book: books.find((book) => book.has_reading_progress) || books[0] || null,
      counts: { books: books.length, authors: new Set(books.map((book) => book.author)).size, collections: 0, genres: 0, audiobooks: 0, highlights: 0, notes: notes.length, history: books.length, pages_total: books.reduce((sum, book) => sum + book.page_count, 0), pages_read: books.reduce((sum, book) => sum + Math.round((book.progress || 0) * book.page_count), 0) },
      collections: [], genres: [], authors: Array.from(new Set(books.map((book) => book.author))), weekly_stats: [],
      reading_goal: { daily_goal_minutes: dailyGoalMinutes, today_ms: 0, today_minutes: 0, progress: 0 }, highlights: [], notes,
      profile: { reader_name: String(settings.reader_name || '') },
      backend: { reachable: true, active_tts_engine: 'supertonic', gpu: false, version: 'android', models: {} },
    }
    return jsonResponse(dashboard)
  }
  if (url.pathname === '/api/book/open-upload' && method === 'POST') {
    const bytes = body.file_bytes
    if (!(bytes instanceof Uint8Array)) return jsonResponse({ detail: 'No readable book file was provided.' }, 400)
    const filename = String(body.file_name || 'book.epub')
    try {
      const imported = await importBookBytes(bytes, filename, { touchExisting: true })
      return jsonResponse(imported.book)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return jsonResponse({ detail }, 400)
    }
  }
  const openMatch = url.pathname === '/api/book/open' ? url.searchParams.get('filepath') : null
  if (openMatch) {
    const book = books.find((entry) => entry.filepath === openMatch || entry.id === openMatch)
    if (!book) return notFound('Book is no longer in the local library.')
    book.last_opened_at = Date.now()
    await putBookState(book)
    void mobilePruneArtworkCache(recentArtworkBookIds(books, book.id)).catch(() => {})
    return jsonResponse(book)
  }
  if (url.pathname === '/api/cache/info') {
    const records = (await getAllAudioRecords()).filter((record) => record.audio instanceof Blob && record.audio.size > 0)
    const bytes = records.reduce((total, record) => total + record.audio.size, 0)
    return jsonResponse({ files: records.length, size_mb: bytes / (1024 * 1024) })
  }
  if (url.pathname === '/api/cache/clear' && method === 'POST') {
    // Invalidate every layer before touching IndexedDB. Native synthesis jobs
    // cannot be interrupted safely, so the epoch prevents an older result
    // from repopulating the cache after this clear completes.
    audioCacheEpoch += 1
    bufferWindows.forEach((window) => { window.cancelled = true })
    bufferWindows.clear()
    preloadJobs.clear()
    audioGenerationJobs.clear()
    const deleted = await clearAudioRecords()
    releaseAllResources()
    globalThis.dispatchEvent(new CustomEvent('folio:audio-cache-cleared', { detail: { deleted } }))
    return jsonResponse({ ok: true, deleted, skipped: 0, files: 0, size_mb: 0 })
  }

  const reflowMatch = url.pathname.match(/^\/api\/book\/([^/]+)\/reflow$/)
  if (reflowMatch) {
    const record = await getRecord(reflowMatch[1])
    return record ? jsonResponse(record.reflow) : notFound('Book not found')
  }
  const pageMatch = url.pathname.match(/^\/api\/book\/([^/]+)\/page\/(\d+)\/text$/)
  if (pageMatch) {
    const record = await getRecord(pageMatch[1])
    return record ? jsonResponse(record.pages[Number(pageMatch[2])] || { page_number: Number(pageMatch[2]), sentences: [], render_width: 1, render_height: 1 }) : notFound('Book not found')
  }
  const sourceMatch = url.pathname.match(/^\/api\/book\/([^/]+)\/source$/)
  if (sourceMatch) {
    const record = await getSourceRecord(sourceMatch[1])
    if (!record?.source) return notFound('The original local book file is unavailable.')
    return new Response(record.source, {
      headers: {
        'content-type': record.mimeType || record.source.type || 'application/octet-stream',
        'content-length': String(record.source.size),
        'cache-control': 'private, max-age=3600',
      },
    })
  }
  const searchMatch = url.pathname.match(/^\/api\/book\/([^/]+)\/search$/)
  if (searchMatch) {
    const record = await getRecord(searchMatch[1])
    if (!record) return notFound('Book not found')
    const query = normalizeText(url.searchParams.get('q') || '').toLowerCase()
    const results = record.reflow.chapters.flatMap((chapter, page) => (
      chapterNarrationSentences(chapter).map((sentence, sentenceIdx) => ({
        page,
        sentence_idx: sentenceIdx,
        global_sentence_idx: sentence.global_sentence_idx ?? null,
        location_label: chapter.title || `Chapter ${page + 1}`,
        text: sentence.text,
        snippet: sentence.text,
      })).filter((result) => !query || result.text.toLowerCase().includes(query))
    ))
    const response: SearchResponse = { query, format: record.book.format, total: results.length, results }
    return jsonResponse(response)
  }
  const positionMatch = url.pathname.match(/^\/api\/book\/([^/]+)\/position$/)
  if (positionMatch && method === 'POST') {
    const book = getBookState(positionMatch[1])
    if (!book) return notFound('Book not found')
    book.last_position = {
      ...book.last_position,
      ...body,
      narration_index_version: NARRATION_INDEX_VERSION,
      saved_at: Date.now(),
    }
    book.has_reading_progress = true
    book.progress = Math.max(0, Math.min(1, (book.last_position.page + 1) / Math.max(1, book.page_count)))
    await putBookState(book)
    return jsonResponse({ ok: true, book })
  }
  const bookmarkMatch = url.pathname.match(/^\/api\/book\/([^/]+)\/bookmark(?:\/(\d+))?$/)
  if (bookmarkMatch) {
    const book = getBookState(bookmarkMatch[1])
    if (!book) return notFound('Book not found')
    if (method === 'POST') {
      book.bookmarks = [...book.bookmarks, { ...body, narration_index_version: NARRATION_INDEX_VERSION } as never]
    }
    else if (method === 'DELETE') book.bookmarks = book.bookmarks.filter((_, index) => index !== Number(bookmarkMatch[2]))
    await putBookState(book)
    return jsonResponse({ ok: true, bookmarks: book.bookmarks })
  }
  const settingsMatch = url.pathname.match(/^\/api\/book\/([^/]+)\/settings$/)
  if (settingsMatch && method === 'POST') {
    const book = getBookState(settingsMatch[1])
    if (!book) return notFound('Book not found')
    const requestedEngine = String(url.searchParams.get('tts_engine') || body.tts_engine || book.tts_engine)
    const requestedVoice = String(url.searchParams.get('voice') || body.voice || book.voice)
    const requestedSpeed = Number(url.searchParams.get('speed') || body.speed || book.speed)
    const updated = {
      ...book,
      ...body,
      tts_engine: requestedEngine as BookState['tts_engine'],
      voice: requestedVoice,
      speed: Number.isFinite(requestedSpeed) ? requestedSpeed : book.speed,
      updated_at: Date.now(),
    }
    await putBookState(updated)
    return jsonResponse(updated)
  }
  const metadataMatch = url.pathname.match(/^\/api\/book\/([^/]+)\/metadata$/)
  if (metadataMatch && method === 'POST') {
    const book = getBookState(metadataMatch[1])
    if (!book) return notFound('Book not found')
    const updated = { ...book, ...body } as BookState
    await putBookState(updated)
    return jsonResponse({ ok: true, book: updated })
  }

  const preloadMatch = url.pathname.match(/^\/api\/book\/([^/]+)\/preload-chapter(?:\/(status))?$/)
  if (preloadMatch) {
    const bookId = safeDecodeURIComponent(preloadMatch[1])
    const page = Number(url.searchParams.get('page'))
    const record = await getRecord(bookId)
    if (!record) return notFound('The selected book is no longer in the Android library.')
    if (!Number.isInteger(page) || page < 0 || page >= record.pages.length) {
      return jsonResponse({ detail: 'The chapter position is invalid.' }, 400)
    }
    const engine = normalizeTtsEngine(url.searchParams.get('engine'))
    const voice = normalizeVoiceForEngine(engine, url.searchParams.get('voice'))
    const speed = clampSpeedForEngine(engine, url.searchParams.get('speed'))
    const requirement = await nativeModelRequirement(engine)
    if (requirement) return requirement
    if (preloadMatch[2] === 'status' && method === 'GET') {
      return jsonResponse(await chapterPreloadStatus(record, page, engine, voice, speed))
    }
    if (!preloadMatch[2] && method === 'POST') {
      return jsonResponse(await startChapterPreload(record, page, engine, voice, speed))
    }
    return jsonResponse({ detail: 'This preload operation does not support the requested method.' }, 405)
  }

  const deleteMatch = url.pathname.match(/^\/api\/book\/([^/]+)$/)
  if (deleteMatch && method === 'DELETE') { await deleteRecord(deleteMatch[1]); return jsonResponse({ ok: true }) }

  if (url.pathname === '/api/tts/buffer/cancel' && method === 'POST') {
    const identity = normalizeAudioIdentity(
      url.searchParams.get('book_id') || '',
      Number(url.searchParams.get('page')),
      Number(url.searchParams.get('sentence')),
      url.searchParams.get('engine'),
      url.searchParams.get('voice'),
      url.searchParams.get('speed'),
    )
    const key = bufferWindowKey(identity)
    const window = bufferWindows.get(key)
    if (window) window.cancelled = true
    bufferWindows.delete(key)
    return jsonResponse({ ok: true, cancelled: window ? 1 : 0 })
  }

  if (url.pathname === '/api/tts/buffer' && method === 'POST') {
    const bookId = url.searchParams.get('book_id') || ''
    const page = Number(url.searchParams.get('page'))
    const sentence = Number(url.searchParams.get('sentence'))
    const record = await getRecord(bookId)
    if (!record) return notFound('The selected book is no longer in the Android library.')
    if (!Number.isInteger(page) || !Number.isInteger(sentence)) {
      return jsonResponse({ detail: 'The narration position is invalid.' }, 400)
    }
    const countValue = Number(url.searchParams.get('count') || 2)
    const count = Math.max(1, Math.min(MAX_BUFFER_SENTENCES, Number.isFinite(countValue) ? Math.floor(countValue) : 2))
    const canonical = normalizeAudioIdentity(bookId, page, sentence, url.searchParams.get('engine'), url.searchParams.get('voice'), url.searchParams.get('speed'))
    const requirement = await nativeModelRequirement(canonical.engine)
    if (requirement) return requirement
    const refs = sentenceWindowRefs(record, page, sentence, count)
    const available = await audioKeysInCache()
    const queued: Array<{ page: number; sentence: number }> = []
    const skipped: Array<{ page: number; sentence: number; reason: string }> = []
    const work = refs.map((entry) => ({
      ...entry,
      identity: normalizeAudioIdentity(bookId, entry.page, entry.sentence, canonical.engine, canonical.voice, canonical.speed),
    }))
    work.forEach((entry) => {
      const key = audioCacheKey(entry.identity)
      if (available.has(key)) skipped.push({ page: entry.page, sentence: entry.sentence, reason: 'cached' })
      else if (audioGenerationJobs.has(key)) skipped.push({ page: entry.page, sentence: entry.sentence, reason: 'running' })
      else queued.push({ page: entry.page, sentence: entry.sentence })
    })
    const windowKey = bufferWindowKey(canonical)
    const previous = bufferWindows.get(windowKey)
    if (previous) previous.cancelled = true
    const window: MobileBufferWindow = { cancelled: false }
    bufferWindows.set(windowKey, window)
    void (async () => {
      try {
        for (const entry of work) {
          if (window.cancelled) break
          if (available.has(audioCacheKey(entry.identity))) continue
          await getOrGenerateAudioRecord(entry.identity, entry.text, entry.pauseAfterMs).catch(() => null)
        }
      } finally {
        if (bufferWindows.get(windowKey) === window) bufferWindows.delete(windowKey)
      }
    })()
    return jsonResponse({ requested: refs.length, queued, skipped, cancelled: previous ? 1 : 0 })
  }

  if (url.pathname === '/api/tts/generate') {
    const bookId = url.searchParams.get('book_id') || ''
    const page = Number(url.searchParams.get('page'))
    const sentence = Number(url.searchParams.get('sentence'))
    const record = await getRecord(bookId)
    if (!record) return notFound('The selected book is no longer in the Android library.')
    if (!Number.isInteger(page) || !Number.isInteger(sentence)) {
      return jsonResponse({ detail: 'The narration position is invalid.' }, 400)
    }
    const sentenceInfo = record.pages[page]?.sentences?.[sentence]
    const text = sentenceInfo?.text?.trim() || ''
    if (!text) return notFound('No readable sentence exists at this position.')
    const identity = normalizeAudioIdentity(bookId, page, sentence, url.searchParams.get('engine'), url.searchParams.get('voice'), url.searchParams.get('speed'))
    const requirement = await nativeModelRequirement(identity.engine)
    if (requirement) return requirement
    try {
      const audio = await getOrGenerateAudioRecord(
        identity,
        text,
        Number(sentenceInfo?.pause_after_ms ?? INTER_CHUNK_PAUSE_MS),
      )
      const resource = materializeAudioResource(audio)
      const result: TtsGenerateResponse & { audio_url: string } = {
        filename: resource.filename,
        duration_ms: audio.durationMs,
        audio_url: resource.url,
      }
      return jsonResponse(result)
    } catch (error) {
      const missingModel = await nativeModelRequirement(identity.engine)
      if (missingModel) return missingModel
      const detail = error instanceof Error ? error.message : String(error)
      return jsonResponse({ detail: `${identity.engine} synthesis failed: ${detail}` }, 503)
    }
  }
  const audioMatch = url.pathname.match(/^\/api\/audio\/(.+)$/)
  if (audioMatch) {
    const filename = safeDecodeURIComponent(audioMatch[1])
    if (!/^folio-[a-f0-9]+\.wav$/i.test(filename)) return jsonResponse({ detail: 'Invalid audio filename.' }, 400)
    const record = await getAudioRecordByFilename(filename)
    if (!record) return notFound('Audio not found')
    materializeAudioResource(record)
    return new Response(record.audio, {
      headers: {
        'content-type': 'audio/wav',
        'content-length': String(record.audio.size),
        'cache-control': 'private, max-age=3600',
      },
    })
  }
  return notFound(`Android API route not implemented: ${method} ${url.pathname}`)
}

export function mobileResourceUrl(path: string): string {
  if (path.startsWith('data:') || path.startsWith('blob:')) return path
  return resourceCache.get(path) || path
}

;(globalThis as { __folioMobileResourceUrl?: (value: string) => string }).__folioMobileResourceUrl = mobileResourceUrl

export async function mobileApiFetch(path: string, options?: RequestInit): Promise<Response> {
  return handleRequest(path, options)
}
