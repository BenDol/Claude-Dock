import type { Settings, TerminalColors, BarSize } from '../../../shared/settings-schema'
import { DARK_TERMINAL_COLORS, LIGHT_TERMINAL_COLORS, STANDARD_TERMINAL_COLORS, CLAUDE_CODE_TERMINAL_COLORS } from '../../../shared/settings-schema'

const TOOLBAR_DIMENSIONS: Record<BarSize, { height: number; fontSize: number; iconSize: number; btnPadV: number; btnPadH: number; gap: number; winBtnW: number; sepH: number }> = {
  small:  { height: 28, fontSize: 11, iconSize: 16, btnPadV: 2, btnPadH: 5, gap: 8, winBtnW: 34, sepH: 16 },
  medium: { height: 36, fontSize: 12, iconSize: 18, btnPadV: 4, btnPadH: 7, gap: 10, winBtnW: 40, sepH: 20 },
  large:  { height: 44, fontSize: 13, iconSize: 20, btnPadV: 6, btnPadH: 9, gap: 12, winBtnW: 46, sepH: 24 }
}

const TERM_HEADER_DIMENSIONS: Record<BarSize, { height: number; fontSize: number; actionFontSize: number; closeFontSize: number; actionPad: number }> = {
  small:  { height: 18, fontSize: 10, actionFontSize: 12, closeFontSize: 15, actionPad: 2 },
  medium: { height: 24, fontSize: 11, actionFontSize: 14, closeFontSize: 17, actionPad: 3 },
  large:  { height: 30, fontSize: 12, actionFontSize: 16, closeFontSize: 19, actionPad: 4 }
}

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

/** Lighten a #rrggbb color by `amount` (0–255 per channel). Used to differentiate
 *  shell terminal backgrounds from Claude terminal backgrounds. */
function lightenHex(hex: string, amount: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return hex
  const num = parseInt(m[1], 16)
  const r = Math.min(255, ((num >> 16) & 0xff) + amount)
  const g = Math.min(255, ((num >> 8) & 0xff) + amount)
  const b = Math.min(255, (num & 0xff) + amount)
  return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')
}

/** Shell terminals share the active theme but use a lightened background to make
 *  them visually distinct from Claude terminals. */
export function getShellTerminalColors(settings: Settings): TerminalColors {
  const tc = getEffectiveTerminalColors(settings)
  return { ...tc, background: lightenHex(tc.background, 18) }
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
  // Shell terminals use a slightly lightened bg to look different from Claude terminals
  root.style.setProperty('--shell-term-bg', getShellTerminalColors(settings).background)

  // Terminal font
  root.style.setProperty('--term-font-family', terminal.fontFamily)
  root.style.setProperty('--term-font-size', `${terminal.fontSize}px`)
  root.style.setProperty('--term-line-height', `${terminal.lineHeight}`)

  // Grid
  root.style.setProperty('--grid-gap', `${settings.grid.gapSize}px`)

  // Toolbar (header bar) size
  const tb = TOOLBAR_DIMENSIONS[settings.theme.headerBarSize || 'small']
  root.style.setProperty('--toolbar-height', `${tb.height}px`)
  root.style.setProperty('--toolbar-font-size', `${tb.fontSize}px`)
  root.style.setProperty('--toolbar-icon-size', `${tb.iconSize}px`)
  root.style.setProperty('--toolbar-btn-pad-v', `${tb.btnPadV}px`)
  root.style.setProperty('--toolbar-btn-pad-h', `${tb.btnPadH}px`)
  root.style.setProperty('--toolbar-gap', `${tb.gap}px`)
  root.style.setProperty('--toolbar-win-btn-w', `${tb.winBtnW}px`)
  root.style.setProperty('--toolbar-sep-h', `${tb.sepH}px`)

  // Terminal header bar size
  const th = TERM_HEADER_DIMENSIONS[settings.theme.terminalHeaderBarSize || 'small']
  root.style.setProperty('--term-header-height', `${th.height}px`)
  root.style.setProperty('--term-header-font', `${th.fontSize}px`)
  root.style.setProperty('--term-header-action-font', `${th.actionFontSize}px`)
  root.style.setProperty('--term-header-close-font', `${th.closeFontSize}px`)
  root.style.setProperty('--term-header-action-pad', `${th.actionPad}px`)

  // Dark/light mode
  root.setAttribute('data-theme', isDarkMode(settings) ? 'dark' : 'light')
}
