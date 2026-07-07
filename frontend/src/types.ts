export type BookFormat = 'epub'
export type TtsEngine = 'supertonic' | 'kokoro'
export type PreloadStatus = 'idle' | 'verifying' | 'current-ready' | 'preloading' | 'ready' | 'error'

export interface Position {
  page: number
  sentence_idx: number
  content_page?: number | null
  pages_per_view?: number | null
  layout_key?: string | null
  chunk_progress?: number | null
  saved_at?: number | null
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
  tts_voices?: Record<string, string>
  speed: number
  last_position: Position
  bookmarks: Bookmark[]
  imported_at?: number | null
  last_opened_at?: number | null
  updated_at?: number | null
  collections?: string[]
  genres?: string[]
  reading_ms_total?: number
  visual_page_count?: number | null
  exists?: boolean
  progress?: number
  has_reading_progress?: boolean
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
  download_label?: string | null
  download_error?: string | null
  fallback_reason?: string | null
  last_load_error?: string | null
  [key: string]: unknown
}

export interface ModelInstallInfo {
  engine: string
  label: string
  state: 'not_installed' | 'download_queued' | 'downloading' | 'verifying' | 'ready' | 'failed'
  ready: boolean
  installed?: boolean
  downloaded_bytes: number
  total_bytes: number
  progress: number
  error?: string | null
  download_active?: boolean
  download_label?: string | null
  download_error?: string | null
  approx_download_bytes?: number
  [key: string]: unknown
}

export interface TtsActivityJob {
  key: string
  status: 'pending' | 'running' | 'done' | 'error' | string
  priority: number
  metadata?: {
    book_id?: string
    engine?: string
    voice?: string
    speed?: number
    page?: number
    page_number?: number
    sentence?: number
    sentence_number?: number
    sentence_count?: number
    text?: string
    [key: string]: unknown
  }
}

export interface TtsActivity {
  active?: TtsActivityJob | null
  running?: TtsActivityJob[]
  pending?: TtsActivityJob[]
}

export interface TtsStatus {
  gpu: boolean
  voices: number
  model_loaded: boolean
  model_loading: boolean
  active_tts_engine: string
  tts_runtime?: TtsRuntimeInfo
  tts_engines?: Record<string, TtsRuntimeInfo>
  tts_activity?: TtsActivity
  models?: Record<string, ModelInstallInfo>
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

export interface ModelRequiredErrorPayload {
  error: 'model_required'
  detail: string
  engine: string
  install: ModelInstallInfo
}

export interface PreloadState {
  state: PreloadStatus
  ready: number
  readyIndices?: number[]
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

export interface DashboardHighlight {
  id: string
  type: 'highlight' | 'note' | 'bookmark'
  book_id?: string | null
  book_title: string
  author?: string
  page: number
  sentence_idx?: number
  text: string
  note?: string
  created_at?: number
}

export interface WeeklyStat {
  date: string
  label: string
  reading_ms: number
  minutes: number
  pages: number
}

export interface DashboardPayload {
  books: BookState[]
  recent_books: BookState[]
  recently_added: BookState[]
  continue_book: BookState | null
  counts: {
    books: number
    authors: number
    collections: number
    genres: number
    audiobooks: number
    highlights: number
    notes: number
    history: number
    pages_total: number
    pages_read: number
  }
  collections: string[]
  genres: string[]
  authors: string[]
  weekly_stats: WeeklyStat[]
  reading_goal: {
    daily_goal_minutes: number
    today_ms: number
    today_minutes: number
    progress: number
  }
  highlights: DashboardHighlight[]
  notes: DashboardHighlight[]
  backend?: {
    reachable?: boolean
    active_tts_engine?: string
    gpu?: boolean
    version?: string | null
    models?: Record<string, ModelInstallInfo>
  }
}

export interface LibrarySearchResponse {
  query: string
  total: number
  books: BookState[]
}

export interface LibraryScanResult {
  folder: string
  recursive: boolean
  scanned: number
  imported: number
  existing: number
  failed: number
  scanned_at: number
  truncated?: boolean
  failures?: Array<{ filepath: string; error: string }>
  imported_books?: BookState[]
}

export interface LibraryFolderStatus {
  folder: string
  recursive: boolean
  exists: boolean
  last_result?: LibraryScanResult | null
}
