import { useState, useEffect, useRef, memo } from 'react'
import type React from 'react'
import { createPortal } from 'react-dom'
import { Icons } from './icons'
import { apiFetch } from '../api'

// Spawns a one-shot radial wash from the click point so the upcoming theme
// change reads as a curtain sweeping across, not a hard cut. The ripple
// element auto-removes after its CSS animation completes.
function spawnThemeRipple(event: React.MouseEvent, theme: string) {
  if (typeof document === 'undefined') return
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
  const x = event.clientX
  const y = event.clientY
  const node = document.createElement('div')
  node.className = 'theme-ripple'
  node.style.setProperty('--rx', `${x}px`)
  node.style.setProperty('--ry', `${y}px`)
  // Use the destination theme's paper as the wash color.
  const paper = theme === 'folio' ? 'rgba(8, 9, 11, 0.68)'
    : theme === 'dark' ? 'rgba(20, 24, 28, 0.6)'
    : theme === 'sepia' ? 'rgba(243, 231, 207, 0.6)'
    : 'rgba(247, 244, 237, 0.6)'
  node.style.setProperty('--ripple-color', paper)
  document.body.appendChild(node)
  setTimeout(() => node.remove(), 820)
}
import {
  ttsEngines,
  voicesForEngine,
  normalizeTtsEngine,
  normalizeVoiceForEngine,
  CHATTERBOX_ENGINE,
} from '../kokoroVoices'

export default memo(function Sidebar({
  book, reflow, currentPage, currentSentence, goToPage,
  addBookmark, removeBookmark,
  voice, setVoice,
  ttsEngine, setTtsEngine,
  theme, setTheme,
  motion, setMotion,
  wheelPaging, setWheelPaging,
  highlightStyle, setHighlightStyle,
  tab, setTab,
  onNavigateSearchResult,
  onHome,
  hidden = false,
}: any) {
  const [renderedTab, setRenderedTab] = useState(tab)
  const panelTab = renderedTab === 'settings' ? null : renderedTab
  const panelOpen = Boolean(tab && tab !== 'settings')
  const settingsOpen = tab === 'settings'

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
    <button
      key={key}
      className={`rail-btn ${tab === key ? 'active' : ''}`}
      onClick={() => setTab(tab === key ? null : key)}
      title={label}
    >
      <Ico size={18} />
    </button>
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
      <div className={`sidebar-wrap ${hidden ? 'is-hidden' : ''} ${panelOpen ? 'is-open' : ''} ${panelTab && !panelOpen ? 'is-closing' : ''}`}>
      <div className="icon-rail" ref={railRef}>
        <button className="rail-brand" onClick={onHome} title="Library" aria-label="Library">
          <img className="rail-brand-logo" src="/folio-monochrome-icon.png" alt="" draggable={false} />
        </button>
        {railBtn('chapters', Icons.Chapters, 'Chapters')}
        {railBtn('bookmarks', Icons.Bookmark, 'Bookmarks')}
        {railBtn('search', Icons.Search, 'Search')}
        <div className="rail-spacer" />
        {railBtn('settings', Icons.Settings, 'Settings')}
      </div>

      {panelTab && (
        <div className={`sidebar-panel ${panelOpen ? 'is-open' : 'is-closing'}`} ref={panelRef} aria-hidden={!panelOpen}>
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
        </div>
      )}
      </div>
      {settingsOpen && createPortal(
        <SettingsPanel
          theme={theme}
          setTheme={setTheme}
          motion={motion} setMotion={setMotion}
          wheelPaging={wheelPaging} setWheelPaging={setWheelPaging}
          highlightStyle={highlightStyle} setHighlightStyle={setHighlightStyle}
          voice={voice} setVoice={setVoice}
          ttsEngine={ttsEngine} setTtsEngine={setTtsEngine}
          onClose={() => setTab(null)}
        />,
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
          <div className="chapter-list">
            {toc.map((c, i) => {
              const next = toc[i + 1]
              const isActive = useReflow
                ? currentPage === c.page
                : (currentPage >= c.page && (!next || currentPage < next.page))
              return (
                <div
                  key={i}
                  className={`chapter-item ${isActive ? 'active' : ''}`}
                  onClick={() => goToPage(c.page)}
                >
                  {isActive && <div className="playing-indicator" />}
                  <div className="ch-num">{String(i + 1).padStart(2, '0')}</div>
                  <div className="ch-title">{c.title}</div>
                  <div className="ch-dur">p.{c.page + 1}</div>
                </div>
              )
            })}
          </div>
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
          <div className="bookmark-list">
            {bookmarks.map((bm, i) => (
              <div key={i} className="bookmark-item" onClick={() => goToPage(bm.page)}>
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
              </div>
            ))}
          </div>
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
          {query && (
            <button
              type="button"
              className="search-clear"
              onClick={() => setQuery('')}
              title="Clear search"
            >
              <Icons.X size={13} />
            </button>
          )}
        </label>

        {error && <div className="search-empty">{error}</div>}

        {!error && !query.trim() && (
          <div className="search-empty">
            Enter a word or phrase to search the book.
          </div>
        )}

        {!error && query.trim() && !loading && results.length === 0 && (
          <div className="search-empty">
            No matches found for "{query.trim()}".
          </div>
        )}

        <div className="search-results">
          {results.map((result, idx) => {
            const key = `${result.page}:${result.sentence_idx}:${result.global_sentence_idx ?? ''}`
            const isActive = activeKey === key || result.page === currentPage
            return (
              <button
                key={`${key}:${idx}`}
                type="button"
                className={`search-result ${isActive ? 'active' : ''}`}
                onClick={() => handleResultClick(result)}
              >
                <div className="search-result-meta">
                  <span>{result.location_label || `Page ${result.page + 1}`}</span>
                  <span>Match {idx + 1}</span>
                </div>
                <div className="search-result-text">{highlightQuery(result.snippet || result.text, query)}</div>
              </button>
            )
          })}
        </div>
      </div>
    </>
  )
}

function highlightQuery(text, query) {
  const source = text || ''
  const trimmed = query.trim()
  if (!trimmed) return source

  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const parts = source.split(new RegExp(`(${escaped})`, 'ig'))
  return parts.map((part, idx) => (
    idx % 2 === 1
      ? <mark key={idx}>{part}</mark>
      : <span key={idx}>{part}</span>
  ))
}

function SettingsPanel({
  theme, setTheme, motion, setMotion, wheelPaging, setWheelPaging,
  highlightStyle, setHighlightStyle,
  voice, setVoice,
  ttsEngine, setTtsEngine,
  onClose,
}: any) {
  const [cacheInfo, setCacheInfo] = useState(null)
  const [clearingCache, setClearingCache] = useState(false)
  const [cacheMessage, setCacheMessage] = useState('')
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [updateMessage, setUpdateMessage] = useState('')
  const activeEngine = normalizeTtsEngine(ttsEngine)
  const voiceItems = voicesForEngine(activeEngine)
  const activeVoice = normalizeVoiceForEngine(activeEngine, voice)

  useEffect(() => {
    apiFetch('/api/cache/info')
      .then(r => r.ok ? r.json() : null)
      .then(setCacheInfo)
      .catch(() => {})
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose?.()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

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
    <div
      className={`settings-overlay theme-${theme}`}
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose?.()
      }}
    >
      <div className="settings-shell" onMouseDown={(event) => event.stopPropagation()}>
        <section className="settings-main">
          <header className="settings-full-head">
            <div>
              <h2>Settings</h2>
              <p>Reader, narrator, and local storage controls.</p>
            </div>
            <button className="settings-close" type="button" onClick={onClose} aria-label="Close settings">
              <Icons.X size={18} />
            </button>
          </header>

          <div className="settings-summary" aria-label="Current settings">
            <span><Icons.Feather size={14} /> {theme}</span>
            <span><Icons.Play size={14} /> {activeEngine === CHATTERBOX_ENGINE ? 'Chatterbox' : 'Kokoro'}</span>
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
              <div className="theme-switch">
                {['light', 'sepia', 'dark', 'folio'].map((t) => (
                  <button
                    key={t}
                    data-t={t}
                    className={`theme-option ${theme === t ? 'active' : ''}`}
                    onClick={(e) => {
                      spawnThemeRipple(e, t)
                      setTheme(t)
                    }}
                  >
                    <span className="swatch" />
                    {t}
                  </button>
                ))}
              </div>
              <div className="control-row">
                <span className="k">Highlight style</span>
                <select value={highlightStyle} onChange={(e) => setHighlightStyle(e.target.value)}>
                  <option value="dim">Dim the rest</option>
                  <option value="underline">Underline cursor</option>
                  <option value="tint">Sentence tint</option>
                </select>
              </div>
              <div className="control-row">
                <span className="k">Page-turn animation</span>
                <div className={`toggle ${motion ? 'on' : ''}`} onClick={() => setMotion(!motion)} />
              </div>
              <div className="control-row">
                <span className="k">Scroll wheel flips pages</span>
                <div className={`toggle ${wheelPaging ? 'on' : ''}`} onClick={() => setWheelPaging(!wheelPaging)} />
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
              <div className="tts-engine-switch">
                {ttsEngines.map((engine) => (
                  <button
                    key={engine.id}
                    type="button"
                    className={`tts-engine-option ${activeEngine === engine.id ? 'active' : ''}`}
                    onClick={() => setTtsEngine(engine.id)}
                  >
                    {engine.name}
                  </button>
                ))}
              </div>
              <div className="voice-picker" role="radiogroup" aria-label={`${activeEngine} voice`}>
                {voiceItems.map((item) => {
                  const active = activeVoice === item.id
                  return (
                    <div
                      key={item.id}
                      className={`voice-card ${active ? 'active' : ''}`}
                      onClick={() => setVoice(item.id)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          setVoice(item.id)
                        }
                      }}
                      role="radio"
                      aria-checked={active}
                      tabIndex={0}
                    >
                      <span className="voice-card-head">
                        <span className="voice-mark">{item.name.slice(0, 1)}</span>
                        <span className="voice-title">
                          <span className="voice-name">{item.name}</span>
                          <span className="voice-id">{item.id}</span>
                        </span>
                        <span className="voice-tag">{item.tagline}</span>
                      </span>
                      <span className="voice-description">{item.description}</span>
                    </div>
                  )
                })}
              </div>
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
        </div>
    </div>
  )
}
