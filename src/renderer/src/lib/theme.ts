import type { Settings, TerminalColors } from '../../../shared/settings-schema'
import { DARK_TERMINAL_COLORS, LIGHT_TERMINAL_COLORS, STANDARD_TERMINAL_COLORS, CLAUDE_CODE_TERMINAL_COLORS } from '../../../shared/settings-schema'

export function isDarkMode(settings: Settings): boolean {
  return settings.theme.mode === 'dark' ||
    (settings.theme.mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
}

export function getEffectiveTerminalColors(settings: Settings): TerminalColors {
  if (settings.theme.terminalStyle === 'standard') return STANDARD_TERMINAL_COLORS
  if (settings.theme.terminalStyle === 'claude-code') return CLAUDE_CODE_TERMINAL_COLORS
  const customized = JSON.stringify(settings.theme.terminalColors) !== JSON.stringify(DARK_TERMINAL_COLORS)
  if (customized) return settings.theme.terminalColors
  return isDarkMode(settings) ? DARK_TERMINAL_COLORS : LIGHT_TERMINAL_COLORS
}

export function applyThemeToDocument(settings: Settings): void {
  const root = document.documentElement
  const { terminal } = settings

  // UI theme
  root.style.setProperty('--accent-color', settings.theme.accentColor)

  // Terminal colors
  const tc = getEffectiveTerminalColors(settings)
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
  root.setAttribute('data-theme', isDarkMode(settings) ? 'dark' : 'light')
}
