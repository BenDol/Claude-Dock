import { useEffect, useRef, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { getDockApi } from '../lib/ipc-bridge'
import { useSettingsStore } from '../stores/settings-store'

interface UseTerminalOptions {
  terminalId: string
  onTitleChange?: (title: string) => void
}

export function useTerminal({ terminalId, onTitleChange }: UseTerminalOptions) {
  const termRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const spawnedRef = useRef(false)

  const settings = useSettingsStore((s) => s.settings)

  const initTerminal = useCallback(
    (container: HTMLDivElement | null) => {
      if (!container || termRef.current) return
      containerRef.current = container

      const tc = settings.theme.terminalColors

      const term = new Terminal({
        fontFamily: settings.terminal.fontFamily,
        fontSize: settings.terminal.fontSize,
        lineHeight: settings.terminal.lineHeight,
        cursorStyle: settings.terminal.cursorStyle,
        cursorBlink: settings.terminal.cursorBlink,
        scrollback: settings.terminal.scrollback,
        theme: {
          background: tc.background,
          foreground: tc.foreground,
          cursor: tc.cursor,
          selectionBackground: tc.selectionBackground,
          black: tc.black,
          red: tc.red,
          green: tc.green,
          yellow: tc.yellow,
          blue: tc.blue,
          magenta: tc.magenta,
          cyan: tc.cyan,
          white: tc.white,
          brightBlack: tc.brightBlack,
          brightRed: tc.brightRed,
          brightGreen: tc.brightGreen,
          brightYellow: tc.brightYellow,
          brightBlue: tc.brightBlue,
          brightMagenta: tc.brightMagenta,
          brightCyan: tc.brightCyan,
          brightWhite: tc.brightWhite
        }
      })

      const fitAddon = new FitAddon()
      term.loadAddon(fitAddon)

      term.open(container)

      // Try WebGL addon
      try {
        const webglAddon = new WebglAddon()
        webglAddon.onContextLoss(() => {
          webglAddon.dispose()
        })
        term.loadAddon(webglAddon)
      } catch {
        // WebGL not available, fall back to canvas
      }

      fitAddon.fit()

      termRef.current = term
      fitAddonRef.current = fitAddon

      const api = getDockApi()

      // Send input to PTY
      term.onData((data) => {
        api.terminal.write(terminalId, data)
      })

      // Spawn the PTY
      if (!spawnedRef.current) {
        spawnedRef.current = true
        api.terminal.spawn(terminalId)
      }
    },
    [terminalId, settings]
  )

  // Handle data from PTY
  useEffect(() => {
    const api = getDockApi()
    const cleanup = api.terminal.onData((id, data) => {
      if (id === terminalId && termRef.current) {
        termRef.current.write(data)
      }
    })
    return cleanup
  }, [terminalId])

  // Fit on resize
  const fit = useCallback(() => {
    if (fitAddonRef.current && termRef.current) {
      try {
        fitAddonRef.current.fit()
        const { cols, rows } = termRef.current
        getDockApi().terminal.resize(terminalId, cols, rows)
      } catch {
        // Ignore fit errors
      }
    }
  }, [terminalId])

  // Cleanup
  useEffect(() => {
    return () => {
      termRef.current?.dispose()
      termRef.current = null
      fitAddonRef.current = null
    }
  }, [])

  // Update theme when settings change
  useEffect(() => {
    if (!termRef.current) return
    const tc = settings.theme.terminalColors
    termRef.current.options.theme = {
      background: tc.background,
      foreground: tc.foreground,
      cursor: tc.cursor,
      selectionBackground: tc.selectionBackground,
      black: tc.black,
      red: tc.red,
      green: tc.green,
      yellow: tc.yellow,
      blue: tc.blue,
      magenta: tc.magenta,
      cyan: tc.cyan,
      white: tc.white,
      brightBlack: tc.brightBlack,
      brightRed: tc.brightRed,
      brightGreen: tc.brightGreen,
      brightYellow: tc.brightYellow,
      brightBlue: tc.brightBlue,
      brightMagenta: tc.brightMagenta,
      brightCyan: tc.brightCyan,
      brightWhite: tc.brightWhite
    }
    termRef.current.options.fontFamily = settings.terminal.fontFamily
    termRef.current.options.fontSize = settings.terminal.fontSize
    termRef.current.options.lineHeight = settings.terminal.lineHeight
    termRef.current.options.cursorStyle = settings.terminal.cursorStyle
    termRef.current.options.cursorBlink = settings.terminal.cursorBlink
  }, [settings])

  const focus = useCallback(() => {
    termRef.current?.focus()
  }, [])

  return { initTerminal, fit, focus, termRef }
}
