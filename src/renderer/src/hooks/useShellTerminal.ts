import { useEffect, useRef, useCallback, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { CanvasAddon } from '@xterm/addon-canvas'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { SearchAddon } from '@xterm/addon-search'
import { getDockApi } from '../lib/ipc-bridge'
import { useSettingsStore } from '../stores/settings-store'
import { getShellTerminalColors } from '../lib/theme'

interface UseShellTerminalOptions {
  shellId: string
  /** Override shell type (e.g. 'bash', 'cmd'). Omit to use configured default. */
  shellType?: string
}

/**
 * Simplified terminal hook for the shell panel.
 * No Claude-specific features (link detection, undo, search, loading state).
 * Spawns a plain shell PTY on mount, kills on unmount.
 */
export function useShellTerminal({ shellId, shellType }: UseShellTerminalOptions) {
  const termRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const searchAddonRef = useRef<SearchAddon | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const spawnedRef = useRef(false)
  const dataBufferRef = useRef<string[]>([])
  const scrolledUpRef = useRef(false)
  const [scrollBtnVisible, setScrollBtnVisible] = useState(false)
  const scrollBtnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  // Write batching — accumulate data and flush via rAF to reduce xterm write() calls
  // Max-wait timer ensures data is flushed within 16ms even if RAF is delayed
  const writeBufRef = useRef('')
  const writeRafRef = useRef<number | null>(null)
  const writeMaxWaitRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const settings = useSettingsStore((s) => s.settings)

  // Spawn shell PTY on mount
  useEffect(() => {
    if (!spawnedRef.current) {
      spawnedRef.current = true
      getDockApi().shell.spawn(shellId, shellType)
    }
  }, [shellId])

  // Listen for clear commands from main process (MCP dock_clear_shell)
  useEffect(() => {
    return getDockApi().shell.onClearShell((id) => {
      if (id !== shellId || !termRef.current) return
      termRef.current.clear()
      termRef.current.reset()
      // Clear any buffered data
      dataBufferRef.current = []
      writeBufRef.current = ''
    })
  }, [shellId])

  // Buffer data from shell PTY — batch writes via rAF for throughput
  useEffect(() => {
    const cleanup = getDockApi().shell.onData((id, data) => {
      if (id !== shellId) return
      if (!termRef.current) {
        dataBufferRef.current.push(data)
        return
      }
      writeBufRef.current += data
      if (writeRafRef.current === null) {
        const flush = () => {
          writeRafRef.current = null
          if (writeMaxWaitRef.current) { clearTimeout(writeMaxWaitRef.current); writeMaxWaitRef.current = null }
          const buf = writeBufRef.current
          writeBufRef.current = ''
          if (buf && termRef.current) {
            termRef.current.write(buf)
          }
        }
        writeRafRef.current = requestAnimationFrame(flush)
        writeMaxWaitRef.current = setTimeout(flush, 16)
      }
    })
    return cleanup
  }, [shellId])

  const initTerminal = useCallback(
    (container: HTMLDivElement | null) => {
      if (!container || termRef.current) return
      containerRef.current = container

      const tc = getShellTerminalColors(settings)

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

      const unicode11Addon = new Unicode11Addon()
      term.loadAddon(unicode11Addon)
      term.unicode.activeVersion = '11'

      const searchAddon = new SearchAddon()
      term.loadAddon(searchAddon)
      searchAddonRef.current = searchAddon

      term.open(container)

      try {
        term.loadAddon(new CanvasAddon())
      } catch {
        // Falls back to DOM renderer
      }

      // Clickable URL links — click to open in browser
      const urlRe = /https?:\/\/[^\s"'<>[\]{}|\\^`]+/g
      term.registerLinkProvider({
        provideLinks(lineNumber, callback) {
          const line = term.buffer.active.getLine(lineNumber - 1)
          if (!line) { callback(undefined); return }
          const text = line.translateToString(true)
          urlRe.lastIndex = 0
          const links: { startIndex: number; url: string }[] = []
          let match: RegExpExecArray | null
          while ((match = urlRe.exec(text)) !== null) {
            let url = match[0]
            while (url.length > 0 && /[),.:;!?]$/.test(url)) url = url.slice(0, -1)
            links.push({ startIndex: match.index, url })
          }
          if (links.length === 0) { callback(undefined); return }
          callback(links.map((l) => ({
            range: {
              start: { x: l.startIndex + 1, y: lineNumber },
              end: { x: l.startIndex + l.url.length + 1, y: lineNumber }
            },
            text: l.url,
            decorations: { pointerCursor: true, underline: true },
            activate() {
              getDockApi().app.openExternal(l.url)
            }
          })))
        }
      })

      // Track Ctrl key for link cursor styling
      const termElement = term.element
      if (termElement) {
        const updateCtrl = (e: KeyboardEvent) => {
          if (e.key === 'Control' || e.key === 'Meta') {
            termElement.classList.toggle('ctrl-held', e.type === 'keydown')
          }
        }
        window.addEventListener('keydown', updateCtrl)
        window.addEventListener('keyup', updateCtrl)
        window.addEventListener('blur', () => termElement.classList.remove('ctrl-held'))
      }

      if (container.clientWidth > 0 && container.clientHeight > 0) {
        fitAddon.fit()
      }
      const { cols, rows } = term
      if (cols > 0 && rows > 0) {
        getDockApi().shell.resize(shellId, cols, rows)
      }

      // Track scroll position for scroll-to-bottom button
      const viewport = container.querySelector('.xterm-viewport') as HTMLElement
      if (viewport) {
        viewport.addEventListener('scroll', () => {
          const gap = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop
          const isAtBottom = gap < 80
          const prev = scrolledUpRef.current
          scrolledUpRef.current = !isAtBottom
          if (prev !== scrolledUpRef.current) {
            if (scrollBtnTimerRef.current) clearTimeout(scrollBtnTimerRef.current)
            scrollBtnTimerRef.current = setTimeout(() => {
              setScrollBtnVisible(scrolledUpRef.current)
            }, 150)
          }
        })
      }

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

      // Key handlers
      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== 'keydown') return true

        // Ctrl+F: open search
        if (e.ctrlKey && !e.shiftKey && e.key === 'f') {
          e.preventDefault()
          setSearchOpen(true)
          return false
        }
        // Escape: close search if open
        if (e.key === 'Escape' && searchAddonRef.current) {
          searchAddonRef.current.clearDecorations()
          setSearchOpen(false)
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
          navigator.clipboard.readText().then((text) => api.shell.write(shellId, text))
          return false
        }
        // Ctrl+C with selection: copy
        if (e.ctrlKey && !e.shiftKey && e.key === 'c' && term.hasSelection()) {
          navigator.clipboard.writeText(term.getSelection())
          term.clearSelection()
          return false
        }
        // Ctrl+V: paste
        if (e.ctrlKey && !e.shiftKey && e.key === 'v') {
          e.preventDefault()
          navigator.clipboard.readText().then((text) => api.shell.write(shellId, text))
          return false
        }

        return true
      })

      // Right-click: paste
      container.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        const sel = term.getSelection()
        if (sel) {
          navigator.clipboard.writeText(sel)
          term.clearSelection()
        } else {
          navigator.clipboard.readText().then((text) => api.shell.write(shellId, text))
        }
      })

      // Forward input to PTY
      term.onData((data) => {
        api.shell.write(shellId, data)
      })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shellId]
  )

  const fit = useCallback(() => {
    if (fitAddonRef.current && termRef.current && containerRef.current) {
      const { clientWidth, clientHeight } = containerRef.current
      if (clientWidth === 0 || clientHeight === 0) return // Container not visible (e.g. minimized)
      try {
        fitAddonRef.current.fit()
        const { cols, rows } = termRef.current
        if (cols > 0 && rows > 0) {
          getDockApi().shell.resize(shellId, cols, rows)
        }
      } catch {
        // Ignore fit errors
      }
    }
  }, [shellId])

  const focus = useCallback(() => {
    termRef.current?.focus()
  }, [])

  const scrollToBottom = useCallback(() => {
    termRef.current?.scrollToBottom()
  }, [])

  // Cleanup
  useEffect(() => {
    return () => {
      if (writeRafRef.current !== null) cancelAnimationFrame(writeRafRef.current)
      if (writeMaxWaitRef.current !== null) clearTimeout(writeMaxWaitRef.current)
      getDockApi().shell.kill(shellId)
      termRef.current?.dispose()
      termRef.current = null
      fitAddonRef.current = null
    }
  }, [shellId])

  // Update theme when settings change
  useEffect(() => {
    if (!termRef.current) return
    const tc = getShellTerminalColors(settings)
    termRef.current.options.theme = { ...tc }
    termRef.current.options.fontFamily = settings.terminal.fontFamily
    termRef.current.options.fontSize = settings.terminal.fontSize
    termRef.current.options.lineHeight = settings.terminal.lineHeight
    termRef.current.options.cursorStyle = settings.terminal.cursorStyle
    termRef.current.options.cursorBlink = settings.terminal.cursorBlink

    setTimeout(() => {
      try { fit() } catch { /* ignore */ }
    }, 50)
  }, [settings, fit])

  return { initTerminal, fit, focus, termRef, scrolledUp: scrollBtnVisible, scrollToBottom, searchAddonRef, searchOpen, setSearchOpen }
}
