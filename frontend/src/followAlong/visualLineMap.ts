import {
  assignVisualLineProgress,
  mergeWithCanonicalLineGeometry,
  placementForLine,
  tokenizeWeighted,
  type PlaybackAnchor,
  type VisualLine,
  type VisualLineMap,
  type WeightedToken,
} from './playbackModel'

type MeasuredFragment = {
  tokenIndex: number
  tokenWeight: number
  contentPage: number
  pageX: number
  pageY: number
  left: number
  right: number
  top: number
  bottom: number
  width: number
  height: number
}

type MutableLine = {
  contentPage: number
  fragments: MeasuredFragment[]
  top: number
  bottom: number
  left: number
  right: number
  tokenWeights: Map<number, number>
  cursorTop?: number
  cursorBottom?: number
}

export type BuildVisualLineMapOptions = {
  root: HTMLElement
  bookId: string
  chapterIndex: number
  generation: number
  pagesPerView: number
  pageStride: number
  layoutIdentity: string
}

const finitePositive = (value: number, fallback: number) => (
  Number.isFinite(value) && value > 0 ? value : fallback
)

function rangeForOffsets(element: Element, start: number, end: number) {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  let consumed = 0
  let startNode: Node | null = null
  let endNode: Node | null = null
  let startOffset = 0
  let endOffset = 0
  let node: Node | null

  while ((node = walker.nextNode())) {
    const length = node.nodeValue?.length || 0
    if (!startNode && consumed + length >= start) {
      startNode = node
      startOffset = Math.max(0, start - consumed)
    }
    if (consumed + length >= end) {
      endNode = node
      endOffset = Math.max(0, end - consumed)
      break
    }
    consumed += length
  }

  if (!startNode || !endNode) return null
  try {
    const range = document.createRange()
    range.setStart(startNode, Math.min(startOffset, startNode.nodeValue?.length || 0))
    range.setEnd(endNode, Math.min(endOffset, endNode.nodeValue?.length || 0))
    return range
  } catch {
    return null
  }
}

function usefulRects(range: Range) {
  const rects = Array.from(range.getClientRects()).filter(rect => (
    rect.width > 0.2 && rect.height > 0.2 &&
    Number.isFinite(rect.left) && Number.isFinite(rect.top)
  ))
  if (rects.length < 2) return rects

  const heights = rects.map(rect => rect.height).sort((a, b) => a - b)
  const median = heights[Math.floor(heights.length / 2)] || heights[0]
  const filtered = rects.filter(rect => rect.height <= median * 1.9)
  return filtered.length ? filtered : rects
}

function measureTokenFragments(
  sentence: Element,
  tokens: WeightedToken[],
  flowRect: DOMRect,
  scaleX: number,
  scaleY: number,
  pageStride: number,
) {
  const fragments: MeasuredFragment[] = []

  tokens.forEach((token, tokenIndex) => {
    const range = rangeForOffsets(sentence, token.start, token.end)
    if (!range) return
    const rects = usefulRects(range)
    range.detach?.()
    if (!rects.length) return
    const weightShare = token.weight / rects.length

    rects.forEach(rect => {
      const localLeft = (rect.left - flowRect.left) / scaleX
      const localRight = (rect.right - flowRect.left) / scaleX
      const localTop = (rect.top - flowRect.top) / scaleY
      const localBottom = (rect.bottom - flowRect.top) / scaleY
      const centerX = (localLeft + localRight) / 2
      const contentPage = Math.max(0, Math.floor((centerX + 0.01) / pageStride))
      const pageOffset = contentPage * pageStride

      fragments.push({
        tokenIndex,
        tokenWeight: weightShare,
        contentPage,
        pageX: localLeft - pageOffset,
        pageY: localTop,
        left: localLeft - pageOffset,
        right: localRight - pageOffset,
        top: localTop,
        bottom: localBottom,
        width: Math.max(0, localRight - localLeft),
        height: Math.max(0, localBottom - localTop),
      })
    })
  })

  return fragments
}

function sameLine(line: MutableLine, fragment: MeasuredFragment) {
  if (line.contentPage !== fragment.contentPage) return false
  const lineMid = (line.top + line.bottom) / 2
  const fragmentMid = (fragment.top + fragment.bottom) / 2
  const tolerance = Math.max(4, Math.min(line.bottom - line.top, fragment.height) * 0.58)
  return Math.abs(lineMid - fragmentMid) <= tolerance
}

function groupFragments(fragments: MeasuredFragment[]) {
  const sorted = [...fragments].sort((a, b) => (
    a.contentPage - b.contentPage ||
    a.top - b.top ||
    a.left - b.left ||
    a.tokenIndex - b.tokenIndex
  ))
  const lines: MutableLine[] = []

  for (const fragment of sorted) {
    let line: MutableLine | undefined
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const candidate = lines[index]
      if (candidate.contentPage < fragment.contentPage) break
      if (sameLine(candidate, fragment)) {
        line = candidate
        break
      }
    }

    if (!line) {
      line = {
        contentPage: fragment.contentPage,
        fragments: [],
        top: fragment.top,
        bottom: fragment.bottom,
        left: fragment.left,
        right: fragment.right,
        tokenWeights: new Map(),
      }
      lines.push(line)
    }

    line.fragments.push(fragment)
    line.top = Math.min(line.top, fragment.top)
    line.bottom = Math.max(line.bottom, fragment.bottom)
    line.left = Math.min(line.left, fragment.left)
    line.right = Math.max(line.right, fragment.right)
    line.tokenWeights.set(
      fragment.tokenIndex,
      (line.tokenWeights.get(fragment.tokenIndex) || 0) + fragment.tokenWeight,
    )
  }

  return lines.sort((a, b) => (
    a.contentPage - b.contentPage || a.top - b.top || a.left - b.left
  ))
}

function measureCanonicalParagraphLines(
  paragraph: Element,
  flowRect: DOMRect,
  scaleX: number,
  scaleY: number,
  pageStride: number,
) {
  const range = document.createRange()
  try {
    range.selectNodeContents(paragraph)
    const rects = usefulRects(range)
    const fragments: MeasuredFragment[] = rects.map((rect, index) => {
      const localLeft = (rect.left - flowRect.left) / scaleX
      const localRight = (rect.right - flowRect.left) / scaleX
      const localTop = (rect.top - flowRect.top) / scaleY
      const localBottom = (rect.bottom - flowRect.top) / scaleY
      const centerX = (localLeft + localRight) / 2
      const contentPage = Math.max(0, Math.floor((centerX + 0.01) / pageStride))
      const pageOffset = contentPage * pageStride
      return {
        tokenIndex: index,
        tokenWeight: 0.001,
        contentPage,
        pageX: localLeft - pageOffset,
        pageY: localTop,
        left: localLeft - pageOffset,
        right: localRight - pageOffset,
        top: localTop,
        bottom: localBottom,
        width: Math.max(0, localRight - localLeft),
        height: Math.max(0, localBottom - localTop),
      }
    })
    return groupFragments(fragments)
  } finally {
    range.detach?.()
  }
}

function applyLeadingGlyphGeometry(
  sentence: Element,
  tokens: WeightedToken[],
  lines: MutableLine[],
  flowRect: DOMRect,
  scaleX: number,
  scaleY: number,
  pageStride: number,
) {
  for (const line of lines) {
    const leadingFragment = [...line.fragments].sort((a, b) => a.left - b.left)[0]
    const token = leadingFragment ? tokens[leadingFragment.tokenIndex] : null
    if (!token) continue

    const range = rangeForOffsets(sentence, token.start, token.end)
    if (!range) continue
    const candidates = Array.from(range.getClientRects()).map(rect => {
      const localLeft = (rect.left - flowRect.left) / scaleX
      const localRight = (rect.right - flowRect.left) / scaleX
      const localTop = (rect.top - flowRect.top) / scaleY
      const localBottom = (rect.bottom - flowRect.top) / scaleY
      const centerX = (localLeft + localRight) / 2
      const contentPage = Math.max(0, Math.floor((centerX + 0.01) / pageStride))
      return {
        contentPage,
        left: localLeft - contentPage * pageStride,
        top: localTop,
        bottom: localBottom,
        height: Math.max(0, localBottom - localTop),
      }
    }).filter(candidate => (
      candidate.height > 0 &&
      candidate.contentPage === line.contentPage &&
      candidate.bottom >= line.top - 1 &&
      candidate.top <= line.bottom + Math.max(2, line.bottom - line.top)
    ))
    range.detach?.()
    if (!candidates.length) continue

    // A drop cap can split the first token into a tall initial and a normal
    // remainder. Choosing the tallest overlapping leading-glyph fragment lets
    // the cursor breathe to the actual letter height. The same rule naturally
    // handles chapter titles, subtitles, small caps, and mixed inline styles.
    const leadingGlyph = candidates.reduce((best, candidate) => (
      candidate.height > best.height ? candidate : best
    ))
    line.left = Math.min(line.left, leadingGlyph.left)
    line.cursorTop = leadingGlyph.top
    line.cursorBottom = leadingGlyph.bottom
  }
}

function applyDropCapCursorGeometry(
  sentence: Element,
  lines: MutableLine[],
  flowRect: DOMRect,
  scaleX: number,
  scaleY: number,
  pageStride: number,
) {
  const dropCap = sentence.querySelector('.drop-cap')
  if (!dropCap) return
  const rect = dropCap.getBoundingClientRect()
  if (!rect.width || !rect.height) return

  const localLeft = (rect.left - flowRect.left) / scaleX
  const localRight = (rect.right - flowRect.left) / scaleX
  const localTop = (rect.top - flowRect.top) / scaleY
  const localBottom = (rect.bottom - flowRect.top) / scaleY
  const centerX = (localLeft + localRight) / 2
  const contentPage = Math.max(0, Math.floor((centerX + 0.01) / pageStride))
  const pageLeft = localLeft - contentPage * pageStride

  // The DOM Range around a floated initial includes its font line box, which
  // can be considerably taller than the visible drop-cap element. Preserve
  // ordinary line bounds for hit testing, but give every fragment of token 0
  // the exact element box so selection and playback agree on its true height.
  lines.forEach((line) => {
    if (
      line.contentPage !== contentPage ||
      !line.tokenWeights.has(0) ||
      line.bottom < localTop ||
      line.top > localBottom
    ) return
    line.left = Math.min(line.left, pageLeft)
    line.cursorTop = localTop
    line.cursorBottom = localBottom
  })
}

function computedLayoutKey(
  flow: HTMLElement,
  viewport: HTMLElement,
  options: BuildVisualLineMapOptions,
  scaleX: number,
  scaleY: number,
) {
  const style = getComputedStyle(flow)
  const viewportRect = viewport.getBoundingClientRect()
  return [
    options.layoutIdentity,
    options.bookId,
    options.chapterIndex,
    options.pagesPerView,
    Math.round(flow.offsetWidth * 10) / 10,
    Math.round(flow.offsetHeight * 10) / 10,
    Math.round(viewportRect.width * 10) / 10,
    Math.round(viewportRect.height * 10) / 10,
    Math.round(scaleX * 10000) / 10000,
    Math.round(scaleY * 10000) / 10000,
    style.fontFamily,
    style.fontSize,
    style.lineHeight,
    style.letterSpacing,
    style.wordSpacing,
    typeof window === 'undefined' ? 1 : window.devicePixelRatio,
  ].join('|')
}

export function buildVisualLineMap(options: BuildVisualLineMapOptions): VisualLineMap | null {
  const { root, pageStride, pagesPerView } = options
  const viewport = root.querySelector<HTMLElement>('.reflow-viewport')
  const flow = viewport?.querySelector<HTMLElement>('.reflow-flow:not(.reflow-measure)')
  if (!viewport || !flow || !flow.isConnected) return null

  const rootRect = root.getBoundingClientRect()
  const viewportRect = viewport.getBoundingClientRect()
  const flowRect = flow.getBoundingClientRect()
  if (!rootRect.width || !viewportRect.width || !flowRect.width) return null

  const scaleX = finitePositive(flow.offsetWidth ? flowRect.width / flow.offsetWidth : 0, 1)
  const scaleY = finitePositive(flow.offsetHeight ? flowRect.height / flow.offsetHeight : 0, scaleX)
  const layoutKey = computedLayoutKey(flow, viewport, options, scaleX, scaleY)
  const lines: VisualLine[] = []
  const bySentence = new Map<number, VisualLine[]>()
  const paragraphLineCache = new WeakMap<Element, MutableLine[]>()
  const sentenceElements = Array.from(
    flow.querySelectorAll<HTMLElement>('.sentence[data-local-sent-idx]'),
  )

  for (const sentence of sentenceElements) {
    const sentenceIndex = Number.parseInt(sentence.dataset.localSentIdx || '-1', 10)
    if (!Number.isFinite(sentenceIndex) || sentenceIndex < 0) continue
    const parsedGlobalIndex = Number.parseInt(sentence.dataset.sentIdx || '', 10)
    const globalSentenceIndex = Number.isFinite(parsedGlobalIndex) ? parsedGlobalIndex : null
    const tokens = tokenizeWeighted(sentence.textContent || '')
    if (!tokens.length) continue

    const fragments = measureTokenFragments(sentence, tokens, flowRect, scaleX, scaleY, pageStride)
    if (!fragments.length) continue
    let grouped = groupFragments(fragments)
    const paragraph = sentence.closest('.reflow-para')
    if (paragraph) {
      let canonicalLines = paragraphLineCache.get(paragraph)
      if (!canonicalLines) {
        canonicalLines = measureCanonicalParagraphLines(paragraph, flowRect, scaleX, scaleY, pageStride)
        paragraphLineCache.set(paragraph, canonicalLines)
      }
      grouped = grouped.map(line => mergeWithCanonicalLineGeometry(line, canonicalLines || []))
    }
    applyLeadingGlyphGeometry(sentence, tokens, grouped, flowRect, scaleX, scaleY, pageStride)
    applyDropCapCursorGeometry(sentence, grouped, flowRect, scaleX, scaleY, pageStride)

    const weightedLines = assignVisualLineProgress(grouped.map(line => ({
      line,
      tokenWeight: Array.from(line.tokenWeights.values()).reduce((sum, value) => sum + value, 0),
    })))

    const sentenceLines = weightedLines.map(({ line, progressStart, progressEnd }, lineIndex) => {
      const tokenIndexes = Array.from(line.tokenWeights.keys()).sort((a, b) => a - b)
      const firstTokenIndex = tokenIndexes[0] ?? 0
      const lastTokenIndex = tokenIndexes[tokenIndexes.length - 1] ?? firstTokenIndex
      const visualLine: VisualLine = {
        lineId: `c${options.chapterIndex}:s${sentenceIndex}:l${lineIndex}`,
        chapterIndex: options.chapterIndex,
        sentenceIndex,
        globalSentenceIndex,
        lineIndex,
        firstTokenIndex,
        lastTokenIndex,
        progressStart,
        progressEnd,
        contentPage: line.contentPage,
        viewIndex: Math.floor(line.contentPage / pagesPerView),
        pageX: line.left,
        pageY: line.top,
        lineWidth: Math.max(2, line.right - line.left),
        lineHeight: Math.max(2, line.bottom - line.top),
        cursorPageY: line.cursorTop,
        cursorLineHeight: line.cursorTop != null && line.cursorBottom != null
          ? Math.max(2, line.cursorBottom - line.cursorTop)
          : undefined,
        generation: options.generation,
      }
      lines.push(visualLine)
      return visualLine
    })

    bySentence.set(sentenceIndex, sentenceLines)
  }

  if (!lines.length) return null

  return {
    bookId: options.bookId,
    chapterIndex: options.chapterIndex,
    generation: options.generation,
    layoutKey,
    pagesPerView,
    lines,
    bySentence,
    metrics: {
      rootContentX: viewportRect.left - rootRect.left + root.scrollLeft,
      rootContentY: viewportRect.top - rootRect.top + root.scrollTop,
      scaleX,
      scaleY,
      pageStride,
      pagesPerView,
    },
    createdAt: Date.now(),
  }
}

export function anchorForLine(
  map: VisualLineMap,
  line: VisualLine,
  visibleViewIndex: number,
): PlaybackAnchor | null {
  const placement = placementForLine(map, line, visibleViewIndex)
  if (!placement) return null
  return {
    bookId: map.bookId,
    chapterIndex: line.chapterIndex,
    sentenceIndex: line.sentenceIndex,
    globalSentenceIndex: line.globalSentenceIndex,
    lineIndex: line.lineIndex,
    viewIndex: line.viewIndex,
    lineId: line.lineId,
    placement,
    progressStart: line.progressStart,
    progressEnd: line.progressEnd,
    generation: line.generation,
  }
}

export function hitTestVisualLine(
  map: VisualLineMap | null,
  root: HTMLElement | null,
  clientX: number,
  clientY: number,
  visibleViewIndex: number,
) {
  if (!map || !root) return null
  const rootRect = root.getBoundingClientRect()
  const localX = clientX - rootRect.left + root.scrollLeft
  const localY = clientY - rootRect.top + root.scrollTop
  let best: { line: VisualLine; distance: number } | null = null

  for (const line of map.lines) {
    if (line.viewIndex !== visibleViewIndex || line.generation !== map.generation) continue
    const slot = line.contentPage - visibleViewIndex * map.pagesPerView
    const left = map.metrics.rootContentX + (slot * map.metrics.pageStride + line.pageX) * map.metrics.scaleX
    const right = left + line.lineWidth * map.metrics.scaleX
    const top = map.metrics.rootContentY + line.pageY * map.metrics.scaleY
    const bottom = top + line.lineHeight * map.metrics.scaleY
    const paddedLeft = left - 20
    const paddedRight = right + 20
    const paddedTop = top - 9
    const paddedBottom = bottom + 9
    const inside = (
      localX >= paddedLeft && localX <= paddedRight &&
      localY >= paddedTop && localY <= paddedBottom
    )
    if (!inside) continue

    const centerY = (top + bottom) / 2
    const distance = Math.abs(localY - centerY)
    if (!best || distance < best.distance) best = { line, distance }
  }

  return best?.line || null
}
