import { useCallback, type MouseEvent as ReactMouseEvent } from 'react'
import { Icons } from './icons'

async function currentWindow() {
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  return getCurrentWindow()
}

export default function TitleBar() {
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

  return (
    <header className="app-titlebar" onMouseDown={handleTitlebarMouseDown}>
      <div className="titlebar-brand">
        <span>Folio</span>
      </div>
      <div className="titlebar-drag-space" />
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
          <Icons.X size={16} stroke={1.8} />
        </button>
      </div>
    </header>
  )
}
