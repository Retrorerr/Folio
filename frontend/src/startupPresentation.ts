export type StartupPresentationInput = {
  interfaceReady: boolean
  backendLaunchStarted: boolean
  backendLaunchSettled: boolean
  backendReachable: boolean
  recentLoaded: boolean
  bookCount: number
  startupIssue: boolean
}

export type StartupPresentation = {
  ready: boolean
  progress: number
  headline: string
  statusText: string
}

export function buildStartupPresentation(input: StartupPresentationInput): StartupPresentation {
  const {
    interfaceReady,
    backendLaunchStarted,
    backendLaunchSettled,
    backendReachable,
    recentLoaded,
    bookCount,
    startupIssue,
  } = input
  const ready = interfaceReady && backendReachable && recentLoaded
  const progress = ready ? 100
    : recentLoaded ? 94
      : backendReachable ? 72
        : backendLaunchSettled ? 48
          : backendLaunchStarted ? 30
            : 14
  const headline = startupIssue ? 'Folio needs a moment'
    : ready ? 'Your library is ready'
      : recentLoaded ? 'Finishing your reading room'
        : backendReachable ? 'Restoring your shelf'
          : backendLaunchStarted ? 'Connecting to your library'
            : 'Starting Folio'
  const statusText = startupIssue
    ? 'Your books are safe. Folio is still trying to reconnect.'
    : ready
      ? `${bookCount} ${bookCount === 1 ? 'book is' : 'books are'} ready where you left off.`
      : recentLoaded
        ? 'Putting the final details in place.'
        : backendReachable
          ? 'Loading books and reading progress from this device.'
          : 'Opening your private, local reading library.'

  return { ready, progress, headline, statusText }
}
