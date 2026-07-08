import { useState, useCallback, useEffect, useRef } from 'react'
import { apiFetch, apiJson } from '../api'
import type { BookState, PageText, Position } from '../types'
import { mergeBookSettingsIfChanged, sameBookSettings, type BookSettingsPatch } from './bookSettings'

function mergePosition(previous: Position | null | undefined, next: Position): Position {
  const merged: Position = { ...next }
  if (previous?.page === next.page) {
    if (merged.content_page == null) merged.content_page = previous.content_page
    if (merged.pages_per_view == null) merged.pages_per_view = previous.pages_per_view
    if (merged.layout_key == null) merged.layout_key = previous.layout_key
  }
  if (previous?.page === next.page && previous?.sentence_idx === next.sentence_idx && merged.chunk_progress == null) {
    merged.chunk_progress = previous.chunk_progress
  } else if (merged.chunk_progress == null) {
    merged.chunk_progress = 0
  }
  return merged
}

function sameReadablePosition(a: Position | null | undefined, b: Position | null | undefined): boolean {
  return (
    a?.page === b?.page &&
    a?.sentence_idx === b?.sentence_idx &&
    a?.content_page === b?.content_page &&
    a?.pages_per_view === b?.pages_per_view &&
    a?.layout_key === b?.layout_key &&
    a?.chunk_progress === b?.chunk_progress
  )
}

export default function useBookState() {
  const [book, setBook] = useState<BookState | null>(null)
  const [pageData, setPageData] = useState<PageText | null>(null)
  const [currentPage, setCurrentPage] = useState(0)
  const [loading, setLoading] = useState(false)
  const [textLoading, setTextLoading] = useState(false)
  const [recentBooks, setRecentBooks] = useState<BookState[]>([])
  const [recentLoaded, setRecentLoaded] = useState(false)
  const loadRequestRef = useRef(0)
  const activeBookId = book?.id ?? null
  const activeBookPageCount = book?.page_count ?? 0

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
    if (!activeBookId) return
    const requestId = ++loadRequestRef.current
    setLoading(true)
    setTextLoading(true)
    setCurrentPage(pageNum)
    setPageData(null)
    let loadedPageData: PageText | null = null
    try {
      const textRes = await apiFetch(`/api/book/${activeBookId}/page/${pageNum}/text`)
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
  }, [activeBookId])

  useEffect(() => {
    if (activeBookId) loadPage(currentPage)
  }, [activeBookId, loadPage]) // eslint-disable-line react-hooks/exhaustive-deps

  const goToPage = useCallback((pageNum: number) => {
    if (!activeBookId || pageNum < 0 || pageNum >= activeBookPageCount) return
    return loadPage(pageNum)
  }, [activeBookId, activeBookPageCount, loadPage])

  const savePosition = useCallback(async (
    pageOrPosition: number | Position,
    sentenceIdx = 0,
    options: Partial<Position> & { keepalive?: boolean } = {}
  ) => {
    if (!activeBookId) return
    const { keepalive = false, ...extra } = options
    const position: Position = typeof pageOrPosition === 'number'
      ? { page: pageOrPosition, sentence_idx: sentenceIdx, ...extra }
      : { ...pageOrPosition, ...extra }
    if (position.saved_at == null) position.saved_at = Date.now()
    // Swallow errors: callers are split between fire-and-forget (pause/stop)
    // and awaited (seek). Letting the error bubble up to fire-and-forget call
    // sites produces unhandled rejections on transient backend hiccups, and
    // there is no useful UI recovery — position re-saves on every navigation.
    try {
      const res = await apiFetch(`/api/book/${activeBookId}/position`, {
        method: 'POST',
        keepalive,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(position),
      })
      if (!res.ok) return
      setBook(prev => {
        if (prev?.id !== activeBookId) return prev
        const lastPosition = mergePosition(prev.last_position, position)
        return sameReadablePosition(prev.last_position, lastPosition)
          ? prev
          : { ...prev, last_position: lastPosition }
      })
      setRecentBooks(prev => {
        let changed = false
        const next = prev.map(item => {
          if (item.id !== activeBookId) return item
          const lastPosition = mergePosition(item.last_position, position)
          if (sameReadablePosition(item.last_position, lastPosition)) return item
          changed = true
          return { ...item, last_position: lastPosition }
        })
        return changed ? next : prev
      })
    } catch {
      // Position will be re-saved on the next navigation / pause / stop.
    }
  }, [activeBookId])

  const applyBookSettings = useCallback((settings: BookSettingsPatch) => {
    if (!activeBookId) return
    setBook(prev => (
      prev?.id === activeBookId
        ? mergeBookSettingsIfChanged(prev, settings)
        : prev
    ))
    setRecentBooks(prev => {
      let changed = false
      const next = prev.map(item => {
        if (item.id !== activeBookId || sameBookSettings(item, settings)) return item
        changed = true
        return mergeBookSettingsIfChanged(item, settings)
      })
      return changed ? next : prev
    })
  }, [activeBookId])

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
    openBook, uploadBook, goToPage, savePosition, applyBookSettings, addBookmark, removeBookmark, closeBook, deleteBook,
  }
}
