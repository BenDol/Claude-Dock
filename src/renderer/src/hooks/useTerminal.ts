import { useEffect, useRef, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { CanvasAddon } from '@xterm/addon-canvas'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { getDockApi } from '../lib/ipc-bridge'
import { useDockStore } from '../stores/dock-store'
import { useSettingsStore } from '../stores/settings-store'
import { getEffectiveTerminalColors } from '../lib/theme'
import { InputUndoManager } from '../lib/input-undo'

function matchesKeybind(e: KeyboardEvent, keybind: string): boolean {
  if (!keybind || keybind.startsWith('!')) return false
  const parts = keybind.split('+').map((p) => p.trim().toLowerCase())
  const needCtrl = parts.includes('ctrl')
  const needShift = parts.includes('shift')
  const needAlt = parts.includes('alt')
  const key = parts.find((p) => !['ctrl', 'shift', 'alt', 'meta'].includes(p))
  if (!key) return false
  if (needCtrl !== (e.ctrlKey || e.metaKey)) return false
  if (needShift !== e.shiftKey) return false
  if (needAlt !== e.altKey) return false
  return e.key.toLowerCase() === key
}

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
  const undoRef = useRef(new InputUndoManager())

  const settings = useSettingsStore((s) => s.settings)

  // Spawn PTY immediately on mount (before terminal is created)
  useEffect(() => {
    if (!spawnedRef.current) {
      spawnedRef.current = true
      const ephemeral = useDockStore.getState().ciFixTerminals.has(terminalId)
      getDockApi().terminal.spawn(terminalId, ephemeral ? { ephemeral: true } : undefined)
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

      // Use canvas renderer instead of DOM renderer (avoids CSS dump) or WebGL (GPU contention)
      try {
        term.loadAddon(new CanvasAddon())
      } catch {
        // Falls back to DOM renderer if canvas fails
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

        // Configurable keybinds (undo/redo, select all, directional focus)
        try {
          const { keybindings } = useSettingsStore.getState().settings
          if (matchesKeybind(e, keybindings.undo)) {
            const backspaces = undoRef.current.undo()
            if (backspaces) api.terminal.write(terminalId, backspaces)
            return false
          }
          if (matchesKeybind(e, keybindings.redo)) {
            const text = undoRef.current.redo()
            if (text) api.terminal.write(terminalId, text)
            return false
          }
          if (matchesKeybind(e, keybindings.selectAll)) {
            // Select only the current input, not the entire terminal
            const inputLen = undoRef.current.inputLength
            if (inputLen > 0) {
              const buf = term.buffer.active
              const row = buf.cursorY + buf.baseY
              const col = buf.cursorX
              // Input starts inputLen chars before cursor
              const startCol = col - inputLen
              if (startCol >= 0) {
                term.select(startCol, row, inputLen)
              } else {
                // Input wraps lines — select what we can on current line
                term.select(0, row, col)
              }
            }
            return false
          }
          // Directional focus: prevent xterm from sending CSI sequences,
          // let the event bubble to the window handler in App.tsx
          if (matchesKeybind(e, keybindings.focusUp) ||
              matchesKeybind(e, keybindings.focusDown) ||
              matchesKeybind(e, keybindings.focusLeft) ||
              matchesKeybind(e, keybindings.focusRight)) {
            return false
          }
        } catch { /* non-critical */ }

        // Selection + typing: delete selected text, then let new key through
        if (term.hasSelection() && !e.ctrlKey && !e.altKey && !e.metaKey) {
          const sel = term.getSelection()
          if (sel && (e.key === 'Backspace' || e.key === 'Delete' || e.key.length === 1)) {
            const delCount = sel.length
            term.clearSelection()
            api.terminal.write(terminalId, '\x7f'.repeat(delCount))
            undoRef.current.clear()
            if (e.key === 'Backspace' || e.key === 'Delete') {
              return false // just delete, don't type anything
            }
            // For printable keys, let xterm process the new character normally
            return true
          }
        }

        // Ctrl+Shift+C: copy
        if (e.ctrlKey && e.shiftKey && e.key === 'C') {
          const sel = term.getSelection()
          if (sel) navigator.clipboard.writeText(sel)
          return false
        }

        // Ctrl+Shift+V: paste
        if (e.ctrlKey && e.shiftKey && e.key === 'V') {
          e.preventDefault()
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
          e.preventDefault()
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

      // Send input to PTY and track for undo
      term.onData((data) => {
        try { undoRef.current.onInput(data) } catch { /* non-critical */ }
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
          fit()
        } catch { /* ignore */ }
      }
    }, 50)
  }, [settings, terminalId])

  // Scroll to bottom after grid reposition
  useEffect(() => {
    const handler = () => {
      if (termRef.current) {
        termRef.current.scrollToBottom()
        fit()
      }
    }
    window.addEventListener('terminals-repositioned', handler)
    return () => window.removeEventListener('terminals-repositioned', handler)
  }, [fit])

  const focus = useCallback(() => {
    if (termRef.current) {
      termRef.current.focus()
      termRef.current.refresh(0, termRef.current.rows - 1)
    }
  }, [])

  return { initTerminal, fit, focus, termRef, gotDataRef }
}
