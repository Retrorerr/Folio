import { Component, type ReactNode } from 'react'

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
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100vh',
            padding: '2rem',
            fontFamily: 'system-ui, sans-serif',
            color: 'var(--ink, #2a2520)',
            background: 'var(--paper-2, #f5efe6)',
            textAlign: 'center',
            gap: '1rem',
          }}
        >
          <h1 style={{ fontSize: '1.5rem', margin: 0 }}>Something went wrong</h1>
          <pre
            style={{
              maxWidth: '40rem',
              whiteSpace: 'pre-wrap',
              opacity: 0.7,
              fontSize: '0.85rem',
              margin: 0,
            }}
          >
            {message}
          </pre>
          <button
            onClick={this.handleReload}
            style={{
              padding: '0.5rem 1.25rem',
              borderRadius: '999px',
              border: '1px solid currentColor',
              background: 'transparent',
              color: 'inherit',
              cursor: 'pointer',
            }}
          >
            Reload
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
