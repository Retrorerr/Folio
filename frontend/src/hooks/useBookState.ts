import { useState, useCallback, useEffect, useRef } from 'react'
import { apiFetch, apiJson } from '../api'
import type { BookState, PageText } from '../types'

export default function useBookState() {
  const [book, setBook] = useState<BookState | null>(null)
  const [pageData, setPageData] = useState<PageText | null>(null)
  const [currentPage, setCurrentPage] = useState(0)
  const [loading, setLoading] = useState(false)
  const [textLoading, setTextLoading] = useState(false)
  const [recentBooks, setRecentBooks] = useState<BookState[]>([])
  const [recentLoaded, setRecentLoaded] = useState(false)
  const loadRequestRef = useRef(0)

  const fetchRecent = useCallback(async () => {
    try {
      const res = await apiFetch('/api/recent')
      if (res.ok) {
        setRecentBooks(await res.json())
        setRecentLoaded(true)
      }
    } catch {
      // Keep the last-known recent list if the backend is temporarily unavailable.
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const run = async () => {
      await fetchRecent()
      if (!cancelled && !recentLoaded) timer = setTimeout(run, 900)
    }
    run()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [fetchRecent, recentLoaded])

  const openBook = useCallback(async (filepath: string) => {
    setLoading(true)
    try {
      const data = await apiJson<BookState>(`/api/book/open?filepath=${encodeURIComponent(filepath)}`, { method: 'POST' })
      setBook(data)
      setCurrentPage(data.last_position?.page || 0)
      fetchRecent()
      return data
    } finally {
      setLoading(false)
    }
  }, [fetchRecent])

  const uploadBook = useCallback(async (file: File) => {
    setLoading(true)
    try {
      const form = new FormData()
      form.append('file', file)
      const data = await apiJson<BookState>('/api/book/open-upload', { method: 'POST', body: form })
      setBook(data)
      setCurrentPage(data.last_position?.page || 0)
      fetchRecent()
      return data
    } finally {
      setLoading(false)
    }
  }, [fetchRecent])

  const loadPage = useCallback(async (pageNum: number) => {
    if (!book) return
    const requestId = ++loadRequestRef.current
    setLoading(true)
    setTextLoading(true)
    setCurrentPage(pageNum)
    let loadedPageData: PageText | null = null
    try {
      const textRes = await apiFetch(`/api/book/${book.id}/page/${pageNum}/text`)
      if (textRes.ok && loadRequestRef.current === requestId) {
        const json = await textRes.json() as PageText
        // Re-check after the JSON parse — if the user navigated away while the
        // body was streaming in, we drop this payload rather than overwriting
        // the newer page's data.
        if (loadRequestRef.current === requestId) {
          loadedPageData = json
          setPageData(loadedPageData)
        }
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

  const goToPage = useCallback((pageNum: number) => {
    if (!book || pageNum < 0 || pageNum >= book.page_count) return
    return loadPage(pageNum)
  }, [book, loadPage])

  const savePosition = useCallback(async (page: number, sentenceIdx: number) => {
    if (!book) return
    // Swallow errors: callers are split between fire-and-forget (pause/stop)
    // and awaited (seek). Letting the error bubble up to fire-and-forget call
    // sites produces unhandled rejections on transient backend hiccups, and
    // there is no useful UI recovery — position re-saves on every navigation.
    try {
      await apiFetch(`/api/book/${book.id}/position`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page, sentence_idx: sentenceIdx }),
      })
    } catch {
      // Position will be re-saved on the next navigation / pause / stop.
    }
  }, [book])

  const addBookmark = useCallback(async (page: number, sentenceIdx: number, label = '') => {
    if (!book) return
    await apiFetch(`/api/book/${book.id}/bookmark`, {
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

  const removeBookmark = useCallback(async (idx: number) => {
    if (!book) return
    await apiFetch(`/api/book/${book.id}/bookmark/${idx}`, { method: 'DELETE' })
    setBook(prev => prev ? {
      ...prev,
      bookmarks: prev.bookmarks.filter((_, i) => i !== idx),
    } : prev)
  }, [book])

  const deleteBook = useCallback(async (bookId: string, deleteFile = false) => {
    await apiFetch(`/api/book/${bookId}?delete_file=${deleteFile}`, { method: 'DELETE' })
    fetchRecent()
  }, [fetchRecent])

  const closeBook = useCallback(() => {
    // Bump the request id so any in-flight text fetches can't clobber state
    // after we've cleared it.
    loadRequestRef.current += 1
    setBook(null)
    setPageData(null)
    setCurrentPage(0)
    fetchRecent()
  }, [fetchRecent])

  return {
    book, pageData, currentPage, loading, textLoading, recentBooks, recentLoaded,
    openBook, uploadBook, goToPage, savePosition, addBookmark, removeBookmark, closeBook, deleteBook,
  }
}
