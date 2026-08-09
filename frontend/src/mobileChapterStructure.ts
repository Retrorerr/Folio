export type MobileRawBlock = {
  type: 'heading' | 'paragraph'
  text: string
  level?: number
}

export type MobileStructuredChapter = {
  title: string | null
  number: string | null
  blocks: MobileRawBlock[]
}

type MobileNarrationSentence = {
  text?: string | null
  global_sentence_idx?: number | null
}

type MobileNarrationPage = {
  sentences?: MobileNarrationSentence[]
}

export type MobileReadingPosition = {
  page: number
  sentence_idx: number
  content_page?: number | null
  visual_page?: number | null
  pages_per_view?: number | null
  layout_key?: string | null
  chunk_progress?: number | null
}

const CHAPTER_MARKER = /^\s*(?:(?:chapter|part|book|prologue|epilogue|introduction|preface|foreword|afterword)\b|(?:[ivxlcdm]{1,8}|\d{1,3})(?:[.\s]\s*[A-Z]|\s*$))/i
const FRONTMATTER = /\b(ebook\s*v?\d|isbn\b|all rights reserved|copyright\s*©?|first published|printed in|library of congress|this edition|scanned by|converted to epub|retail epub|version\s*\d|table of contents|contents)\b/i

function normalizeText(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

/** Split labels such as “Chapter VII — The Races” without losing bare labels. */
export function mobileChapterNumberFromTitle(value: string): { number: string | null; title: string } {
  const title = normalizeText(value)
  if (!title) return { number: null, title: '' }
  const named = title.match(/^\s*(?:chapter|ch\.?|part|book)\s+([ivxlcdm\d]+)\b[\s.—–:-]*(.*)$/i)
  if (named) {
    return {
      number: named[1].toUpperCase(),
      title: normalizeText(named[2]) || title,
    }
  }
  const numeric = title.match(/^\s*(\d{1,3})[.\s]\s*(.+?)\s*\.?\s*$/)
  if (numeric) return { number: numeric[1], title: normalizeText(numeric[2]) }
  const roman = title.match(/^\s*([ivxlcdm]{1,8})[.\s]\s*(.+?)\s*\.?\s*$/i)
  if (roman) return { number: roman[1].toUpperCase(), title: normalizeText(roman[2]) }
  const bareNumber = title.match(/^\s*([ivxlcdm]{1,8}|\d{1,3})\s*$/i)
  if (bareNumber) {
    const number = bareNumber[1].toUpperCase()
    return { number, title: `Chapter ${number}` }
  }
  return { number: null, title }
}

function promoteChapterMarkers(blocks: MobileRawBlock[]): MobileRawBlock[] {
  return blocks.map((block, index) => {
    if (block.type !== 'paragraph') return block
    const text = normalizeText(block.text)
    if (!text || text.length > 140 || !CHAPTER_MARKER.test(text)) return block
    const hasBodyAfter = blocks.slice(index + 1, index + 6).some((next) => (
      next.type === 'paragraph' && normalizeText(next.text).length > 200
    ))
    return hasBodyAfter ? { type: 'heading', level: 1, text } : block
  })
}

function splitDocument(blocks: MobileRawBlock[]): MobileStructuredChapter[] {
  const headings = blocks.filter((block) => block.type === 'heading')
  const headingLevels = headings
    .map((block) => Math.max(1, Math.min(6, Math.floor(Number(block.level) || 1))))
  if (!headingLevels.length) return [{ title: null, number: null, blocks: [...blocks] }]

  const splitLevel = Math.min(...headingLevels)
  const hasExplicitChapterMarkers = headings.some((block) => CHAPTER_MARKER.test(normalizeText(block.text)))
  const chapters: MobileStructuredChapter[] = []
  let currentTitle: string | null = null
  let currentBlocks: MobileRawBlock[] = []

  const flush = () => {
    if (!currentTitle && !currentBlocks.length) return
    const parsed = mobileChapterNumberFromTitle(currentTitle || '')
    chapters.push({
      title: parsed.title || currentTitle,
      number: parsed.number,
      blocks: currentBlocks,
    })
  }

  blocks.forEach((block) => {
    const level = Math.max(1, Math.min(6, Math.floor(Number(block.level) || 1)))
    const isBoundary = block.type === 'heading' && (
      hasExplicitChapterMarkers
        ? CHAPTER_MARKER.test(normalizeText(block.text))
        : level === splitLevel
    )
    if (isBoundary) {
      flush()
      currentTitle = normalizeText(block.text) || null
      currentBlocks = []
    } else {
      currentBlocks.push(block)
    }
  })
  flush()
  return chapters
}

function looksLikeFrontmatter(chapter: MobileStructuredChapter): boolean {
  const body = normalizeText(chapter.blocks
    .filter((block) => block.type === 'paragraph')
    .map((block) => block.text)
    .join(' '))
  if (!body) return true
  return FRONTMATTER.test(`${chapter.title || ''} ${body}`)
}

/**
 * Turn EPUB spine documents into logical chapters. A spine file is only a
 * packaging unit: publishers commonly place several real chapters in one.
 */
export function structureMobileSpineDocuments(documents: MobileRawBlock[][]): MobileStructuredChapter[] {
  const chapters: MobileStructuredChapter[] = []
  documents.forEach((document) => {
    const split = splitDocument(promoteChapterMarkers(document))
    const hasNamedBoundary = split.some((chapter) => Boolean(chapter.title))
    if (split[0] && !split[0].title && chapters.length && hasNamedBoundary) {
      chapters[chapters.length - 1].blocks.push(...split[0].blocks)
      split.shift()
    }
    split.forEach((chapter) => {
      const hasBody = chapter.blocks.some((block) => block.type === 'paragraph' && normalizeText(block.text))
      if (!hasBody) return
      // Remove frontmatter only when its text positively identifies it. Short
      // prologues and short first chapters are real content and must survive.
      if (!chapters.length && looksLikeFrontmatter(chapter)) return
      chapters.push({ ...chapter, blocks: [...chapter.blocks] })
    })
  })
  return chapters
}

function finiteIndex(value: unknown, maximum: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || maximum <= 0) return 0
  return Math.max(0, Math.min(maximum - 1, Math.floor(parsed)))
}

/** Preserve a saved reading anchor when a content migration changes chapter boundaries. */
export function remapMobileReadingPosition<T extends MobileReadingPosition>(
  position: T,
  oldPages: MobileNarrationPage[],
  newPages: MobileNarrationPage[],
): T {
  const remapped = (page: number, sentence: number): T => ({
    ...position,
    page,
    sentence_idx: sentence,
    content_page: null,
    visual_page: null,
    pages_per_view: null,
    layout_key: null,
    chunk_progress: 0,
  })
  if (!newPages.length) return remapped(0, 0)
  const oldPageIndex = finiteIndex(position.page, oldPages.length)
  const oldSentences = oldPages[oldPageIndex]?.sentences || []
  const oldSentenceIndex = finiteIndex(position.sentence_idx, oldSentences.length)
  const anchor = oldSentences[oldSentenceIndex]
  const anchorText = normalizeText(anchor?.text).toLocaleLowerCase()
  const anchorGlobal = Number(anchor?.global_sentence_idx)
  const candidates: Array<{ page: number; sentence: number; global: number | null }> = []

  newPages.forEach((page, pageIndex) => {
    ;(page.sentences || []).forEach((sentence, sentenceIndex) => {
      if (anchorText && normalizeText(sentence.text).toLocaleLowerCase() !== anchorText) return
      const global = Number(sentence.global_sentence_idx)
      candidates.push({ page: pageIndex, sentence: sentenceIndex, global: Number.isFinite(global) ? global : null })
    })
  })

  if (candidates.length) {
    candidates.sort((left, right) => {
      if (Number.isFinite(anchorGlobal)) {
        const leftDelta = left.global == null ? Number.MAX_SAFE_INTEGER : Math.abs(left.global - anchorGlobal)
        const rightDelta = right.global == null ? Number.MAX_SAFE_INTEGER : Math.abs(right.global - anchorGlobal)
        if (leftDelta !== rightDelta) return leftDelta - rightDelta
      }
      const pageDelta = Math.abs(left.page - oldPageIndex) - Math.abs(right.page - oldPageIndex)
      return pageDelta || left.sentence - right.sentence
    })
    const target = candidates[0]
    return remapped(target.page, target.sentence)
  }

  const pageRatio = oldPages.length > 1 ? oldPageIndex / (oldPages.length - 1) : 0
  const page = Math.round(pageRatio * Math.max(0, newPages.length - 1))
  const newSentences = newPages[page]?.sentences || []
  const sentenceRatio = oldSentences.length > 1 ? oldSentenceIndex / (oldSentences.length - 1) : 0
  return remapped(page, Math.round(sentenceRatio * Math.max(0, newSentences.length - 1)))
}
