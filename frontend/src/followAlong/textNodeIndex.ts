/**
 * Reusable text-node offsets for a sentence.
 *
 * A sentence can contain inline elements (drop caps, emphasis, links, and
 * other spans), so a DOM Range still needs concrete text nodes. The old
 * resolver created a TreeWalker from the sentence root for every token. This
 * index walks the sentence once and resolves subsequent offsets by binary
 * search without changing the resulting Range boundaries.
 */
export type TextNodeSegment = {
  node: Text
  start: number
  end: number
}

export type TextNodeIndex = {
  segments: TextNodeSegment[]
  totalLength: number
}

export function buildTextNodeIndex(element: Element): TextNodeIndex {
  const segments: TextNodeSegment[] = []
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  let offset = 0
  let node: Node | null

  while ((node = walker.nextNode())) {
    const text = node as Text
    const length = text.nodeValue?.length || 0
    if (length > 0) {
      segments.push({ node: text, start: offset, end: offset + length })
      offset += length
    }
  }

  return { segments, totalLength: offset }
}

export function resolveTextNodeSegment(index: TextNodeIndex, offset: number): TextNodeSegment | null {
  if (!Number.isFinite(offset) || offset < 0 || offset > index.totalLength) return null
  const segments = index.segments
  let low = 0
  let high = segments.length

  // Find the last segment whose start is at or before the requested offset.
  // At a text-node boundary this intentionally chooses the preceding node,
  // matching the old TreeWalker resolver's Range boundary behavior.
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (segments[middle].start <= offset) low = middle + 1
    else high = middle
  }

  let candidate = segments[low - 1]
  if (candidate?.start === offset && low > 1) candidate = segments[low - 2]
  return candidate && offset <= candidate.end ? candidate : null
}

export function rangeForTextOffsets(
  index: TextNodeIndex,
  start: number,
  end: number,
): Range | null {
  if (start < 0 || end < start || end > index.totalLength) return null
  const startSegment = resolveTextNodeSegment(index, start)
  const endSegment = resolveTextNodeSegment(index, end)
  if (!startSegment || !endSegment) return null

  try {
    const range = document.createRange()
    range.setStart(startSegment.node, Math.min(start - startSegment.start, startSegment.node.length))
    range.setEnd(endSegment.node, Math.min(end - endSegment.start, endSegment.node.length))
    return range
  } catch {
    return null
  }
}
