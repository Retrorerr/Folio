import { useRef, useState, useCallback, memo } from 'react'
import type React from 'react'
import { Icons } from './icons'
import { apiUrl } from '../api'

const COVERS = ['cover-a', 'cover-b', 'cover-c', 'cover-d', 'cover-e', 'cover-f', 'cover-g', 'cover-h']

// Renders the staggered-word hero title. Each word becomes its own animated
// span so the line settles in like ink soaking into paper.
function HeroTitle() {
  const words = [
    { t: 'Hear' }, { t: 'any' }, { t: 'book' },
    { t: 'read', em: true }, { t: 'aloud,', em: true },
    { t: 'on' }, { t: 'every' }, { t: 'page.' },
  ]
  let i = 0
  return (
    <h1 aria-label="Hear any book read aloud, on every page.">
      {words.map((w, idx) => {
        const span = (
          <span className="hw" style={{ '--i': i } as React.CSSProperties}>
            {w.em ? <em>{w.t}</em> : w.t}
          </span>
        )
        i += 1
        return (
          <span key={idx}>
            {span}
            {idx < words.length - 1 ? ' ' : ''}
          </span>
        )
      })}
    </h1>
  )
}

// Decorative drifting motes layered behind the welcome hero. Pure visual,
// CSS-driven, no per-frame work.
function DustMotes({ count = 10, className = 'motes' }) {
  return (
    <div className={className} aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className="mote" />
      ))}
    </div>
  )
}

// Apply magnetic-tilt mouse handlers to a card. The CSS reads --tx/--ty
// (range -1..1) and translates them to subtle perspective rotation.
function magneticHandlers(extraClass = 'is-magnetic') {
  return {
    onMouseMove: (e: React.MouseEvent<HTMLElement>) => {
      const el = e.currentTarget
      const r = el.getBoundingClientRect()
      const tx = ((e.clientX - r.left) / r.width) * 2 - 1
      const ty = ((e.clientY - r.top) / r.height) * 2 - 1
      el.style.setProperty('--tx', tx.toFixed(3))
      el.style.setProperty('--ty', ty.toFixed(3))
      if (!el.classList.contains(extraClass)) el.classList.add(extraClass)
    },
    onMouseLeave: (e: React.MouseEvent<HTMLElement>) => {
      const el = e.currentTarget
      el.style.setProperty('--tx', '0')
      el.style.setProperty('--ty', '0')
      el.classList.remove(extraClass)
    },
  }
}

function Ring({ pct }: { pct: number }) {
  const r = 22, c = 2 * Math.PI * r
  return (
    <div className="progress-ring">
      <svg width="56" height="56">
        <circle className="ring-bg" cx="28" cy="28" r={r} strokeWidth="2" fill="none" />
        <circle className="ring-fg" cx="28" cy="28" r={r} strokeWidth="2" fill="none"
                strokeDasharray={c} strokeDashoffset={c * (1 - pct)} strokeLinecap="round" />
      </svg>
      <div className="pct">{Math.round(pct * 100)}%</div>
    </div>
  )
}

function coverImageStyle(book: any): React.CSSProperties | undefined {
  return book?.cover_url
    ? { backgroundImage: `url("${apiUrl(book.cover_url)}")` }
    : undefined
}

export default memo(function Welcome({ onUpload, recentBooks, onOpenRecent, onDeleteRecent, statusBadges }: any) {
  const [drag, setDrag] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState('')
  const fileRef = useRef<HTMLInputElement | null>(null)

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
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not open that book. The backend may still be starting.'
      setImportError(message.length > 260 ? `${message.slice(0, 260)}...` : message)
    } finally {
      setImporting(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }, [importing, onUpload])

  const handleDrop = useCallback((e: React.DragEvent<HTMLElement>) => {
    e.preventDefault()
    setDrag(false)
    const file = e.dataTransfer.files[0]
    importFile(file)
  }, [importFile])

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files[0]
    importFile(file)
  }, [importFile])

  const handleOpen = useCallback((b: any) => {
    if (b.exists === false) {
      window.alert(`File not found:\n${b.filepath}\n\nUse the × button to remove it from history.`)
      return
    }
    onOpenRecent(b.filepath)
  }, [onOpenRecent])

  const handleDelete = useCallback((e: React.MouseEvent, b: any) => {
    e.stopPropagation()
    const msg = b.exists !== false
      ? `Remove "${b.title}" from history and delete the EPUB?`
      : `Remove "${b.title}" from history?`
    if (!window.confirm(msg)) return
    onDeleteRecent?.(b.id, b.exists !== false)
  }, [onDeleteRecent])

  const continueBook = recentBooks?.[0]
  const rest = (recentBooks || []).slice(1)
  const bookProgress = (b) => {
    if (!b || !b.page_count) return 0
    return Math.min(1, (b.last_position?.page || 0) / b.page_count)
  }
  const hasLibrary = (recentBooks?.length || 0) > 0

  // Reusable upload affordance — full-size in empty state, compact pill in
  // library header. Same drag/drop semantics either way.
  const dropZone = (variant = 'full') => (
    <>
      <input ref={fileRef} type="file" accept=".epub" onChange={handleFileSelect} style={{ display: 'none' }} />
      <div
        className={`drop-zone drop-${variant}${drag ? ' drag-over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDrag(true) }}
        onDragLeave={() => setDrag(false)}
        onDrop={handleDrop}
        onClick={() => !importing && fileRef.current?.click()}
      >
        <div className="icon"><Icons.Upload size={variant === 'full' ? 22 : 16} /></div>
        <div className="copy">
          <strong>{importing ? 'Opening book...' : (variant === 'full' ? 'Drop a book here' : 'Drop a book')}</strong>
          {variant === 'full' && (
            <span>{importing ? 'Preparing your library entry' : 'EPUB, or click to browse'}</span>
          )}
        </div>
        {variant === 'full' && <div className="kbd">⌘ O</div>}
      </div>
      {importError && <div className="import-error">{importError}</div>}
    </>
  )

  // Library content (continue card + grid). Shared between layouts.
  const libraryContent = (
    <>
      {continueBook && (
        <section className="library-section">
          <div className="section-head">
            <h2>Continue reading</h2>
            <div className="meta">{recentBooks.length} BOOK{recentBooks.length === 1 ? '' : 'S'}</div>
          </div>

          <div
            className={`continue-card${continueBook.exists === false ? ' missing' : ''}`}
            onClick={() => handleOpen(continueBook)}
            {...magneticHandlers()}
          >
            <div
              className={`cover ${COVERS[0]}${continueBook.cover_url ? ' has-real-cover' : ''}`}
              style={coverImageStyle(continueBook)}
            >
              {!continueBook.cover_url && <div className="cover-title">{continueBook.title}</div>}
            </div>
            <div className="continue-info">
              <div className="eyebrow">PAGE {(continueBook.last_position?.page || 0) + 1} OF {continueBook.page_count}</div>
              <h3>{continueBook.title}</h3>
              <div className="author">by {continueBook.author || 'Unknown'}</div>
              {continueBook.exists === false && (
                <div className="snippet" style={{ color: 'var(--ember)' }}>File missing — use × to remove from history.</div>
              )}
            </div>
            <div className="continue-cta">
              <Ring pct={bookProgress(continueBook)} />
              <button className="resume-btn" onClick={(e) => { e.stopPropagation(); handleOpen(continueBook) }}>
                Resume <Icons.ArrowRight size={16} />
              </button>
              <button
                className="continue-remove"
                onClick={(e) => handleDelete(e, continueBook)}
                title="Remove from history"
              >Remove</button>
            </div>
          </div>
        </section>
      )}

      {rest.length > 0 && (
        <section className="library-section">
          <div className="section-head">
            <h2>Your shelf</h2>
            <div className="meta">SORTED BY RECENT</div>
          </div>
          <div className="library-grid">
            {rest.map((b, i) => (
              <div
                key={b.id}
                className={`book-card${b.exists === false ? ' missing' : ''}`}
                onClick={() => handleOpen(b)}
                {...magneticHandlers()}
              >
                <div
                  className={`book-cover ${COVERS[(i + 1) % COVERS.length]}${b.cover_url ? ' has-real-cover' : ''}`}
                  style={coverImageStyle(b)}
                >
                  {!b.cover_url && (
                    <>
                      <div className="book-cover-author">{(b.author || '').split(' ').pop().toUpperCase()}</div>
                      <div className="book-cover-title">{b.title}</div>
                    </>
                  )}
                  <button
                    className="book-card-remove"
                    onClick={(e) => handleDelete(e, b)}
                    title="Remove from history"
                  >×</button>
                </div>
                <div className="book-info-row">
                  <div className="t">{b.title}</div>
                  <div className="a">{b.author || 'Unknown'}</div>
                  <div className="p">
                    <span>{bookProgress(b) > 0 ? `${Math.round(bookProgress(b) * 100)}%` : 'NEW'}</span>
                    <span>·</span>
                    <span>{b.page_count}pp</span>
                  </div>
                  {bookProgress(b) > 0 && (
                    <div className="book-progress-bar">
                      <div className="fill" style={{ width: `${bookProgress(b) * 100}%` }} />
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  )

  // ─── Empty state: full marketing hero on the left, drop zone, and a small
  // empty-library callout on the right. This is what a brand-new user sees. ───
  if (!hasLibrary) {
    return (
      <div className="welcome welcome-empty">
        <div className="welcome-left">
          <div className="brand-mark">
            <span className="bracket">[</span>
            <span className="title">Folio</span>
            <span className="bracket">]</span>
          </div>

          <DustMotes count={10} />

          <div className="welcome-hero">
            <div className="eyebrow">A READER FOR LISTENING</div>
            <HeroTitle />
            <p>Drop in an EPUB and we'll turn it into a followable audiobook, with the voice you choose, the pace you want, and every word in its place.</p>
            {statusBadges && <div className="status-badges">{statusBadges}</div>}
          </div>

          {dropZone('full')}

          <div className="welcome-footer">
            <span>KOKORO READER · ON-DEVICE TTS</span>
            <span>0 BOOKS IN LIBRARY</span>
          </div>
        </div>

        <div className="welcome-right">
          <div className="empty-library">
            <div className="empty-mark">{/* decorative serif glyph */}❦</div>
            <h2>Your shelf is empty</h2>
            <p>Once you add your first book, it'll wait for you here — picking up exactly where you left off.</p>
          </div>
        </div>
      </div>
    )
  }

  // ─── Library state: compact header strip at top (brand + drop zone +
  // status), with the library taking the bulk of the screen below. The
  // marketing hero retreats once it's done its job. ───
  return (
    <div className="welcome welcome-library">
      <header className="welcome-topbar">
        <DustMotes count={3} className="motes-row" />
        <div className="welcome-topbar-brand">
          <img className="welcome-topbar-logo" src="/folio-monochrome-icon.png" alt="Folio" draggable={false} />
        </div>

        <div className="welcome-topbar-drop">
          {dropZone('compact')}
        </div>
      </header>

      <main className="welcome-library-main">
        {libraryContent}
      </main>
    </div>
  )
})
