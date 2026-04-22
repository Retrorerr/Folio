import { useState, useCallback, useEffect, useRef } from 'react'

const API = ''

export default function useBookState() {
  const [book, setBook] = useState(null)
  const [pageData, setPageData] = useState(null) // {sentences, render_width, render_height}
  const [pageImageUrl, setPageImageUrl] = useState(null)
  const [facingPageImageUrl, setFacingPageImageUrl] = useState(null)
  const [facingPageNum, setFacingPageNum] = useState(null)
  const [currentPage, setCurrentPage] = useState(0)
  const [loading, setLoading] = useState(false)
  const [textLoading, setTextLoading] = useState(false)
  const [recentBooks, setRecentBooks] = useState([])
  const loadRequestRef = useRef(0)

  const fetchRecent = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/recent`)
      if (res.ok) setRecentBooks(await res.json())
    } catch {
      // Keep the last-known recent list if the backend is temporarily unavailable.
    }
  }, [])

  useEffect(() => { fetchRecent() }, [fetchRecent])

  const openBook = useCallback(async (filepath) => {
    setLoading(true)
    try {
      const res = await fetch(`${API}/api/book/open?filepath=${encodeURIComponent(filepath)}`, { method: 'POST' })
      if (!res.ok) throw new Error(await res.text())
      const data = await res.json()
      setBook(data)
      setCurrentPage(data.last_position?.page || 0)
      fetchRecent()
      return data
    } finally {
      setLoading(false)
    }
  }, [fetchRecent])

  const uploadBook = useCallback(async (file) => {
    setLoading(true)
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await fetch(`${API}/api/book/open-upload`, { method: 'POST', body: form })
      if (!res.ok) throw new Error(await res.text())
      const data = await res.json()
      setBook(data)
      setCurrentPage(data.last_position?.page || 0)
      fetchRecent()
      return data
    } finally {
      setLoading(false)
    }
  }, [fetchRecent])

  const loadPage = useCallback(async (pageNum) => {
    if (!book) return
    const requestId = ++loadRequestRef.current
    setLoading(true)
    setTextLoading(true)
    setCurrentPage(pageNum)
    setPageData(null)
    let loadedPageData = null
    const isEpub = book.format === 'epub'
    // Determine facing page: pair (0,1),(2,3)... — even=verso, odd=recto
    const facingNum = pageNum ^ 1
    const facingValid = !isEpub && facingNum >= 0 && facingNum < book.page_count
    // Load image first (fast), then text (may need OCR, slow)
    try {
      if (!isEpub) {
        const imgRes = await fetch(`${API}/api/book/${book.id}/page/${pageNum}/image`)
        if (imgRes.ok && loadRequestRef.current === requestId) {
          const blob = await imgRes.blob()
          setPageImageUrl((prev) => {
            if (prev) URL.revokeObjectURL(prev)
            return URL.createObjectURL(blob)
          })
        }
      }
      if (loadRequestRef.current === requestId) {
        setLoading(false)
      }
      // Kick off facing page image in parallel (don't block text load)
      if (facingValid) {
        fetch(`${API}/api/book/${book.id}/page/${facingNum}/image`).then(async (r) => {
          if (!r.ok || loadRequestRef.current !== requestId) return
          const b = await r.blob()
          setFacingPageImageUrl((prev) => {
            if (prev) URL.revokeObjectURL(prev)
            return URL.createObjectURL(b)
          })
          setFacingPageNum(facingNum)
        }).catch(() => {})
      } else {
        setFacingPageImageUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return null })
        setFacingPageNum(null)
      }
      const textRes = await fetch(`${API}/api/book/${book.id}/page/${pageNum}/text`)
      if (textRes.ok && loadRequestRef.current === requestId) {
        loadedPageData = await textRes.json()
        setPageData(loadedPageData)
      }
    } finally {
      if (loadRequestRef.current === requestId) {
        setLoading(false)
        setTextLoading(false)
      }
    }
    return loadedPageData
  }, [book])

  useEffect(() => {
    if (book) loadPage(currentPage)
  }, [book]) // eslint-disable-line react-hooks/exhaustive-deps

  const goToPage = useCallback((pageNum) => {
    if (!book || pageNum < 0 || pageNum >= book.page_count) return
    return loadPage(pageNum)
  }, [book, loadPage])

  const savePosition = useCallback(async (page, sentenceIdx) => {
    if (!book) return
    await fetch(`${API}/api/book/${book.id}/position`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page, sentence_idx: sentenceIdx }),
    })
  }, [book])

  const addBookmark = useCallback(async (page, sentenceIdx, label = '') => {
    if (!book) return
    await fetch(`${API}/api/book/${book.id}/bookmark`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page, sentence_idx: sentenceIdx, label }),
    })
    // Update bookmarks locally instead of re-opening book (avoids resetting playback settings)
    setBook(prev => prev ? {
      ...prev,
      bookmarks: [...prev.bookmarks, { page, sentence_idx: sentenceIdx, label: label || `Page ${page + 1}` }],
    } : prev)
  }, [book])

  const removeBookmark = useCallback(async (idx) => {
    if (!book) return
    await fetch(`${API}/api/book/${book.id}/bookmark/${idx}`, { method: 'DELETE' })
    setBook(prev => prev ? {
      ...prev,
      bookmarks: prev.bookmarks.filter((_, i) => i !== idx),
    } : prev)
  }, [book])

  const deleteBook = useCallback(async (bookId, deleteFile = false) => {
    await fetch(`${API}/api/book/${bookId}?delete_file=${deleteFile}`, { method: 'DELETE' })
    fetchRecent()
  }, [fetchRecent])

  const closeBook = useCallback(() => {
    if (pageImageUrl) URL.revokeObjectURL(pageImageUrl)
    if (facingPageImageUrl) URL.revokeObjectURL(facingPageImageUrl)
    setBook(null)
    setPageData(null)
    setPageImageUrl(null)
    setFacingPageImageUrl(null)
    setFacingPageNum(null)
    setCurrentPage(0)
    fetchRecent()
  }, [pageImageUrl, facingPageImageUrl, fetchRecent])

  return {
    book, pageData, pageImageUrl, facingPageImageUrl, facingPageNum, currentPage, loading, textLoading, recentBooks,
    openBook, uploadBook, goToPage, savePosition, addBookmark, removeBookmark, closeBook, deleteBook,
  }
}
