import { memo, useEffect, useRef, useState, useLayoutEffect, useCallback, useMemo } from 'react'
import type React from 'react'
import { clampReaderViewTarget, readerPageNavigationState } from '../readerNavigation'
import type { ReaderPageNavigationState } from '../readerNavigation'
import type {
  Position,
  ReaderNavHandle,
  ReaderSearchTarget,
  ReflowDocument,
  ReflowProgress,
} from '../types'

const PAGE_WIDTH = 680
const PAGE_HEIGHT = 936
const PAGE_PAD_X = 56
const CONTENT_TOP = 120
const CONTENT_BOTTOM = 96
const GAP = PAGE_PAD_X * 2
const TEXT_WIDTH = PAGE_WIDTH - PAGE_PAD_X * 2
const TEXT_HEIGHT = PAGE_HEIGHT - CONTENT_TOP - CONTENT_BOTTOM
const TWO_PAGE_WIDTH = PAGE_WIDTH * 2
const TWO_PAGE_MARGIN = 24
const PAGE_TURN_MS = 560
const PAGE_TURN_CLEAR_MS = PAGE_TURN_MS + 80
const SINGLE_PAGE_TURN_MS = 280
const LINE_SWITCH_HYSTERESIS = 0.018
type TurnDirection = 'next' | 'prev'
type TurnState = 'started' | 'busy' | 'skipped'
type DoubleTurn = {
  key: string
  direction: TurnDirection
  fromFirstPage: number
  toFirstPage: number
  frontPage: number
  backPage: number
  holdPage: number
  contentEls: React.ReactNode
  contentPageCount: number
  nCols: number
  flowWidth: number
  chapterPageOffset: number
  runHead: string
  chapLabel: string
}
const PAGINATION_CACHE_VERSION = 1
const PAGINATION_CACHE_PREFIX = 'folio:pagination:'
const PAGINATION_CACHE_INDEX_KEY = `${PAGINATION_CACHE_PREFIX}index`
const PAGINATION_CACHE_LIMIT = 24
const DASHBOARD_PAGE_TOTAL_PREFIX = 'folio:dashboard-page-total:'
const READER_POSITION_CACHE_VERSION = 1
const READER_POSITION_PREFIX = 'folio:reader-position:'

function getInitialPagesPerView() {
  if (typeof window === 'undefined') return 1
  const androidTabletLandscape = document.documentElement.dataset.platform === 'android' &&
    document.documentElement.dataset.androidShell === 'tablet-landscape'
  return window.innerWidth >= (androidTabletLandscape ? 1040 : TWO_PAGE_WIDTH + TWO_PAGE_MARGIN) ? 2 : 1
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n))
}

function classNames(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(' ')
}

function blockRole(block: any) {
  return block?.role || 'prose'
}

function blockRoleClass(role: string) {
  return `reflow-para-${String(role || 'prose').replace(/[^a-z0-9_-]/gi, '-')}`
}

function debugFlag(globalName: string, storageKey: string) {
  if (typeof window === 'undefined') return false
  return Boolean(window[globalName]) || window.localStorage?.getItem(storageKey) === '1'
}

function debugRect(rect: any) {
  if (!rect) return null
  return {
    left: Math.round(rect.left),
    top: Math.round(rect.top),
    right: Math.round(rect.right),
    bottom: Math.round(rect.bottom),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  }
}

function safeStorage() {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function paginationCacheKey({
  bookId,
  reflow,
  pagesPerView,
  theme,
}: {
  bookId?: string | null
  reflow: any
  pagesPerView: number
  theme?: string | null
}) {
  if (!bookId || !reflow?.chapters?.length) return null
  const version = reflow.version || reflow.chunker_version || 'unknown'
  const chapterCount = reflow.chapters.length
  return [
    PAGINATION_CACHE_PREFIX,
    PAGINATION_CACHE_VERSION,
    bookId,
    version,
    theme || 'default',
    TEXT_WIDTH,
    TEXT_HEIGHT,
    pagesPerView,
    chapterCount,
  ].join(':')
}

function chapterReadingWeight(chapter: any) {
  if (!chapter?.blocks?.length) return 1
  let weight = 0
  for (const block of chapter.blocks) {
    if (block?.type === 'paragraph' && Array.isArray(block.sentences)) {
      for (const sentence of block.sentences) {
        weight += String(sentence?.text || '').trim().length
      }
    } else if (block?.text) {
      weight += String(block.text).trim().length * 0.6
    }
  }
  return Math.max(1, weight)
}

function positionLayoutMatches(position: any, layoutKey: string | null, pagesPerView: number) {
  if (!position || position.content_page == null) return false
  if (position.layout_key && layoutKey && position.layout_key !== layoutKey) return false
  if (position.pages_per_view != null && position.pages_per_view !== pagesPerView) return false
  return true
}

function contentPageFromPosition(position: any, chapterIdx: number, layoutKey: string | null, pagesPerView: number) {
  if (!position || position.page !== chapterIdx) return null
  if (!positionLayoutMatches(position, layoutKey, pagesPerView)) return null
  const value = Number.parseInt(String(position.content_page), 10)
  return Number.isFinite(value) && value >= 0 ? value : null
}

function rememberPaginationCacheKey(storage: Storage, key: string) {
  try {
    const raw = storage.getItem(PAGINATION_CACHE_INDEX_KEY)
    const existing = raw ? JSON.parse(raw) : []
    const keys = Array.isArray(existing) ? existing.filter((item) => typeof item === 'string' && item !== key) : []
    keys.unshift(key)
    for (const stale of keys.slice(PAGINATION_CACHE_LIMIT)) {
      storage.removeItem(stale)
    }
    storage.setItem(PAGINATION_CACHE_INDEX_KEY, JSON.stringify(keys.slice(0, PAGINATION_CACHE_LIMIT)))
  } catch {
    // Cache maintenance should never interrupt reading.
  }
}

function readPaginationCache(key: string | null, expectedChapters: number) {
  if (!key || !expectedChapters) return null
  const storage = safeStorage()
  if (!storage) return null
  try {
    const raw = storage.getItem(key)
    if (!raw) return null
    const cached = JSON.parse(raw)
    if (cached?.version !== PAGINATION_CACHE_VERSION) return null
    if (cached?.chapterCount !== expectedChapters) return null
    if (!Array.isArray(cached?.counts)) return null
    const counts = cached.counts
      .slice(0, expectedChapters)
      .map((count) => Math.max(0, Number.parseInt(String(count), 10) || 0))
    if (counts.length !== expectedChapters) return null
    return counts
  } catch {
    storage.removeItem(key)
    return null
  }
}

function writePaginationCache(key: string | null, counts: number[], expectedChapters: number) {
  if (!key || !expectedChapters || counts.length !== expectedChapters) return
  const storage = safeStorage()
  if (!storage) return
  try {
    storage.setItem(key, JSON.stringify({
      version: PAGINATION_CACHE_VERSION,
      chapterCount: expectedChapters,
      counts,
      savedAt: Date.now(),
    }))
    rememberPaginationCacheKey(storage, key)
  } catch {
    // localStorage can be full/blocked; the reader should still work.
  }
}

function readerPositionKey(bookId?: string | null, chapterIdx?: number) {
  if (!bookId || chapterIdx == null || chapterIdx < 0) return null
  return `${READER_POSITION_PREFIX}${bookId}:${chapterIdx}`
}

function readReaderContentPage(
  bookId: string | null | undefined,
  chapterIdx: number,
  layoutKey: string | null = null,
  pagesPerView: number | null = null
) {
  const key = readerPositionKey(bookId, chapterIdx)
  const storage = safeStorage()
  if (!key || !storage) return null
  try {
    const raw = storage.getItem(key) || ''
    if (!raw) return null
    if (raw.trim().startsWith('{')) {
      const cached = JSON.parse(raw)
      if (cached?.version !== READER_POSITION_CACHE_VERSION) return null
      if (cached?.layoutKey && layoutKey && cached.layoutKey !== layoutKey) return null
      if (cached?.pagesPerView && pagesPerView && cached.pagesPerView !== pagesPerView) return null
      const contentPage = Number.parseInt(String(cached?.contentPage), 10)
      return Number.isFinite(contentPage) && contentPage >= 0 ? contentPage : null
    }
    const value = Number.parseInt(raw, 10)
    return Number.isFinite(value) && value >= 0 ? value : null
  } catch {
    return null
  }
}

function writeReaderContentPage(
  bookId: string | null | undefined,
  chapterIdx: number,
  contentPage: number,
  layoutKey: string | null,
  pagesPerView: number
) {
  const key = readerPositionKey(bookId, chapterIdx)
  const storage = safeStorage()
  if (!key || !storage || !Number.isFinite(contentPage) || contentPage < 0) return
  try {
    storage.setItem(key, JSON.stringify({
      version: READER_POSITION_CACHE_VERSION,
      contentPage: Math.floor(contentPage),
      pagesPerView,
      layoutKey,
      savedAt: Date.now(),
    }))
  } catch {
    // Visual resume is best-effort; storage failures should never block reading.
  }
}

// Build a Range covering [start, end) character offsets inside the element's
// concatenated textContent. Walks text nodes so it works through nested spans
// (e.g. drop-cap). Returns null if offsets are out of bounds.
function rangeForCharOffsets(el: Element, start: number, end: number) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  let offset = 0
  let startNode = null, startOff = 0, endNode = null, endOff = 0
  let node: Node | null
  while ((node = walker.nextNode())) {
    const len = node.nodeValue?.length || 0
    if (startNode == null && offset + len >= start) {
      startNode = node
      startOff = start - offset
    }
    if (offset + len >= end) {
      endNode = node
      endOff = end - offset
      break
    }
    offset += len
  }
  if (!startNode || !endNode) return null
  try {
    const range = document.createRange()
    range.setStart(startNode, startOff)
    range.setEnd(endNode, endOff)
    return range
  } catch {
    return null
  }
}

function wordRect(active: Element, word: any) {
  const range = rangeForCharOffsets(active, word.start, word.end)
  if (!range) return null
  const rects = Array.from(range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0)
  const rect = rects.length ? normalizedWordRect(rects) : range.getBoundingClientRect()
  range.detach?.()
  return rect.width ? rect : null
}

function normalizedWordRect(rects: DOMRect[]) {
  if (rects.length === 1) return rects[0]
  const sortedByHeight = [...rects].sort((a, b) => a.height - b.height)
  const shortest = sortedByHeight[0]
  const tallest = sortedByHeight[sortedByHeight.length - 1]
  if (tallest.height > shortest.height * 1.8) return shortest

  const left = Math.min(...rects.map(rect => rect.left))
  const top = Math.min(...rects.map(rect => rect.top))
  const right = Math.max(...rects.map(rect => rect.right))
  const bottom = Math.max(...rects.map(rect => rect.bottom))
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
  }
}

function rectToLocal(rect: DOMRect | any, rootRect: DOMRect, scrollEl: Element | null) {
  // Cursor lives inside the scrolling .page-scroll container, so it's
  // positioned in the container's *content* coordinate space, not the
  // viewport. getBoundingClientRect returns viewport coords, so we add the
  // current scroll offset to anchor the cursor to its content position.
  // Without this, scrolling the reader leaves the cursor behind / ahead of
  // the active word.
  const scrollTop = scrollEl?.scrollTop || 0
  const scrollLeft = scrollEl?.scrollLeft || 0
  return {
    x: rect.left - rootRect.left + scrollLeft,
    y: rect.top - rootRect.top + scrollTop,
    width: rect.width,
    height: rect.height,
  }
}

function rectIntersects(a: DOMRect | any, b: DOMRect | any, pad = 2) {
  return (
    a.right >= b.left - pad &&
    a.left <= b.right + pad &&
    a.bottom >= b.top - pad &&
    a.top <= b.bottom + pad
  )
}

function pointIntersectsRect(x: number, y: number, rect: DOMRect | any, pad = 2) {
  return (
    x >= rect.left - pad &&
    x <= rect.right + pad &&
    y >= rect.top - pad &&
    y <= rect.bottom + pad
  )
}

function visibleColumnLayout(viewportRect: DOMRect | undefined) {
  if (!viewportRect) return null
  const columns = viewportRect.width > TEXT_WIDTH + GAP / 2 ? 2 : 1
  const layoutWidth = columns * TEXT_WIDTH + (columns - 1) * GAP
  const scale = viewportRect.width / layoutWidth
  return {
    columns,
    stride: (TEXT_WIDTH + GAP) * scale,
  }
}

function rectColumnIndex(rect: DOMRect | any, viewportRect: DOMRect | undefined) {
  const layout = visibleColumnLayout(viewportRect)
  if (!layout) return 0
  const mid = rect.left + rect.width / 2
  return clamp(
    Math.floor(Math.max(0, mid - viewportRect!.left) / layout.stride),
    0,
    layout.columns - 1,
  )
}

function sameVisualLine(a, b, viewportRect?: DOMRect) {
  if (!a || !b) return false
  const aMid = a.top + a.height / 2
  const bMid = b.top + b.height / 2
  const sameRow = Math.abs(aMid - bMid) < Math.max(7, Math.min(a.height, b.height) * 0.7)
  const sameColumn = rectColumnIndex(a, viewportRect) === rectColumnIndex(b, viewportRect)
  return sameRow && sameColumn
}

function unionRects(rects: Array<DOMRect | any>) {
  const left = Math.min(...rects.map(rect => rect.left))
  const top = Math.min(...rects.map(rect => rect.top))
  const right = Math.max(...rects.map(rect => rect.right))
  const bottom = Math.max(...rects.map(rect => rect.bottom))
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
  }
}

function expandRect(rect: any, x: number, y: number) {
  return {
    left: rect.left - x,
    top: rect.top - y,
    right: rect.right + x,
    bottom: rect.bottom + y,
    width: rect.width + x * 2,
    height: rect.height + y * 2,
  }
}

function clampRectToBounds(rect: any, bounds: any) {
  const left = Math.max(rect.left, bounds.left)
  const top = Math.max(rect.top, bounds.top)
  const right = Math.min(rect.right, bounds.right)
  const bottom = Math.min(rect.bottom, bounds.bottom)
  return {
    left,
    top,
    right,
    bottom,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  }
}

function activeLineRect(active: Element, words: any[], currentIdx: number, viewportRect: DOMRect | undefined) {
  const currentRect = wordRect(active, words[currentIdx])
  if (!currentRect) return null

  // Drop caps create an oversized first-letter box that can distort the
  // paragraph-level line rect. For that opening sentence, keep the measured
  // line scoped to the sentence's own fragments.
  const lineSource = active.closest('.reflow-para') || active
  const dropCap = lineSource.querySelector('.drop-cap')
  const hasDropCap = Boolean(dropCap)
  const sourceRange = document.createRange()
  sourceRange.selectNodeContents(lineSource)
  const sourceRects = Array.from(sourceRange.getClientRects()).filter(rect => (
    rect.width > 0 &&
    rect.height > 0 &&
    (!hasDropCap || rect.height < currentRect.height * 1.8)
  ))
  sourceRange.detach?.()

  const lineRects = sourceRects.filter(rect => sameVisualLine(currentRect, rect, viewportRect))
  let startIdx = currentIdx
  let endIdx = currentIdx
  for (let i = currentIdx - 1; i >= 0; i--) {
    const rect = wordRect(active, words[i])
    if (!rect || !sameVisualLine(currentRect, rect, viewportRect)) break
    startIdx = i
  }
  for (let i = currentIdx + 1; i < words.length; i++) {
    const rect = wordRect(active, words[i])
    if (!rect || !sameVisualLine(currentRect, rect, viewportRect)) break
    endIdx = i
  }
  const wordLineRects: Array<DOMRect | any> = []
  for (let i = startIdx; i <= endIdx; i++) {
    const rect = wordRect(active, words[i])
    if (rect) wordLineRects.push(rect)
  }
  const lineRect = lineRects.length
    ? unionRects(lineRects)
    : (wordLineRects.length ? unionRects(wordLineRects) : currentRect)

  let rect = expandRect(lineRect, 18, 9)
  if (viewportRect) rect = clampRectToBounds(rect, viewportRect)
  const dropCapRect = dropCap?.getBoundingClientRect() || null
  const markerRect = lineMarkerAnchorRect(lineRect, currentRect, viewportRect, dropCapRect)
  const lineKey = [
    lineSource.getAttribute('data-block-index') || '',
    Math.round(lineRect.top),
    Math.round(lineRect.left),
    Math.round(lineRect.right),
    Math.round(lineRect.height),
  ].join(':')
  return rect.width && rect.height ? { rect, lineRect, markerRect, currentRect, startIdx, endIdx, lineKey } : null
}

type CursorMode = 'hover' | 'selected' | 'playback' | 'turn-suppressed'
type CursorHideMode = CursorMode | 'hidden' | 'force-hidden'
type CursorPlacement = {
  x: number
  y: number
  width: number
  height: number
  key: string
}

const LINE_CURSOR_GUTTER = 26
const LINE_CURSOR_COLUMN_SNAP_DISTANCE = 96

function placeLineOverlay(el: HTMLElement, rect: CursorPlacement, opacity: number, mode: CursorMode) {
  const opacityKey = `${opacity}`
  const wasVisible = el.classList.contains('is-visible')
  const previousMode = el.dataset.cursorMode
  const previousX = Number.parseFloat(el.dataset.cursorX || '')
  const positionChanged = el.dataset.cursorKey !== rect.key
  const modeChanged = el.dataset.cursorMode !== mode
  const opacityChanged = el.dataset.cursorOpacity !== opacityKey
  if (!positionChanged && !modeChanged && !opacityChanged && wasVisible) return

  const horizontalDistance = Number.isFinite(previousX)
    ? Math.abs(rect.x - previousX)
    : 0
  const shouldSnapPosition = (
    !wasVisible ||
    (positionChanged && (
      previousMode !== mode
    ))
  )
  const shouldSnapHorizontal = (
    !shouldSnapPosition &&
    positionChanged &&
    horizontalDistance > LINE_CURSOR_COLUMN_SNAP_DISTANCE
  )

  // A cursor returning from a hidden page should appear at its destination,
  // not travel across the spread from the last visible line. Playback handoff
  // and cross-column jumps snap for the same reason: the marker should never
  // sweep horizontally through paragraph text while it is catching up to the
  // reader. Vertical movement stays animated because the marker remains in
  // the clear gutter beside the text for the entire journey.
  if (shouldSnapPosition) el.dataset.cursorMode = 'instant'
  else el.dataset.cursorMode = mode
  el.dataset.cursorPosition = shouldSnapHorizontal ? 'horizontal-snap' : 'smooth'

  if (positionChanged) {
    el.style.transform = `translate3d(${rect.x}px, ${rect.y}px, 0)`
    el.style.width = `${rect.width}px`
    el.style.height = `${rect.height}px`
    el.dataset.cursorKey = rect.key
    el.dataset.cursorX = `${rect.x}`
    el.dataset.cursorY = `${rect.y}`
  }

  if (shouldSnapPosition) void el.offsetWidth
  el.dataset.cursorMode = mode
  el.dataset.cursorOpacity = opacityKey
  el.dataset.cursorSticky = mode === 'selected' ? 'true' : 'false'
  el.style.opacity = opacityKey
  el.classList.toggle('is-visible', opacity > 0)
  if (shouldSnapHorizontal) {
    const key = rect.key
    requestAnimationFrame(() => {
      if (el.isConnected && el.dataset.cursorKey === key) {
        el.dataset.cursorPosition = 'smooth'
      }
    })
  }
}

function lineMarkerRect(region: any, rootRect: DOMRect, scrollEl: Element | null): CursorPlacement {
  const local = rectToLocal(region.markerRect || region.lineRect || region.currentRect || region.rect, rootRect, scrollEl)
  const x = Math.max(0, local.x - LINE_CURSOR_GUTTER)
  const y = local.y - 2
  const width = 2
  const height = Math.max(18, local.height + 4)
  return {
    x,
    y,
    width,
    height,
    key: `${region.lineKey || ''}:${Math.round(x * 2) / 2}:${Math.round(y * 2) / 2}:${Math.round(height * 2) / 2}`,
  }
}

function lineMarkerAnchorRect(
  lineRect: any,
  currentRect: DOMRect | any,
  viewportRect: DOMRect | undefined,
  dropCapRect?: DOMRect | null,
) {
  const layout = visibleColumnLayout(viewportRect)
  const columnLeft = layout && viewportRect
    ? viewportRect.left + rectColumnIndex(currentRect, viewportRect) * layout.stride
    : lineRect.left
  let left = Math.max(columnLeft, lineRect.left)
  let top = lineRect.top
  let bottom = lineRect.bottom

  // A floated drop cap normally sits immediately to the left of the opening
  // text, so its rectangle does not intersect the line rectangle horizontally.
  // Detect the opening line by vertical proximity instead. Anchor the marker
  // to the cap's left edge and grow it to the cap's full height; subsequent
  // lines return to the regular line-sized marker even while wrapping beside
  // the float.
  const dropCapWrapsLine = Boolean(
    dropCapRect &&
    lineRect.bottom >= dropCapRect.top &&
    lineRect.top <= dropCapRect.bottom + lineRect.height
  )
  const dropCapOpeningLine = Boolean(
    dropCapRect &&
    dropCapWrapsLine &&
    Math.abs(lineRect.top - dropCapRect.top) <= Math.max(12, lineRect.height * 0.75)
  )
  if (dropCapRect && dropCapWrapsLine) {
    left = Math.max(columnLeft, dropCapRect.left)
  }
  if (dropCapRect && dropCapOpeningLine) {
    top = Math.min(lineRect.top, dropCapRect.top)
    bottom = Math.max(lineRect.bottom, dropCapRect.bottom)
  }
  return {
    left,
    top,
    right: Math.max(left + 2, lineRect.right),
    bottom,
    width: Math.max(2, lineRect.right - left),
    height: Math.max(2, bottom - top),
  }
}

type WeightedWord = { start: number; end: number; weightStart: number; weightEnd: number }
type WordCacheResult = { key: string; words: WeightedWord[]; totalWeight: number }

const EMPTY_WORD_CACHE: WordCacheResult = { key: '', words: [], totalWeight: 0 }
const WORD_CACHE = new WeakMap<Element, { text: string; result: WordCacheResult }>()

function wordWeight(token: string) {
  const coreLength = token.replace(/[^A-Za-z0-9]/g, '').length || token.length
  let weight = Math.max(1, Math.pow(coreLength, 0.82))
  if (/[.!?]["')\]]*$/.test(token)) weight += 3.2
  else if (/[,;:]["')\]]*$/.test(token)) weight += 1.35
  else if (/--$/.test(token) || /-$/.test(token)) weight += 0.65
  return weight
}

function wordCacheForElement(active: Element | null) {
  if (!active) return EMPTY_WORD_CACHE
  const text = active.textContent || ''
  const cached = WORD_CACHE.get(active)
  if (cached?.text === text) return cached.result
  const words: WeightedWord[] = []
  const re = /\S+/g
  let m
  let weight = 0
  while ((m = re.exec(text))) {
    const nextWeight = weight + wordWeight(m[0])
    words.push({ start: m.index, end: m.index + m[0].length, weightStart: weight, weightEnd: nextWeight })
    weight = nextWeight
  }
  const key = [
    active.getAttribute('data-sent-idx') || '',
    active.getAttribute('data-local-sent-idx') || '',
    text.length,
    text.slice(0, 48),
  ].join('|')
  const result = { key, words, totalWeight: weight }
  WORD_CACHE.set(active, { text, result })
  return result
}

function predictedWordIndex(words: WeightedWord[], progress: number) {
  if (!words.length) return { index: -1, weightedPosition: 0 }
  const totalWeight = words[words.length - 1].weightEnd || words.length
  const target = clamp(progress, 0, 0.999999) * totalWeight
  let lo = 0
  let hi = words.length - 1
  let result = hi
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (target < words[mid].weightEnd) {
      result = mid
      hi = mid - 1
    } else {
      lo = mid + 1
    }
  }
  return { index: result, weightedPosition: target }
}

function wordIndexForOffset(words: WeightedWord[], offset: number) {
  if (!words.length) return -1
  const safeOffset = Math.max(0, offset)
  let lo = 0
  let hi = words.length - 1
  let result = hi
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (safeOffset <= words[mid].end) {
      result = mid
      hi = mid - 1
    } else {
      lo = mid + 1
    }
  }
  return result
}

function progressForWord(words: WeightedWord[], index: number) {
  if (!words.length || index < 0) return 0
  const totalWeight = words[words.length - 1].weightEnd || words.length
  if (!totalWeight) return 0
  return clamp(words[Math.min(index, words.length - 1)].weightStart / totalWeight, 0, 0.98)
}

function measuredSentenceElement(measure: Element | null, sentenceIdx: number, indexType = 'local') {
  if (!measure || sentenceIdx == null || sentenceIdx < 0) return null
  const attr = indexType === 'global' ? 'data-sent-idx' : 'data-local-sent-idx'
  return measure.querySelector(`[${attr}="${sentenceIdx}"]`)
}

function measuredSentenceView(
  measure: Element | null,
  sentenceIdx: number,
  indexType: string,
  pagesPerView: number,
) {
  const el = measuredSentenceElement(measure, sentenceIdx, indexType)
  if (!el) return null
  const contentPage = Math.floor((el as HTMLElement).offsetTop / TEXT_HEIGHT)
  return Math.max(0, Math.floor(contentPage / pagesPerView))
}

function measuredReadingView(
  measure: Element | null,
  sentenceIdx: number,
  progress: number,
  indexType: string,
  pagesPerView: number,
) {
  const el = measuredSentenceElement(measure, sentenceIdx, indexType)
  if (!el) return null
  const { words } = wordCacheForElement(el)
  if (words.length) {
    const { index } = predictedWordIndex(words, progress)
    if (index >= 0) {
      const currentRect = wordRect(el, words[index])
      if (currentRect) {
        const measureRect = measure!.getBoundingClientRect()
        const wordY = currentRect.top - measureRect.top + currentRect.height / 2
        const contentPage = Math.max(0, Math.floor(wordY / TEXT_HEIGHT))
        return Math.max(0, Math.floor(contentPage / pagesPerView))
      }
    }
  }
  return measuredSentenceView(measure, sentenceIdx, indexType, pagesPerView)
}

function caretRangeFromPoint(x: number, y: number) {
  const doc: any = document
  if (typeof doc.caretRangeFromPoint === 'function') {
    return doc.caretRangeFromPoint(x, y)
  }
  if (typeof doc.caretPositionFromPoint === 'function') {
    const pos = doc.caretPositionFromPoint(x, y)
    if (!pos) return null
    const range = document.createRange()
    range.setStart(pos.offsetNode, pos.offset)
    range.collapse(true)
    return range
  }
  return null
}

function sentenceFromNode(node: Node | null) {
  const element = node?.nodeType === Node.ELEMENT_NODE
    ? node as Element
    : node?.parentElement
  return element?.closest('.sentence') || null
}

function textOffsetInElement(root: Element, node: Node, offset: number) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let total = 0
  let current = walker.nextNode()
  while (current) {
    if (current === node) return total + offset
    total += current.textContent?.length || 0
    current = walker.nextNode()
  }
  return total
}

interface ReflowViewerProps {
  bookId: string
  reflow: ReflowDocument | null
  chapterIdx?: number
  setChapterIdx?: (chapter: number) => Promise<unknown> | undefined
  runningHead?: string
  currentSentence?: number
  activeChapterIdx?: number
  chunkProgress?: number
  isPlaying?: boolean
  onProgress?: (progress: ReflowProgress) => void
  onNavigationState?: (state: ReaderPageNavigationState) => void
  navRef?: React.MutableRefObject<ReaderNavHandle>
  motion?: boolean
  wheelPaging?: boolean
  searchTarget?: ReaderSearchTarget | null
  followAlongMode?: boolean
  onSentenceSelect?: (chapter: number, sentence: number, options?: { progress?: number }) => void
  theme?: string
  resumePosition?: Position | null
  onVisualPositionChange?: (position: Position) => void
}

function ReflowViewer({
  bookId,
  reflow,
  chapterIdx = 0,
  setChapterIdx,
  runningHead,
  currentSentence = -1,
  activeChapterIdx = chapterIdx,
  chunkProgress = 0,
  isPlaying = false,
  onProgress,
  onNavigationState,
  navRef,
  motion = true,
  wheelPaging = false,
  searchTarget = null,
  followAlongMode = false,
  onSentenceSelect,
  theme = 'default',
  resumePosition = null,
  onVisualPositionChange,
}: ReflowViewerProps) {
  const androidRuntime = typeof document !== 'undefined' && document.documentElement.dataset.platform === 'android'
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const measureRef = useRef<HTMLDivElement | null>(null)
  const chapterMeasureRef = useRef<HTMLDivElement | null>(null)
  const androidLineTapRef = useRef({ pointerId: -1, x: 0, y: 0 })
  const [contentPageCount, setContentPageCount] = useState(1)
  const [chapterPageCounts, setChapterPageCounts] = useState<number[]>([])
  const [measureChapterIdx, setMeasureChapterIdx] = useState<number | null>(null)
  const [viewPage, setViewPage] = useState(0)
  const [pagesPerView, setPagesPerView] = useState(getInitialPagesPerView)
  const [spreadScale, setSpreadScale] = useState(1)
  const [modeMeasured, setModeMeasured] = useState(false)

  const chapter = reflow?.chapters?.[chapterIdx]
  const chapterCount = reflow?.chapters?.length || 0
  const paginationKey = useMemo(
    () => paginationCacheKey({ bookId, reflow, pagesPerView, theme }),
    [bookId, reflow, pagesPerView, theme]
  )
  const setMeasuredChapterPages = useCallback((idx: number, pages: number) => {
    setChapterPageCounts(prev => {
      if (!chapterCount || idx < 0 || idx >= chapterCount) return prev
      const sameLength = prev.length === chapterCount
      const next = sameLength ? [...prev] : Array.from({ length: chapterCount }, (_, i) => prev[i] || 0)
      if (sameLength && next[idx] === pages) return prev
      next[idx] = pages
      writePaginationCache(paginationKey, next, chapterCount)
      return next
    })
  }, [chapterCount, paginationKey])
  const viewCount = Math.max(1, Math.ceil(contentPageCount / pagesPerView))
  const firstVisiblePage = viewPage * pagesPerView
  const chapterWeights = useMemo(
    () => (reflow?.chapters || []).map(chapterReadingWeight),
    [reflow]
  )
  const estimatedChapterPageCounts = useMemo(() => {
    if (!reflow?.chapters?.length) return []
    const counts = Array.from({ length: chapterCount }, (_, idx) => (
      chapterPageCounts[idx] || (idx === chapterIdx ? contentPageCount : 0)
    ))
    let measuredPages = 0
    let measuredWeight = 0
    counts.forEach((pages, idx) => {
      if (pages > 0) {
        measuredPages += pages
        measuredWeight += chapterWeights[idx] || 1
      }
    })
    const density = measuredWeight > 0 ? measuredPages / measuredWeight : 1 / 2400
    return counts.map((pages, idx) => (
      pages > 0 ? pages : Math.max(1, Math.ceil((chapterWeights[idx] || 1) * density))
    ))
  }, [reflow, chapterCount, chapterIdx, chapterPageCounts, chapterWeights, contentPageCount])
  const chapterPageOffset = useMemo(() => {
    if (!reflow?.chapters) return 0
    let total = 0
    for (let i = 0; i < chapterIdx; i++) {
      total += estimatedChapterPageCounts[i] || 1
    }
    return total
  }, [reflow, chapterIdx, estimatedChapterPageCounts])
  const bookPageTotal = useMemo(() => {
    if (!reflow?.chapters?.length) return Math.max(1, contentPageCount)
    return estimatedChapterPageCounts.reduce((total, pages) => total + Math.max(1, pages || 1), 0)
  }, [reflow, estimatedChapterPageCounts, contentPageCount])
  const allChaptersMeasured = useMemo(() => {
    if (!reflow?.chapters?.length) return modeMeasured && contentPageCount > 0
    if (!modeMeasured || chapterPageCounts.length !== chapterCount) return false
    return chapterPageCounts.every(pages => Number.isFinite(pages) && pages > 0)
  }, [reflow, modeMeasured, contentPageCount, chapterPageCounts, chapterCount])

  useEffect(() => {
    const storage = safeStorage()
    if (!storage || !bookId || !allChaptersMeasured || !Number.isFinite(bookPageTotal) || bookPageTotal <= 0) return
    storage.setItem(`${DASHBOARD_PAGE_TOTAL_PREFIX}${bookId}`, String(Math.max(1, Math.round(bookPageTotal))))
  }, [bookId, bookPageTotal, allChaptersMeasured])
  const pendingLanding = useRef('first')
  const pendingScrollSentence = useRef<any>(null)
  const pendingContentPage = useRef<number | null>(null)
  const initialResumeLandingRef = useRef<string | null>(null)
  const stateRef = useRef({ viewPage: 0, viewCount: 1, chapterIdx: 0, pagesPerView: 1 })
  const visualPositionReadyRef = useRef(false)
  const followTurnKeyRef = useRef('')
  const pendingFollowTargetRef = useRef<any>(null)
  const [followRetryTick, setFollowRetryTick] = useState(0)
  const followRetryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearFollowRetry = useCallback(() => {
    if (followRetryTimeoutRef.current) {
      clearTimeout(followRetryTimeoutRef.current)
      followRetryTimeoutRef.current = null
    }
  }, [])

  const queueFollowRetry = useCallback(() => {
    if (followRetryTimeoutRef.current) return
    followRetryTimeoutRef.current = setTimeout(() => {
      followRetryTimeoutRef.current = null
      setFollowRetryTick((tick) => (tick + 1) % 1000000)
    }, 180)
  }, [])

  const chapterMeasureOrder = useMemo(() => {
    const total = reflow?.chapters?.length || 0
    if (!total) return []
    const order: number[] = []
    for (let i = chapterIdx - 1; i >= 0; i -= 1) order.push(i)
    for (let i = chapterIdx + 1; i < total; i += 1) order.push(i)
    return order
  }, [reflow, chapterIdx])

  const renderChapterContent = useCallback((targetChapter: any) => {
    if (!targetChapter) return null

    let localSentenceIdx = 0

    let targetDropCapBlockIdx = -1
    for (let i = 0; i < targetChapter.blocks.length; i++) {
      const block = targetChapter.blocks[i]
      if (block.type !== 'paragraph') continue
      const joined = block.sentences.map(s => s.text || '').join(' ').trim()
      const startsWithQuote = /^["']/.test(joined)
      if (joined.length >= 140 && !startsWithQuote) {
        targetDropCapBlockIdx = i
        break
      }
    }
    if (targetDropCapBlockIdx === -1) {
      targetDropCapBlockIdx = targetChapter.blocks.findIndex(b => b.type === 'paragraph')
    }

    return (
      <>
        {targetChapter.number || targetChapter.title ? (
          <div className="chapter-opener" style={{ breakAfter: 'avoid' }}>
            {targetChapter.number && <div className="label">CHAPTER {targetChapter.number}</div>}
            <h1>{targetChapter.title}</h1>
            <div className="fleuron">. . .</div>
          </div>
        ) : null}
        {targetChapter.blocks.map((block, i) => {
          if (block.type === 'dinkus') {
            return <div key={i} className="reflow-dinkus" data-block-kind="section-break">. . .</div>
          }
          if (block.type === 'heading') {
            const Tag = `h${Math.min(4, Math.max(2, block.level || 2))}` as React.ElementType
            return (
              <Tag
                key={i}
                className="reflow-heading"
                data-block-kind="heading"
                data-block-level={block.level || 2}
              >
                {block.text}
              </Tag>
            )
          }
          if (block.type !== 'paragraph') return null

          const isFirstBodyPara = i === targetDropCapBlockIdx
          const prevType = targetChapter.blocks[i - 1]?.type
          const startsFresh = i === 0 || prevType === 'dinkus' || prevType === 'heading'
          const role = blockRole(block)
          return (
            <p
              key={i}
              className={classNames(
                'reflow-para',
                startsFresh && 'first',
                isFirstBodyPara && 'dropcap-para',
                blockRoleClass(role)
              )}
              data-block-kind={role}
              data-block-index={i}
            >
              {block.sentences.map((sent, si) => {
                const localIdx = localSentenceIdx
                localSentenceIdx += 1
                const isDrop = isFirstBodyPara && si === 0
                const text = sent.text || ''
                return (
                  <span
                    key={si}
                    className="sentence"
                    data-sent-idx={sent.idx}
                    data-local-sent-idx={localIdx}
                  >
                    {isDrop && text ? (<><span className="drop-cap">{text.charAt(0)}</span>{text.slice(1)}</>) : text}
                    {' '}
                  </span>
                )
              })}
            </p>
          )
        })}
      </>
    )
  }, [])

  const contentEls = useMemo(
    () => renderChapterContent(chapter),
    [chapter, renderChapterContent]
  )
  const runHeadText = runningHead || reflow?.metadata?.running_head || ''
  const chapterLabel = chapter
    ? `${chapter.number ? `${chapter.number} - ` : ''}${(chapter.title || '').toUpperCase()}`
    : ''

  // Single-page mode has no flipper — a brief fade+slide masks the instant
  // content swap when nav happens. `singleTurn` is the direction; cleared
  // after the animation runs.
  const [singleTurn, setSingleTurn] = useState<TurnDirection | null>(null)
  const singleTurnTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [doubleTurn, setDoubleTurn] = useState<DoubleTurn | null>(null)
  const doubleTurnTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [cursorRefreshTick, setCursorRefreshTick] = useState(0)
  const cursorRefreshFrameRef = useRef<number | null>(null)
  const refreshCursorAfterTurn = useCallback(() => {
    if (cursorRefreshFrameRef.current != null) cancelAnimationFrame(cursorRefreshFrameRef.current)
    cursorRefreshFrameRef.current = requestAnimationFrame(() => {
      cursorRefreshFrameRef.current = null
      setCursorRefreshTick((tick) => (tick + 1) % 1000000)
    })
  }, [])
  const isPageTurning = Boolean(singleTurn || doubleTurn)
  const pageNavigation = readerPageNavigationState(
    viewPage,
    viewCount,
    chapterIdx,
    chapterCount,
    isPageTurning,
  )

  useEffect(() => {
    onNavigationState?.({
      canGoNext: pageNavigation.canGoNext,
      canGoPrevious: pageNavigation.canGoPrevious,
    })
  }, [onNavigationState, pageNavigation.canGoNext, pageNavigation.canGoPrevious])

  const triggerSingleTurn = useCallback((direction: TurnDirection): TurnState => {
    if (!motion) return 'skipped'
    if (singleTurnTimeoutRef.current) return 'busy'
    setSingleTurn(direction)
    singleTurnTimeoutRef.current = setTimeout(() => {
      setSingleTurn(null)
      singleTurnTimeoutRef.current = null
      refreshCursorAfterTurn()
    }, SINGLE_PAGE_TURN_MS)
    return 'started'
  }, [motion, refreshCursorAfterTurn])
  const triggerDoubleTurn = useCallback((
    direction: TurnDirection,
    fromView: number,
    toView: number,
    ppv: number,
  ): TurnState => {
    if (!motion || ppv !== 2) return 'skipped'
    if (doubleTurnTimeoutRef.current) return 'busy'

    const fromFirstPage = Math.max(0, fromView * ppv)
    const toFirstPage = toView * ppv
    // A double-page turn has four visible surfaces. The old stationary page
    // remains beneath the sheet until the turning page covers it; the front of
    // the sheet is the old page, and the back is the destination page printed
    // on the reverse side of that same physical sheet.
    const frontPage = direction === 'next' ? fromFirstPage + 1 : fromFirstPage
    const backPage = direction === 'next' ? toFirstPage : toFirstPage + 1
    const holdPage = direction === 'next' ? fromFirstPage : fromFirstPage + 1
    const snapshotCols = Math.max(1, contentPageCount)
    setDoubleTurn({
      key: `${direction}:${fromFirstPage}:${toFirstPage}:${Date.now()}`,
      direction,
      fromFirstPage,
      toFirstPage,
      frontPage,
      backPage,
      holdPage,
      contentEls,
      contentPageCount,
      nCols: snapshotCols,
      flowWidth: snapshotCols * TEXT_WIDTH + (snapshotCols - 1) * GAP,
      chapterPageOffset,
      runHead: runHeadText,
      chapLabel: chapterLabel,
    })

    doubleTurnTimeoutRef.current = setTimeout(() => {
      setDoubleTurn(null)
      doubleTurnTimeoutRef.current = null
      refreshCursorAfterTurn()
    }, PAGE_TURN_CLEAR_MS)
    return 'started'
  }, [chapterLabel, chapterPageOffset, contentEls, contentPageCount, motion, refreshCursorAfterTurn, runHeadText])

  // Reading/selection cursor — a single minimal line. It uses the same
  // weighted-word estimate as follow-along page turns, but renders beside the
  // active visual line instead of tinting text.
  const cursorRef = useRef<HTMLDivElement | null>(null)
  const wordsCacheRef = useRef<WeightedWord[]>([])
  const wordsCacheKeyRef = useRef('')
  const cursorDebugRef = useRef({ lastKey: '', lastAt: 0 })
  const selectedLineRef = useRef<any>(null)
  const hoverFrameRef = useRef<number | null>(null)
  const hoverPointRef = useRef<{ x: number; y: number } | null>(null)
  const playbackLineCacheRef = useRef<{ key: string; placements: Map<number, any> }>({
    key: '',
    placements: new Map(),
  })
  const playbackLineHoldRef = useRef<any>(null)

  const findVisibleSentence = useCallback((sentenceIdx: number) => {
    const root = scrollRef.current
    if (!root) return null
    const live = root.querySelector('.reflow-viewport .reflow-flow:not(.reflow-measure)')
    return live?.querySelector(`.sentence[data-local-sent-idx="${sentenceIdx}"]`) || null
  }, [])

  const findLiveSentence = useCallback((sentenceIdx: number) => {
    if (activeChapterIdx !== chapterIdx) return null
    return findVisibleSentence(sentenceIdx)
  }, [activeChapterIdx, chapterIdx, findVisibleSentence])

  const selectedLineStillVisible = useCallback((selection = selectedLineRef.current) => {
    if (!selection?.placement || selection.chapterIdx !== chapterIdx || selection.pagesPerView !== pagesPerView) return false
    const sentence = findVisibleSentence(selection.sentenceIdx)
    const viewport = sentence?.closest('.reflow-viewport')?.getBoundingClientRect()
    const rect = sentence?.getBoundingClientRect()
    return Boolean(rect && viewport && rectIntersects(rect, viewport, 1))
  }, [chapterIdx, findVisibleSentence, pagesPerView])

  const selectedLineMatchesCurrentView = useCallback((selection = selectedLineRef.current) => (
    Boolean(
      selection?.placement &&
      selection.chapterIdx === chapterIdx &&
      selection.pagesPerView === pagesPerView &&
      (selection.viewPage === viewPage || selectedLineStillVisible(selection))
    )
  ), [chapterIdx, pagesPerView, selectedLineStillVisible, viewPage])

  const readingViewForPosition = useCallback((sentenceIdx: number, progress: number) => (
    measuredReadingView(measureRef.current, sentenceIdx, progress, 'local', pagesPerView)
  ), [pagesPerView])

  const showLineCursor = useCallback((placement: CursorPlacement, opacity = 1, mode: CursorMode = 'playback') => {
    const cursor = cursorRef.current
    if (!cursor || !placement) return
    placeLineOverlay(cursor, placement, opacity, mode)
  }, [])

  const cursorPlacementForRegion = useCallback((region: any) => {
    const root = scrollRef.current
    if (!root || !region) return null
    const rootRect = root.getBoundingClientRect()
    const scale = Number.isFinite(spreadScale) && spreadScale > 0 ? spreadScale : 1
    if (Math.abs(scale - 1) < 0.001) return lineMarkerRect(region, rootRect, root)

    // Chromium reports descendant ranges in the pre-zoom coordinate space,
    // while the cursor is rendered outside the zoomed spread. Project the
    // measured line back into the page-scroll coordinate space first.
    const visualRect = (rect: any) => rect ? {
      left: rootRect.left + (rect.left - rootRect.left) * scale,
      top: rootRect.top + (rect.top - rootRect.top) * scale,
      right: rootRect.left + (rect.right - rootRect.left) * scale,
      bottom: rootRect.top + (rect.bottom - rootRect.top) * scale,
      width: rect.width * scale,
      height: rect.height * scale,
    } : rect
    return lineMarkerRect({
      ...region,
      rect: visualRect(region.rect),
      lineRect: visualRect(region.lineRect),
      markerRect: visualRect(region.markerRect),
      currentRect: visualRect(region.currentRect),
    }, rootRect, root)
  }, [spreadScale])

  const hideLineCursor = useCallback((mode: CursorHideMode = 'hidden') => {
    const cursor = cursorRef.current
    if (!cursor) return
    if (mode === 'hidden' && cursor.dataset.cursorSticky === 'true') return
    cursor.style.opacity = '0'
    cursor.classList.remove('is-visible')
    cursor.dataset.cursorMode = mode === 'force-hidden' ? 'hidden' : mode
    cursor.dataset.cursorOpacity = '0'
    cursor.dataset.cursorSticky = 'false'
  }, [])

  const locateLineAtPoint = useCallback((clientX: number, clientY: number) => {
    const root = scrollRef.current
    if (!root) return null
    const viewport = root.querySelector('.reflow-viewport')
    const viewportRect = viewport?.getBoundingClientRect()
    if (!viewportRect) return null
    const rootRect = root.getBoundingClientRect()
    const scale = Number.isFinite(spreadScale) && spreadScale > 0 ? spreadScale : 1
    const geometryX = rootRect.left + (clientX - rootRect.left) / scale
    const geometryY = rootRect.top + (clientY - rootRect.top) / scale
    if (
      geometryX < viewportRect.left ||
      geometryX > viewportRect.right ||
      geometryY < viewportRect.top ||
      geometryY > viewportRect.bottom
    ) return null

    const range = caretRangeFromPoint(clientX, clientY)
    let sentence = sentenceFromNode(range?.startContainer || null)
    let words = sentence && viewport.contains(sentence)
      ? wordCacheForElement(sentence).words
      : []
    let wordIdx = -1
    if (sentence && words.length && range?.startContainer) {
      const offset = textOffsetInElement(sentence, range.startContainer, range.startOffset)
      wordIdx = wordIndexForOffset(words, offset)
    }
    let region = wordIdx >= 0
      ? activeLineRect(sentence!, words, wordIdx, viewportRect)
      : null

    // Android WebView can return a caret range from an adjacent visual line
    // when the compact phone page is scaled with CSS zoom. Treat the caret as
    // a fast path, then recover from the rendered line fragments themselves.
    if (!region || !pointIntersectsRect(geometryX, geometryY, region.rect)) {
      sentence = null
      words = []
      wordIdx = -1
      region = null
      const candidates = Array.from(viewport.querySelectorAll('.sentence[data-local-sent-idx]'))
      for (const candidate of candidates) {
        const candidateRange = document.createRange()
        candidateRange.selectNodeContents(candidate)
        const lineFragments = Array.from(candidateRange.getClientRects()).filter(rect => (
          rect.width > 0 &&
          rect.height > 0 &&
          pointIntersectsRect(geometryX, geometryY, expandRect(rect, 18, 9))
        ))
        candidateRange.detach?.()
        if (!lineFragments.length) continue

        const candidateWords = wordCacheForElement(candidate).words
        let bestWordIdx = -1
        let bestDistance = Number.POSITIVE_INFINITY
        for (let idx = 0; idx < candidateWords.length; idx++) {
          const rect = wordRect(candidate, candidateWords[idx])
          if (!rect || !lineFragments.some(fragment => sameVisualLine(fragment, rect, viewportRect))) continue
          const dx = geometryX < rect.left
            ? rect.left - geometryX
            : (geometryX > rect.right ? geometryX - rect.right : 0)
          const dy = geometryY < rect.top
            ? rect.top - geometryY
            : (geometryY > rect.bottom ? geometryY - rect.bottom : 0)
          const distance = Math.hypot(dx, dy)
          if (distance < bestDistance) {
            bestDistance = distance
            bestWordIdx = idx
          }
        }
        if (bestWordIdx < 0) continue
        const candidateRegion = activeLineRect(candidate, candidateWords, bestWordIdx, viewportRect)
        if (!candidateRegion || !pointIntersectsRect(geometryX, geometryY, candidateRegion.rect)) continue
        sentence = candidate
        words = candidateWords
        wordIdx = bestWordIdx
        region = candidateRegion
        break
      }
    }

    if (!sentence || !region || wordIdx < 0) return null
    const sentenceIdx = Number.parseInt(sentence.getAttribute('data-local-sent-idx') || '-1', 10)
    if (!Number.isFinite(sentenceIdx) || sentenceIdx < 0) return null
    const placement = cursorPlacementForRegion(region)
    if (!placement) return null
    const lineStartWordIdx = Math.max(0, region.startIdx ?? wordIdx)
    return {
      region,
      placement,
      sentenceIdx,
      progress: progressForWord(words, lineStartWordIdx),
      wordIdx,
      lineStartWordIdx,
      text: sentence.textContent || '',
    }
  }, [cursorPlacementForRegion, spreadScale])

  // Word boundaries only change with the active sentence/chapter. Rebuilding
  // this cache on every progress tick forces repeated text walks at 20Hz.
  useLayoutEffect(() => {
    wordsCacheRef.current = []
    wordsCacheKeyRef.current = ''
    if (currentSentence == null || currentSentence < 0) return
    const active = findLiveSentence(currentSentence)
    if (!active) return
    const text = active.textContent || ''
    const { key, words } = wordCacheForElement(active)
    wordsCacheRef.current = words
    wordsCacheKeyRef.current = key
    if (typeof window !== 'undefined') {
      window.__folioCursorWords = {
        currentSentence,
        activeChapterIdx,
        wordCount: words.length,
        textPreview: text.slice(0, 120),
      }
    }
  }, [currentSentence, activeChapterIdx, chapterIdx, findLiveSentence])

  const restoreSelectedOrHide = useCallback(() => {
    if (isPageTurning) {
      hideLineCursor('turn-suppressed')
      return
    }
    const selected = selectedLineRef.current
    const handoffActive = Number.isFinite(selected?.handoffUntil) && performance.now() < selected.handoffUntil
    if (selected?.placement && (selectedLineMatchesCurrentView(selected) || handoffActive)) {
      showLineCursor(selected.placement, 1, 'selected')
    } else {
      hideLineCursor()
    }
  }, [hideLineCursor, isPageTurning, selectedLineMatchesCurrentView, showLineCursor])

  const flushHoverCursor = useCallback(() => {
    hoverFrameRef.current = null
    const point = hoverPointRef.current
    if (!point || isPlaying || isPageTurning) return
    if (selectedLineMatchesCurrentView()) {
      showLineCursor(selectedLineRef.current.placement, 1, 'selected')
      return
    }
    const located = locateLineAtPoint(point.x, point.y)
    if (!located) {
      restoreSelectedOrHide()
      return
    }
    showLineCursor(located.placement, 0.86, 'hover')
  }, [isPageTurning, isPlaying, locateLineAtPoint, restoreSelectedOrHide, selectedLineMatchesCurrentView, showLineCursor])

  const handleLinePointerMove = useCallback((event: React.PointerEvent) => {
    if (event.pointerType === 'touch' || event.pointerType === 'pen') return
    if (isPlaying || isPageTurning || selectedLineMatchesCurrentView()) return
    hoverPointRef.current = { x: event.clientX, y: event.clientY }
    if (hoverFrameRef.current == null) {
      hoverFrameRef.current = requestAnimationFrame(flushHoverCursor)
    }
  }, [flushHoverCursor, isPageTurning, isPlaying, selectedLineMatchesCurrentView])

  const handleLinePointerLeave = useCallback(() => {
    if (isPlaying) return
    if (isPageTurning) {
      hideLineCursor('turn-suppressed')
      return
    }
    hoverPointRef.current = null
    if (hoverFrameRef.current != null) {
      cancelAnimationFrame(hoverFrameRef.current)
      hoverFrameRef.current = null
    }
    restoreSelectedOrHide()
  }, [hideLineCursor, isPageTurning, isPlaying, restoreSelectedOrHide])

  const selectLineAtPoint = useCallback((clientX: number, clientY: number) => {
    if (isPageTurning) return
    const located = locateLineAtPoint(clientX, clientY)
    if (!located) return
    if (hoverFrameRef.current != null) {
      cancelAnimationFrame(hoverFrameRef.current)
      hoverFrameRef.current = null
    }
    selectedLineRef.current = {
      ...located,
      chapterIdx,
      viewPage,
      pagesPerView,
      handoffUntil: performance.now() + 4000,
    }
    showLineCursor(located.placement, 1, 'selected')
    onSentenceSelect?.(chapterIdx, located.sentenceIdx, { progress: located.progress })
  }, [chapterIdx, isPageTurning, locateLineAtPoint, onSentenceSelect, pagesPerView, showLineCursor, viewPage])

  const handleLineDoubleClick = useCallback((event: React.MouseEvent) => {
    if (androidRuntime || event.button !== 0) return
    event.preventDefault()
    selectLineAtPoint(event.clientX, event.clientY)
  }, [androidRuntime, selectLineAtPoint])

  const handleAndroidLinePointerDown = useCallback((event: React.PointerEvent) => {
    if (!androidRuntime || (event.pointerType !== 'touch' && event.pointerType !== 'pen')) return
    const target = event.target as HTMLElement | null
    if (target?.closest('button, a, input, textarea, select, [role="button"]')) return
    androidLineTapRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY }
  }, [androidRuntime])

  const handleAndroidLinePointerUp = useCallback((event: React.PointerEvent) => {
    const tap = androidLineTapRef.current
    androidLineTapRef.current = { pointerId: -1, x: 0, y: 0 }
    if (!androidRuntime || event.pointerId !== tap.pointerId) return
    if (Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > 12) return
    event.preventDefault()
    selectLineAtPoint(event.clientX, event.clientY)
  }, [androidRuntime, selectLineAtPoint])

  const cancelAndroidLineTap = useCallback(() => {
    androidLineTapRef.current = { pointerId: -1, x: 0, y: 0 }
  }, [])

  useEffect(() => () => {
    if (hoverFrameRef.current != null) cancelAnimationFrame(hoverFrameRef.current)
  }, [])

  useLayoutEffect(() => {
    if (isPageTurning) {
      selectedLineRef.current = null
      hideLineCursor('turn-suppressed')
      return
    }
    const selected = selectedLineRef.current
    if (!selected || selectedLineMatchesCurrentView(selected)) return
    const handoffActive = Number.isFinite(selected.handoffUntil) && performance.now() < selected.handoffUntil
    if (handoffActive) {
      showLineCursor(selected.placement, 1, 'selected')
      return
    }
    if (isPlaying) {
      hideLineCursor()
      return
    }
    hideLineCursor()
  }, [chapterIdx, hideLineCursor, isPageTurning, isPlaying, pagesPerView, selectedLineMatchesCurrentView, showLineCursor, viewPage])

  // While audio is playing, the line trails the estimated word/line inside the
  // generated chunk. While paused, a clicked line remains parked until the user
  // hovers/selects elsewhere.
  useLayoutEffect(() => {
    const cursor = cursorRef.current
    const root = scrollRef.current
    if (!cursor || !root) return
    const reportCursor = (reason: string, extra: any = {}) => {
      if (typeof window === 'undefined') return
      const entry = {
        reason,
        isPlaying,
        chunkProgress,
        currentSentence,
        activeChapterIdx,
        chapterIdx,
        viewPage,
        pagesPerView,
        wordCount: wordsCacheRef.current.length,
        selectedSentence: selectedLineRef.current?.sentenceIdx ?? null,
        cursorStyle: cursor.getAttribute('style') || '',
        ...extra,
      }
      window.__folioCursorDebug = entry

      if (!debugFlag('FOLIO_DEBUG_CURSOR', 'folioDebugCursor')) return
      const now = performance.now()
      const key = `${reason}|${extra.currentIdx ?? ''}|${chunkProgress.toFixed(3)}`
      const prev = cursorDebugRef.current
      if (key !== prev.lastKey || now - prev.lastAt > 600) {
        cursorDebugRef.current = { lastKey: key, lastAt: now }
        console.debug('[cursor]', entry)
      }
    }
    const hide = (reason: string, extra: any = {}, mode: CursorHideMode = 'hidden') => {
      hideLineCursor(mode)
      reportCursor(reason, extra)
    }
    const showSelectedFallback = (reason: string, extra: any = {}) => {
      const selected = selectedLineRef.current
      const sameSentence = (
        selected?.sentenceIdx === currentSentence ||
        currentSentence == null ||
        currentSentence < 0
      )
      const handoffActive = Number.isFinite(selected?.handoffUntil) && performance.now() < selected.handoffUntil
      if ((!sameSentence && !handoffActive) || !selectedLineMatchesCurrentView(selected)) return false
      showLineCursor(selected.placement, 1, 'selected')
      reportCursor(reason, {
        selectedSentence: selected.sentenceIdx,
        selectedProgress: selected.progress,
        ...extra,
      })
      return true
    }
    if (isPageTurning) {
      return hide('page-turn-active', {
        singleTurn,
        doubleTurn: Boolean(doubleTurn),
      }, 'turn-suppressed')
    }
    if (!isPlaying) {
      const selected = selectedLineRef.current
      if (selected?.placement) {
        showLineCursor(selected.placement, 1, 'selected')
      } else {
        hideLineCursor()
      }
      return
    }
    if (activeChapterIdx !== chapterIdx) {
      if (showSelectedFallback('selected-line-awaiting-active-chapter', { activeChapterIdx, chapterIdx })) return
      return hide('chapter-mismatch', { activeChapterIdx, chapterIdx })
    }
    const targetView = readingViewForPosition(currentSentence, chunkProgress)
    if (targetView == null) {
      if (showSelectedFallback('selected-line-awaiting-reading-view', { currentSentence, chunkProgress })) return
      return hide('no-reading-view', { currentSentence, chunkProgress })
    }
    if (targetView !== viewPage) {
      if (showSelectedFallback('selected-line-before-reading-view-sync', { targetView, viewPage })) return
      return hide('reading-position-off-view', { targetView, viewPage })
    }
    const active = findLiveSentence(currentSentence)
    if (!active) {
      if (showSelectedFallback('selected-line-awaiting-live-sentence')) return
      return hide('no-live-sentence')
    }
    const liveCache = wordCacheForElement(active)
    if (
      liveCache.key &&
      (liveCache.key !== wordsCacheKeyRef.current || wordsCacheRef.current.length !== liveCache.words.length)
    ) {
      wordsCacheRef.current = liveCache.words
      wordsCacheKeyRef.current = liveCache.key
      if (typeof window !== 'undefined') {
        window.__folioCursorWords = {
          currentSentence,
          activeChapterIdx,
          wordCount: liveCache.words.length,
          textPreview: (active.textContent || '').slice(0, 120),
          rebuiltInCursorEffect: true,
        }
      }
    }
    const words = wordsCacheRef.current
    if (!words.length) {
      if (showSelectedFallback('selected-line-awaiting-words')) return
      return hide('no-words')
    }
    const viewportRect = active.closest('.reflow-viewport')?.getBoundingClientRect()
    const { index: currentIdx, weightedPosition } = predictedWordIndex(words, chunkProgress)
    if (currentIdx < 0) {
      if (showSelectedFallback('selected-line-awaiting-prediction')) return
      return hide('no-predicted-word')
    }
    const viewportKey = viewportRect
      ? `${Math.round(viewportRect.width)}:${Math.round(viewportRect.height)}`
      : 'none'
    const activeRect = active.getBoundingClientRect()
    const activeStyle = getComputedStyle(active)
    const layoutKey = [
      Math.round(activeRect.width * 2) / 2,
      activeStyle.fontFamily,
      activeStyle.fontSize,
      activeStyle.lineHeight,
      activeStyle.letterSpacing,
    ].join(':')
    const cacheKey = `${chapterIdx}:${viewPage}:${pagesPerView}:${currentSentence}:${liveCache.key}:${viewportKey}:${layoutKey}`
    if (playbackLineCacheRef.current.key !== cacheKey) {
      playbackLineCacheRef.current = { key: cacheKey, placements: new Map() }
    }
    let cachedLine = playbackLineCacheRef.current.placements.get(currentIdx)
    if (!cachedLine) {
      const region = activeLineRect(active, words, currentIdx, viewportRect)
      const placement = cursorPlacementForRegion(region)
      if (region && placement) {
        cachedLine = { region, placement }
        const startIdx = Math.max(0, region.startIdx ?? currentIdx)
        const endIdx = Math.min(words.length - 1, region.endIdx ?? currentIdx)
        for (let idx = startIdx; idx <= endIdx; idx += 1) {
          playbackLineCacheRef.current.placements.set(idx, cachedLine)
        }
      }
    }
    if (!cachedLine) {
      if (showSelectedFallback('selected-line-awaiting-region', { currentIdx, weightedPosition })) return
      return hide('no-estimated-region-rect', { currentIdx, weightedPosition })
    }
    let displayedLine = cachedLine
    const previousLine = playbackLineHoldRef.current
    if (
      previousLine &&
      previousLine.cacheKey === cacheKey &&
      previousLine.lineKey !== cachedLine.region.lineKey &&
      previousLine.region?.endIdx < cachedLine.region?.startIdx
    ) {
      const nextLineProgress = progressForWord(words, cachedLine.region.startIdx ?? currentIdx)
      if (chunkProgress < nextLineProgress + LINE_SWITCH_HYSTERESIS) {
        displayedLine = previousLine
      }
    }

    const { region, placement } = displayedLine
    if (viewportRect && !rectIntersects(region.currentRect, viewportRect)) {
      if (showSelectedFallback('selected-line-current-word-outside-viewport', {
        currentIdx,
        weightedPosition,
      })) return
      return hide('current-word-outside-viewport', {
        currentIdx,
        weightedPosition,
        word: active.textContent?.slice(words[currentIdx].start, words[currentIdx].end),
        wordRect: debugRect(region.currentRect),
        viewportRect: debugRect(viewportRect),
      })
    }

    showLineCursor(placement, 1, 'playback')
    playbackLineHoldRef.current = {
      cacheKey,
      lineKey: region.lineKey,
      region,
      placement,
    }
    selectedLineRef.current = null
    reportCursor('placed', {
      currentIdx,
      startIdx: region.startIdx,
      endIdx: region.endIdx,
      lineKey: region.lineKey,
      weightedPosition,
      word: active.textContent?.slice(words[currentIdx].start, words[currentIdx].end),
      phrase: active.textContent?.slice(words[region.startIdx].start, words[region.endIdx].end),
      wordRect: debugRect(region.currentRect),
      regionRect: debugRect(region.rect),
      viewportRect: debugRect(viewportRect),
    })
  }, [chunkProgress, currentSentence, activeChapterIdx, chapterIdx, cursorPlacementForRegion, cursorRefreshTick, doubleTurn, hideLineCursor, isPageTurning, isPlaying, pagesPerView, singleTurn, viewPage, readingViewForPosition, findLiveSentence, selectedLineMatchesCurrentView, showLineCursor])

  const turnToView = useCallback((targetView: number, animate = true) => {
    const { viewPage: currentView, viewCount: currentViewCount, pagesPerView: ppv } = stateRef.current
    if (!Number.isFinite(targetView) || currentViewCount <= 0) return false
    const nextView = clampReaderViewTarget(targetView, currentViewCount)
    if (nextView == null) return false
    if (nextView === currentView) {
      followTurnKeyRef.current = ''
      return false
    }
    selectedLineRef.current = null
    hideLineCursor('force-hidden')
    const direction: TurnDirection = nextView > currentView ? 'next' : 'prev'
    const adjacent = Math.abs(nextView - currentView) === 1
    if (animate && adjacent && ppv === 2 && !androidRuntime) {
      const turnState = triggerDoubleTurn(direction, currentView, nextView, ppv)
      if (turnState === 'busy') return false
      setViewPage(nextView)
      return true
    }
    if (animate && adjacent && triggerSingleTurn(direction) === 'busy') return false
    setViewPage(nextView)
    return true
  }, [androidRuntime, hideLineCursor, triggerDoubleTurn, triggerSingleTurn])

  useEffect(() => () => {
    if (singleTurnTimeoutRef.current) clearTimeout(singleTurnTimeoutRef.current)
    if (doubleTurnTimeoutRef.current) clearTimeout(doubleTurnTimeoutRef.current)
    if (followRetryTimeoutRef.current) clearTimeout(followRetryTimeoutRef.current)
    if (cursorRefreshFrameRef.current != null) cancelAnimationFrame(cursorRefreshFrameRef.current)
  }, [])

  const updateMode = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const available = Math.max(el.clientWidth || 0, rect.width || 0)
    const androidTabletLandscape = document.documentElement.dataset.platform === 'android' &&
      document.documentElement.dataset.androidShell === 'tablet-landscape'
    const next = available >= (androidTabletLandscape ? 1040 : TWO_PAGE_WIDTH + TWO_PAGE_MARGIN) ? 2 : 1
    const paperWidth = next * PAGE_WIDTH
    const horizontalRoom = Math.max(280, available - (androidTabletLandscape ? 24 : 16))
    setSpreadScale(Math.min(1, horizontalRoom / paperWidth))
    setModeMeasured(true)
    setPagesPerView(prev => {
      if (prev === next) return prev
      setViewPage(currentView => {
        const firstContentPage = currentView * prev
        pendingContentPage.current = firstContentPage
        return Math.max(0, Math.floor(firstContentPage / next))
      })
      return next
    })
  }, [])

  useLayoutEffect(() => {
    updateMode()
    let raf = requestAnimationFrame(updateMode)
    const ro = new ResizeObserver(updateMode)
    if (scrollRef.current) ro.observe(scrollRef.current)
    window.addEventListener('resize', updateMode)
    document.fonts?.ready?.then(() => {
      raf = requestAnimationFrame(updateMode)
    }).catch(() => {})
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', updateMode)
      ro.disconnect()
    }
  }, [updateMode, reflow])

  const viewForSentence = useCallback((sentenceIdx: number, indexType = 'local') => {
    return measuredSentenceView(measureRef.current, sentenceIdx, indexType, pagesPerView)
  }, [pagesPerView])

  const viewForReadingPosition = useCallback((sentenceIdx: number, progress = 0, indexType = 'local') => {
    return measuredReadingView(measureRef.current, sentenceIdx, progress, indexType, pagesPerView)
  }, [pagesPerView])

  const sentenceForContentPage = useCallback((contentPage: number) => {
    const measure = measureRef.current
    if (!measure) return 0
    const pageTop = contentPage * TEXT_HEIGHT
    const pageBottom = pageTop + TEXT_HEIGHT
    const measureRect = measure.getBoundingClientRect()
    const sentences = Array.from(measure.querySelectorAll('[data-local-sent-idx]'))
    for (const sentenceEl of sentences) {
      const rects = Array.from(sentenceEl.getClientRects())
      if (rects.some(rect => {
        const top = rect.top - measureRect.top
        const bottom = rect.bottom - measureRect.top
        return bottom > pageTop + 1 && top < pageBottom - 1
      })) {
        const idx = Number.parseInt(sentenceEl.getAttribute('data-local-sent-idx') || '0', 10)
        return Number.isFinite(idx) ? idx : 0
      }
    }
    return 0
  }, [])

  const handleViewportKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' || isPageTurning) return
    event.preventDefault()
    const sentenceIdx = sentenceForContentPage(firstVisiblePage)
    onSentenceSelect?.(chapterIdx, sentenceIdx, { progress: 0 })
  }, [chapterIdx, firstVisiblePage, isPageTurning, onSentenceSelect, sentenceForContentPage])

  useEffect(() => {
    if (!onProgress || !reflow?.chapters) return
    const total = Math.max(1, bookPageTotal)
    const cur = Math.min(total, Math.max(1, chapterPageOffset + firstVisiblePage + 1))
    onProgress({ current: cur, total, allChaptersMeasured, stable: allChaptersMeasured })
  }, [firstVisiblePage, reflow, onProgress, chapterPageOffset, bookPageTotal, allChaptersMeasured])

  useLayoutEffect(() => {
    const measure = measureRef.current

    visualPositionReadyRef.current = false
    if (!measure || !modeMeasured) return
    const pages = Math.max(1, Math.ceil(measure.scrollHeight / TEXT_HEIGHT))
    const nextViewCount = Math.max(1, Math.ceil(pages / pagesPerView))
    const clampView = (contentPage: number) => (
      Math.min(nextViewCount - 1, Math.max(0, Math.floor(contentPage / pagesPerView)))
    )
    const initialResumeForThisChapter = Boolean(
      bookId &&
      initialResumeLandingRef.current !== bookId &&
      resumePosition?.page === chapterIdx
    )
    const savedVisualContentPage = initialResumeForThisChapter
      ? contentPageFromPosition(resumePosition, chapterIdx, paginationKey, pagesPerView)
      : null
    setContentPageCount(pages)
    setMeasuredChapterPages(chapterIdx, pages)

    if (pendingContentPage.current != null) {
      setViewPage(clampView(pendingContentPage.current))
      pendingContentPage.current = null
    } else if (searchTarget?.page === chapterIdx && searchTarget?.globalSentenceIdx != null) {
      const targetView = viewForSentence(searchTarget.globalSentenceIdx, 'global')
      setViewPage(targetView != null ? Math.min(nextViewCount - 1, targetView) : 0)
      pendingScrollSentence.current = null
    } else if (pendingScrollSentence.current != null) {
      const pending = pendingScrollSentence.current
      const targetView = viewForReadingPosition(pending.idx, pending.progress ?? 0, pending.indexType)
      setViewPage(targetView != null ? Math.min(nextViewCount - 1, targetView) : 0)
      pendingScrollSentence.current = null
    } else if (pendingLanding.current === 'last') {
      setViewPage(nextViewCount - 1)
    } else if (savedVisualContentPage != null) {
      setViewPage(clampView(savedVisualContentPage))
      initialResumeLandingRef.current = bookId
    } else if (initialResumeForThisChapter && resumePosition?.sentence_idx > 0) {
      const targetView = viewForSentence(resumePosition.sentence_idx, 'local')
      if (targetView != null) {
        setViewPage(Math.min(nextViewCount - 1, Math.max(0, targetView)))
        initialResumeLandingRef.current = bookId
      } else {
        setViewPage(0)
      }
    } else {
      const savedContentPage = readReaderContentPage(bookId, chapterIdx, paginationKey, pagesPerView)
      setViewPage(savedContentPage != null
        ? clampView(savedContentPage)
        : 0)
    }
    pendingLanding.current = 'first'
    visualPositionReadyRef.current = true
  }, [bookId, chapter, pagesPerView, paginationKey, resumePosition, searchTarget, chapterIdx, modeMeasured, viewForSentence, viewForReadingPosition, setMeasuredChapterPages])

  useEffect(() => {
    if (!reflow?.chapters?.length) {
      setChapterPageCounts([])
      setMeasureChapterIdx(null)
      return
    }
    const cached = readPaginationCache(paginationKey, chapterCount)
    setChapterPageCounts(prev => {
      if (cached) return cached
      const next = Array.from({ length: chapterCount }, (_, i) => prev[i] || 0)
      return prev.length === next.length ? prev : next
    })
    setMeasureChapterIdx(null)
  }, [reflow, paginationKey, chapterCount])

  useEffect(() => {
    const total = reflow?.chapters?.length || 0
    if (!total || measureChapterIdx != null) return

    const missing = chapterMeasureOrder.find(idx => idx !== chapterIdx && !chapterPageCounts[idx])
    if (missing == null) return

    const schedule = window.requestIdleCallback || ((cb) => window.setTimeout(cb, 250))
    const cancel = window.cancelIdleCallback || window.clearTimeout
    const handle = schedule(() => {
      setMeasureChapterIdx(missing)
    }, { timeout: 1200 })
    return () => cancel(handle)
  }, [reflow, chapterIdx, chapterMeasureOrder, chapterPageCounts, measureChapterIdx])

  useLayoutEffect(() => {
    if (measureChapterIdx == null) return
    const raf = requestAnimationFrame(() => {
      const el = chapterMeasureRef.current
      if (!el) return
      const pages = Math.max(1, Math.ceil((el.scrollHeight || TEXT_HEIGHT) / TEXT_HEIGHT))
      setMeasuredChapterPages(measureChapterIdx, pages)
      setMeasureChapterIdx(null)
    })
    return () => cancelAnimationFrame(raf)
  }, [measureChapterIdx, setMeasuredChapterPages])

  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      setViewPage(prev => Math.min(prev, Math.max(0, viewCount - 1)))
    })
    return () => cancelAnimationFrame(raf)
  }, [pagesPerView, viewCount])

  useLayoutEffect(() => {
    stateRef.current = { viewPage, viewCount, chapterIdx, pagesPerView }
  }, [viewPage, viewCount, chapterIdx, pagesPerView])

  const buildVisualPosition = useCallback(() => {
    if (!bookId || !reflow?.chapters?.length) return null
    const state = stateRef.current
    const contentPage = state.viewPage * state.pagesPerView
    return {
      page: state.chapterIdx,
      sentence_idx: sentenceForContentPage(contentPage),
      content_page: contentPage,
      visual_page: chapterPageOffset + contentPage + 1,
      pages_per_view: state.pagesPerView,
      layout_key: paginationKey,
      saved_at: Date.now(),
    }
  }, [bookId, reflow, chapterPageOffset, paginationKey, sentenceForContentPage])

  useEffect(() => {
    if (!bookId || !reflow?.chapters?.length) return
    if (!visualPositionReadyRef.current) return
    const contentPage = viewPage * pagesPerView
    const position = buildVisualPosition()
    if (!position) return
    writeReaderContentPage(bookId, chapterIdx, contentPage, paginationKey, pagesPerView)
    onVisualPositionChange?.(position)
  }, [bookId, reflow, chapterIdx, viewPage, pagesPerView, paginationKey, buildVisualPosition, onVisualPositionChange])

  const goNext = useCallback(() => {
    if (!reflow) return
    const nChapters = reflow.chapters.length
    const { viewPage: vp, viewCount: vc, chapterIdx: ci, pagesPerView: ppv } = stateRef.current
    if (vp < vc - 1) {
      if (ppv === 2 && !androidRuntime) {
        const turnState = triggerDoubleTurn('next', vp, vp + 1, ppv)
        if (turnState !== 'busy') setViewPage(vp + 1)
      } else {
        const turnState = triggerSingleTurn('next')
        if (turnState !== 'busy') setViewPage(vp + 1)
      }
    } else if (ci < nChapters - 1) {
      // The destination chapter is not mounted yet, so a two-sided sheet turn
      // would expose a blank reverse face. Use the whole-spread transition at
      // chapter boundaries and reserve the physical flipper for in-chapter pages.
      const turnState = triggerSingleTurn('next')
      if (turnState !== 'busy') setChapterIdx?.(ci + 1)
    }
  }, [androidRuntime, reflow, setChapterIdx, triggerDoubleTurn, triggerSingleTurn])

  const goPrev = useCallback(() => {
    if (!reflow) return
    const { viewPage: vp, chapterIdx: ci, pagesPerView: ppv } = stateRef.current
    if (vp > 0) {
      if (ppv === 2 && !androidRuntime) {
        const turnState = triggerDoubleTurn('prev', vp, vp - 1, ppv)
        if (turnState !== 'busy') setViewPage(vp - 1)
      } else {
        const turnState = triggerSingleTurn('prev')
        if (turnState !== 'busy') setViewPage(vp - 1)
      }
    } else if (ci > 0) {
      const turnState = triggerSingleTurn('prev')
      if (turnState !== 'busy') {
        pendingLanding.current = 'last'
        setChapterIdx?.(ci - 1)
      }
    }
  }, [androidRuntime, reflow, setChapterIdx, triggerDoubleTurn, triggerSingleTurn])

  const goToReadingPosition = useCallback((targetChapter, sentenceIdx, progress = 0, indexType = 'local', animate = true) => {
    if (sentenceIdx == null || sentenceIdx < 0) return
    const safeProgress = clamp(progress, 0, 0.98)
    if (targetChapter != null && targetChapter !== chapterIdx) {
      pendingScrollSentence.current = { idx: sentenceIdx, indexType, progress: safeProgress }
      if (!animate) {
        setChapterIdx?.(targetChapter)
      } else {
        const direction = targetChapter > chapterIdx ? 'next' : 'prev'
        const turnState = triggerSingleTurn(direction)
        if (turnState !== 'busy') setChapterIdx?.(targetChapter)
      }
      return
    }
    const targetView = viewForReadingPosition(sentenceIdx, safeProgress, indexType)
    if (targetView != null) turnToView(targetView, animate)
  }, [chapterIdx, setChapterIdx, triggerSingleTurn, turnToView, viewForReadingPosition])

  // Follow Along owns continuous page/sub-page synchronization. App only
  // enters/exits the mode; this effect keeps retrying until the active audio
  // position is actually on the visible spread.
  useLayoutEffect(() => {
    const debug = typeof window !== 'undefined' && window.FOLIO_DEBUG_PAGE_TURN
    const log = (reason: string, extra: any = undefined) => {
      if (debug) console.debug('[page-turn]', reason, extra || '')
    }

    if (!followAlongMode) {
      pendingFollowTargetRef.current = null
      followTurnKeyRef.current = ''
      clearFollowRetry()
      return log('skip: not in follow along')
    }
    if (currentSentence == null || currentSentence < 0) {
      return log('pending: no current sentence', { currentSentence })
    }
    if (activeChapterIdx == null || activeChapterIdx < 0) {
      return log('pending: no active chapter', { activeChapterIdx })
    }

    const target = {
      chapterIdx: activeChapterIdx,
      sentenceIdx: currentSentence,
      progress: clamp(chunkProgress, 0, 0.98),
    }
    pendingFollowTargetRef.current = target

    if (isPageTurning) {
      queueFollowRetry()
      return log('pending: page turn active', target)
    }

    if (!modeMeasured || !measureRef.current) {
      queueFollowRetry()
      return log('pending: measurement not ready', { modeMeasured, target })
    }

    if (target.chapterIdx !== chapterIdx) {
      goToReadingPosition(target.chapterIdx, target.sentenceIdx, target.progress, 'local', false)
      queueFollowRetry()
      return log('requested chapter sync', { from: chapterIdx, target })
    }

    const measuredTargetView = viewForReadingPosition(target.sentenceIdx, target.progress, 'local')
    if (measuredTargetView == null) {
      queueFollowRetry()
      return log('pending: no target view', target)
    }

    const { viewPage: vp, viewCount: vc } = stateRef.current
    const targetView = clampReaderViewTarget(measuredTargetView, vc)
    if (targetView == null) {
      queueFollowRetry()
      return log('pending: invalid view count', { measuredTargetView, viewCount: vc })
    }
    log('checked', {
      currentSentence,
      chunkProgress: +target.progress.toFixed(3),
      targetView,
      measuredTargetView,
      currentView: vp,
      viewCount: vc,
    })

    if (targetView === vp) {
      pendingFollowTargetRef.current = null
      followTurnKeyRef.current = ''
      clearFollowRetry()
      return log('in sync', { targetView, currentView: vp })
    }

    // Follow Along favors synchronization over a decorative physical turn.
    // A full page animation can outlast a short spoken line and leave the
    // cursor one view behind; the manual controls still use the page turn.
    const moved = turnToView(targetView, false)
    if (moved) {
      followTurnKeyRef.current = `${chapterIdx}:${targetView}`
      return log('TURN', { from: vp, to: targetView })
    }
    queueFollowRetry()
    log('pending: turn refused', { from: vp, to: targetView })
  }, [
    activeChapterIdx,
    chapterIdx,
    clearFollowRetry,
    chunkProgress,
    currentSentence,
    followAlongMode,
    followRetryTick,
    goToReadingPosition,
    isPageTurning,
    modeMeasured,
    pagesPerView,
    queueFollowRetry,
    turnToView,
    viewCount,
    viewForReadingPosition,
    viewPage,
  ])

  const goToSentence = useCallback((targetChapter, sentenceIdx, indexType = 'local') => {
    goToReadingPosition(targetChapter, sentenceIdx, 0, indexType)
  }, [goToReadingPosition])

  useEffect(() => {
    if (!navRef) return
    navRef.current = { goNext, goPrev, goToSentence, goToReadingPosition, getVisualPosition: buildVisualPosition }
  }, [navRef, goNext, goPrev, goToSentence, goToReadingPosition, buildVisualPosition])

  useEffect(() => {
    if (!wheelPaging) return
    const el = scrollRef.current
    if (!el) return
    let cooldown = 0
    const onWheel = (e) => {
      e.preventDefault()
      const now = Date.now()
      if (now < cooldown) return
      const dy = e.deltaY
      const dx = e.deltaX
      if (Math.abs(dy) < 12 && Math.abs(dx) < 12) return
      cooldown = now + 220
      if (dy > 0 || dx > 0) goNext()
      else goPrev()
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [wheelPaging, goNext, goPrev])

  if (!reflow) {
    return (
      <div className={`page-scroll ${followAlongMode ? 'follow-along-scroll' : ''}`} data-android-scroll-fade>
        <div style={{ margin: 'auto', color: 'var(--ink-3)', fontFamily: 'var(--font-display)', fontStyle: 'italic' }}>
          Loading reflow...
        </div>
      </div>
    )
  }

  if (!chapter) {
    return (
      <div className={`page-scroll ${followAlongMode ? 'follow-along-scroll' : ''}`} data-android-scroll-fade>
        <div style={{ margin: 'auto', color: 'var(--ink-3)' }}>No chapters found.</div>
      </div>
    )
  }

  const runHead = runHeadText
  const chapLabel = chapterLabel
  const nCols = Math.max(1, contentPageCount)
  const flowWidth = nCols * TEXT_WIDTH + (nCols - 1) * GAP
  const stride = pagesPerView * (TEXT_WIDTH + GAP)
  const showRecto = pagesPerView === 2
  const bookPageNumber = (localPageIdx) => chapterPageOffset + localPageIdx + 1
  const versoFooter = bookPageNumber(firstVisiblePage)
  const rectoFooter = bookPageNumber(Math.min(contentPageCount - 1, firstVisiblePage + 1))
  const pageColumnOffset = (pageIdx) => pageIdx * (TEXT_WIDTH + GAP)
  const activeTurn = doubleTurn

  const renderTurnPage = (pageIdx, extraClass = '', source = activeTurn) => {
    const turnSource = source
    const sourcePageCount = turnSource?.contentPageCount ?? contentPageCount
    if (pageIdx < 0 || pageIdx >= sourcePageCount) return null
    const isRecto = pageIdx % 2 === 1
    const sourceCols = turnSource?.nCols ?? nCols
    const sourceFlowWidth = turnSource?.flowWidth ?? flowWidth
    const sourceContentEls = turnSource?.contentEls ?? contentEls
    const sourceRunHead = turnSource?.runHead ?? runHead
    const sourceChapLabel = turnSource?.chapLabel ?? chapLabel
    const sourcePageNumber = (turnSource?.chapterPageOffset ?? chapterPageOffset) + pageIdx + 1
    return (
      <>
        <header className="page-header pt-page-header">
          {isRecto ? (
            <><span>{sourceChapLabel}</span><span>{sourceRunHead}</span></>
          ) : (
            <><span>{sourceRunHead}</span><span>{sourceChapLabel}</span></>
          )}
        </header>
        <div className={`pt-page-text ${extraClass}`}>
          <div
            className="reflow-flow"
            style={{
              columnCount: sourceCols,
              columnGap: `${GAP}px`,
              columnFill: 'auto',
              height: `${TEXT_HEIGHT}px`,
              width: `${sourceFlowWidth}px`,
              transform: `translateX(-${pageColumnOffset(pageIdx)}px)`,
            }}
          >
            {sourceContentEls}
          </div>
        </div>
        <div className="page-footer pt-page-footer">- {sourcePageNumber} -</div>
      </>
    )
  }

  return (
    <div
      className={`page-scroll reflow-scroll ${followAlongMode ? 'follow-along-scroll' : ''} ${isPageTurning ? 'is-page-turning' : ''}`}
      data-android-scroll-fade
      data-page-turning={isPageTurning ? 'true' : undefined}
      ref={scrollRef}
    >
      <div className="reader-line-cursor" ref={cursorRef} aria-hidden="true" />
      <div
        className={`spread reflow-spread pt-spread pages-${pagesPerView}${singleTurn ? ` sp-turning sp-turning-${singleTurn}` : ''}`}
        style={{ zoom: spreadScale } as React.CSSProperties}
        data-turn-direction={activeTurn?.direction}
        data-turn-from={activeTurn?.fromFirstPage}
        data-turn-to={activeTurn?.toFirstPage}
      >
        <article className="page-sheet reflow-sheet pt-page pt-verso verso">
          <header className="page-header"><span>{runHead}</span><span>{chapLabel}</span></header>
          <div className="reflow-slot" />
          <div className="page-footer">- {versoFooter} -</div>
        </article>

        {showRecto && (
          <article className="page-sheet reflow-sheet pt-page pt-recto recto">
            <header className="page-header"><span>{chapLabel}</span><span>{runHead}</span></header>
            <div className="reflow-slot" />
            <div className="page-footer">- {rectoFooter} -</div>
          </article>
        )}

        {showRecto && activeTurn?.holdPage != null && (
          <div className={`pt-cover-hold pt-cover-${activeTurn.direction}`}>
            {renderTurnPage(activeTurn.holdPage, 'pt-page-text-hold', activeTurn)}
          </div>
        )}

        {showRecto && activeTurn && (
          <>
            <div
              key={activeTurn.key}
              className={`pt-flipper pt-flipper-${activeTurn.direction}`}
              data-front-page={activeTurn.frontPage}
              data-back-page={activeTurn.backPage}
              data-hold-page={activeTurn.holdPage}
            >
              <div className="pt-face pt-front">
                {renderTurnPage(activeTurn.frontPage, 'pt-page-text-front', activeTurn)}
                <div className="pt-shade pt-shade-front" />
                <div className="pt-sheen" />
                <div className="pt-edge" />
              </div>
              <div className="pt-face pt-back">
                {renderTurnPage(activeTurn.backPage, 'pt-page-text-back', activeTurn)}
                <div className="pt-shade pt-shade-back" />
                <div className="pt-sheen" />
              </div>
            </div>
            <div className={`pt-cast pt-cast-${activeTurn.direction}`} />
            <div className={`pt-cast-receiving pt-recv-${activeTurn.direction}`} />
          </>
        )}

        <div
          ref={measureRef}
          className="reflow-flow reflow-measure"
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: -99999,
            top: 0,
            width: `${TEXT_WIDTH}px`,
            // Clamp layout height to 0 so the (very tall) single-column clone
            // doesn't expand the page-scroll's scrollHeight. scrollHeight on
            // the measure itself still reports the natural content height,
            // which is what the pagination math reads.
            height: 0,
            overflow: 'hidden',
            visibility: 'hidden',
            pointerEvents: 'none',
          }}
        >
          {contentEls}
        </div>

        {measureChapterIdx != null && reflow.chapters[measureChapterIdx] && (
          <div
            key={`chapter-measure-${reflow.chapters[measureChapterIdx].id ?? measureChapterIdx}`}
            ref={chapterMeasureRef}
            className="reflow-flow reflow-measure"
            aria-hidden="true"
            style={{
              position: 'absolute',
              left: -99999,
              top: 0,
              width: `${TEXT_WIDTH}px`,
              height: 0,
              overflow: 'hidden',
              visibility: 'hidden',
              pointerEvents: 'none',
            }}
          >
          {renderChapterContent(reflow.chapters[measureChapterIdx])}
          </div>
        )}

        <div
          className="reflow-viewport"
          role="region"
          tabIndex={0}
          aria-label={`Reading page ${versoFooter}${showRecto ? ` and ${rectoFooter}` : ''}. Press Enter to begin narration from this page.`}
          aria-keyshortcuts="Enter PageUp PageDown Space"
          onPointerDown={handleAndroidLinePointerDown}
          onPointerMove={handleLinePointerMove}
          onPointerUp={handleAndroidLinePointerUp}
          onPointerCancel={cancelAndroidLineTap}
          onPointerLeave={handleLinePointerLeave}
          onDoubleClick={handleLineDoubleClick}
          onKeyDown={handleViewportKeyDown}
        >
          <div
            className="reflow-flow"
            style={{
              columnCount: nCols,
              columnGap: `${GAP}px`,
              columnFill: 'auto',
              height: `${TEXT_HEIGHT}px`,
              width: `${flowWidth}px`,
              transform: `translateX(-${viewPage * stride}px)`,
            }}
          >
            {contentEls}
          </div>
        </div>
      </div>
    </div>
  )
}

export default memo(ReflowViewer)
