import { useRef, useState, useCallback } from 'react'
import { Icons } from './icons'

const COVERS = ['cover-a', 'cover-b', 'cover-c', 'cover-d', 'cover-e', 'cover-f', 'cover-g', 'cover-h']

function Ring({ pct }) {
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

export default function Welcome({ onUpload, recentBooks, onOpenRecent, onDeleteRecent, statusBadges }) {
  const [drag, setDrag] = useState(false)
  const fileRef = useRef()

  const handleDrop = useCallback((e) => {
    e.preventDefault()
    setDrag(false)
    const file = e.dataTransfer.files[0]
    if (file && /\.(pdf|epub)$/i.test(file.name)) onUpload(file)
  }, [onUpload])

  const handleFileSelect = useCallback((e) => {
    const file = e.target.files[0]
    if (file) onUpload(file)
  }, [onUpload])

  const handleOpen = useCallback((b) => {
    if (b.exists === false) {
      window.alert(`File not found:\n${b.filepath}\n\nUse the × button to remove it from history.`)
      return
    }
    onOpenRecent(b.filepath)
  }, [onOpenRecent])

  const handleDelete = useCallback((e, b) => {
    e.stopPropagation()
    const msg = b.exists !== false
      ? `Remove "${b.title}" from history and delete the PDF?`
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

  return (
    <div className="welcome">
      <div className="welcome-left">
        <div className="brand-mark">
          <span className="bracket">[</span>
          <span className="title">Folio</span>
          <span className="bracket">]</span>
        </div>

        <div className="welcome-hero">
          <div className="eyebrow">A READER FOR LISTENING</div>
          <h1>Hear any book <em>read aloud</em>, on every page.</h1>
          <p>Drop in a PDF or EPUB and we'll turn it into a followable audiobook, with the voice you choose, the pace you want, and every word in its place.</p>
          {statusBadges && <div className="status-badges">{statusBadges}</div>}
        </div>

        <input ref={fileRef} type="file" accept=".pdf,.epub" onChange={handleFileSelect} style={{ display: 'none' }} />
        <div
          className={`drop-zone${drag ? ' drag-over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDrag(true) }}
          onDragLeave={() => setDrag(false)}
          onDrop={handleDrop}
          onClick={() => fileRef.current?.click()}
        >
          <div className="icon"><Icons.Upload size={22} /></div>
          <div className="copy">
            <strong>Drop a book here</strong>
            <span>PDF or EPUB, or click to browse</span>
          </div>
          <div className="kbd">⌘ O</div>
        </div>

        <div className="welcome-footer">
          <span>KOKORO READER · ON-DEVICE TTS</span>
          <span>{recentBooks?.length || 0} BOOKS IN LIBRARY</span>
        </div>
      </div>

      <div className="welcome-right">
        {continueBook ? (
          <>
            <div className="section-head">
              <h2>Continue reading</h2>
              <div className="meta">{recentBooks.length} BOOK{recentBooks.length === 1 ? '' : 'S'}</div>
            </div>

            <div className={`continue-card${continueBook.exists === false ? ' missing' : ''}`} onClick={() => handleOpen(continueBook)}>
              <div className={`cover ${COVERS[0]}`}>
                <div className="cover-title">{continueBook.title}</div>
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
                  onClick={(e) => handleDelete(e, continueBook)}
                  style={{
                    fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '.14em',
                    color: 'var(--ink-3)', textTransform: 'uppercase', padding: '4px 8px'
                  }}
                  title="Remove from history"
                >Remove</button>
              </div>
            </div>
          </>
        ) : (
          <div className="section-head">
            <h2>Your shelf</h2>
            <div className="meta">EMPTY — DROP A PDF TO BEGIN</div>
          </div>
        )}

        {rest.length > 0 && (
          <>
            <div className="section-head">
              <h2>Your shelf</h2>
              <div className="meta">SORTED BY RECENT</div>
            </div>
            <div className="library-grid">
              {rest.map((b, i) => (
                <div key={b.id} className={`book-card${b.exists === false ? ' missing' : ''}`} onClick={() => handleOpen(b)}>
                  <div className={`book-cover ${COVERS[(i + 1) % COVERS.length]}`}>
                    <div className="book-cover-author">{(b.author || '').split(' ').pop().toUpperCase()}</div>
                    <div className="book-cover-title">{b.title}</div>
                    <button
                      onClick={(e) => handleDelete(e, b)}
                      style={{
                        position: 'absolute', top: 6, right: 6, width: 22, height: 22,
                        borderRadius: '50%', background: 'rgba(0,0,0,0.3)', color: '#e5cb96',
                        fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2,
                      }}
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
          </>
        )}
      </div>
    </div>
  )
}
