import { Component, type ReactNode } from 'react'
import TitleBar from './components/TitleBar'

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
}

export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: unknown) {
    console.error('Folio crashed:', error, info)
  }

  handleReload = () => {
    window.location.reload()
  }

  render() {
    if (this.state.error) {
      const message = this.state.error?.message || String(this.state.error)
      return (
        <div className="error-screen theme-folio">
          <TitleBar />
          <main className="error-card" role="alert">
            <img src="/folio-monochrome-icon.png" alt="" />
            <div className="error-kicker">Folio recovery</div>
            <h1>Your reading session hit a snag.</h1>
            <p>Your library and reading position are stored locally. Reload Folio to restore the app safely.</p>
            <button type="button" className="error-reload" onClick={this.handleReload} autoFocus>
              Reload Folio
            </button>
            <details>
              <summary>Technical details</summary>
              <pre>{message}</pre>
            </details>
          </main>
        </div>
      )
    }
    return this.props.children
  }
}
