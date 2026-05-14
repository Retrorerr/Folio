export type BookFormat = 'epub'
export type TtsEngine = 'kokoro' | 'chatterbox-turbo'
export type PreloadStatus = 'idle' | 'verifying' | 'current-ready' | 'preloading' | 'ready' | 'error'

export interface Position {
  page: number
  sentence_idx: number
}

export interface Bookmark extends Position {
  label: string
}

export interface TocEntry {
  title: string
  page: number
}

export interface BookState {
  id: string
  filepath: string
  title: string
  author: string
  page_count: number
  toc: TocEntry[]
  format: BookFormat
  cover_url?: string | null
  cover_source?: string | null
  tts_engine: TtsEngine | string
  voice: string
  speed: number
  last_position: Position
  bookmarks: Bookmark[]
}

export interface WordInfo {
  text: string
  x: number
  y: number
  w: number
  h: number
  char_offset: number
  char_length: number
}

export interface SentenceInfo {
  text: string
  words: WordInfo[]
  audio_path?: string | null
  duration_ms?: number
}

export interface PageText {
  page_number: number
  sentences: SentenceInfo[]
  render_width: number
  render_height: number
}

export interface Voice {
  id: string
  name: string
  tagline?: string
  description?: string
}

export interface TtsRuntimeInfo {
  model_loaded?: boolean
  model_loading?: boolean
  gpu?: boolean
  provider?: string
  selected_device?: string
  download_active?: boolean
  download_bytes?: number
  download_total_bytes?: number
  fallback_reason?: string | null
  last_load_error?: string | null
  [key: string]: unknown
}

export interface TtsStatus {
  gpu: boolean
  voices: number
  model_loaded: boolean
  model_loading: boolean
  active_tts_engine: string
  tts_runtime?: TtsRuntimeInfo
  tts_engines?: Record<string, TtsRuntimeInfo>
  system?: {
    ram?: {
      used_bytes: number
      total_bytes: number
      percent: number
    }
    gpu?: {
      name?: string
      vram_used_mb?: number
      vram_total_mb?: number
    } | null
  }
}

export interface PreloadState {
  state: PreloadStatus
  ready: number
  total: number
  failed: number[]
}

export interface AudioInfo {
  url: string
  duration_ms: number
}

export interface SearchResult {
  page: number
  sentence_idx: number
  global_sentence_idx: number
  location_label: string
  text: string
  snippet: string
}

export interface SearchResponse {
  query: string
  format?: BookFormat
  total: number
  results: SearchResult[]
}

export interface CacheInfo {
  files: number
  size_mb: number
}

export interface CacheClearResponse extends CacheInfo {
  ok: boolean
  deleted: number
  skipped: number
}

export type GlobalSettings = Record<string, unknown>

export interface TtsGenerateResponse {
  filename: string
  duration_ms: number
}

export interface TtsBufferResponse {
  requested: number
  queued: Array<{ page: number; sentence: number }>
  skipped: Array<{ page: number; sentence: number; reason: string }>
}

export interface PreloadChapterResponse {
  total: number
  queued: number
}
