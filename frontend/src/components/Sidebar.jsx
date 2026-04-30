import { useState, useEffect, useRef } from 'react'
import { Icons } from './icons'
import { apiFetch } from '../api'
import { kokoroVoices, normalizeKokoroVoice } from '../kokoroVoices'

export default function Sidebar({
  book, reflow, currentPage, currentSentence, goToPage,
  addBookmark, removeBookmark,
  voice, setVoice,
  theme, setTheme,
  motion, setMotion,
  wheelPaging, setWheelPaging,
  highlightStyle, setHighlightStyle,
  tab, setTab,
  onNavigateSearchResult,
  onHome,
  hidden = false,
}) {
  const [renderedTab, setRenderedTab] = useState(tab)

  useEffect(() => {
    let timer
    if (tab) {
      timer = setTimeout(() => setRenderedTab(tab), 0)
    } else {
      timer = setTimeout(() => setRenderedTab(null), 340)
    }
    return () => clearTimeout(timer)
  }, [tab])

  const railBtn = (key, Ico, label) => (
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
  const railRef = useRef(null)
  const panelRef = useRef(null)
  useEffect(() => {
    if (!tab) return
    const onPointerDown = (e) => {
      const t = e.target
      if (railRef.current?.contains(t)) return
      if (panelRef.current?.contains(t)) return
      setTab(null)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [tab, setTab])

  return (
    <>
      <div className={`sidebar-wrap ${hidden ? 'is-hidden' : ''} ${tab ? 'is-open' : ''} ${renderedTab && !tab ? 'is-closing' : ''}`}>
      <div className="icon-rail" ref={railRef}>
        <div className="rail-brand" onClick={onHome} title="Library">F</div>
        {railBtn('chapters', Icons.Chapters, 'Chapters')}
        {railBtn('bookmarks', Icons.Bookmark, 'Bookmarks')}
        {railBtn('search', Icons.Search, 'Search')}
        <div className="rail-spacer" />
        {railBtn('settings', Icons.Settings, 'Settings')}
        <button className="rail-btn" onClick={onHome} title="Library">
          <Icons.Library size={18} />
        </button>
      </div>

      {renderedTab && (
        <div className={`sidebar-panel ${tab ? 'is-open' : 'is-closing'}`} ref={panelRef} aria-hidden={!tab}>
          {renderedTab === 'chapters' && <ChapterPanel book={book} reflow={reflow} currentPage={currentPage} goToPage={goToPage} />}
          {renderedTab === 'bookmarks' && (
            <BookmarkPanel
              book={book}
              currentPage={currentPage}
              currentSentence={currentSentence}
              goToPage={goToPage}
              addBookmark={addBookmark}
              removeBookmark={removeBookmark}
            />
          )}
          {renderedTab === 'search' && (
            <SearchPanel
              book={book}
              currentPage={currentPage}
              onNavigateSearchResult={onNavigateSearchResult}
            />
          )}
          {renderedTab === 'settings' && (
            <SettingsPanel
              theme={theme} setTheme={setTheme}
              motion={motion} setMotion={setMotion}
              wheelPaging={wheelPaging} setWheelPaging={setWheelPaging}
              highlightStyle={highlightStyle} setHighlightStyle={setHighlightStyle}
              voice={voice} setVoice={setVoice}
            />
          )}
        </div>
      )}
      </div>
    </>
  )
}

function ChapterPanel({ book, reflow, currentPage, goToPage }) {
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
            No table of contents found in this PDF.
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

function BookmarkPanel({ book, currentPage, currentSentence, goToPage, addBookmark, removeBookmark }) {
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
                <div className="bm-snip">"{bm.label || `Page ${bm.page + 1}, sentence ${bm.sentence_idx + 1}`}"</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  )
}

function SearchPanel({ book, currentPage, onNavigateSearchResult }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [activeKey, setActiveKey] = useState('')
  const inputRef = useRef(null)

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
                  <span>{book?.format === 'epub' ? result.location_label : `Page ${result.page + 1}`}</span>
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
}) {
  const [cacheInfo, setCacheInfo] = useState(null)
  const [clearingCache, setClearingCache] = useState(false)
  const [cacheMessage, setCacheMessage] = useState('')
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [updateMessage, setUpdateMessage] = useState('')

  useEffect(() => {
    apiFetch('/api/cache/info')
      .then(r => r.ok ? r.json() : null)
      .then(setCacheInfo)
      .catch(() => {})
  }, [])

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
    <>
      <div className="panel-head">
        <div className="pre">PREFERENCES</div>
        <h2>Settings</h2>
      </div>
      <div className="panel-body settings-body">
        <div className="settings-group">
          <div className="label">Paper</div>
          <div className="theme-switch">
            {['light', 'sepia', 'dark'].map((t) => (
              <button
                key={t}
                data-t={t}
                className={`theme-option ${theme === t ? 'active' : ''}`}
                onClick={() => setTheme(t)}
              >
                <span className="swatch" />
                {t}
              </button>
            ))}
          </div>
        </div>

        <div className="settings-group">
          <div className="label">Narrator</div>
          <div className="voice-picker" role="radiogroup" aria-label="Kokoro voice">
            {kokoroVoices.map((item) => {
              const active = normalizeKokoroVoice(voice) === item.id
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`voice-card ${active ? 'active' : ''}`}
                  onClick={() => setVoice(item.id)}
                  role="radio"
                  aria-checked={active}
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
                </button>
              )
            })}
          </div>
        </div>

        <div className="settings-group">
          <div className="label">Read-along highlight</div>
          <div className="control-row">
            <span className="k">Style</span>
            <select value={highlightStyle} onChange={(e) => setHighlightStyle(e.target.value)}
              style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--rule)', background: 'var(--paper)', color: 'var(--ink)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
              <option value="dim">Dim the rest</option>
              <option value="underline">Underline cursor</option>
              <option value="tint">Sentence tint</option>
            </select>
          </div>
        </div>

        <div className="settings-group">
          <div className="label">Motion</div>
          <div className="control-row">
            <span className="k">Page-turn animation</span>
            <div className={`toggle ${motion ? 'on' : ''}`} onClick={() => setMotion(!motion)} />
          </div>
          <div className="control-row">
            <span className="k">Scroll wheel flips pages</span>
            <div className={`toggle ${wheelPaging ? 'on' : ''}`} onClick={() => setWheelPaging(!wheelPaging)} />
          </div>
        </div>

        <div className="settings-group">
          <div className="label">Updates</div>
          <div style={{ padding: 14, background: 'var(--paper)', borderRadius: 8, border: '1px solid var(--rule)' }}>
            <button
              disabled={checkingUpdate}
              onClick={checkForUpdates}
              style={{
                padding: '6px 14px', fontSize: 11, fontFamily: 'var(--font-mono)',
                letterSpacing: '.14em', textTransform: 'uppercase',
                background: 'var(--ink)', color: 'var(--paper)', borderRadius: 8,
                opacity: checkingUpdate ? 0.6 : 1,
              }}
            >{checkingUpdate ? 'Checking...' : 'Check for updates'}</button>
            {updateMessage && <p style={{ marginTop: 8, fontSize: 11, color: 'var(--ink-3)', overflowWrap: 'anywhere' }}>{updateMessage}</p>}
          </div>
        </div>

        {cacheInfo && (
          <div className="settings-group">
            <div className="label">Voice cache</div>
            <div style={{ padding: 14, background: 'var(--paper)', borderRadius: 10, border: '1px solid var(--rule)' }}>
              <div style={{ fontSize: 13, color: 'var(--ink-2)', marginBottom: 10 }}>
                {cacheInfo.files} files · <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--ember)' }}>{cacheInfo.size_mb} MB</span>
              </div>
              <button
                disabled={clearingCache}
                onClick={clearCache}
                style={{
                  padding: '6px 14px', fontSize: 11, fontFamily: 'var(--font-mono)',
                  letterSpacing: '.14em', textTransform: 'uppercase',
                  background: 'var(--ink)', color: 'var(--paper)', borderRadius: 999,
                  opacity: clearingCache ? 0.6 : 1,
                }}
              >{clearingCache ? 'Clearing...' : 'Clear cache'}</button>
              {cacheMessage && <p style={{ marginTop: 8, fontSize: 11, color: 'var(--ink-3)' }}>{cacheMessage}</p>}
            </div>
          </div>
        )}
      </div>
    </>
  )
}
