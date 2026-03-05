import { useEffect, useRef, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { getDockApi } from '../lib/ipc-bridge'
import { useSettingsStore } from '../stores/settings-store'
import { getEffectiveTerminalColors } from '../lib/theme'

interface UseTerminalOptions {
  terminalId: string
  onTitleChange?: (title: string) => void
}

export function useTerminal({ terminalId, onTitleChange }: UseTerminalOptions) {
  const termRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const spawnedRef = useRef(false)
  const dataBufferRef = useRef<string[]>([])
  const dataLenRef = useRef(0)
  const gotDataRef = useRef(false)
  const mountTimeRef = useRef(Date.now())

  const settings = useSettingsStore((s) => s.settings)

  // Spawn PTY immediately on mount (before terminal is created)
  useEffect(() => {
    if (!spawnedRef.current) {
      spawnedRef.current = true
      getDockApi().terminal.spawn(terminalId)
    }
  }, [terminalId])

  // Buffer data from PTY - works even before terminal is mounted
  useEffect(() => {
    const api = getDockApi()
    const cleanup = api.terminal.onData((id, data) => {
      if (id !== terminalId) return
      dataLenRef.current += data.length
      // Only mark ready after enough data (skip shell prompt + claude command echo)
      if (dataLenRef.current > 1500) {
        gotDataRef.current = true
      }
      if (termRef.current) {
        termRef.current.write(data)
      } else {
        dataBufferRef.current.push(data)
      }
    })
    return cleanup
  }, [terminalId])

  const initTerminal = useCallback(
    (container: HTMLDivElement | null) => {
      if (!container || termRef.current) return
      containerRef.current = container

      const tc = getEffectiveTerminalColors(settings)

      const term = new Terminal({
        allowProposedApi: true,
        fontFamily: settings.terminal.fontFamily,
        fontSize: settings.terminal.fontSize,
        lineHeight: settings.terminal.lineHeight,
        cursorStyle: settings.terminal.cursorStyle,
        cursorBlink: settings.terminal.cursorBlink,
        scrollback: settings.terminal.scrollback,
        theme: { ...tc }
      })

      const fitAddon = new FitAddon()
      term.loadAddon(fitAddon)

      // Unicode 11 support for emoji and wide characters
      const unicode11Addon = new Unicode11Addon()
      term.loadAddon(unicode11Addon)
      term.unicode.activeVersion = '11'

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

      // Replay buffered data
      if (dataBufferRef.current.length > 0) {
        for (const chunk of dataBufferRef.current) {
          term.write(chunk)
        }
        dataBufferRef.current = []
      }

      const api = getDockApi()

      // Ctrl+Shift+C = copy, Ctrl+Shift+V = paste
      // Also support Ctrl+C as copy when there's a selection (otherwise send SIGINT)
      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== 'keydown') return true

        // Ctrl+Shift+C: copy
        if (e.ctrlKey && e.shiftKey && e.key === 'C') {
          const sel = term.getSelection()
          if (sel) navigator.clipboard.writeText(sel)
          return false
        }

        // Ctrl+Shift+V: paste
        if (e.ctrlKey && e.shiftKey && e.key === 'V') {
          navigator.clipboard.readText().then((text) => {
            api.terminal.write(terminalId, text)
          })
          return false
        }

        // Ctrl+C with selection: copy (without selection, let it send SIGINT)
        if (e.ctrlKey && !e.shiftKey && e.key === 'c' && term.hasSelection()) {
          navigator.clipboard.writeText(term.getSelection())
          term.clearSelection()
          return false
        }

        // Ctrl+V: paste
        if (e.ctrlKey && !e.shiftKey && e.key === 'v') {
          navigator.clipboard.readText().then((text) => {
            api.terminal.write(terminalId, text)
          })
          return false
        }

        return true
      })

      // Right-click context menu: paste
      container.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        const sel = term.getSelection()
        if (sel) {
          navigator.clipboard.writeText(sel)
          term.clearSelection()
        } else {
          navigator.clipboard.readText().then((text) => {
            api.terminal.write(terminalId, text)
          })
        }
      })

      // Send input to PTY
      term.onData((data) => {
        api.terminal.write(terminalId, data)
      })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [terminalId]
  )

  // Fit on resize
  const fit = useCallback(() => {
    if (fitAddonRef.current && termRef.current) {
      try {
        const term = termRef.current
        // Clear scrollback before resize to prevent xterm reflow duplication
        // But skip during first 10s so resumed sessions keep their history
        if (Date.now() - mountTimeRef.current > 10000) {
          term.clear()
        }
        fitAddonRef.current.fit()
        const { cols, rows } = term
        getDockApi().terminal.resize(terminalId, cols, rows)
        term.scrollToBottom()
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
    const tc = getEffectiveTerminalColors(settings)
    termRef.current.options.theme = { ...tc }
    termRef.current.options.fontFamily = settings.terminal.fontFamily
    termRef.current.options.fontSize = settings.terminal.fontSize
    termRef.current.options.lineHeight = settings.terminal.lineHeight
    termRef.current.options.cursorStyle = settings.terminal.cursorStyle
    termRef.current.options.cursorBlink = settings.terminal.cursorBlink

    // Re-fit after font changes so xterm recalculates layout
    setTimeout(() => {
      if (fitAddonRef.current && termRef.current) {
        try {
          fitAddonRef.current.fit()
          const { cols, rows } = termRef.current
          getDockApi().terminal.resize(terminalId, cols, rows)
        } catch { /* ignore */ }
      }
    }, 50)
  }, [settings, terminalId])

  const focus = useCallback(() => {
    termRef.current?.focus()
  }, [])

  return { initTerminal, fit, focus, termRef, gotDataRef }
}
