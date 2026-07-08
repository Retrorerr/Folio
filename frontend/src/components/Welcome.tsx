import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion as m } from 'motion/react'
import { Icons } from './icons'
import { SettingsPanel } from './Sidebar'
import { apiFetch, apiJson, apiResourceUrl } from '../api'
import { buttonHover, buttonTap, listItem, listStagger, pageTransition, scaleIn, slideUp, spring } from '../motion'
import type { BookState, DashboardHighlight, DashboardPayload, LibrarySearchResponse, WeeklyStat } from '../types'

async function currentWindow() {
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  return getCurrentWindow()
}

type DashboardView = 'home' | 'continue' | 'library' | 'audiobooks' | 'highlights' | 'notes' | 'history'
type MetadataKind = 'genres'
type LibraryFilter = {
  author: string
  genre: string
}
type WelcomeProps = {
  theme?: string
  setTheme?: (theme: string) => void
  motion?: boolean
  setMotion?: (motion: boolean) => void
  onUpload: (file: File) => Promise<unknown>
  recentBooks: BookState[]
  onOpenRecent: (filepath: string) => void | Promise<unknown>
  onDeleteRecent?: (bookId: string, deleteFile?: boolean) => void | Promise<unknown>
  statusBadges?: React.ReactNode
  settingsPanelProps?: Record<string, unknown>
}

const COVERS = ['cover-a', 'cover-b', 'cover-c', 'cover-d', 'cover-e', 'cover-f', 'cover-g', 'cover-h']
const OPEN_SHORTCUT = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform)
  ? 'Cmd O'
  : 'Ctrl O'
const DASHBOARD_PAGE_TOTAL_PREFIX = 'folio:dashboard-page-total:'
const PAGINATION_CACHE_PREFIX = 'folio:pagination:'
const READER_NAME_KEY = 'folio:reader-name'
const EMPTY_SHELF_SPINES = ['tall', 'short', 'lean', 'gold', 'wide', 'slim', 'dark']

const EMPTY_DASHBOARD: DashboardPayload = {
  books: [],
  recent_books: [],
  recently_added: [],
  continue_book: null,
  counts: {
    books: 0,
    authors: 0,
    collections: 0,
    genres: 0,
    audiobooks: 0,
    highlights: 0,
    notes: 0,
    history: 0,
    pages_total: 0,
    pages_read: 0,
  },
  collections: [],
  genres: [],
  authors: [],
  weekly_stats: [],
  reading_goal: {
    daily_goal_minutes: 60,
    today_ms: 0,
    today_minutes: 0,
    progress: 0,
  },
  highlights: [],
  notes: [],
}

const NAV_ITEMS: Array<{ id: DashboardView; label: string; icon: keyof typeof Icons; countKey?: keyof DashboardPayload['counts'] }> = [
  { id: 'continue', label: 'Continue Reading', icon: 'Play' },
  { id: 'library', label: 'Library', icon: 'Library', countKey: 'books' },
  { id: 'audiobooks', label: 'Audiobooks', icon: 'Headphones', countKey: 'audiobooks' },
  { id: 'highlights', label: 'Highlights', icon: 'Highlight', countKey: 'highlights' },
  { id: 'notes', label: 'Notes', icon: 'Note', countKey: 'notes' },
  { id: 'history', label: 'History', icon: 'Clock', countKey: 'history' },
]

function clampProgress(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(1, n))
}

function safeLocalStorage(): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function normalizeReaderName(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 40)
}

function greetingForHour(date = new Date()): string {
  const hour = date.getHours()
  if (hour >= 5 && hour < 12) return 'morning'
  if (hour >= 12 && hour < 17) return 'afternoon'
  if (hour >= 17 && hour < 21) return 'evening'
  return 'night'
}

function parsePaginationCounts(raw: string | null, expectedChapters: number): number[] | null {
  if (!raw || expectedChapters <= 0) return null
  try {
    const cached = JSON.parse(raw)
    if (!Array.isArray(cached?.counts)) return null
    const counts = cached.counts
      .slice(0, expectedChapters)
      .map((count: unknown) => Math.max(0, Number.parseInt(String(count), 10) || 0))
    return counts.length === expectedChapters ? counts : null
  } catch {
    return null
  }
}

function readStoredPaginationMeta(book: BookState): { total: number | null; current: number | null } {
  const storage = safeLocalStorage()
  if (!storage || !book?.id) return { total: null, current: null }

  const chapterCount = Math.max(1, Number(book.page_count || 0))
  const layoutKey = book.last_position?.layout_key || ''
  let counts = layoutKey.startsWith(PAGINATION_CACHE_PREFIX)
    ? parsePaginationCounts(storage.getItem(layoutKey), chapterCount)
    : null

  if (!counts) {
    try {
      const keys = JSON.parse(storage.getItem(`${PAGINATION_CACHE_PREFIX}index`) || '[]')
      const matchingKey = Array.isArray(keys)
        ? keys.find((key) => (
          typeof key === 'string' &&
          key.startsWith(PAGINATION_CACHE_PREFIX) &&
          key.includes(`:${book.id}:`)
        ))
        : null
      counts = matchingKey ? parsePaginationCounts(storage.getItem(matchingKey), chapterCount) : null
    } catch {
      counts = null
    }
  }

  if (counts?.length) {
    const normalized = counts.map((count) => Math.max(1, count || 1))
    const total = normalized.reduce((sum, count) => sum + count, 0)
    const chapterIdx = Math.max(0, Math.min(normalized.length - 1, Number(book.last_position?.page || 0)))
    const before = normalized.slice(0, chapterIdx).reduce((sum, count) => sum + count, 0)
    const contentPage = Math.max(0, Number(book.last_position?.content_page || 0))
    return { total, current: Math.min(total, before + contentPage + 1) }
  }

  const storedTotal = Number.parseInt(storage.getItem(`${DASHBOARD_PAGE_TOTAL_PREFIX}${book.id}`) || '', 10)
  return Number.isFinite(storedTotal) && storedTotal > 0
    ? { total: storedTotal, current: null }
    : { total: null, current: null }
}

function displayPageCount(book: BookState, pagination = readStoredPaginationMeta(book)): number {
  return Math.max(1, pagination.total || Number(book.visual_page_count || book.page_count || 1))
}

function displayPagesRead(book: BookState): number {
  const pagination = readStoredPaginationMeta(book)
  if (pagination.current) return pagination.current
  return Math.min(displayPageCount(book, pagination), Math.max(0, Number(book.last_position?.page || 0)) + 1)
}

function bookProgress(book: BookState | null | undefined): number {
  if (!book) return 0
  const pagination = readStoredPaginationMeta(book)
  if (pagination.total && pagination.current) return clampProgress((pagination.current - 1) / pagination.total)
  if (book.progress !== undefined) return clampProgress(book.progress)
  if (!book.page_count) return 0
  return clampProgress((book.last_position?.page || 0) / book.page_count)
}

function pageLabel(book: BookState): string {
  const pagination = readStoredPaginationMeta(book)
  const total = displayPageCount(book, pagination)
  const page = pagination.current || Math.min(Math.max(0, book.last_position?.page || 0) + 1, total)
  return `Page ${page} of ${total}`
}

function formatDate(value?: number | null): string {
  if (!value) return 'Not opened yet'
  try {
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(value))
  } catch {
    return 'Not opened yet'
  }
}

function formatMinutes(value: number): string {
  if (value <= 0) return '0 min'
  if (value < 60) return `${Math.round(value)} min`
  const hours = value / 60
  return `${hours.toFixed(hours < 10 ? 1 : 0)} hr`
}

function coverImageStyle(book: BookState): React.CSSProperties | undefined {
  return book.cover_url
    ? { backgroundImage: `url("${apiResourceUrl(book.cover_url)}")` }
    : undefined
}

function BookCover({ book, index = 0, className = '' }: { book: BookState; index?: number; className?: string }) {
  const hasCover = Boolean(book.cover_url)
  return (
    <div
      className={`dash-book-cover ${COVERS[index % COVERS.length]} ${hasCover ? 'has-real-cover' : ''} ${className}`}
      style={coverImageStyle(book)}
    >
      {!hasCover && (
        <>
          <span className="dash-cover-author">{(book.author || 'Unknown').split(' ').pop()?.toUpperCase()}</span>
          <span className="dash-cover-title">{book.title}</span>
        </>
      )}
    </div>
  )
}

function ContinuePanel({ book, onOpen }: { book: BookState | null; onOpen: (book: BookState) => void }) {
  if (!book) {
    return (
      <m.section className="dash-panel dash-continue-empty" layout variants={scaleIn}>
        <div className="dash-empty-mark"><Icons.Book size={22} /></div>
        <h2>No book in progress</h2>
        <p>Add an EPUB or open a library book to make it your next read.</p>
      </m.section>
    )
  }

  const progress = bookProgress(book)
  return (
    <m.section
      className={`dash-panel dash-continue ${book.exists === false ? 'is-missing' : ''}`}
      layout
      variants={scaleIn}
      transition={spring.layout}
    >
      <BookCover book={book} className="dash-continue-cover" />
      <div className="dash-continue-copy">
        <div className="dash-kicker">Continue reading</div>
        <h2>{book.title}</h2>
        <p>{book.author || 'Unknown author'}</p>
        <div className="dash-progress-line">
          <span>{pageLabel(book)}</span>
          <span>{formatDate(book.last_opened_at || book.updated_at)}</span>
        </div>
        <div className="dash-progress-bar"><span style={{ width: `${progress * 100}%` }} /></div>
      </div>
      <div className="dash-continue-actions">
        <button type="button" className="dash-primary-btn" onClick={() => onOpen(book)}>
          <Icons.Play size={14} />
          Resume
        </button>
      </div>
    </m.section>
  )
}

function BookCard({
  book,
  index,
  onOpen,
  onDelete,
}: {
  book: BookState
  index: number
  onOpen: (book: BookState) => void
  onDelete?: (event: React.MouseEvent, book: BookState) => void
}) {
  const progress = bookProgress(book)
  return (
    <m.article
      className={`dash-book-card ${book.exists === false ? 'is-missing' : ''}`}
      layout
      variants={listItem}
      transition={spring.layout}
    >
      <m.button
        type="button"
        className="dash-book-open"
        aria-label={`Open ${book.title} by ${book.author || 'Unknown author'}`}
        onClick={() => onOpen(book)}
        whileHover={buttonHover}
        whileTap={buttonTap}
      >
        <div className="dash-book-cover-wrap">
          <BookCover book={book} index={index} />
        </div>
        <div className="dash-book-meta">
          <h3>{book.title}</h3>
          <p>{book.author || 'Unknown author'}</p>
          <div className="dash-book-facts">
            <span>{progress > 0 ? `${Math.round(progress * 100)}%` : 'New'}</span>
            <span>{displayPageCount(book)} pp</span>
          </div>
          {progress > 0 && <div className="dash-mini-progress"><span style={{ width: `${progress * 100}%` }} /></div>}
          {book.exists === false && <div className="dash-missing">File missing</div>}
        </div>
      </m.button>
      {onDelete && (
        <button
          type="button"
          className="dash-remove-book"
          title="Remove from library"
          aria-label={`Remove ${book.title}`}
          onClick={(event) => onDelete(event, book)}
        >
          <Icons.X size={14} />
        </button>
      )}
    </m.article>
  )
}

function StatCard({ label, value, detail, icon }: { label: string; value: string | number; detail?: string; icon: keyof typeof Icons }) {
  const Icon = Icons[icon]
  return (
    <m.div className="dash-stat" layout variants={listItem}>
      <div className="dash-stat-icon"><Icon size={17} /></div>
      <div>
        <strong>{value}</strong>
        <span>{label}</span>
        {detail && <em>{detail}</em>}
      </div>
    </m.div>
  )
}

function ActivityChart({ stats }: { stats: WeeklyStat[] }) {
  const rows = stats.length ? stats : EMPTY_DASHBOARD.weekly_stats
  const max = Math.max(1, ...rows.map((row) => row.minutes || 0))
  return (
    <div className="dash-chart" aria-label="Weekly reading activity">
      {rows.map((row) => (
        <div className="dash-chart-col" key={row.date}>
          <div className="dash-chart-track">
            <span style={{ height: `${Math.max(3, ((row.minutes || 0) / max) * 100)}%` }} />
          </div>
          <strong>{row.label}</strong>
          <small>{row.minutes ? formatMinutes(row.minutes) : '0'}</small>
        </div>
      ))}
    </div>
  )
}

function HighlightList({ items, emptyTitle, emptyCopy }: { items: DashboardHighlight[]; emptyTitle: string; emptyCopy: string }) {
  if (!items.length) {
    return <EmptyState icon="Highlight" title={emptyTitle} copy={emptyCopy} />
  }
  return (
    <m.div className="dash-highlight-list" variants={listStagger} initial="initial" animate="animate" exit="exit">
      {items.map((item) => (
        <m.article className="dash-highlight" key={item.id} layout variants={listItem}>
          <div className="dash-highlight-icon">
            {item.type === 'note' ? <Icons.Note size={16} /> : item.type === 'bookmark' ? <Icons.Bookmark size={16} /> : <Icons.Highlight size={16} />}
          </div>
          <div>
            <p>{item.text || item.note || `Page ${(item.page || 0) + 1}`}</p>
            {item.note && item.note !== item.text && <blockquote>{item.note}</blockquote>}
            <span>{item.book_title} - page {(item.page || 0) + 1}</span>
          </div>
        </m.article>
      ))}
    </m.div>
  )
}

function NotesPanel({
  books,
  notes,
  onSaved,
}: {
  books: BookState[]
  notes: DashboardHighlight[]
  onSaved: () => void | Promise<void>
}) {
  const [selectedBookId, setSelectedBookId] = useState(books[0]?.id || '')
  const [pageDraft, setPageDraft] = useState('1')
  const [noteDraft, setNoteDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!books.length) {
      setSelectedBookId('')
      return
    }
    if (!books.some((book) => book.id === selectedBookId)) {
      setSelectedBookId(books[0].id)
    }
  }, [books, selectedBookId])

  const selectedBook = books.find((book) => book.id === selectedBookId) || books[0] || null

  const saveNote = useCallback(async (event: React.FormEvent) => {
    event.preventDefault()
    const text = noteDraft.trim()
    if (!selectedBook || !text || saving) return

    const page = Math.max(1, Number.parseInt(pageDraft, 10) || 1)
    setSaving(true)
    setError('')
    try {
      await apiJson('/api/dashboard/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          book_id: selectedBook.id,
          page: page - 1,
          text,
        }),
      })
      setNoteDraft('')
      await onSaved()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not save note.'
      setError(message.length > 180 ? `${message.slice(0, 180)}...` : message)
    } finally {
      setSaving(false)
    }
  }, [noteDraft, onSaved, pageDraft, saving, selectedBook])

  if (!books.length) {
    return <EmptyState icon="Note" title="No books for notes" copy="Import a book before creating local notes." />
  }

  return (
    <m.div className="dash-notes-layout" layout variants={listStagger} initial="initial" animate="animate" exit="exit">
      <m.section className="dash-panel dash-note-composer" layout variants={listItem}>
        <div className="dash-section-head compact">
          <div>
            <h2>Notes</h2>
            <p>Save local note records against your library metadata.</p>
          </div>
        </div>
        <form onSubmit={saveNote}>
          <label>
            <span>Book</span>
            <select value={selectedBookId} onChange={(event) => setSelectedBookId(event.target.value)}>
              {books.map((book) => (
                <option key={book.id} value={book.id}>{book.title}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Page</span>
            <input
              value={pageDraft}
              inputMode="numeric"
              onChange={(event) => setPageDraft(event.target.value.replace(/[^\d]/g, '').slice(0, 5))}
              onBlur={() => setPageDraft(String(Math.max(1, Number.parseInt(pageDraft, 10) || 1)))}
            />
          </label>
          <label className="dash-note-field">
            <span>Note</span>
            <textarea
              value={noteDraft}
              onChange={(event) => setNoteDraft(event.target.value)}
              rows={5}
              maxLength={1000}
              placeholder="Capture a note"
            />
          </label>
          <button type="submit" className="dash-primary-btn" disabled={saving || !noteDraft.trim()}>
            <Icons.Note size={15} />
            {saving ? 'Saving' : 'Save note'}
          </button>
          {error && <p className="dash-form-error">{error}</p>}
        </form>
      </m.section>

      <m.section className="dash-section" layout variants={listItem}>
        <div className="dash-section-head">
          <div>
            <h2>Saved notes</h2>
            <p>{notes.length} {notes.length === 1 ? 'note' : 'notes'} in the local dashboard store.</p>
          </div>
        </div>
        <HighlightList items={notes} emptyTitle="No notes yet" emptyCopy="Saved notes will appear here." />
      </m.section>
    </m.div>
  )
}

function EmptyState({ icon, title, copy }: { icon: keyof typeof Icons; title: string; copy: string }) {
  const Icon = Icons[icon]
  return (
    <m.div className="dash-empty" layout variants={scaleIn} initial="initial" animate="animate" exit="exit">
      <div className="dash-empty-mark"><Icon size={22} /></div>
      <h2>{title}</h2>
      <p>{copy}</p>
    </m.div>
  )
}

function EmptyLibraryWelcome({
  greetingTitle,
  readerName,
  readerNameDraft,
  showNameForm,
  importing,
  onReaderNameDraftChange,
  onSaveReaderName,
  onEditReaderName,
  onAddBook,
}: {
  greetingTitle: string
  readerName: string
  readerNameDraft: string
  showNameForm: boolean
  importing: boolean
  onReaderNameDraftChange: (value: string) => void
  onSaveReaderName: (event: React.FormEvent<HTMLFormElement>) => void
  onEditReaderName: () => void
  onAddBook: () => void
}) {
  return (
    <>
      <m.section className="dash-empty-welcome" layout variants={slideUp}>
        <div className="dash-empty-welcome-copy">
          <h1>{greetingTitle}</h1>
          <p>Start with one EPUB. Folio will keep the shelf local, remember your place, and stay out of the way.</p>

          {showNameForm ? (
            <form className="dash-name-form" onSubmit={onSaveReaderName}>
              <label htmlFor="reader-name">What should Folio call you?</label>
              <div>
                <Icons.User size={16} />
                <input
                  id="reader-name"
                  value={readerNameDraft}
                  maxLength={40}
                  placeholder="Reader name"
                  onChange={(event) => onReaderNameDraftChange(event.target.value)}
                />
                <button type="submit" disabled={!normalizeReaderName(readerNameDraft)}>
                  Save
                </button>
              </div>
            </form>
          ) : (
            <div className="dash-reader-chip">
              <Icons.User size={15} />
              <span>Reading as {readerName}</span>
              <button type="button" onClick={onEditReaderName}>Change</button>
            </div>
          )}

          <div className="dash-empty-actions">
            <button type="button" className="dash-primary-btn" onClick={onAddBook}>
              <Icons.Upload size={15} />
              {importing ? 'Opening book' : 'Choose first EPUB'}
            </button>
            <span>or drop an EPUB anywhere on this window</span>
          </div>
        </div>

        <div className="dash-empty-scene" aria-hidden="true">
          <div className="dash-empty-scene-glow" />
          <div className="dash-empty-bookmark"><Icons.Bookmark size={30} /></div>
          <div className="dash-empty-shelf">
            {EMPTY_SHELF_SPINES.map((spine, index) => (
              <span key={`${spine}-${index}`} className={spine} />
            ))}
          </div>
          <div className="dash-empty-shelf-line" />
        </div>
      </m.section>

      <section className="dash-empty-rhythm" aria-label="First shelf state">
        <div>
          <Icons.Library size={18} />
          <strong>No shelf noise</strong>
          <span>Your dashboard starts clean until a book exists.</span>
        </div>
        <div>
          <Icons.Book size={18} />
          <strong>One book is enough</strong>
          <span>The first import becomes your continue-reading view.</span>
        </div>
        <div>
          <Icons.Headphones size={18} />
          <strong>Narration waits</strong>
          <span>Voice models stay optional until you press play.</span>
        </div>
      </section>
    </>
  )
}

function MetadataAssignment({
  kind,
  books,
  onSaved,
}: {
  kind: MetadataKind
  books: BookState[]
  onSaved: () => void | Promise<void>
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [savingId, setSavingId] = useState<string | null>(null)
  const label = 'genre'

  const saveTag = useCallback(async (book: BookState) => {
    const value = (drafts[book.id] || '').trim()
    if (!value || savingId) return
    const existing = Array.isArray(book[kind]) ? book[kind] || [] : []
    const next = Array.from(new Set([...existing, value]))
    setSavingId(book.id)
    try {
      await apiFetch(`/api/book/${book.id}/metadata`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [kind]: next }),
      })
      setDrafts((prev) => ({ ...prev, [book.id]: '' }))
      await onSaved()
    } finally {
      setSavingId(null)
    }
  }, [drafts, kind, onSaved, savingId])

  if (!books.length) return null

  return (
    <m.section className="dash-panel dash-metadata-editor" layout variants={slideUp}>
      <div className="dash-section-head">
        <div>
          <h2>Add genres</h2>
          <p>Metadata stays local and is used by dashboard filters and search.</p>
        </div>
      </div>
      <div className="dash-metadata-rows">
        {books.map((book) => {
          const tags = book[kind] || []
          return (
            <m.div className="dash-metadata-row" key={book.id} layout variants={listItem}>
              <div>
                <strong>{book.title}</strong>
                <span>{tags.length ? tags.join(', ') : `No ${label}s`}</span>
              </div>
              <form onSubmit={(event) => { event.preventDefault(); void saveTag(book) }}>
                <input
                  value={drafts[book.id] || ''}
                  onChange={(event) => setDrafts((prev) => ({ ...prev, [book.id]: event.target.value }))}
                  placeholder={`Add ${label}`}
                />
                <button type="submit" disabled={savingId === book.id || !(drafts[book.id] || '').trim()}>
                  {savingId === book.id ? 'Saving' : 'Save'}
                </button>
              </form>
            </m.div>
          )
        })}
      </div>
    </m.section>
  )
}

function BookGrid({
  books,
  onOpen,
  onDelete,
  emptyTitle,
  emptyCopy,
}: {
  books: BookState[]
  onOpen: (book: BookState) => void
  onDelete?: (event: React.MouseEvent, book: BookState) => void
  emptyTitle: string
  emptyCopy: string
}) {
  if (!books.length) {
    return <EmptyState icon="Library" title={emptyTitle} copy={emptyCopy} />
  }
  return (
    <m.div className="dash-book-grid" layout variants={listStagger} initial="initial" animate="animate" exit="exit">
      <AnimatePresence mode="popLayout" initial={false}>
        {books.map((book, index) => (
          <BookCard key={book.id} book={book} index={index} onOpen={onOpen} onDelete={onDelete} />
        ))}
      </AnimatePresence>
    </m.div>
  )
}

export default memo(function Welcome({
  theme = 'sepia',
  setTheme,
  motion = true,
  setMotion,
  onUpload,
  recentBooks,
  onOpenRecent,
  onDeleteRecent,
  statusBadges,
  settingsPanelProps,
}: WelcomeProps) {
  const [dashboard, setDashboard] = useState<DashboardPayload>(EMPTY_DASHBOARD)
  const [view, setView] = useState<DashboardView>('home')
  const [query, setQuery] = useState('')
  const [searchBooks, setSearchBooks] = useState<BookState[] | null>(null)
  const [libraryFilter, setLibraryFilter] = useState<LibraryFilter>({ author: '', genre: '' })
  const [drag, setDrag] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState('')
  const [goalDraft, setGoalDraft] = useState('60')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [readerName, setReaderName] = useState(() => normalizeReaderName(safeLocalStorage()?.getItem(READER_NAME_KEY) || ''))
  const [readerNameDraft, setReaderNameDraft] = useState(readerName)
  const [readerNameEditing, setReaderNameEditing] = useState(false)
  const fileRef = useRef<HTMLInputElement | null>(null)

  const refreshDashboard = useCallback(async () => {
    try {
      const data = await apiJson<DashboardPayload>('/api/dashboard')
      setDashboard(data)
      setGoalDraft(String(data.reading_goal?.daily_goal_minutes || 60))
    } catch {
      setDashboard((prev) => ({
        ...prev,
        books: recentBooks || [],
        recent_books: recentBooks || [],
        recently_added: recentBooks || [],
        continue_book: recentBooks?.[0] || null,
        counts: { ...prev.counts, books: recentBooks?.length || 0 },
      }))
    }
  }, [recentBooks])

  useEffect(() => {
    void refreshDashboard()
  }, [refreshDashboard])

  useEffect(() => {
    const trimmed = query.trim()
    if (!trimmed) {
      setSearchBooks(null)
      return
    }
    const timeout = window.setTimeout(() => {
      apiJson<LibrarySearchResponse>(`/api/library/search?q=${encodeURIComponent(trimmed)}`)
        .then((data) => setSearchBooks(data.books || []))
        .catch(() => {
          const normalized = trimmed.toLowerCase()
          setSearchBooks((dashboard.books || []).filter((book) => [
            book.title,
            book.author,
            ...(book.genres || []),
            ...(book.collections || []),
          ].join(' ').toLowerCase().includes(normalized)))
        })
    }, 160)
    return () => window.clearTimeout(timeout)
  }, [dashboard.books, query])

  const allBooks = useMemo(() => (
    dashboard.books?.length ? dashboard.books : (recentBooks || [])
  ), [dashboard.books, recentBooks])

  const visibleBooks = useMemo(() => {
    const books = searchBooks ?? allBooks
    return books.filter((book) => {
      const authorMatches = !libraryFilter.author || (book.author || 'Unknown author') === libraryFilter.author
      const genreMatches = !libraryFilter.genre || (book.genres || []).includes(libraryFilter.genre)
      return authorMatches && genreMatches
    })
  }, [allBooks, libraryFilter.author, libraryFilter.genre, searchBooks])

  const libraryFilterOptions = useMemo(() => {
    const authors = Array.from(new Set(
      allBooks.map((book) => book.author || 'Unknown author')
    )).sort((a, b) => a.localeCompare(b))
    const genres = Array.from(new Set(
      allBooks.flatMap((book) => book.genres || [])
    )).sort((a, b) => a.localeCompare(b))
    return { authors, genres }
  }, [allBooks])

  const hasLibraryFilter = Boolean(libraryFilter.author || libraryFilter.genre)

  const displayPagesTotal = useMemo(() => (
    allBooks.reduce((sum, book) => sum + displayPageCount(book), 0)
  ), [allBooks])

  const displayPagesReadTotal = useMemo(() => (
    allBooks.reduce((sum, book) => sum + (book.has_reading_progress || bookProgress(book) > 0 ? displayPagesRead(book) : 0), 0)
  ), [allBooks])

  const continueBook = useMemo(() => {
    if (searchBooks) return searchBooks.find((book) => book.id === dashboard.continue_book?.id) || searchBooks[0] || null
    return dashboard.continue_book || allBooks[0] || null
  }, [allBooks, dashboard.continue_book, searchBooks])

  const handleOpen = useCallback((book: BookState) => {
    if (book.exists === false) {
      window.alert(`File not found:\n${book.filepath}\n\nRemove it from history or re-import the EPUB.`)
      return
    }
    onOpenRecent(book.filepath)
  }, [onOpenRecent])

  const handleDelete = useCallback(async (event: React.MouseEvent, book: BookState) => {
    event.stopPropagation()
    const message = book.exists !== false
      ? `Remove "${book.title}" from history and delete the EPUB?`
      : `Remove "${book.title}" from history?`
    if (!window.confirm(message)) return
    await onDeleteRecent?.(book.id, book.exists !== false)
    await refreshDashboard()
  }, [onDeleteRecent, refreshDashboard])

  const importFile = useCallback(async (file?: File) => {
    if (!file || importing) return
    if (!/\.epub$/i.test(file.name)) {
      setImportError('Choose an EPUB file.')
      return
    }
    setImporting(true)
    setImportError('')
    try {
      await onUpload(file)
      await refreshDashboard()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not open that book. The backend may still be starting.'
      setImportError(message.length > 260 ? `${message.slice(0, 260)}...` : message)
    } finally {
      setImporting(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }, [importing, onUpload, refreshDashboard])

  const handleDrop = useCallback((event: React.DragEvent<HTMLElement>) => {
    event.preventDefault()
    setDrag(false)
    void importFile(event.dataTransfer.files[0])
  }, [importFile])

  const handleDragOver = useCallback((event: React.DragEvent<HTMLElement>) => {
    if (Array.from(event.dataTransfer.types || []).includes('Files')) {
      event.preventDefault()
      setDrag(true)
    }
  }, [])

  const handleDragLeave = useCallback((event: React.DragEvent<HTMLElement>) => {
    const nextTarget = event.relatedTarget as Node | null
    if (!nextTarget || !event.currentTarget.contains(nextTarget)) setDrag(false)
  }, [])

  const handleFileSelect = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    void importFile(event.target.files?.[0])
  }, [importFile])

  const saveReaderName = useCallback((event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const next = normalizeReaderName(readerNameDraft)
    if (!next) return
    safeLocalStorage()?.setItem(READER_NAME_KEY, next)
    setReaderName(next)
    setReaderNameDraft(next)
    setReaderNameEditing(false)
  }, [readerNameDraft])

  const editReaderName = useCallback(() => {
    setReaderNameDraft(readerName)
    setReaderNameEditing(true)
  }, [readerName])

  const handleDashboardMouseDown = useCallback(async (event: React.MouseEvent<HTMLElement>) => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement | null
    if (target?.closest('button, input, textarea, select, a')) return

    const rect = event.currentTarget.getBoundingClientRect()
    if (event.clientY - rect.top > 36) return

    try {
      const win = await currentWindow()
      if (event.detail === 2) {
        await win.toggleMaximize()
      } else {
        await win.startDragging()
      }
    } catch {
      // Browser preview and some OS gestures can reject drag starts.
    }
  }, [])

  const openSettings = useCallback(() => {
    setSettingsOpen(true)
  }, [])

  const closeSettings = useCallback(() => {
    setSettingsOpen(false)
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') {
        event.preventDefault()
        if (!importing) fileRef.current?.click()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [importing])

  const commitGoal = useCallback(async () => {
    const minutes = Math.max(1, Math.min(1440, Number.parseInt(goalDraft, 10) || 60))
    setGoalDraft(String(minutes))
    try {
      await apiFetch('/api/dashboard/goal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ daily_goal_minutes: minutes }),
      })
      await refreshDashboard()
    } catch {
      setGoalDraft(String(dashboard.reading_goal.daily_goal_minutes || 60))
    }
  }, [dashboard.reading_goal.daily_goal_minutes, goalDraft, refreshDashboard])

  const historyBooks = useMemo(() => (
    [...visibleBooks].sort((a, b) => Number(b.last_opened_at || b.updated_at || 0) - Number(a.last_opened_at || a.updated_at || 0))
  ), [visibleBooks])

  const libraryTitle = query.trim() ? `Search results for "${query.trim()}"` : hasLibraryFilter ? 'Filtered library' : 'Library'
  const backendVersion = dashboard.backend?.version ? `Folio ${dashboard.backend.version}` : 'Folio'
  const greetingPeriod = useMemo(() => greetingForHour(), [])
  const greetingTitle = readerName ? `Good ${greetingPeriod}, ${readerName}.` : `Good ${greetingPeriod}.`
  const showNameForm = !readerName || readerNameEditing
  const renderHome = () => {
    if (!allBooks.length && !query.trim()) {
      return (
        <EmptyLibraryWelcome
          greetingTitle={greetingTitle}
          readerName={readerName}
          readerNameDraft={readerNameDraft}
          showNameForm={showNameForm}
          importing={importing}
          onReaderNameDraftChange={setReaderNameDraft}
          onSaveReaderName={saveReaderName}
          onEditReaderName={editReaderName}
          onAddBook={() => fileRef.current?.click()}
        />
      )
    }

    return (
      <>
        <section className="dash-hero">
          <div>
            <h1>{greetingTitle}</h1>
            <p>Pick up a book, review your notes, or add another EPUB to the shelf.</p>
          </div>
        </section>

      <div className="dash-home-grid">
        <ContinuePanel book={continueBook} onOpen={handleOpen} />
        <section className="dash-panel dash-stats-panel">
          <div className="dash-section-head">
            <div>
              <h2>Library summary</h2>
              <p>Real counts from your local EPUB state.</p>
            </div>
          </div>
          <div className="dash-stat-grid">
            <StatCard icon="Library" label="Books" value={dashboard.counts.books} detail={`${displayPagesTotal} pages`} />
            <StatCard icon="Users" label="Authors" value={dashboard.counts.authors} />
            <StatCard icon="Bookmark" label="Pages read" value={displayPagesReadTotal} />
            <StatCard icon="Highlight" label="Highlights" value={dashboard.counts.highlights} />
          </div>
        </section>
      </div>

      <section className="dash-section">
        <div className="dash-section-head">
          <div>
            <h2>Recently added</h2>
            <p>Sorted by import time when available.</p>
          </div>
          <button type="button" onClick={() => setView('library')}>View all</button>
        </div>
        <BookGrid books={(dashboard.recently_added?.length ? dashboard.recently_added : allBooks).slice(0, 6)} onOpen={handleOpen} onDelete={handleDelete} emptyTitle="Your shelf is empty" emptyCopy="Import an EPUB and it will appear here." />
      </section>

      <div className="dash-home-grid lower">
        <section className="dash-panel">
          <div className="dash-section-head">
            <div>
              <h2>Weekly reading</h2>
              <p>{formatMinutes(dashboard.reading_goal.today_minutes)} today of {dashboard.reading_goal.daily_goal_minutes} min.</p>
            </div>
          </div>
          <ActivityChart stats={dashboard.weekly_stats} />
        </section>
        <section className="dash-panel">
          <div className="dash-section-head">
            <div>
              <h2>Recent highlights</h2>
              <p>Bookmarks and saved notes from your books.</p>
            </div>
          </div>
          <HighlightList items={dashboard.highlights.slice(0, 4)} emptyTitle="No highlights yet" emptyCopy="Bookmarks and future note highlights will show up here." />
        </section>
      </div>
      </>
    )
  }

  const renderView = () => {
    if (view === 'home') return renderHome()
    if (view === 'continue') {
      const inProgress = visibleBooks.filter((book) => book.has_reading_progress || bookProgress(book) > 0)
      return (
        <>
          <ContinuePanel book={continueBook} onOpen={handleOpen} />
          <section className="dash-section">
            <div className="dash-section-head"><div><h2>Reading queue</h2><p>Books with saved progress.</p></div></div>
            <BookGrid books={inProgress} onOpen={handleOpen} onDelete={handleDelete} emptyTitle="No saved progress yet" emptyCopy="Open a book and Folio will remember where you stop." />
          </section>
        </>
      )
    }
    if (view === 'library') {
      return (
        <>
          <section className="dash-section">
            <div className="dash-section-head">
              <div>
                <h2>{libraryTitle}</h2>
                <p>{visibleBooks.length} {visibleBooks.length === 1 ? 'book' : 'books'} visible.</p>
              </div>
            </div>
            <div className="dash-library-filters" aria-label="Library filters">
              <label>
                <Icons.Users size={15} />
                <span>Author</span>
                <select
                  value={libraryFilter.author}
                  onChange={(event) => setLibraryFilter((prev) => ({ ...prev, author: event.target.value }))}
                >
                  <option value="">All authors</option>
                  {libraryFilterOptions.authors.map((author) => (
                    <option key={author} value={author}>{author}</option>
                  ))}
                </select>
              </label>
              <label>
                <Icons.Tag size={15} />
                <span>Genre</span>
                <select
                  value={libraryFilter.genre}
                  onChange={(event) => setLibraryFilter((prev) => ({ ...prev, genre: event.target.value }))}
                >
                  <option value="">All genres</option>
                  {libraryFilterOptions.genres.map((genre) => (
                    <option key={genre} value={genre}>{genre}</option>
                  ))}
                </select>
              </label>
              {hasLibraryFilter && (
                <button type="button" onClick={() => setLibraryFilter({ author: '', genre: '' })}>
                  <Icons.X size={14} />
                  Clear
                </button>
              )}
            </div>
            <BookGrid books={visibleBooks} onOpen={handleOpen} onDelete={handleDelete} emptyTitle="No books found" emptyCopy="Adjust the search or filters, or import another EPUB." />
          </section>
          <MetadataAssignment kind="genres" books={allBooks} onSaved={refreshDashboard} />
        </>
      )
    }
    if (view === 'audiobooks') {
      return <EmptyState icon="Headphones" title="No generated audiobooks yet" copy="Folio streams generated audio while reading; a saved audiobook library is not present yet." />
    }
    if (view === 'highlights') {
      return <HighlightList items={dashboard.highlights} emptyTitle="No highlights yet" emptyCopy="Bookmarks are shown here today; saved text highlights can be added later." />
    }
    if (view === 'notes') {
      return <NotesPanel books={allBooks} notes={dashboard.notes} onSaved={refreshDashboard} />
    }
    return (
      <section className="dash-section">
        <div className="dash-section-head"><div><h2>History</h2><p>Sorted by the last time each book was opened.</p></div></div>
        <BookGrid books={historyBooks} onOpen={handleOpen} onDelete={handleDelete} emptyTitle="No history yet" emptyCopy="Open a book to create reading history." />
      </section>
    )
  }

  return (
    <m.div
      className={`dashboard-home ${motion ? 'motion-enabled' : 'motion-reduced'} ${drag ? 'is-dragging' : ''}`}
      onMouseDown={handleDashboardMouseDown}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      layout
      transition={spring.layout}
    >
      <input ref={fileRef} type="file" accept=".epub" onChange={handleFileSelect} style={{ display: 'none' }} />

      <m.aside className="dash-sidebar" layout transition={spring.layout}>
        <m.button type="button" className="dash-brand" onClick={() => setView('home')} aria-label="Folio dashboard" whileTap={buttonTap}>
          <img src={theme === 'light' || theme === 'sepia' ? '/folio-icon.png' : '/folio-monochrome-icon.png'} alt="" draggable={false} />
          <span>Folio</span>
        </m.button>

        <m.button type="button" className="dash-add-btn" onClick={() => fileRef.current?.click()} whileHover={buttonHover} whileTap={buttonTap}>
          <Icons.Upload size={16} />
          {importing ? 'Opening book' : 'Add books'}
          <kbd>{OPEN_SHORTCUT}</kbd>
        </m.button>
        <AnimatePresence>
          {importError && <m.div className="dash-import-error" variants={slideUp} initial="initial" animate="animate" exit="exit">{importError}</m.div>}
        </AnimatePresence>

        <nav className="dash-nav" aria-label="Dashboard">
          {NAV_ITEMS.map((item) => {
            const Icon = Icons[item.icon]
            const count = item.countKey ? dashboard.counts[item.countKey] : undefined
            return (
              <m.button
                key={item.id}
                type="button"
                className={view === item.id ? 'active' : ''}
                onClick={() => setView(item.id)}
                layout
                whileHover={buttonHover}
                whileTap={buttonTap}
                transition={spring.quick}
              >
                {view === item.id && (
                  <m.span
                    className="dash-nav-active-bg"
                    layoutId="dashboard-nav-active"
                    transition={spring.layout}
                    aria-hidden="true"
                  />
                )}
                <Icon size={17} />
                <span>{item.label}</span>
                {count !== undefined && <em>{count}</em>}
              </m.button>
            )
          })}
        </nav>

        <m.section className="dash-goal" layout>
          <div className="dash-goal-head">
            <span>Reading goal</span>
            <strong>{Math.round(clampProgress(dashboard.reading_goal.progress) * 100)}%</strong>
          </div>
          <div className="dash-progress-bar"><span style={{ width: `${clampProgress(dashboard.reading_goal.progress) * 100}%` }} /></div>
          <div className="dash-goal-edit">
            <input
              aria-label="Daily reading goal minutes"
              value={goalDraft}
              inputMode="numeric"
              onChange={(event) => setGoalDraft(event.target.value.replace(/[^\d]/g, '').slice(0, 4))}
              onBlur={() => void commitGoal()}
              onKeyDown={(event) => { if (event.key === 'Enter') void commitGoal() }}
            />
            <span>min/day</span>
          </div>
        </m.section>

        <footer className="dash-sidebar-footer">
          <span>{backendVersion}</span>
          {statusBadges && <div className="dash-status-badges">{statusBadges}</div>}
        </footer>
      </m.aside>

      <m.main className="dash-main" layout transition={spring.layout}>
        <header className="dash-topbar">
          <div className="dash-search">
            <Icons.Search size={17} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search library metadata"
              aria-label="Search title, author, genre, collection"
            />
            <AnimatePresence>
              {query && (
                <m.button type="button" onClick={() => setQuery('')} aria-label="Clear search" variants={scaleIn} initial="initial" animate="animate" exit="exit" whileTap={buttonTap}>
                  <Icons.X size={14} />
                </m.button>
              )}
            </AnimatePresence>
          </div>
          <div className="dash-toolbar">
            <m.button type="button" onClick={openSettings} title="Settings" aria-label="Open settings" whileHover={buttonHover} whileTap={buttonTap}>
              <Icons.Settings size={16} />
            </m.button>
          </div>
        </header>

        <div className="dash-content">
          <AnimatePresence mode="wait" initial={false}>
            <m.div
              className="dash-view-body"
              key={view}
              variants={pageTransition}
              initial="initial"
              animate="animate"
              exit="exit"
              layout
              transition={spring.layout}
            >
              {renderView()}
            </m.div>
          </AnimatePresence>
        </div>
      </m.main>

      {typeof document !== 'undefined' && createPortal(
        <AnimatePresence>
          {settingsOpen && (
            <SettingsPanel
              key="dashboard-settings"
              theme={theme}
              setTheme={setTheme}
              motion={motion}
              setMotion={setMotion}
              {...settingsPanelProps}
              onLibraryFolderChanged={refreshDashboard}
              onClose={closeSettings}
            />
          )}
        </AnimatePresence>,
        document.body,
      )}
    </m.div>
  )
})
