export const FOLIO_THEMES = ['sepia', 'light', 'dark', 'folio', 'blackleaf'] as const

export type FolioTheme = typeof FOLIO_THEMES[number]

export function isFolioTheme(value: unknown): value is FolioTheme {
  return typeof value === 'string' && (FOLIO_THEMES as readonly string[]).includes(value)
}

export function resolveInitialTheme(
  savedTheme: unknown,
  legacyDarkMode: string | null,
  prefersDark: boolean,
): FolioTheme {
  if (isFolioTheme(savedTheme)) return savedTheme
  // Preserve an explicit preference written by older Folio versions.
  if (legacyDarkMode === 'true') return 'dark'
  if (legacyDarkMode === 'false') return 'sepia'
  return prefersDark ? 'blackleaf' : 'sepia'
}
