import { useRef, useState, useEffect, useCallback } from 'react'

export default function PdfViewer({
  pageImageUrl, facingPageImageUrl, facingPageNum, pageData,
  currentSentence, currentWordIdx, activePage, currentPage, pageCount,
  zoom, setZoom, highlightStyle = 'dim',
  searchTarget,
  onSentenceSelect,
}) {
  const scrollRef = useRef()
  const imgRef = useRef()
  const [imgNatural, setImgNatural] = useState({ w: 0, h: 0 })
  const [imgDisplayWidth, setImgDisplayWidth] = useState(0)

  const handleImgLoad = useCallback((e) => {
    setImgNatural({ w: e.target.naturalWidth, h: e.target.naturalHeight })
    setImgDisplayWidth(e.target.clientWidth || 0)
  }, [])

  useEffect(() => {
    const img = imgRef.current
    if (!img) return

    const updateWidth = () => setImgDisplayWidth(img.clientWidth || 0)
    updateWidth()

    const ro = new ResizeObserver(updateWidth)
    ro.observe(img)
    return () => ro.disconnect()
  }, [pageImageUrl, facingPageImageUrl, currentPage])

  // currentPage even → verso (left); odd → recto (right)
  const activeSide = currentPage % 2 === 0 ? 'verso' : 'recto'
  const versoSrc = activeSide === 'verso' ? pageImageUrl : facingPageImageUrl
  const rectoSrc = activeSide === 'recto' ? pageImageUrl : facingPageImageUrl
  const versoNum = activeSide === 'verso' ? currentPage : facingPageNum
  const rectoNum = activeSide === 'recto' ? currentPage : facingPageNum

  useEffect(() => {
    if (currentWordIdx < 0 || !pageData) return
    const sent = pageData.sentences[currentSentence]
    if (!sent || !sent.words[currentWordIdx]) return
    const word = sent.words[currentWordIdx]
    const el = scrollRef.current
    if (!el || !imgRef.current) return

    const displayW = imgRef.current.clientWidth
    const scaleX = displayW / (pageData.render_width || 1)
    const wordY = word.y * scaleX * zoom

    const viewTop = el.scrollTop
    const viewBottom = viewTop + el.clientHeight
    if (wordY < viewTop + 50 || wordY > viewBottom - 50) {
      el.scrollTo({ top: wordY - el.clientHeight / 3, behavior: 'smooth' })
    }
  }, [currentWordIdx, currentSentence, pageData, zoom])

  useEffect(() => {
    if (!searchTarget || searchTarget.page !== currentPage || searchTarget.sentenceIdx == null || !pageData) return
    const sent = pageData.sentences?.[searchTarget.sentenceIdx]
    const word = sent?.words?.[0]
    const el = scrollRef.current
    if (!el || !imgRef.current || !word) return

    const displayW = imgRef.current.clientWidth
    const scale = displayW / (pageData.render_width || 1)
    const targetY = word.y * scale * zoom
    el.scrollTo({ top: Math.max(0, targetY - el.clientHeight / 3), behavior: 'smooth' })
  }, [searchTarget, currentPage, pageData, zoom])

  const scaleX = imgNatural.w > 0 && pageData
    ? (imgDisplayWidth || imgNatural.w) / pageData.render_width
    : 1
  const searchSentenceIdx = searchTarget?.page === currentPage ? searchTarget.sentenceIdx : null
  const activeSentenceIdx = activePage === currentPage ? currentSentence : null

  const renderSentenceOverlay = (sent, sIdx, variant) => (
    sent.words.map((word, wIdx) => {
      const isCurWord = variant === 'playback' && activeSentenceIdx === currentSentence && wIdx === currentWordIdx
      return (
        <div
          key={`${variant}-${sIdx}-${wIdx}`}
          className={`word-highlight ${variant === 'search' ? 'search-hit' : (isCurWord ? 'active-word' : 'active-sentence')}`}
          style={{
            position: 'absolute',
            left: word.x * scaleX,
            top: word.y * scaleX,
            width: word.w * scaleX,
            height: word.h * scaleX,
            pointerEvents: 'none',
          }}
        />
      )
    })
  )

  const renderSentenceHitboxes = (sent, sIdx) => (
    sent.words.map((word, wIdx) => (
      <button
        type="button"
        key={`hitbox-${sIdx}-${wIdx}`}
        className="word-hitbox"
        onClick={(e) => {
          e.stopPropagation()
          onSentenceSelect?.(currentPage, sIdx)
        }}
        title="Read from this sentence"
        style={{
          position: 'absolute',
          left: word.x * scaleX,
          top: word.y * scaleX,
          width: word.w * scaleX,
          height: word.h * scaleX,
        }}
      />
    ))
  )

  const renderSheet = (side, src, pageNum) => {
    const isActive = side === activeSide
    return (
      <div className={`page-sheet ${side}`}>
        <div className="page-sheet-inner" style={{ position: 'relative', flex: 1 }}>
          {src ? (
            <img
              ref={isActive ? imgRef : undefined}
              src={src}
              alt={`Page ${(pageNum ?? 0) + 1}`}
              onLoad={isActive ? handleImgLoad : undefined}
              draggable={false}
              style={{ display: 'block', width: '100%' }}
            />
          ) : (
            <div style={{
              minHeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--ink-3)', fontFamily: 'var(--font-display)', fontStyle: 'italic', fontSize: 16,
            }}>{pageNum == null ? '' : 'Loading…'}</div>
          )}

          {isActive && pageData && (
            <>
              {pageData.sentences.map((sent, sIdx) => (
                <div key={`hitbox-sentence-${sIdx}`}>
                  {renderSentenceHitboxes(sent, sIdx)}
                </div>
              ))}
              {pageData.sentences.map((sent, sIdx) => {
                if (sIdx !== activeSentenceIdx && sIdx !== searchSentenceIdx) return null
                return (
                  <div key={`sentence-${sIdx}`}>
                    {sIdx === searchSentenceIdx && renderSentenceOverlay(sent, sIdx, 'search')}
                    {sIdx === activeSentenceIdx && renderSentenceOverlay(sent, sIdx, 'playback')}
                  </div>
                )
              })}
            </>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className={`page-scroll hl-${highlightStyle}`} ref={scrollRef}>
      <div className="spread" style={{ transform: `scale(${zoom})`, transformOrigin: 'top center' }}>
        {renderSheet('verso', versoSrc, versoNum)}
        {renderSheet('recto', rectoSrc, rectoNum)}
      </div>

      <div className="zoom-controls">
        <button onClick={() => setZoom(z => Math.max(0.5, z - 0.1))} title="Zoom out">−</button>
        <span>{Math.round(zoom * 100)}%</span>
        <button onClick={() => setZoom(z => Math.min(3, z + 0.1))} title="Zoom in">+</button>
        <button onClick={() => setZoom(1)} title="Reset zoom" style={{ width: 'auto', padding: '0 8px', borderRadius: 14 }}>Fit</button>
      </div>

      <div className="page-indicator">
        {versoNum != null && rectoNum != null
          ? `Pages ${versoNum + 1}–${rectoNum + 1} of ${pageCount}`
          : `Page ${currentPage + 1} of ${pageCount}`}
      </div>
    </div>
  )
}
