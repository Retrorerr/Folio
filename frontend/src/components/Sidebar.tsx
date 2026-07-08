import { useState, useEffect, useRef, memo, useCallback } from 'react'
import type React from 'react'
import { createPortal, flushSync } from 'react-dom'
import { AnimatePresence, motion as m } from 'motion/react'
import { Icons } from './icons'
import { apiFetch, apiJson, selectLibraryFolder } from '../api'
import { buttonHover, buttonTap, listItem, listStagger, modalPanel, overlayFade, panelReveal, scaleIn, slideUp, spring } from '../motion'
import {
  engineDisplayName,
  ttsEngines,
  voicesForEngine,
  normalizeTtsEngine,
  normalizeVoiceForEngine,
} from '../ttsVoices'
import type { LibraryFolderStatus, LibraryScanResult } from '../types'

function themeTransitionColors(theme: string) {
  if (theme === 'dark') {
    return { paper: 'rgb(17, 20, 23)', wash: 'rgba(17, 20, 23, 0.88)', accent: 'rgba(126, 210, 194, 0.28)' }
  }
  if (theme === 'folio') {
    return { paper: 'rgb(8, 9, 11)', wash: 'rgba(8, 9, 11, 0.9)', accent: 'rgba(214, 101, 43, 0.28)' }
  }
  if (theme === 'sepia') {
    return { paper: 'rgb(243, 231, 207)', wash: 'rgba(243, 231, 207, 0.9)', accent: 'rgba(201, 91, 43, 0.22)' }
  }
  return { paper: 'rgb(247, 244, 237)', wash: 'rgba(247, 244, 237, 0.9)', accent: 'rgba(196, 91, 43, 0.18)' }
}

function themeTransitionPoint(event: React.MouseEvent) {
  return { x: event.clientX, y: event.clientY }
}

function setThemeTransitionVars(event: React.MouseEvent, theme: string) {
  const { x, y } = themeTransitionPoint(event)
  const colors = themeTransitionColors(theme)
  document.documentElement.style.setProperty('--theme-transition-x', `${x}px`)
  document.documentElement.style.setProperty('--theme-transition-y', `${y}px`)
  document.documentElement.style.setProperty('--theme-transition-paper', colors.paper)
  document.documentElement.style.setProperty('--theme-transition-wash', colors.wash)
  document.documentElement.style.setProperty('--theme-transition-accent', colors.accent)
}

function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

function spawnThemeRipple(event: React.MouseEvent, theme: string) {
  if (typeof document === 'undefined') return
  if (prefersReducedMotion()) return
  const { x, y } = themeTransitionPoint(event)
  const colors = themeTransitionColors(theme)
  const node = document.createElement('div')
  node.className = 'theme-ripple'
  node.style.setProperty('--rx', `${x}px`)
  node.style.setProperty('--ry', `${y}px`)
  node.style.setProperty('--ripple-color', colors.wash)
  node.style.setProperty('--ripple-accent', colors.accent)
  document.body.appendChild(node)
  setTimeout(() => node.remove(), 900)
}

function runThemeTransition(event: React.MouseEvent, nextTheme: string, currentTheme: string, setTheme: (theme: string) => void) {
  if (nextTheme === currentTheme) return
  if (typeof document === 'undefined' || prefersReducedMotion()) {
    setTheme(nextTheme)
    return
  }

  setThemeTransitionVars(event, nextTheme)
  document.documentElement.classList.remove('theme-transitioning')
  spawnThemeRipple(event, nextTheme)
  requestAnimationFrame(() => {
    flushSync(() => setTheme(nextTheme))
  })
}

function folderLabel(path: string): string {
  if (!path) return 'No folder selected'
  const normalized = path.replace(/[\\/]+$/, '')
  const parts = normalized.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || normalized
}

function scanSummary(result?: LibraryScanResult | null): string {
  if (!result) return 'No scan yet'
  const imported = result.imported === 1 ? '1 new book' : `${result.imported} new books`
  const scanned = result.scanned === 1 ? '1 EPUB scanned' : `${result.scanned} EPUBs scanned`
  const failed = result.failed ? `, ${result.failed} failed` : ''
  return `${imported} from ${scanned}${failed}`
}

function isMethodNotAllowed(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '')
  return message.toLowerCase().includes('method not allowed') || message.includes('405')
}

export default memo(function Sidebar({
  book, reflow, currentPage, currentSentence, goToPage,
  addBookmark, removeBookmark,
  voice, setVoice,
  ttsEngine, setTtsEngine,
  modelStatus,
  installPromptEngine,
  clearInstallPrompt,
  theme, setTheme,
  motion, setMotion,
  wheelPaging, setWheelPaging,
  tab, setTab,
  onNavigateSearchResult,
  onHome,
  hidden = false,
}: any) {
  const [renderedTab, setRenderedTab] = useState(tab)
  const panelTab = renderedTab === 'settings' ? null : renderedTab
  const panelOpen = Boolean(tab && tab !== 'settings')
  const settingsOpen = tab === 'settings'
  const useGoldLogo = theme === 'light' || theme === 'sepia'
  const logoSrc = useGoldLogo ? '/folio-icon.png' : '/folio-monochrome-icon.png'

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    if (tab) {
      timer = setTimeout(() => setRenderedTab(tab), 0)
    } else {
      timer = setTimeout(() => setRenderedTab(null), 340)
    }
    return () => clearTimeout(timer)
  }, [tab])

  const railBtn = (key: string, Ico: any, label: string) => (
    <m.button
      key={key}
      className={`rail-btn ${tab === key ? 'active' : ''}`}
      onClick={() => setTab(tab === key ? null : key)}
      title={label}
      aria-label={label}
      layout
      whileHover={buttonHover}
      whileTap={buttonTap}
      transition={spring.quick}
    >
      {tab === key && <m.span className="rail-active-bg" layoutId="reader-rail-active" transition={spring.layout} aria-hidden="true" />}
      <Ico size={18} />
    </m.button>
  )

  // Close the expanded panel when the user clicks/taps anywhere outside the
  // sidebar (panel + icon rail). Toggling via a rail button still works
  // because rail clicks are inside the sidebar root.
  const railRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!tab || tab === 'settings') return
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (railRef.current?.contains(t)) return
      if (panelRef.current?.contains(t)) return
      setTab(null)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [tab, setTab])

  return (
    <>
      <m.div className={`sidebar-wrap ${hidden ? 'is-hidden' : ''} ${panelOpen ? 'is-open' : ''} ${panelTab && !panelOpen ? 'is-closing' : ''}`} layout transition={spring.layout}>
      <m.div className="icon-rail" ref={railRef} layout>
        <m.button className="rail-brand" onClick={onHome} title="Library" aria-label="Library" whileHover={buttonHover} whileTap={buttonTap}>
          <img className="rail-brand-logo" src={logoSrc} alt="" draggable={false} />
        </m.button>
        {railBtn('chapters', Icons.Chapters, 'Chapters')}
        {railBtn('bookmarks', Icons.Bookmark, 'Bookmarks')}
        {railBtn('search', Icons.Search, 'Search')}
        <div className="rail-spacer" />
        {railBtn('settings', Icons.Settings, 'Settings')}
      </m.div>

      <AnimatePresence initial={false} mode="wait">
        {panelTab && (
          <m.div
            key={panelTab}
            className={`sidebar-panel ${panelOpen ? 'is-open' : 'is-closing'}`}
            ref={panelRef}
            aria-hidden={!panelOpen}
            variants={panelReveal}
            initial="initial"
            animate={panelOpen ? 'animate' : 'exit'}
            exit="exit"
            layout
            transition={spring.layout}
          >
            {panelTab === 'chapters' && <ChapterPanel book={book} reflow={reflow} currentPage={currentPage} goToPage={goToPage} />}
            {panelTab === 'bookmarks' && (
              <BookmarkPanel
                book={book}
                currentPage={currentPage}
                currentSentence={currentSentence}
                goToPage={goToPage}
                addBookmark={addBookmark}
                removeBookmark={removeBookmark}
              />
            )}
            {panelTab === 'search' && (
              <SearchPanel
                book={book}
                currentPage={currentPage}
                onNavigateSearchResult={onNavigateSearchResult}
              />
            )}
          </m.div>
        )}
      </AnimatePresence>
      </m.div>
      {typeof document !== 'undefined' && createPortal(
        <AnimatePresence>
          {settingsOpen && (
            <SettingsPanel
              key="reader-settings"
              theme={theme}
              setTheme={setTheme}
              motion={motion} setMotion={setMotion}
              wheelPaging={wheelPaging} setWheelPaging={setWheelPaging}
              voice={voice} setVoice={setVoice}
              ttsEngine={ttsEngine} setTtsEngine={setTtsEngine}
              modelStatus={modelStatus}
              installPromptEngine={installPromptEngine}
              clearInstallPrompt={clearInstallPrompt}
              onClose={() => setTab(null)}
            />
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  )
})

function ChapterPanel({ book, reflow, currentPage, goToPage }: any) {
  if (!book) return null
  const reflowChapters = reflow?.chapters || []
  const useReflow = reflowChapters.length > 0
  const toc = useReflow
    ? reflowChapters.map((c, i) => ({
        title: c.number ? `${c.number} - ${c.title}` : (c.title || `Chapter ${i + 1}`),
        page: i,
      }))
    : (book.toc || [])
  return (
    <>
      <div className="panel-head">
        <div className="pre">CONTENTS</div>
        <h2>{book.title}</h2>
        {book.author && <div className="sub">by {book.author}</div>}
      </div>
      <div className="panel-body">
        {toc.length === 0 ? (
          <div style={{ padding: 24, color: 'var(--ink-3)', fontStyle: 'italic', fontSize: 13.5, textAlign: 'center' }}>
            No table of contents found in this EPUB.
          </div>
        ) : (
          <m.div className="chapter-list" variants={listStagger} initial="initial" animate="animate" exit="exit">
            {toc.map((c, i) => {
              const next = toc[i + 1]
              const isActive = useReflow
                ? currentPage === c.page
                : (currentPage >= c.page && (!next || currentPage < next.page))
              return (
                <m.div
                  key={i}
                  className={`chapter-item ${isActive ? 'active' : ''}`}
                  onClick={() => goToPage(c.page)}
                  layout
                  variants={listItem}
                >
                  {isActive && <m.div className="playing-indicator" layoutId="chapter-active-indicator" />}
                  <div className="ch-num">{String(i + 1).padStart(2, '0')}</div>
                  <div className="ch-title">{c.title}</div>
                  <div className="ch-dur">p.{c.page + 1}</div>
                </m.div>
              )
            })}
          </m.div>
        )}
      </div>
    </>
  )
}

function BookmarkPanel({ book, currentPage, currentSentence, goToPage, addBookmark, removeBookmark }: any) {
  if (!book) return null
  const bookmarks = book.bookmarks || []
  return (
    <>
      <div className="panel-head">
        <div className="pre">MARGINALIA</div>
        <h2>Bookmarks</h2>
        <div className="sub">{bookmarks.length} saved passage{bookmarks.length === 1 ? '' : 's'}</div>
      </div>
      <div className="panel-body">
        <button
          className="add-bookmark"
          onClick={() => addBookmark(currentPage, currentSentence, `Page ${currentPage + 1}`)}
        >
          <Icons.Plus size={14} /> Mark current page
        </button>
        {bookmarks.length === 0 ? (
          <div style={{ padding: 14, color: 'var(--ink-3)', fontStyle: 'italic', fontSize: 13, textAlign: 'center' }}>
            No bookmarks yet.
          </div>
        ) : (
          <m.div className="bookmark-list" variants={listStagger} initial="initial" animate="animate" exit="exit">
            {bookmarks.map((bm, i) => (
              <m.div key={i} className="bookmark-item" onClick={() => goToPage(bm.page)} layout variants={listItem}>
                <div className="bm-head">
                  <span className="bm-page">PAGE {bm.page + 1}</span>
                  <span className="bm-rule" />
                  <button
                    onClick={(e) => { e.stopPropagation(); removeBookmark(i) }}
                    style={{ color: 'var(--ink-3)', display: 'flex' }}
                    title="Remove bookmark"
                  ><Icons.X size={13} /></button>
                </div>
                <div className="bm-snip">{bm.label || `Page ${bm.page + 1}, sentence ${(bm.sentence_idx ?? 0) + 1}`}</div>
              </m.div>
            ))}
          </m.div>
        )}
      </div>
    </>
  )
}

function SearchPanel({ book, currentPage, onNavigateSearchResult }: any) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [activeKey, setActiveKey] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!book) return

    const trimmed = query.trim()
    if (!trimmed) {
      setResults([])
      setTotal(0)
      setLoading(false)
      setError('')
      return
    }

    const controller = new AbortController()
    const timer = setTimeout(async () => {
      setLoading(true)
      setError('')
      try {
        const params = new URLSearchParams({
          q: trimmed,
          limit: '40',
        })
        const response = await apiFetch(`/api/book/${book.id}/search?${params.toString()}`, {
          signal: controller.signal,
        })
        if (!response.ok) throw new Error('Search failed')
        const data = await response.json()
        setResults(data.results || [])
        setTotal(data.total || 0)
      } catch (err) {
        if (err.name === 'AbortError') return
        setResults([])
        setTotal(0)
        setError('Search is unavailable right now.')
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }, 180)

    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [book, query])

  const handleResultClick = async (result) => {
    const key = `${result.page}:${result.sentence_idx}:${result.global_sentence_idx ?? ''}`
    setActiveKey(key)
    await onNavigateSearchResult?.(result)
  }

  return (
    <>
      <div className="panel-head">
        <div className="pre">FIND IN BOOK</div>
        <h2>Search</h2>
        <div className="sub">
          {query.trim()
            ? (loading ? 'Searching passages...' : `${total} match${total === 1 ? '' : 'es'} in ${book?.title || 'this book'}`)
            : 'Search across the full text of the current book.'}
        </div>
      </div>
      <div className="panel-body search-body">
        <label className="search-box">
          <Icons.Search size={14} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search passages..."
            aria-label="Search book text"
          />
          <AnimatePresence>
            {query && (
              <m.button
                type="button"
                className="search-clear"
                onClick={() => setQuery('')}
                title="Clear search"
                variants={scaleIn}
                initial="initial"
                animate="animate"
                exit="exit"
                whileTap={buttonTap}
              >
                <Icons.X size={13} />
              </m.button>
            )}
          </AnimatePresence>
        </label>

        <AnimatePresence mode="wait">
          {error && <m.div className="search-empty" key="search-error" variants={scaleIn} initial="initial" animate="animate" exit="exit">{error}</m.div>}

          {!error && !query.trim() && (
          <m.div className="search-empty" key="search-prompt" variants={scaleIn} initial="initial" animate="animate" exit="exit">
            Enter a word or phrase to search the book.
          </m.div>
          )}

          {!error && query.trim() && !loading && results.length === 0 && (
          <m.div className="search-empty" key="search-empty" variants={scaleIn} initial="initial" animate="animate" exit="exit">
            No matches found for "{query.trim()}".
          </m.div>
          )}
        </AnimatePresence>

        <m.div className="search-results" variants={listStagger} initial="initial" animate="animate">
          <AnimatePresence mode="popLayout" initial={false}>
            {results.map((result, idx) => {
              const key = `${result.page}:${result.sentence_idx}:${result.global_sentence_idx ?? ''}`
              const isActive = activeKey === key || result.page === currentPage
              return (
                <m.button
                  key={`${key}:${idx}`}
                  type="button"
                  className={`search-result ${isActive ? 'active' : ''}`}
                  onClick={() => handleResultClick(result)}
                  layout
                  variants={listItem}
                >
                  <div className="search-result-meta">
                    <span>{result.location_label || `Page ${result.page + 1}`}</span>
                    <span>Match {idx + 1}</span>
                  </div>
                  <div className="search-result-text">{result.snippet || result.text}</div>
                </m.button>
              )
            })}
          </AnimatePresence>
        </m.div>
      </div>
    </>
  )
}

export function SettingsPanel({
  theme, setTheme, motion, setMotion, wheelPaging, setWheelPaging,
  voice, setVoice,
  ttsEngine, setTtsEngine,
  modelStatus = {},
  installPromptEngine,
  clearInstallPrompt,
  onLibraryFolderChanged,
  onClose,
}: any) {
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)
  const onCloseRef = useRef(onClose)
  const [cacheInfo, setCacheInfo] = useState(null)
  const [clearingCache, setClearingCache] = useState(false)
  const [cacheMessage, setCacheMessage] = useState('')
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [updateMessage, setUpdateMessage] = useState('')
  const [installingEngine, setInstallingEngine] = useState<string | null>(null)
  const [libraryFolderStatus, setLibraryFolderStatus] = useState<LibraryFolderStatus | null>(null)
  const [libraryFolderBusy, setLibraryFolderBusy] = useState(false)
  const [libraryFolderMessage, setLibraryFolderMessage] = useState('')
  const activeEngine = normalizeTtsEngine(ttsEngine)
  const voiceItems = voicesForEngine(activeEngine)
  const activeVoice = normalizeVoiceForEngine(activeEngine, voice)
  const promptEngine = normalizeTtsEngine(installingEngine || installPromptEngine || activeEngine)
  const promptInstall = modelStatus?.[promptEngine] || null
  const activeInstall = modelStatus?.[activeEngine] || null
  const engineReady = !!activeInstall?.ready
  const activeEngineName = engineDisplayName(activeEngine)
  const installingEngineName = engineDisplayName(installingEngine)

  const formatInstallSize = (bytes: number | undefined) => {
    const safe = Number(bytes || 0)
    if (!safe) return 'Local download'
    const gb = safe / (1024 ** 3)
    if (gb >= 1) return `${gb.toFixed(1)} GB`
    return `${(safe / (1024 ** 2)).toFixed(0)} MB`
  }

  const installLabel = (engineId: string) => {
    const install = modelStatus?.[engineId]
    if (!install) return 'Download'
    if (install.state === 'ready') return 'Installed'
    if (install.state === 'verifying') return 'Verifying'
    if (install.state === 'failed') return 'Retry'
    if (install.state === 'download_queued' || install.state === 'downloading') {
      const pct = install.total_bytes > 0
        ? Math.round(((install.downloaded_bytes || 0) / install.total_bytes) * 100)
        : Math.round((install.progress || 0) * 100)
      return `Downloading ${Math.max(1, Math.min(99, pct))}%`
    }
    return 'Download'
  }

  const installBusy = (install: any) => (
    install?.state === 'download_queued' || install?.state === 'downloading' || install?.state === 'verifying'
  )

  const installActionLabel = (install: any) => {
    if (install?.state === 'failed') return 'Retry download'
    if (install?.state === 'verifying') return 'Verifying...'
    if (install?.state === 'download_queued' || install?.state === 'downloading') return 'Downloading...'
    return 'Start download'
  }

  const requestEngine = (engineId: string) => {
    const install = modelStatus?.[engineId]
    setTtsEngine(engineId)
    if (install?.ready) {
      clearInstallPrompt?.()
      setInstallingEngine(null)
      return
    }
    clearInstallPrompt?.()
    setInstallingEngine(engineId)
  }

  const runInstallAction = async (engineId: string, mode: 'download' | 'retry' | 'cancel' = 'download') => {
    const path = mode === 'retry'
      ? `/api/models/${engineId}/retry`
      : mode === 'cancel'
        ? `/api/models/${engineId}/cancel`
        : `/api/models/${engineId}/download`
    try {
      await apiFetch(path, { method: 'POST' })
      if (mode !== 'cancel') setInstallingEngine(engineId)
    } catch {
      setUpdateMessage('Could not update the model install. Please try again.')
    }
  }

  const refreshLibraryFolderStatus = useCallback(async () => {
    const status = await apiJson<LibraryFolderStatus>('/api/library/folder')
    setLibraryFolderStatus(status)
    return status
  }, [])

  const saveLibraryFolder = useCallback(async (folder: string, recursive = true) => {
    try {
      return await apiJson<LibraryFolderStatus>('/api/library/folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder, recursive }),
      })
    } catch (error) {
      if (!isMethodNotAllowed(error)) throw error

      await apiJson('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          library_scan_folder: folder,
          library_scan_recursive: recursive,
        }),
      })
      const scanResult = await apiJson<LibraryScanResult>('/api/library/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder, recursive }),
      }).catch(() => null)
      const status = await refreshLibraryFolderStatus().catch(() => null)
      return status || {
        folder,
        recursive,
        exists: true,
        last_result: scanResult,
      }
    }
  }, [refreshLibraryFolderStatus])

  const chooseLibraryFolder = useCallback(async () => {
    if (libraryFolderBusy) return
    setLibraryFolderBusy(true)
    setLibraryFolderMessage('')
    try {
      const selected = await selectLibraryFolder(libraryFolderStatus?.folder || null)
      if (!selected) return
      const status = await saveLibraryFolder(selected, true)
      setLibraryFolderStatus(status)
      setLibraryFolderMessage(scanSummary(status.last_result))
      await onLibraryFolderChanged?.()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not scan that folder.'
      setLibraryFolderMessage(message.length > 220 ? `${message.slice(0, 220)}...` : message)
    } finally {
      setLibraryFolderBusy(false)
    }
  }, [libraryFolderBusy, libraryFolderStatus?.folder, onLibraryFolderChanged, saveLibraryFolder])

  const scanLibraryFolder = useCallback(async () => {
    if (libraryFolderBusy || !libraryFolderStatus?.folder) return
    setLibraryFolderBusy(true)
    setLibraryFolderMessage('')
    try {
      const result = await apiJson<LibraryScanResult>('/api/library/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const nextStatus = await refreshLibraryFolderStatus()
      setLibraryFolderMessage(scanSummary(nextStatus?.last_result || result))
      await onLibraryFolderChanged?.()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not scan the selected folder.'
      setLibraryFolderMessage(message.length > 220 ? `${message.slice(0, 220)}...` : message)
    } finally {
      setLibraryFolderBusy(false)
    }
  }, [libraryFolderBusy, libraryFolderStatus?.folder, onLibraryFolderChanged, refreshLibraryFolderStatus])

  useEffect(() => {
    apiFetch('/api/cache/info')
      .then(r => r.ok ? r.json() : null)
      .then(setCacheInfo)
      .catch(() => {})
  }, [])

  useEffect(() => {
    refreshLibraryFolderStatus().catch(() => {
      setLibraryFolderStatus(null)
    })
  }, [refreshLibraryFolderStatus])

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    const focusFrame = window.requestAnimationFrame(() => closeButtonRef.current?.focus())

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCloseRef.current?.()
        return
      }
      if (event.key !== 'Tab') return

      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      ) || []).filter((element) => (
        element.getAttribute('aria-hidden') !== 'true' &&
        !element.closest('[aria-hidden="true"]') &&
        element.getClientRects().length > 0
      ))
      if (focusable.length === 0) return

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.cancelAnimationFrame(focusFrame)
      window.removeEventListener('keydown', onKeyDown)
      if (previouslyFocused?.isConnected) previouslyFocused.focus()
    }
  }, [])

  useEffect(() => {
    if (installPromptEngine) setInstallingEngine(normalizeTtsEngine(installPromptEngine))
  }, [installPromptEngine])

  useEffect(() => {
    if (installingEngine && modelStatus?.[installingEngine]?.ready) {
      setTtsEngine(installingEngine)
      clearInstallPrompt?.()
      setInstallingEngine(null)
    }
  }, [clearInstallPrompt, installingEngine, modelStatus, setTtsEngine])

  const clearCache = async () => {
    setClearingCache(true)
    setCacheMessage('')
    try {
      const clearRes = await apiFetch('/api/cache/clear', { method: 'POST' })
      const clearData = clearRes.ok ? await clearRes.json() : null
      const r = await apiFetch('/api/cache/info')
      if (r.ok) setCacheInfo(await r.json())
      if (clearData) {
        const skipped = clearData.skipped || 0
        setCacheMessage(skipped > 0
          ? `Cleared ${clearData.deleted} files, skipped ${skipped} active.`
          : `Cleared ${clearData.deleted} files.`)
      }
    } catch {
      setCacheMessage('Cache clear failed.')
    } finally {
      setClearingCache(false)
    }
  }

  const checkForUpdates = async () => {
    setCheckingUpdate(true)
    setUpdateMessage('')
    try {
      const { check } = await import('@tauri-apps/plugin-updater')
      const update = await check()
      if (!update) {
        setUpdateMessage('Folio is up to date.')
        return
      }

      setUpdateMessage(`Downloading ${update.version}...`)
      await update.downloadAndInstall()
      setUpdateMessage('Update installed. Restart Folio to finish.')
    } catch (error) {
      setUpdateMessage(error?.message || 'Update check failed.')
    } finally {
      setCheckingUpdate(false)
    }
  }

  return (
    <m.div
      ref={dialogRef}
      className={`settings-overlay theme-${theme}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose?.()
      }}
      variants={overlayFade}
      initial="initial"
      animate="animate"
      exit="exit"
    >
      <m.div
        className="settings-shell"
        onMouseDown={(event) => event.stopPropagation()}
        variants={modalPanel}
        layout
        transition={spring.panel}
      >
        <section className="settings-main">
          <header className="settings-full-head">
            <div>
              <h2 id="settings-title">Settings</h2>
              <p>Reader, narrator, and local storage controls.</p>
            </div>
            <button ref={closeButtonRef} className="settings-close" type="button" onClick={onClose} aria-label="Close settings">
              <Icons.X size={18} />
            </button>
          </header>

          <div className="settings-summary" aria-label="Current settings">
            <span><Icons.Feather size={14} /> {theme}</span>
            <span><Icons.Play size={14} /> {activeEngineName}</span>
            <span><Icons.Settings size={14} /> {voiceItems.find((item) => item.id === activeVoice)?.name || activeVoice}</span>
          </div>

          <div className="settings-full-body settings-body">
            <div className="settings-group">
              <div className="settings-card-head">
                <div>
                  <div className="label">Reader</div>
                  <h3>Appearance</h3>
                </div>
                <span>{theme}</span>
              </div>
              <m.div className="theme-switch" layout>
                {['light', 'sepia', 'dark', 'folio'].map((t) => (
                  <m.button
                    key={t}
                    data-t={t}
                    className={`theme-option ${theme === t ? 'active' : ''}`}
                    onClick={(e) => {
                      runThemeTransition(e, t, theme, setTheme)
                    }}
                    layout
                    whileTap={buttonTap}
                  >
                    {theme === t && <m.span className="settings-active-bg" layoutId="settings-theme-active" transition={spring.layout} aria-hidden="true" />}
                    <span className="swatch" />
                    {t}
                  </m.button>
                ))}
              </m.div>
              <div className="control-row">
                <span className="k" id="motion-toggle-label">Page-turn animation</span>
                <button
                  type="button"
                  className={`toggle ${motion ? 'on' : ''}`}
                  role="switch"
                  aria-checked={Boolean(motion)}
                  aria-labelledby="motion-toggle-label"
                  onClick={() => setMotion(!motion)}
                />
              </div>
              <div className="control-row">
                <span className="k" id="wheel-toggle-label">Scroll wheel flips pages</span>
                <button
                  type="button"
                  className={`toggle ${wheelPaging ? 'on' : ''}`}
                  role="switch"
                  aria-checked={Boolean(wheelPaging)}
                  aria-labelledby="wheel-toggle-label"
                  onClick={() => setWheelPaging(!wheelPaging)}
                />
              </div>
            </div>

            <div className="settings-group settings-card-wide settings-library-folder">
              <div className="settings-card-head">
                <div>
                  <div className="label">Library</div>
                  <h3>Auto-scan folder</h3>
                </div>
                <span>{libraryFolderStatus?.exists ? 'Watching' : 'Optional'}</span>
              </div>
              <div className="settings-folder-path">
                <Icons.Folder size={16} />
                <div>
                  <strong title={libraryFolderStatus?.folder || undefined}>
                    {folderLabel(libraryFolderStatus?.folder || '')}
                  </strong>
                  <p>
                    {libraryFolderStatus?.folder
                      ? libraryFolderStatus.folder
                      : 'Choose a folder and Folio will periodically pick up new EPUB files from it.'}
                  </p>
                </div>
              </div>
              <div className="settings-folder-summary">
                <span>{libraryFolderMessage || scanSummary(libraryFolderStatus?.last_result)}</span>
              </div>
              <div className="settings-folder-actions">
                <button type="button" className="settings-action" onClick={chooseLibraryFolder} disabled={libraryFolderBusy}>
                  {libraryFolderStatus?.folder ? 'Change folder' : 'Select folder'}
                </button>
                <button type="button" className="settings-action" onClick={scanLibraryFolder} disabled={libraryFolderBusy || !libraryFolderStatus?.folder}>
                  {libraryFolderBusy ? 'Scanning...' : 'Scan now'}
                </button>
              </div>
            </div>

            <div className="settings-group settings-voice-card">
              <div className="settings-card-head">
                <div>
                  <div className="label">Narrator</div>
                  <h3>Engine and voice</h3>
                </div>
                <span>{activeVoice}</span>
              </div>
              <m.div className="tts-engine-switch" layout>
                {ttsEngines.map((engine) => (
                  <m.button
                    key={engine.id}
                    type="button"
                    className={`tts-engine-option ${activeEngine === engine.id ? 'active' : ''}`}
                    onClick={() => requestEngine(engine.id)}
                    layout
                    whileTap={buttonTap}
                  >
                    {activeEngine === engine.id && <m.span className="settings-active-bg" layoutId="settings-engine-active" transition={spring.layout} aria-hidden="true" />}
                    <span>{engine.name}</span>
                    <small>{installLabel(engine.id)}</small>
                  </m.button>
                ))}
              </m.div>
              <AnimatePresence>
                {!engineReady && (
                <m.div className="model-install-card" role="status" variants={slideUp} initial="initial" animate="animate" exit="exit" layout>
                  <div className="model-install-copy">
                    <div className="label">Model install</div>
                    <h4>{activeEngineName} is not installed yet</h4>
                    <p>
                      Download the voice engine once, store it locally on this machine, and Folio will use it offline after that.
                    </p>
                    <div className="model-install-meta">
                      <span>{formatInstallSize(activeInstall?.approx_download_bytes || activeInstall?.total_bytes)}</span>
                      <span>{activeInstall?.state === 'failed' ? (activeInstall?.error || 'Install failed') : installLabel(activeEngine)}</span>
                    </div>
                  </div>
                  <div className="model-install-actions">
                    <button
                      type="button"
                      className="settings-action model-install-btn"
                      disabled={installBusy(activeInstall)}
                      onClick={() => runInstallAction(activeEngine, activeInstall?.state === 'failed' ? 'retry' : 'download')}
                    >
                      {installActionLabel(activeInstall)}
                    </button>
                  </div>
                  <div className="model-install-progress" aria-hidden="true">
                    <div style={{ width: `${Math.max(6, Math.round(((activeInstall?.progress || 0) * 100)))}%` }} />
                  </div>
                </m.div>
                )}
              </AnimatePresence>
              <m.div className={`voice-picker ${engineReady ? '' : 'is-disabled'}`} role="radiogroup" aria-label={`${activeEngineName} voice`} layout>
                {voiceItems.map((item) => {
                  const active = activeVoice === item.id
                  return (
                    <m.button
                      key={item.id}
                      type="button"
                      className={`voice-card ${active ? 'active' : ''}`}
                      onClick={() => engineReady && setVoice(item.id)}
                      disabled={!engineReady}
                      role="radio"
                      aria-checked={active}
                      layout
                      whileHover={engineReady ? buttonHover : undefined}
                      whileTap={engineReady ? buttonTap : undefined}
                    >
                      {active && <m.span className="settings-active-bg" layoutId="settings-voice-active" transition={spring.layout} aria-hidden="true" />}
                      <span className="voice-card-head">
                        <span className="voice-mark">{item.name.slice(0, 1)}</span>
                        <span className="voice-title">
                          <span className="voice-name">{item.name}</span>
                          <span className="voice-id">{item.id}</span>
                        </span>
                        <span className="voice-tag">{item.tagline}</span>
                      </span>
                      <span className="voice-description">{item.description}</span>
                    </m.button>
                  )
                })}
              </m.div>
            </div>

            <div className="settings-group">
              <div className="settings-card-head">
                <div>
                  <div className="label">Maintenance</div>
                  <h3>Updates</h3>
                </div>
              </div>
              <button className="settings-action" disabled={checkingUpdate} onClick={checkForUpdates}>
                {checkingUpdate ? 'Checking...' : 'Check for updates'}
              </button>
              {updateMessage && <p className="settings-note">{updateMessage}</p>}
            </div>

            {cacheInfo && (
              <div className="settings-group">
                <div className="settings-card-head">
                  <div>
                    <div className="label">Storage</div>
                    <h3>Voice cache</h3>
                  </div>
                  <span>{cacheInfo.size_mb} MB</span>
                </div>
                <div className="settings-metric">
                  <span>Cached files</span>
                  <strong>{cacheInfo.files}</strong>
                </div>
                <button className="settings-action" disabled={clearingCache} onClick={clearCache}>
                  {clearingCache ? 'Clearing...' : 'Clear cache'}
                </button>
                {cacheMessage && <p className="settings-note">{cacheMessage}</p>}
              </div>
            )}
          </div>
        </section>
      </m.div>
      <AnimatePresence>
      {installingEngine && (
        <m.div className="model-install-overlay" onMouseDown={() => { setInstallingEngine(null); clearInstallPrompt?.() }} variants={overlayFade} initial="initial" animate="animate" exit="exit">
          <m.div className="model-install-modal" onMouseDown={(event) => event.stopPropagation()} variants={modalPanel}>
            <div className="model-install-orbit" aria-hidden="true" />
            <div className="model-install-head">
              <div className="label">Local voice engine</div>
              <h3>Download {installingEngineName}</h3>
              <p>Folio keeps models on your device and only downloads them when you choose to install one.</p>
            </div>
            <div className="model-install-stats">
              <span>{formatInstallSize(promptInstall?.approx_download_bytes || promptInstall?.total_bytes)}</span>
              <span>{installLabel(installingEngine)}</span>
            </div>
            <div className="model-install-progress hero">
              <div style={{ width: `${Math.max(8, Math.round(((promptInstall?.progress || 0) * 100)))}%` }} />
            </div>
            <p className="settings-note">
              {promptInstall?.state === 'failed'
                ? (promptInstall?.error || 'The previous install failed. Retry to continue.')
                : promptInstall?.state === 'ready'
                  ? 'Installed and ready. Folio will switch to this engine automatically.'
                  : 'Narration stays unavailable for this engine until the local model finishes downloading and verifying.'}
            </p>
            <div className="model-install-actions">
              {promptInstall?.state !== 'ready' && (
                <button
                  type="button"
                  className="settings-action model-install-btn"
                  disabled={installBusy(promptInstall)}
                  onClick={() => runInstallAction(installingEngine, promptInstall?.state === 'failed' ? 'retry' : 'download')}
                >
                  {installActionLabel(promptInstall)}
                </button>
              )}
              {(promptInstall?.state === 'download_queued' || promptInstall?.state === 'downloading' || promptInstall?.state === 'verifying') && (
                <button
                  type="button"
                  className="settings-action"
                  onClick={() => runInstallAction(installingEngine, 'cancel')}
                >
                  Cancel
                </button>
              )}
              <button type="button" className="settings-action" onClick={() => { setInstallingEngine(null); clearInstallPrompt?.() }}>
                {promptInstall?.state === 'ready' ? 'Done' : 'Close'}
              </button>
            </div>
          </m.div>
        </m.div>
      )}
      </AnimatePresence>
    </m.div>
  )
}
