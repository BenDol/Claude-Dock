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
import { detectInputBoxRows, renderPinnedRows } from '../lib/pinned-footer'

/**
 * If `cwd` is inside a `.claude/worktrees/<id>` directory, return the worktree
 * root path (everything up to and including the `<id>` segment). Otherwise
 * return null. Used to auto-register a terminal as a worktree terminal when
 * the store hasn't been explicitly populated (e.g. after an app restart).
 */
function detectWorktreePath(cwd: string): string | null {
  if (!cwd) return null
  const normalized = cwd.replace(/\\/g, '/')
  const match = normalized.match(/^(.*\/\.claude\/worktrees\/[^/]+)(?:\/|$)/)
  if (!match) return null
  // Return with the original separator style preserved for Windows paths.
  const usesBackslash = cwd.includes('\\')
  return usesBackslash ? match[1].replace(/\//g, '\\') : match[1]
}

/** Resolve a relative path against a base directory, handling `..` and `.` segments. */
function resolveRelativePath(base: string, relative: string): string {
  // Normalise separators to forward slashes
  const norm = (p: string) => p.replace(/\\/g, '/')
  const parts = [...norm(base).split('/'), ...norm(relative).split('/')]
  const resolved: string[] = []
  for (const seg of parts) {
    if (seg === '.' || seg === '') continue
    if (seg === '..') { resolved.pop(); continue }
    resolved.push(seg)
  }
  // Preserve drive letter on Windows (e.g. C:)
  const result = resolved.join('/')
  return result
}

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

type FilePasteData = {
  files: { name: string; path: string }[]
  image?: { tempPath: string }
  terminalId: string
}

/** Paste plain text to the terminal (standard paste fallback). */
function pasteText(api: ReturnType<typeof getDockApi>, terminalId: string): void {
  navigator.clipboard.readText().then((text) => {
    if (text) api.terminal.write(terminalId, text)
  }).catch(() => { /* clipboard access denied — ignore */ })
}

/** Check clipboard for files/images before falling back to normal text paste. */
function handlePasteWithFileCheck(
  api: ReturnType<typeof getDockApi>,
  terminalId: string,
  filePasteRef: { current: (data: FilePasteData | null) => void }
): void {
  api.filePaste.checkClipboard().then(async (result) => {
    if (result.files.length > 0) {
      const fileInfos = result.files.map((f) => ({
        name: f.replace(/.*[/\\]/, ''),
        path: f,
      }))
      filePasteRef.current({ files: fileInfos, terminalId })
    } else if (result.image) {
      const saved = await api.filePaste.saveImage()
      if (saved) {
        filePasteRef.current({ files: [], image: { tempPath: saved.tempPath }, terminalId })
      } else {
        pasteText(api, terminalId)
      }
    } else {
      pasteText(api, terminalId)
    }
  }).catch(() => {
    pasteText(api, terminalId)
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

  // Pinned-footer overlay: mirrors Claude Code's input box while user is scrolled up.
  // Three refs: wrapper (.pinned-footer), the rows host (.pinned-rows — innerHTML replaced
  // on each refresh), and the cursor element (.pinned-cursor — positioned absolutely).
  const pinnedFooterRef = useRef<HTMLDivElement | null>(null)
  const pinnedRowsRef = useRef<HTMLDivElement | null>(null)
  const pinnedCursorRef = useRef<HTMLDivElement | null>(null)
  const pinnedRafRef = useRef<number | null>(null)

  // File paste interception state
  const [filePasteData, setFilePasteData] = useState<{
    files: { name: string; path: string }[]
    image?: { tempPath: string }
    terminalId: string
  } | null>(null)
  const filePasteRef = useRef(setFilePasteData)
  filePasteRef.current = setFilePasteData

  // Pending corrective-fit timers scheduled after term.open. Must be cleared
  // on unmount so fit() doesn't fire against a disposed terminal.
  const correctiveFitTimersRef = useRef<ReturnType<typeof setTimeout>[]>([])

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
  const pinInputBox = useSettingsStore((s) => s.settings.terminal.pinInputBox)

  // Refresh the pinned-footer overlay. Stable callback — reads current state from
  // refs and the settings store, so it never needs to re-subscribe to effects.
  const refreshPinnedFooter = useCallback(() => {
    const footer = pinnedFooterRef.current
    const rowsHost = pinnedRowsRef.current
    const cursor = pinnedCursorRef.current
    const term = termRef.current
    const container = containerRef.current
    if (!footer || !rowsHost || !term || !container) return

    const settings = useSettingsStore.getState().settings
    const active = settings.terminal.pinInputBox && scrolledUpRef.current
    const wrapper = container.parentElement
    const scrollBtn = wrapper?.querySelector('.scroll-to-bottom-btn') as HTMLElement | null
    const setButtonBottom = (footerPx: number) => {
      // Match CSS: base offset (6px) when no footer, else 4px container inset
      // + footer height − 12px so the button sits roughly half over the
      // footer's top edge (button is ~24px tall).
      const v = footerPx > 0 ? `${4 + footerPx - 12}px` : '6px'
      if (scrollBtn) scrollBtn.style.bottom = v
      wrapper?.style.setProperty('--pinned-footer-height', `${footerPx}px`)
    }
    if (!active) {
      footer.classList.remove('visible')
      setButtonBottom(0)
      return
    }

    const { rowCount, bottomOffset } = detectInputBoxRows(term)
    if (rowCount <= 0) {
      footer.classList.remove('visible')
      setButtonBottom(0)
      return
    }

    const theme = getEffectiveTerminalColors(settings)
    const { cursorRow, cursorCol } = renderPinnedRows(term, rowCount, theme, rowsHost, bottomOffset)

    // Derive row height, cell width, and horizontal alignment from xterm's DOM
    // so the overlay aligns pixel-perfectly with the real rendering.
    //
    // `.xterm-screen` fills the xterm content area (including the scrollbar
    // gutter on the right), so its width is slightly larger than the actual
    // `cols * cellWidth` grid — using it for footer width made the footer
    // extend past the rendered text and let long input lines clip past the
    // terminal's right edge.
    //
    // Canvases inside `.xterm-screen` (created by CanvasAddon) are sized
    // exactly to `cols * cellWidth` in CSS pixels, so we measure one of them
    // for precise dimensions. Fallbacks: `.xterm-screen` rect, then font-
    // metric math.
    const screenEl = container.querySelector('.xterm-screen') as HTMLElement | null
    const canvasEl = screenEl?.querySelector('canvas') as HTMLCanvasElement | null
    let rowHeight = Math.round(settings.terminal.fontSize * settings.terminal.lineHeight)
    let cellWidth = settings.terminal.fontSize * 0.6
    let footerLeft: number | null = null
    let footerWidth: number | null = null
    if (screenEl && term.cols > 0 && term.rows > 0) {
      const containerRect = container.getBoundingClientRect()
      // Prefer the canvas for size (exact cell grid), screen for left offset.
      const sizeRect = canvasEl ? canvasEl.getBoundingClientRect() : screenEl.getBoundingClientRect()
      const screenRect = screenEl.getBoundingClientRect()
      if (sizeRect.height > 0) rowHeight = sizeRect.height / term.rows
      if (sizeRect.width > 0) cellWidth = sizeRect.width / term.cols
      if (sizeRect.width > 0 && containerRect.width > 0) {
        footerLeft = screenRect.left - containerRect.left
        footerWidth = sizeRect.width
      }
    }

    // Must match `padding-top` in global.css `.pinned-footer`. Absolutely-
    // positioned children (cursor) are measured from the padding edge, so the
    // padding does NOT shift them — we have to add it manually.
    const PINNED_FOOTER_PAD_TOP = 8

    const footerHeight = rowCount * rowHeight + PINNED_FOOTER_PAD_TOP

    footer.style.fontFamily = settings.terminal.fontFamily
    footer.style.fontSize = `${settings.terminal.fontSize}px`
    footer.style.lineHeight = `${rowHeight}px`
    footer.style.background = theme.background
    footer.style.color = theme.foreground
    footer.style.height = `${footerHeight}px`
    if (footerLeft != null && footerWidth != null) {
      footer.style.left = `${footerLeft}px`
      footer.style.right = 'auto'
      footer.style.width = `${footerWidth}px`
    }
    setButtonBottom(footerHeight)

    if (cursor) {
      if (cursorRow != null && cursorCol != null) {
        cursor.style.left = `${cursorCol * cellWidth}px`
        cursor.style.top = `${cursorRow * rowHeight + PINNED_FOOTER_PAD_TOP}px`
        cursor.style.width = `${cellWidth}px`
        cursor.style.height = `${rowHeight}px`
        cursor.style.background = theme.cursor
        cursor.style.display = 'block'
      } else {
        cursor.style.display = 'none'
      }
    }

    footer.classList.add('visible')
  }, [])

  // RAF-coalesced refresh — safe to call from high-frequency events (PTY writes).
  const schedulePinnedRefresh = useCallback(() => {
    if (pinnedRafRef.current != null) return
    pinnedRafRef.current = requestAnimationFrame(() => {
      pinnedRafRef.current = null
      refreshPinnedFooter()
    })
  }, [refreshPinnedFooter])

  // Helper to spawn the PTY for this terminal
  const doSpawn = useCallback(() => {
    const state = useDockStore.getState()
    const isTask = state.claudeTaskTerminals.has(terminalId)
    const ephemeral = isTask && !state.claudePersistentTaskTerminals.has(terminalId)
    const taskFlags = state.claudeTaskFlags.get(terminalId)

    // Check if this terminal has a worktree assigned
    const worktreeCwd = state.terminalWorktrees.get(terminalId)

    // Auto-detect worktree terminals: if the effective spawn cwd sits inside
    // `.claude/worktrees/<id>`, register the association so the worktree
    // button + resolve/remove actions appear on the terminal. Covers cases
    // the explicit worktree-creation flow missed — e.g. the dock was opened
    // from within a worktree directory, or the store entry was lost across
    // an app restart.
    const effectiveCwd = worktreeCwd || state.projectDir
    if (!worktreeCwd && effectiveCwd) {
      const detectedWorktreePath = detectWorktreePath(effectiveCwd)
      if (detectedWorktreePath) {
        state.setTerminalWorktree(terminalId, detectedWorktreePath)
      }
    }

    // Check if this terminal has a manual resume session ID
    const manualResumeId = state.manualResumeIds.get(terminalId)

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
          const baseDir = useDockStore.getState().projectDir
          for (const dir of additionalDirs) {
            const resolved = dir.match(/^[a-zA-Z]:[\\/]|^\//) ? dir : resolveRelativePath(baseDir, dir)
            parts.push(`--add-dir "${resolved}"`)
          }
        }
        flags = parts.length > 0 ? parts.join(' ') : undefined
        // Store default flags so the terminal header can display them
        if (flags) {
          useDockStore.getState().setTerminalClaudeFlags(terminalId, flags)
        }
      }
      const spawnOpts: { claudeFlags?: string; cwd?: string; resumeId?: string } = {}
      if (flags) spawnOpts.claudeFlags = flags
      if (worktreeCwd) spawnOpts.cwd = worktreeCwd
      if (manualResumeId) spawnOpts.resumeId = manualResumeId
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
      // Mark ready when Claude's TUI enters alt screen (definitive signal) or
      // after enough data to skip the shell prompt + command echo
      if (!gotDataRef.current && (data.includes('\x1b[?1049h') || dataLenRef.current > 600)) {
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
        // Keep the pinned footer in sync with live buffer changes. RAF coalesces
        // high-frequency writes and gives xterm's parser a frame to apply the data.
        if (scrolledUpRef.current) schedulePinnedRefresh()
      } else {
        dataBufferRef.current.push(data)
      }
    })
    return cleanup
  }, [terminalId, schedulePinnedRefresh])

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
        // Keep the viewport put when the user is scrolled up and starts typing
        // — the pinned footer mirrors the input live, so they can keep editing
        // without being yanked back to the bottom.
        scrollOnUserInput: false,
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

      // Guard: ensure the container has real dimensions before opening xterm.
      // If the flex layout hasn't settled yet (e.g. DockPanelLayout is still
      // mounting), xterm's Viewport.syncScrollArea can crash accessing
      // undefined renderer dimensions. Wait for the next frame.
      const openTerminal = () => {
        try {
          term.open(container)
        } catch (err) {
          // xterm.open can throw if dimensions aren't ready — retry next frame
          if (String(err).includes('dimensions')) {
            requestAnimationFrame(openTerminal)
            return
          }
          throw err
        }

        // Use canvas renderer instead of DOM renderer (avoids CSS dump) or WebGL (GPU contention)
        try {
          term.loadAddon(new CanvasAddon())
        } catch {
          // Falls back to DOM renderer if canvas fails
        }

        fitAddon.fit()
      }

      if (container.clientWidth < 1 || container.clientHeight < 1) {
        // Container not sized yet — defer to next frame
        requestAnimationFrame(openTerminal)
      } else {
        openTerminal()
      }

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
      correctiveFitTimersRef.current.push(setTimeout(() => {
        correctiveFit()
        // If container still not sized after initial fit, retry once more after layout animation
        if (containerRef.current && (containerRef.current.clientWidth < 10 || containerRef.current.clientHeight < 10)) {
          correctiveFitTimersRef.current.push(setTimeout(correctiveFit, 800))
        }
      }, 200))

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
            // Sync pinned footer immediately on transition (not debounced — the
            // overlay should appear/disappear the moment the user scrolls).
            schedulePinnedRefresh()
          }
        })
      }

      // Create the pinned-footer overlay inside the terminal container. Positioned
      // absolutely so it floats over xterm's viewport bottom; pointer-events: none
      // so typing and clicks pass through to the focused xterm.
      const footer = document.createElement('div')
      footer.className = 'pinned-footer'
      const rowsHost = document.createElement('div')
      rowsHost.className = 'pinned-rows'
      const cursorEl = document.createElement('div')
      cursorEl.className = 'pinned-cursor'
      footer.appendChild(rowsHost)
      footer.appendChild(cursorEl)
      container.appendChild(footer)
      pinnedFooterRef.current = footer
      pinnedRowsRef.current = rowsHost
      pinnedCursorRef.current = cursorEl

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

        // Ctrl+Shift+V: paste (with file interception)
        if (e.ctrlKey && e.shiftKey && e.key === 'V') {
          e.preventDefault()
          handlePasteWithFileCheck(api, terminalId, filePasteRef)
          return false
        }

        // Ctrl+C with selection: copy (without selection, let it send SIGINT)
        if (e.ctrlKey && !e.shiftKey && e.key === 'c' && term.hasSelection()) {
          navigator.clipboard.writeText(term.getSelection())
          term.clearSelection()
          return false
        }

        // Ctrl+V: paste (with file interception)
        if (e.ctrlKey && !e.shiftKey && e.key === 'v') {
          e.preventDefault()
          handlePasteWithFileCheck(api, terminalId, filePasteRef)
          return false
        }

        return true
      })

      // Right-click context menu: copy selection or paste (with file interception)
      container.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        const sel = term.getSelection()
        if (sel) {
          navigator.clipboard.writeText(sel)
          term.clearSelection()
        } else {
          handlePasteWithFileCheck(api, terminalId, filePasteRef)
        }
      })

      // Send input to PTY and track for undo
      term.onData((data) => {
        try { undoRef.current.onInput(data) } catch { /* non-critical */ }
        api.terminal.write(terminalId, data)
      })

      // xterm's parser processes write() chunks across multiple frames, so the
      // RAF refresh we schedule on PTY arrival can read a stale buffer. This
      // fires *after* each parse completes — guarantees our pinned-footer
      // detection sees the final state, so the height (and the scroll-button
      // position anchored to it) settles correctly when the live-context block
      // clears.
      term.onWriteParsed(() => {
        if (scrolledUpRef.current) schedulePinnedRefresh()
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
            programmaticScrollRef.current = false
          })
        }
        // Refresh overlay — row height/cell width may have changed after reflow.
        schedulePinnedRefresh()
      }, 150)
    } catch {
      // Ignore fit errors
    }
  }, [terminalId, schedulePinnedRefresh])

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
      const term = termRef.current
      termRef.current = null
      fitAddonRef.current = null
      searchAddonRef.current = null
      if (activityTimerRef.current) clearTimeout(activityTimerRef.current)
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current)
      if (scrollBtnTimerRef.current) clearTimeout(scrollBtnTimerRef.current)
      for (const id of correctiveFitTimersRef.current) clearTimeout(id)
      correctiveFitTimersRef.current = []
      if (pinnedRafRef.current != null) {
        cancelAnimationFrame(pinnedRafRef.current)
        pinnedRafRef.current = null
      }
      pinnedFooterRef.current?.remove()
      pinnedFooterRef.current = null
      pinnedRowsRef.current = null
      pinnedCursorRef.current = null
      // Defer dispose by one tick so xterm's Viewport-constructor
      // `setTimeout(() => syncScrollArea())` can fire against a still-live
      // RenderService. Without this, rapid mount/unmount (e.g. during the
      // worktree-terminal flow) triggers:
      //   TypeError: Cannot read properties of undefined (reading 'dimensions')
      // in Viewport.syncScrollArea → RenderService.dimensions, because
      // MutableDisposable._value is cleared on RenderService.dispose().
      if (term) {
        setTimeout(() => {
          try { term.dispose() } catch (err) {
            try { getDockApi().debug.write(`[useTerminal] deferred dispose error: ${String(err)}`) } catch { /* IPC dead */ }
          }
        }, 0)
      }
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
      // Font/theme changes mean overlay measurements are stale — refresh if visible.
      schedulePinnedRefresh()
    }, 50)
  }, [termFontFamily, termFontSize, termLineHeight, termCursorStyle, termCursorBlink, themeMode, themeAccent, termStyle, terminalId, forceFit, schedulePinnedRefresh])

  // React to pinInputBox setting changes — if toggled off while visible, hide;
  // if toggled on while scrolled up, show.
  useEffect(() => {
    schedulePinnedRefresh()
  }, [pinInputBox, schedulePinnedRefresh])

  // Safety-net refresh poller. `onWriteParsed` is the primary trigger, but there
  // are edge cases where buffer state transitions (Claude's spinner ending,
  // tool-call block collapsing, TUI redraws) do not map 1:1 to a parse event
  // that we observe — so the footer can get stuck at a stale height until the
  // next PTY byte nudges it. A cheap 300ms poll while the feature is active
  // guarantees the footer re-measures and re-renders on every state transition.
  useEffect(() => {
    if (!pinInputBox) return
    const id = window.setInterval(() => {
      if (scrolledUpRef.current) schedulePinnedRefresh()
    }, 300)
    return () => window.clearInterval(id)
  }, [pinInputBox, schedulePinnedRefresh])

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
      // Hide pinned footer immediately — we're no longer scrolled up.
      pinnedFooterRef.current?.classList.remove('visible')
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

  // Submit file paste: copy files to temp, construct prompt, write to PTY
  const submitFilePaste = useCallback(async (data: FilePasteData, contextText: string) => {
    const api = getDockApi()
    const tempPaths: string[] = []

    if (data.files.length > 0) {
      const result = await api.filePaste.copyToTemp(data.files.map((f) => f.path))
      tempPaths.push(...result.tempPaths)
      if (result.errors.length > 0) {
        console.warn('[file-paste] copy errors:', result.errors)
      }
    }
    if (data.image) {
      tempPaths.push(data.image.tempPath)
    }

    if (tempPaths.length === 0) {
      setFilePasteData(null)
      return
    }

    const fileList = tempPaths.map((p) => `- ${p.replace(/\\/g, '/')}`).join('\n')
    let prompt = `I've placed file(s) for you to work with:\n${fileList}`
    if (contextText.trim()) {
      prompt += `\n\n${contextText.trim()}`
    }

    // Bracketed paste + Escape + Enter — same pattern as App.tsx sendToTerminal
    const paste = `\x1b[200~${prompt}\x1b[201~`
    api.terminal.write(data.terminalId, paste)
    setTimeout(() => api.terminal.write(data.terminalId, '\x1b'), 400)
    setTimeout(() => api.terminal.write(data.terminalId, '\r'), 700)

    setFilePasteData(null)
  }, [])

  // Listen for file-paste-trigger events from drag-and-drop (dispatched by TerminalCard)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (detail?.terminalId === terminalId && detail?.files?.length > 0) {
        const fileInfos = (detail.files as string[]).map((f) => ({
          name: f.replace(/.*[/\\]/, ''),
          path: f,
        }))
        setFilePasteData({ files: fileInfos, terminalId })
      }
    }
    window.addEventListener('file-paste-trigger', handler)
    return () => window.removeEventListener('file-paste-trigger', handler)
  }, [terminalId])

  return { initTerminal, fit, forceFit, resizePoke, focus, termRef, searchAddonRef, searchOpen, setSearchOpen, gotDataRef, scrolledUp: scrollBtnVisible, autoScroll: autoScrollActive, scrollToBottom, enableAutoScroll, disableAutoScroll, filePasteData, setFilePasteData, submitFilePaste }
}
