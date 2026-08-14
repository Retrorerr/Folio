import { useCallback, useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react'
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
  progress = null,
  gpuEnabled = null,
  followAlong = false,
  onBookmark,
}: TitleBarProps) {
  const [isMaximized, setIsMaximized] = useState(false)
  const [isWindowActive, setIsWindowActive] = useState(true)

  useEffect(() => {
    let disposed = false
    const unlisten: Array<() => void> = []

    void (async () => {
      try {
        const win = await currentWindow()
        const syncMaximized = async () => {
          const maximized = await win.isMaximized()
          if (!disposed) setIsMaximized(maximized)
        }
        await syncMaximized()
        unlisten.push(await win.onResized(syncMaximized))
        unlisten.push(await win.onFocusChanged(({ payload }) => {
          if (!disposed) setIsWindowActive(payload)
        }))
      } catch {
        // The browser preview has no native window events.
      }
    })()

    return () => {
      disposed = true
      unlisten.forEach((stop) => stop())
    }
  }, [])

  const runWindowAction = useCallback(async (action: 'minimize' | 'maximize' | 'close') => {
    try {
      const win = await currentWindow()
      if (action === 'minimize') await win.minimize()
      else if (action === 'maximize') {
        await win.toggleMaximize()
        setIsMaximized(await win.isMaximized())
      }
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
    <header
      className={`app-titlebar ${hasBook ? 'is-reader' : 'is-library'} ${followAlong ? 'is-following' : ''} ${isWindowActive ? 'is-window-active' : 'is-window-inactive'}`}
      onMouseDown={handleTitlebarMouseDown}
    >
      <div className="titlebar-main">
        {hasBook ? (
          <>
            <div className="titlebar-book" aria-hidden="true" />
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
          <svg className="titlebar-caption-icon" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M3.5 8.5h9" />
          </svg>
        </button>
        <button
          type="button"
          className="titlebar-control"
          aria-label={isMaximized ? 'Restore' : 'Maximize'}
          title={isMaximized ? 'Restore' : 'Maximize'}
          onClick={() => runWindowAction('maximize')}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          {isMaximized ? (
            <svg className="titlebar-caption-icon" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M5.5 4.5h6v6" />
              <rect x="3.5" y="6.5" width="6" height="6" rx=".5" />
            </svg>
          ) : (
            <svg className="titlebar-caption-icon" viewBox="0 0 16 16" aria-hidden="true">
              <rect x="3.5" y="3.5" width="9" height="9" rx=".6" />
            </svg>
          )}
        </button>
        <button
          type="button"
          className="titlebar-control titlebar-close"
          aria-label="Close"
          title="Close"
          onClick={() => runWindowAction('close')}
        >
          <svg className="titlebar-caption-icon" viewBox="0 0 16 16" aria-hidden="true">
            <path d="m4 4 8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>
    </header>
  )
}
