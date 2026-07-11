import { useCallback, type MouseEvent as ReactMouseEvent } from 'react'
import { Icons } from './icons'

async function currentWindow() {
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  return getCurrentWindow()
}

type TitleBarProps = {
  bookTitle?: string
  author?: string
  progress?: { current: number; total: number } | null
  gpuEnabled?: boolean | null
  followAlong?: boolean
  onBookmark?: () => void
}

export default function TitleBar({
  bookTitle,
  author,
  progress = null,
  gpuEnabled = null,
  followAlong = false,
  onBookmark,
}: TitleBarProps) {
  const runWindowAction = useCallback(async (action: 'minimize' | 'maximize' | 'close') => {
    try {
      const win = await currentWindow()
      if (action === 'minimize') await win.minimize()
      else if (action === 'maximize') await win.toggleMaximize()
      else await win.close()
    } catch {
      // In browser preview we expect these calls to fail harmlessly.
    }
  }, [])

  const handleTitlebarMouseDown = useCallback(async (event: ReactMouseEvent<HTMLElement>) => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement | null
    if (target?.closest('button, input, textarea, select, a')) return

    try {
      const win = await currentWindow()
      if (event.detail === 2) {
        await win.toggleMaximize()
      } else {
        await win.startDragging()
      }
    } catch {
      // Browser preview and some OS gestures can reject drag starts.
    }
  }, [])

  const hasBook = Boolean(bookTitle)
  const progressTotal = Math.max(1, progress?.total || 1)
  const progressCurrent = Math.min(progressTotal, Math.max(1, progress?.current || 1))
  const progressPct = progress ? Math.min(100, Math.max(0, (progressCurrent / progressTotal) * 100)) : 0

  return (
    <header className={`app-titlebar ${hasBook ? 'is-reader' : 'is-library'} ${followAlong ? 'is-following' : ''}`} onMouseDown={handleTitlebarMouseDown}>
      <div className="titlebar-main">
        {hasBook ? (
          <>
            <div className="titlebar-book">
              <span className="titlebar-book-title">{bookTitle}</span>
              {author && <><span className="titlebar-dot" /><span className="titlebar-book-author">{author}</span></>}
            </div>
            {progress && (
              <div className="titlebar-progress" aria-label={`Reading progress page ${progressCurrent} of ${progressTotal}`}>
                <div className="titlebar-progress-bar"><div className="fill" style={{ width: `${progressPct}%` }} /></div>
                <div className="titlebar-progress-label">
                  <span>P. {progressCurrent} / {progressTotal}</span>
                  <span>{Math.round(progressPct)}%</span>
                </div>
              </div>
            )}
            <div className="titlebar-app-actions" onMouseDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
              {gpuEnabled !== null && gpuEnabled !== undefined && (
                <span className={`gpu-badge small ${gpuEnabled ? 'gpu-on' : 'gpu-off'}`}>
                  {gpuEnabled ? 'GPU' : 'CPU'}
                </span>
              )}
              {onBookmark && (
                <button
                  type="button"
                  className="titlebar-action"
                  onClick={onBookmark}
                  title="Add bookmark"
                  aria-label="Add bookmark"
                >
                  <Icons.Bookmark size={16} />
                </button>
              )}
            </div>
          </>
        ) : (
          <div className="titlebar-empty" aria-hidden="true" />
        )}
      </div>
      <div className="titlebar-controls" onMouseDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="titlebar-control"
          aria-label="Minimize"
          title="Minimize"
          onClick={() => runWindowAction('minimize')}
        >
          <span className="titlebar-minimize" />
        </button>
        <button
          type="button"
          className="titlebar-control"
          aria-label="Maximize"
          title="Maximize"
          onClick={() => runWindowAction('maximize')}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <span className="titlebar-maximize" />
        </button>
        <button
          type="button"
          className="titlebar-control titlebar-close"
          aria-label="Close"
          title="Close"
          onClick={() => runWindowAction('close')}
        >
          <Icons.X size={10} stroke={1.5} />
        </button>
      </div>
    </header>
  )
}
