import { useEffect, useRef, useCallback, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { CanvasAddon } from '@xterm/addon-canvas'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { SearchAddon } from '@xterm/addon-search'
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

// Tools whose argument is a file path (the entire content inside parens is the path)
const FILE_PATH_TOOLS = new Set([
  'Read', 'Write', 'Edit', 'MultiEdit', 'Update', 'Create',
  'NotebookEdit', 'Glob'
])

// Tools whose argument may contain quoted file paths (e.g. Bash, Grep)
const COMMAND_TOOLS = new Set(['Bash', 'Grep'])

// Match PascalCase tool invocations: ToolName(...)
const TOOL_RE = /\b([A-Z][a-zA-Z]*)\(([^)]+)\)/g

// Match standalone file:line references: path/to/file.ext:123
const FILE_LINE_RE = /(?:^|[\s│┃┆┇┊┋╎╏])([a-zA-Z0-9_.][a-zA-Z0-9_./\\-]*\.[a-zA-Z]{1,10}):(\d+)(?::(\d+))?/g

// Extract a clean file path from a tool argument
function extractFilePath(toolName: string, rawArg: string): string | null {
  const arg = rawArg.trim()

  if (FILE_PATH_TOOLS.has(toolName)) {
    // Strip surrounding quotes if present
    const unquoted = arg.replace(/^["']|["']$/g, '')
    if (looksLikeFilePath(unquoted)) return unquoted
    return null
  }

  if (COMMAND_TOOLS.has(toolName)) {
    // Extract quoted paths from commands like: ls "C:\path" or cat 'file.txt'
    const quoted = arg.match(/["']([^"']+)["']/g)
    if (quoted) {
      for (const q of quoted) {
        const inner = q.slice(1, -1)
        if (looksLikeFilePath(inner)) return inner
      }
    }
    return null
  }

  // Unknown tool — try the raw arg
  const unquoted = arg.replace(/^["']|["']$/g, '')
  if (looksLikeFilePath(unquoted)) return unquoted
  return null
}

// Quick check: does the string look like a file path?
function looksLikeFilePath(s: string): boolean {
  if (!s || s.length > 300) return false
  // Must contain a dot (extension) or path separator
  if (!/[./\\]/.test(s)) return false
  // Must not be a glob pattern with **
  if (s.includes('**')) return false
  // Must not contain shell operators or code syntax
  if (/[<>{}|&;!?#@$%^*+~`]/.test(s)) return false
  // Must not start with a flag
  if (/^-/.test(s)) return false
  // Must not contain spaces unless it's a Windows path (C:\Program Files\...)
  if (s.includes(' ') && !/^[a-zA-Z]:\\/.test(s)) return false
  return true
}

// Regex matching URLs — same as the default from @xterm/addon-web-links
const URL_RE = /https?:\/\/[^\s"'<>[\]{}|\\^`]+/g

function registerWebLinks(term: Terminal): void {
  term.registerLinkProvider({
    provideLinks(lineNumber, callback) {
      const line = term.buffer.active.getLine(lineNumber - 1)
      if (!line) { callback(undefined); return }
      const text = line.translateToString(true)

      URL_RE.lastIndex = 0
      const links: { startIndex: number; url: string }[] = []
      let m: RegExpExecArray | null
      while ((m = URL_RE.exec(text)) !== null) {
        // Trim trailing punctuation that's likely not part of the URL
        let url = m[0]
        while (url.length > 0 && /[),.:;!?]$/.test(url)) {
          url = url.slice(0, -1)
        }
        links.push({ startIndex: m.index, url })
      }

      if (links.length === 0) { callback(undefined); return }

      callback(links.map((l) => ({
        range: {
          start: { x: l.startIndex + 1, y: lineNumber },
          end: { x: l.startIndex + l.url.length + 1, y: lineNumber }
        },
        text: l.url,
        decorations: { pointerCursor: true, underline: false },
        activate(event: MouseEvent) {
          if (event.ctrlKey || event.metaKey) {
            getDockApi().app.openExternal(l.url)
          }
        }
      })))
    }
  })
}

interface FileLink {
  startIndex: number
  length: number
  filePath: string
}

function registerFilePathLinks(term: Terminal): void {
  term.registerLinkProvider({
    provideLinks(lineNumber, callback) {
      const line = term.buffer.active.getLine(lineNumber - 1)
      if (!line) { callback(undefined); return }
      const text = line.translateToString(true)

      const links: FileLink[] = []

      // 1. Tool invocations: Read(path), Write(path), Bash(cmd "path"), etc.
      TOOL_RE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = TOOL_RE.exec(text)) !== null) {
        const toolName = m[1]
        const rawArg = m[2]
        const filePath = extractFilePath(toolName, rawArg)
        if (!filePath) continue

        // Find where the path actually starts within the full match
        const argStart = m.index + toolName.length + 1 // after "Tool("
        const innerText = m[2]
        const pathOffset = innerText.indexOf(filePath.charAt(0) === '"' || filePath.charAt(0) === "'"
          ? filePath : filePath)

        // For command tools, find the quoted path position
        if (COMMAND_TOOLS.has(toolName)) {
          const quoteMatch = innerText.match(new RegExp(`["']${filePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`))
          if (quoteMatch && quoteMatch.index != null) {
            const start = argStart + quoteMatch.index + 1 // skip opening quote
            links.push({ startIndex: start, length: filePath.length, filePath })
            continue
          }
        }

        // For file path tools, the path is the content (possibly unquoted)
        const stripped = rawArg.trim()
        const quoteOffset = stripped.startsWith('"') || stripped.startsWith("'") ? 1 : 0
        const leadingSpaces = rawArg.length - rawArg.trimStart().length
        const start = argStart + leadingSpaces + quoteOffset
        links.push({ startIndex: start, length: filePath.length, filePath })
      }

      // 2. Standalone file:line references (e.g. src/foo.ts:42:10)
      FILE_LINE_RE.lastIndex = 0
      while ((m = FILE_LINE_RE.exec(text)) !== null) {
        const filePath = m[1]
        if (!looksLikeFilePath(filePath)) continue
        // Don't duplicate if already matched by a tool invocation
        const pathStart = text.indexOf(filePath, m.index)
        if (pathStart < 0) continue
        const alreadyLinked = links.some((l) =>
          pathStart >= l.startIndex && pathStart < l.startIndex + l.length
        )
        if (alreadyLinked) continue
        links.push({ startIndex: pathStart, length: filePath.length, filePath })
      }

      if (links.length === 0) { callback(undefined); return }

      const projectDir = useDockStore.getState().projectDir
      callback(links.map((l) => ({
        range: {
          start: { x: l.startIndex + 1, y: lineNumber },
          end: { x: l.startIndex + l.length + 1, y: lineNumber }
        },
        text: l.filePath,
        decorations: { pointerCursor: true, underline: false },
        activate(event: MouseEvent) {
          if (!event.ctrlKey && !event.metaKey) return
          const resolved = l.filePath.match(/^[a-zA-Z]:[\\/]|^\//)
            ? l.filePath
            : projectDir + '/' + l.filePath
          getDockApi().app.openInExplorer(resolved)
        }
      })))
    }
  })
}

interface UseTerminalOptions {
  terminalId: string
  onTitleChange?: (title: string) => void
}

export function useTerminal({ terminalId, onTitleChange }: UseTerminalOptions) {
  const termRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const searchAddonRef = useRef<SearchAddon | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const spawnedRef = useRef(false)
  const dataBufferRef = useRef<string[]>([])
  const dataLenRef = useRef(0)
  const gotDataRef = useRef(false)
  const undoRef = useRef(new InputUndoManager())
  const activityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Scroll state uses refs to avoid re-renders during active output.
  // Only scrollBtnVisible triggers re-renders (debounced) for the UI button.
  const scrolledUpRef = useRef(false)
  const autoScrollRef = useRef(false)
  const programmaticScrollRef = useRef(false)
  const [scrollBtnVisible, setScrollBtnVisible] = useState(false)
  const [autoScrollActive, setAutoScrollActive] = useState(false)
  const scrollBtnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)

  const settings = useSettingsStore((s) => s.settings)
  // Granular selectors for the settings effect to avoid re-fitting on unrelated changes
  const termFontFamily = useSettingsStore((s) => s.settings.terminal.fontFamily)
  const termFontSize = useSettingsStore((s) => s.settings.terminal.fontSize)
  const termLineHeight = useSettingsStore((s) => s.settings.terminal.lineHeight)
  const termCursorStyle = useSettingsStore((s) => s.settings.terminal.cursorStyle)
  const termCursorBlink = useSettingsStore((s) => s.settings.terminal.cursorBlink)
  const themeMode = useSettingsStore((s) => s.settings.theme.mode)
  const themeAccent = useSettingsStore((s) => s.settings.theme.accentColor)
  const termStyle = useSettingsStore((s) => s.settings.theme.terminalStyle)

  // Helper to spawn the PTY for this terminal
  const doSpawn = useCallback(() => {
    const state = useDockStore.getState()
    const isTask = state.claudeTaskTerminals.has(terminalId)
    const ephemeral = isTask && !state.claudePersistentTaskTerminals.has(terminalId)
    const taskFlags = state.claudeTaskFlags.get(terminalId)

    // Check if this terminal has a worktree assigned
    const worktreeCwd = state.terminalWorktrees.get(terminalId)

    if (ephemeral) {
      // Ephemeral task terminal — task flags only, no session persistence
      getDockApi().terminal.spawn(terminalId, { ephemeral: true, claudeFlags: taskFlags, cwd: worktreeCwd })
    } else {
      // Persistent terminal (regular or task) — merge task flags with defaults
      let flags = taskFlags
      if (!flags) {
        // No task flags — apply default permission flags from settings
        const { defaultAllowedTools, defaultPermissionMode, additionalDirs } = useSettingsStore.getState().settings.terminal
        const parts: string[] = []
        if (defaultAllowedTools && defaultAllowedTools.length > 0) {
          parts.push(`--allowedTools ${defaultAllowedTools.join(',')}`)
        }
        if (defaultPermissionMode && defaultPermissionMode !== 'default') {
          parts.push(`--permission-mode ${defaultPermissionMode}`)
        }
        if (additionalDirs && additionalDirs.length > 0) {
          for (const dir of additionalDirs) {
            parts.push(`--add-dir "${dir}"`)
          }
        }
        flags = parts.length > 0 ? parts.join(' ') : undefined
        // Store default flags so the terminal header can display them
        if (flags) {
          useDockStore.getState().setTerminalClaudeFlags(terminalId, flags)
        }
      }
      const spawnOpts: { claudeFlags?: string; cwd?: string } = {}
      if (flags) spawnOpts.claudeFlags = flags
      if (worktreeCwd) spawnOpts.cwd = worktreeCwd
      getDockApi().terminal.spawn(terminalId, Object.keys(spawnOpts).length > 0 ? spawnOpts : undefined)
    }
  }, [terminalId])

  // Spawn PTY immediately on mount (before terminal is created),
  // unless this terminal is waiting for a worktree to be created.
  useEffect(() => {
    if (!spawnedRef.current) {
      const state = useDockStore.getState()
      if (state.pendingWorktrees.has(terminalId)) return // wait for worktree
      spawnedRef.current = true
      doSpawn()
    }
  }, [terminalId, doSpawn])

  // When a pending worktree finishes, spawn the PTY
  useEffect(() => {
    if (spawnedRef.current) return
    const unsub = useDockStore.subscribe((state, prev) => {
      if (spawnedRef.current) { unsub(); return }
      const wasPending = prev.pendingWorktrees.has(terminalId)
      const isPending = state.pendingWorktrees.has(terminalId)
      if (wasPending && !isPending) {
        spawnedRef.current = true
        doSpawn()
        unsub()
      }
    })
    return unsub
  }, [terminalId, doSpawn])

  // Buffer data from PTY - works even before terminal is mounted
  useEffect(() => {
    const api = getDockApi()
    const setTerminalActive = useDockStore.getState().setTerminalActive
    const cleanup = api.terminal.onData((id, data) => {
      if (id !== terminalId) return
      dataLenRef.current += data.length
      // Only mark ready after enough data (skip shell prompt + claude command echo)
      if (dataLenRef.current > 1500) {
        gotDataRef.current = true
      }

      // Track activity: mark active on data, inactive after 3s idle.
      // Only call setTerminalActive(true) once per active burst to avoid store churn.
      if (!activityTimerRef.current) {
        setTerminalActive(terminalId, true)
      } else {
        clearTimeout(activityTimerRef.current)
      }
      activityTimerRef.current = setTimeout(() => {
        setTerminalActive(terminalId, false)
        activityTimerRef.current = null
      }, 3000)

      if (termRef.current) {
        termRef.current.write(data)
        if (autoScrollRef.current) {
          programmaticScrollRef.current = true
          termRef.current.scrollToBottom()
          requestAnimationFrame(() => { programmaticScrollRef.current = false })
        }
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

      // Clickable URL links — Ctrl+Click to open (underline appears only while Ctrl is held)
      registerWebLinks(term)

      // Clickable file paths from Claude tool output — e.g. Read(src/foo.ts), Write(src/bar.ts)
      registerFilePathLinks(term)

      // Track Ctrl key state so CSS can show pointer cursor on links only while Ctrl is held
      const termElement = term.element
      if (termElement) {
        const updateCtrlHeld = (e: KeyboardEvent) => {
          if (e.key === 'Control' || e.key === 'Meta') {
            termElement.classList.toggle('ctrl-held', e.type === 'keydown')
          }
        }
        window.addEventListener('keydown', updateCtrlHeld)
        window.addEventListener('keyup', updateCtrlHeld)
        window.addEventListener('blur', () => termElement.classList.remove('ctrl-held'))
      }

      // Search in scrollback buffer (Ctrl+F)
      const searchAddon = new SearchAddon()
      term.loadAddon(searchAddon)
      searchAddonRef.current = searchAddon

      term.open(container)

      // Use canvas renderer instead of DOM renderer (avoids CSS dump) or WebGL (GPU contention)
      try {
        term.loadAddon(new CanvasAddon())
      } catch {
        // Falls back to DOM renderer if canvas fails
      }

      fitAddon.fit()

      // Send real terminal dimensions to PTY immediately (not the default 80x24)
      const { cols, rows } = term
      getDockApi().terminal.resize(terminalId, cols, rows)

      // Seed dims ref but NOT container size ref — the container may not have its
      // final size yet (grid layout still settling). Leave lastContainerSizeRef at
      // {0,0} so the first ResizeObserver callback triggers a proper fit.
      lastDimsRef.current = { cols, rows }

      // Schedule corrective re-fits after grid layout settles.
      // The container may not have its final size yet when initTerminal runs
      // (grid animation, flex recalculation). These staggered re-fits ensure
      // the PTY gets the correct dimensions once layout is stable.
      const correctiveFit = () => {
        if (!fitAddonRef.current || !termRef.current || !containerRef.current) return
        const cw = containerRef.current.clientWidth
        const ch = containerRef.current.clientHeight
        if (cw < 10 || ch < 10) return // container not ready yet
        fitAddonRef.current.fit()
        const newCols = termRef.current.cols
        const newRows = termRef.current.rows
        if (newCols !== lastDimsRef.current.cols || newRows !== lastDimsRef.current.rows) {
          lastDimsRef.current = { cols: newCols, rows: newRows }
          lastContainerSizeRef.current = { w: cw, h: ch }
          getDockApi().terminal.resize(terminalId, newCols, newRows)
        }
      }
      setTimeout(correctiveFit, 200)
      setTimeout(correctiveFit, 500)
      setTimeout(correctiveFit, 1000)

      termRef.current = term
      fitAddonRef.current = fitAddon

      // Scroll detection via xterm viewport — uses refs to avoid re-renders
      const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null
      if (viewport) {
        const SCROLL_THRESHOLD = 80
        viewport.addEventListener('scroll', () => {
          if (programmaticScrollRef.current) return
          const gap = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop
          const isAtBottom = gap < SCROLL_THRESHOLD
          const wasScrolledUp = scrolledUpRef.current
          scrolledUpRef.current = !isAtBottom

          // If user scrolls away from bottom while auto-scroll is on, disable it
          if (!isAtBottom && autoScrollRef.current) {
            autoScrollRef.current = false
            setAutoScrollActive(false)
          }

          // Debounce the button visibility update to avoid re-renders during rapid scrolling
          if (wasScrolledUp !== scrolledUpRef.current) {
            if (scrollBtnTimerRef.current) clearTimeout(scrollBtnTimerRef.current)
            scrollBtnTimerRef.current = setTimeout(() => {
              setScrollBtnVisible(scrolledUpRef.current)
            }, 150)
          }
        })
      }

      // Replay buffered data
      if (dataBufferRef.current.length > 0) {
        for (const chunk of dataBufferRef.current) {
          term.write(chunk)
        }
        dataBufferRef.current = []
        // Scroll to bottom so the user sees the current state (critical for resumed sessions
        // where large amounts of buffered data push the active prompt off-screen)
        term.scrollToBottom()
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

        // Ctrl+F: open search
        if (e.ctrlKey && !e.shiftKey && e.key === 'f') {
          setSearchOpen(true)
          return false
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

  // Fit on resize — skips both xterm reflow and PTY resize if dimensions
  // haven't actually changed. This prevents ConPTY/Claude TUI from redrawing
  // at the wrong scroll position when fit() is called spuriously.
  const lastDimsRef = useRef<{ cols: number; rows: number }>({ cols: 0, rows: 0 })
  const lastContainerSizeRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 })
  // Debounced PTY resize timer — coalesces rapid fit() calls into a single resize
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const fitInner = useCallback((force?: boolean) => {
    if (!fitAddonRef.current || !termRef.current || !containerRef.current) return
    try {
      if (!force) {
        const w = containerRef.current.clientWidth
        const h = containerRef.current.clientHeight
        if (Math.abs(w - lastContainerSizeRef.current.w) < 2 && Math.abs(h - lastContainerSizeRef.current.h) < 2) {
          return
        }
        lastContainerSizeRef.current = { w, h }
      } else {
        lastContainerSizeRef.current = { w: containerRef.current.clientWidth, h: containerRef.current.clientHeight }
      }

      // Refit xterm's internal layout (recalculates cols/rows for new container size)
      fitAddonRef.current.fit()
      const { cols, rows } = termRef.current

      // Only send resize to PTY if dimensions actually changed
      if (cols === lastDimsRef.current.cols && rows === lastDimsRef.current.rows) return
      lastDimsRef.current = { cols, rows }

      // Debounce the PTY resize to coalesce rapid layout changes (e.g., shell panel
      // opening causes multiple ResizeObserver callbacks). This also ensures ConPTY
      // gets a single SIGWINCH after layout settles, not multiple rapid ones that
      // cause Claude's TUI to redraw at the wrong scroll position.
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current)
      resizeTimerRef.current = setTimeout(() => {
        resizeTimerRef.current = null
        if (!termRef.current) return
        const term = termRef.current
        const viewport = containerRef.current?.querySelector('.xterm-viewport') as HTMLElement | null

        // CRITICAL: Before telling the PTY about the new size, temporarily scroll
        // to the bottom. ConPTY/Claude TUI redraws from the current viewport position
        // on SIGWINCH. If the user was scrolled up, the TUI header would be redrawn
        // at that position, making the content appear to "jump". By scrolling to bottom
        // first, the redraw happens at the right place.
        const wasScrolledUp = scrolledUpRef.current
        if (wasScrolledUp && viewport) {
          programmaticScrollRef.current = true
          term.scrollToBottom()
        }

        getDockApi().terminal.resize(terminalId, lastDimsRef.current.cols, lastDimsRef.current.rows)

        // After the PTY processes the resize (give it a frame + buffer), restore
        // the user's scroll position if they were scrolled up
        if (wasScrolledUp && viewport) {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              if (scrolledUpRef.current || wasScrolledUp) {
                // Don't restore — let the user re-scroll manually.
                // The alternative (restoring exact position) is fragile because
                // line wrapping changes after resize, making the old position wrong.
              }
              programmaticScrollRef.current = false
            })
          })
        }
      }, 150)
    } catch {
      // Ignore fit errors
    }
  }, [terminalId])

  // Standard fit — only runs if container size changed
  const fit = useCallback(() => fitInner(false), [fitInner])
  // Force fit — always runs (for font/theme changes that need reflow at same size)
  const forceFit = useCallback(() => fitInner(true), [fitInner])
  // Resize poke — temporarily shrink by 1 col then restore to force ConPTY SIGWINCH.
  // Used after Claude's TUI starts to make it re-read terminal dimensions.
  const resizePoke = useCallback(() => {
    const { cols, rows } = lastDimsRef.current
    if (cols <= 1 || !termRef.current) return
    getDockApi().terminal.resize(terminalId, cols - 1, rows)
    setTimeout(() => {
      getDockApi().terminal.resize(terminalId, cols, rows)
    }, 50)
  }, [terminalId])

  // Cleanup
  useEffect(() => {
    return () => {
      termRef.current?.dispose()
      termRef.current = null
      fitAddonRef.current = null
      if (activityTimerRef.current) clearTimeout(activityTimerRef.current)
    }
  }, [])

  // Update theme when settings change
  useEffect(() => {
    if (!termRef.current) return
    const tc = getEffectiveTerminalColors(settings)
    termRef.current.options.theme = { ...tc }
    termRef.current.options.fontFamily = termFontFamily
    termRef.current.options.fontSize = termFontSize
    termRef.current.options.lineHeight = termLineHeight
    termRef.current.options.cursorStyle = termCursorStyle
    termRef.current.options.cursorBlink = termCursorBlink

    // Re-fit after font changes so xterm recalculates layout (force — size didn't change but font did)
    setTimeout(() => {
      if (fitAddonRef.current && termRef.current) {
        try {
          forceFit()
        } catch { /* ignore */ }
      }
    }, 50)
  }, [termFontFamily, termFontSize, termLineHeight, termCursorStyle, termCursorBlink, themeMode, themeAccent, termStyle, terminalId, forceFit])

  // Re-fit after grid reposition — force fit since container size always changes
  useEffect(() => {
    const handler = () => {
      if (termRef.current) {
        forceFit()
        if (!scrolledUpRef.current) {
          termRef.current.scrollToBottom()
        }
      }
    }
    window.addEventListener('terminals-repositioned', handler)
    return () => window.removeEventListener('terminals-repositioned', handler)
  }, [forceFit])

  const focus = useCallback(() => {
    if (termRef.current) {
      termRef.current.focus()
      termRef.current.refresh(0, termRef.current.rows - 1)
    }
  }, [])

  const scrollToBottom = useCallback(() => {
    if (termRef.current) {
      programmaticScrollRef.current = true
      termRef.current.scrollToBottom()
      scrolledUpRef.current = false
      setScrollBtnVisible(false)
      requestAnimationFrame(() => { programmaticScrollRef.current = false })
    }
  }, [])

  const enableAutoScroll = useCallback(() => {
    autoScrollRef.current = true
    setAutoScrollActive(true)
    scrollToBottom()
  }, [scrollToBottom])

  const disableAutoScroll = useCallback(() => {
    autoScrollRef.current = false
    setAutoScrollActive(false)
  }, [])

  return { initTerminal, fit, forceFit, resizePoke, focus, termRef, searchAddonRef, searchOpen, setSearchOpen, gotDataRef, scrolledUp: scrollBtnVisible, autoScroll: autoScrollActive, scrollToBottom, enableAutoScroll, disableAutoScroll }
}
