export interface ReaderPageNavigationState {
  canGoPrevious: boolean
  canGoNext: boolean
}

export function clampReaderViewTarget(targetView: number, viewCount: number): number | null {
  if (!Number.isFinite(targetView) || !Number.isFinite(viewCount) || viewCount <= 0) return null
  return Math.min(Math.max(0, Math.floor(viewCount) - 1), Math.max(0, Math.floor(targetView)))
}

export function readerPageNavigationState(
  viewPage: number,
  viewCount: number,
  chapterIdx: number,
  chapterCount: number,
  pageTurnActive = false,
): ReaderPageNavigationState {
  if (pageTurnActive || viewCount <= 0 || chapterCount <= 0) {
    return { canGoPrevious: false, canGoNext: false }
  }
  return {
    canGoPrevious: viewPage > 0 || chapterIdx > 0,
    canGoNext: viewPage < viewCount - 1 || chapterIdx < chapterCount - 1,
  }
}
