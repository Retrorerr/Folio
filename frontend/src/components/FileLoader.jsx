import { useCallback, useRef, useState } from 'react'

export default function FileLoader({ onUpload, recentBooks, onOpenRecent, onDeleteRecent }) {
  const [dragOver, setDragOver] = useState(false)
  const fileRef = useRef()

  const handleDrop = useCallback((e) => {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file && file.name.endsWith('.pdf')) onUpload(file)
  }, [onUpload])

  const handleFileSelect = useCallback((e) => {
    const file = e.target.files[0]
    if (file) onUpload(file)
  }, [onUpload])

  const handleDelete = useCallback((e, b) => {
    e.stopPropagation()
    const msg = b.exists
      ? `Remove "${b.title}" from history and delete the PDF?`
      : `Remove "${b.title}" from history?`
    if (!window.confirm(msg)) return
    onDeleteRecent?.(b.id, b.exists)
  }, [onDeleteRecent])

  const handleOpen = useCallback((b) => {
    if (!b.exists) {
      window.alert(`File not found:\n${b.filepath}\n\nUse the × button to remove it from history.`)
      return
    }
    onOpenRecent(b.filepath)
  }, [onOpenRecent])

  return (
    <div className="file-loader">
      <div
        className={`drop-zone ${dragOver ? 'drag-over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => fileRef.current?.click()}
      >
        <div className="drop-icon">&#128214;</div>
        <p>Drop a PDF here or click to browse</p>
        <input
          ref={fileRef}
          type="file"
          accept=".pdf"
          onChange={handleFileSelect}
          style={{ display: 'none' }}
        />
      </div>

      {recentBooks.length > 0 && (
        <div className="recent-books">
          <h3>Recent Books</h3>
          <ul>
            {recentBooks.map((b) => (
              <li
                key={b.id}
                className={b.exists === false ? 'missing' : ''}
                onClick={() => handleOpen(b)}
              >
                <span className="recent-title">
                  {b.title}
                  {b.exists === false && <span className="recent-missing"> (missing)</span>}
                </span>
                <span className="recent-author">{b.author}</span>
                <span className="recent-page">Page {b.last_position.page + 1}/{b.page_count}</span>
                <button
                  className="recent-delete"
                  onClick={(e) => handleDelete(e, b)}
                  title="Remove from history"
                >
                  &times;
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
