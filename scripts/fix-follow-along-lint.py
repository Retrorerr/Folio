from pathlib import Path

path = Path('frontend/src/followAlong/usePlaybackLineCursor.tsx')
text = path.read_text(encoding='utf-8')

old = """  const performRebuild = useCallback(() => {
    rebuildFrameRef.current = null
    const root = rootRef.current
    if (!root || !bookId) return

    const generation = generationRef.current + 1
    generationRef.current = generation
    const map = buildVisualLineMap({
      root,
      bookId,
      chapterIndex,
      generation,
      pagesPerView,
      pageStride,
      layoutIdentity,
    })

    if (map) {
      commitMap(map)
      return
    }

    rebuildAttemptRef.current += 1
    trace('layout-build-failed', {
      reason: rebuildReasonRef.current,
      attempt: rebuildAttemptRef.current,
    })
    if (rebuildAttemptRef.current < MAX_BUILD_ATTEMPTS) {
      rebuildFrameRef.current = requestAnimationFrame(performRebuild)
      return
    }
    dispatch({ type: 'UNAVAILABLE', reason: `layout:${rebuildReasonRef.current}` })
  }, [bookId, chapterIndex, commitMap, layoutIdentity, pageStride, pagesPerView, rootRef, trace])
"""

new = """  const performRebuild = useCallback(() => {
    function attemptBuild() {
      rebuildFrameRef.current = null
      const root = rootRef.current
      if (!root || !bookId) return

      const generation = generationRef.current + 1
      generationRef.current = generation
      const map = buildVisualLineMap({
        root,
        bookId,
        chapterIndex,
        generation,
        pagesPerView,
        pageStride,
        layoutIdentity,
      })

      if (map) {
        commitMap(map)
        return
      }

      rebuildAttemptRef.current += 1
      trace('layout-build-failed', {
        reason: rebuildReasonRef.current,
        attempt: rebuildAttemptRef.current,
      })
      if (rebuildAttemptRef.current < MAX_BUILD_ATTEMPTS) {
        rebuildFrameRef.current = requestAnimationFrame(attemptBuild)
        return
      }
      dispatch({ type: 'UNAVAILABLE', reason: `layout:${rebuildReasonRef.current}` })
    }

    attemptBuild()
  }, [bookId, chapterIndex, commitMap, layoutIdentity, pageStride, pagesPerView, rootRef, trace])
"""

count = text.count(old)
if count != 1:
    raise RuntimeError(f'expected one rebuild callback, found {count}')

path.write_text(text.replace(old, new, 1), encoding='utf-8')
print('Rewrote bounded layout retry without a self-referential React callback')
