import type { Settings } from '../../../shared/settings-schema'

export function applyThemeToDocument(settings: Settings): void {
  const root = document.documentElement
  const { theme, terminal } = settings

  // UI theme
  root.style.setProperty('--accent-color', theme.accentColor)

  // Terminal colors
  const tc = theme.terminalColors
  root.style.setProperty('--term-bg', tc.background)
  root.style.setProperty('--term-fg', tc.foreground)
  root.style.setProperty('--term-cursor', tc.cursor)
  root.style.setProperty('--term-selection', tc.selectionBackground)

  // Terminal font
  root.style.setProperty('--term-font-family', terminal.fontFamily)
  root.style.setProperty('--term-font-size', `${terminal.fontSize}px`)
  root.style.setProperty('--term-line-height', `${terminal.lineHeight}`)

  // Grid
  root.style.setProperty('--grid-gap', `${settings.grid.gapSize}px`)

  // Dark/light mode
  const isDark = theme.mode === 'dark' ||
    (theme.mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)

  root.setAttribute('data-theme', isDark ? 'dark' : 'light')
}
