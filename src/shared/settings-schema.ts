export interface Settings {
  theme: {
    mode: 'dark' | 'light' | 'system'
    accentColor: string
    terminalColors: TerminalColors
  }
  terminal: {
    fontFamily: string
    fontSize: number
    lineHeight: number
    cursorStyle: 'block' | 'underline' | 'bar'
    cursorBlink: boolean
    scrollback: number
  }
  grid: {
    maxColumns: number
    gapSize: number
    defaultMode: 'auto' | 'freeform'
  }
  behavior: {
    confirmCloseWithRunning: boolean
    autoSpawnFirstTerminal: boolean
  }
}

export interface TerminalColors {
  background: string
  foreground: string
  cursor: string
  selectionBackground: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

export const DEFAULT_SETTINGS: Settings = {
  theme: {
    mode: 'dark',
    accentColor: '#6366f1',
    terminalColors: {
      background: '#1a1b26',
      foreground: '#c0caf5',
      cursor: '#c0caf5',
      selectionBackground: '#33467c',
      black: '#15161e',
      red: '#f7768e',
      green: '#9ece6a',
      yellow: '#e0af68',
      blue: '#7aa2f7',
      magenta: '#bb9af7',
      cyan: '#7dcfff',
      white: '#a9b1d6',
      brightBlack: '#414868',
      brightRed: '#f7768e',
      brightGreen: '#9ece6a',
      brightYellow: '#e0af68',
      brightBlue: '#7aa2f7',
      brightMagenta: '#bb9af7',
      brightCyan: '#7dcfff',
      brightWhite: '#c0caf5'
    }
  },
  terminal: {
    fontFamily: "'Cascadia Code', 'Fira Code', 'JetBrains Mono', Consolas, monospace",
    fontSize: 14,
    lineHeight: 1.2,
    cursorStyle: 'block',
    cursorBlink: true,
    scrollback: 5000
  },
  grid: {
    maxColumns: 4,
    gapSize: 8,
    defaultMode: 'auto'
  },
  behavior: {
    confirmCloseWithRunning: true,
    autoSpawnFirstTerminal: true
  }
}
