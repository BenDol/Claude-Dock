export type TerminalStyle = 'default' | 'standard' | 'claude-code'

export interface Settings {
  theme: {
    mode: 'dark' | 'light' | 'system'
    accentColor: string
    terminalStyle: TerminalStyle
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
  updater: {
    profile: string // 'latest' | 'bleeding-edge' | specific release tag
  }
  keybindings: {
    focusUp: string
    focusDown: string
    focusLeft: string
    focusRight: string
    undo: string
    redo: string
    selectAll: string
  }
  linked: {
    enabled: boolean
  }
  advanced: {
    debugLogging: boolean
    disableGpuAcceleration: boolean
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

export const DARK_TERMINAL_COLORS: TerminalColors = {
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

export const STANDARD_TERMINAL_COLORS: TerminalColors = {
  background: '#000000',
  foreground: '#cccccc',
  cursor: '#ffffff',
  selectionBackground: '#444444',
  black: '#000000',
  red: '#cc0000',
  green: '#00cc00',
  yellow: '#cccc00',
  blue: '#0000cc',
  magenta: '#cc00cc',
  cyan: '#00cccc',
  white: '#cccccc',
  brightBlack: '#666666',
  brightRed: '#ff0000',
  brightGreen: '#00ff00',
  brightYellow: '#ffff00',
  brightBlue: '#5c5cff',
  brightMagenta: '#ff00ff',
  brightCyan: '#00ffff',
  brightWhite: '#ffffff'
}

export const CLAUDE_CODE_TERMINAL_COLORS: TerminalColors = {
  background: '#000000',
  foreground: '#D4D4D4',
  cursor: '#DA8B55',
  selectionBackground: '#2D3450',
  black: '#1A1A1A',
  red: '#E87D5F',
  green: '#8BBF65',
  yellow: '#DA8B55',
  blue: '#7B9FE8',
  magenta: '#C49BD6',
  cyan: '#5FB8C2',
  white: '#D4D4D4',
  brightBlack: '#555555',
  brightRed: '#F09B7F',
  brightGreen: '#A5D67E',
  brightYellow: '#E8A86F',
  brightBlue: '#99B9F0',
  brightMagenta: '#D4B3E0',
  brightCyan: '#7FCCD4',
  brightWhite: '#FFFFFF'
}

export const LIGHT_TERMINAL_COLORS: TerminalColors = {
  background: '#fafafa',
  foreground: '#383a42',
  cursor: '#526eff',
  selectionBackground: '#bfceff',
  black: '#383a42',
  red: '#e45649',
  green: '#50a14f',
  yellow: '#c18401',
  blue: '#4078f2',
  magenta: '#a626a4',
  cyan: '#0184bc',
  white: '#a0a1a7',
  brightBlack: '#696c77',
  brightRed: '#e45649',
  brightGreen: '#50a14f',
  brightYellow: '#c18401',
  brightBlue: '#4078f2',
  brightMagenta: '#a626a4',
  brightCyan: '#0184bc',
  brightWhite: '#fafafa'
}

export const DEFAULT_SETTINGS: Settings = {
  theme: {
    mode: 'dark',
    accentColor: '#6366f1',
    terminalStyle: 'default',
    terminalColors: { ...DARK_TERMINAL_COLORS }
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
    gapSize: 0,
    defaultMode: 'auto'
  },
  behavior: {
    confirmCloseWithRunning: true,
    autoSpawnFirstTerminal: true
  },
  updater: {
    profile: 'latest'
  },
  keybindings: {
    focusUp: 'Ctrl+Shift+ArrowUp',
    focusDown: 'Ctrl+Shift+ArrowDown',
    focusLeft: 'Ctrl+Shift+ArrowLeft',
    focusRight: 'Ctrl+Shift+ArrowRight',
    undo: 'Ctrl+Shift+Z',
    redo: 'Ctrl+Shift+Y',
    selectAll: 'Ctrl+Shift+A'
  },
  linked: {
    enabled: false
  },
  advanced: {
    debugLogging: false,
    disableGpuAcceleration: false
  }
}
