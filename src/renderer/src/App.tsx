import React, { useEffect, useState, useCallback, useRef, Suspense } from 'react'
import DockGrid from './components/DockGrid'
import Toolbar from './components/Toolbar'
import EmptyState from './components/EmptyState'
import SettingsModal from './components/SettingsModal'
import Launcher from './components/Launcher'
import ToastContainer from './components/ToastContainer'
import { useDockStore } from './stores/dock-store'
import { useSettingsStore } from './stores/settings-store'
import { getDockApi } from './lib/ipc-bridge'
import { applyThemeToDocument } from './lib/theme'
import { computeAutoLayout, findAdjacentTerminal, type Direction } from './lib/grid-math'
import { getPluginViews } from './plugin-views'
import { useInputContextMenu } from './hooks/useInputContextMenu'

const searchParams = new URLSearchParams(window.location.search)
const isLauncher = searchParams.has('launcher')
const pluginView = getPluginViews().find((v) => searchParams.has(v.queryParam))

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

function App() {
  // Right-click Cut/Copy/Paste menu on all text inputs and textareas
  useInputContextMenu()

  if (pluginView) {
    const PluginComponent = pluginView.component
    return (
      <>
        <Suspense fallback={<div className="loading">Loading...</div>}>
          <PluginComponent />
        </Suspense>
        <ToastContainer />
      </>
    )
  }
  if (isLauncher) {
    return (
      <>
        <LauncherApp />
        <ToastContainer />
      </>
    )
  }
  return (
    <>
      <DockApp />
      <ToastContainer />
    </>
  )
}

function LauncherApp() {
  const loadSettings = useSettingsStore((s) => s.load)

  useEffect(() => {
    loadSettings().then(() => {
      applyThemeToDocument(useSettingsStore.getState().settings)
    })
  }, [loadSettings])

  return <Launcher />
}

let nextTermId = 1

const ERROR_PATTERNS = /\b(error|fail|fatal|exception|panic|abort|segfault|ENOENT|EACCES|TypeError|ReferenceError|SyntaxError|Cannot find|could not|undefined is not|is not a function|exit code [1-9]|Process completed with exit code [1-9]|ERR!|npm ERR|FAILED|AssertionError|assert\.|expect\()\b/i

/**
 * Extract only the error-relevant lines from a CI log, with context.
 * Falls back to the last 80 lines if no error patterns are found.
 */
function extractErrorContext(fullLog: string, contextLines = 10): string {
  const lines = fullLog.split('\n')
  // Find all line indices that match error patterns
  const errorIndices: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (ERROR_PATTERNS.test(lines[i])) errorIndices.push(i)
  }

  if (errorIndices.length === 0) {
    // No error patterns found — fall back to tail
    return lines.slice(-80).join('\n')
  }

  // Merge overlapping ranges into contiguous blocks
  const ranges: [number, number][] = []
  for (const idx of errorIndices) {
    const start = Math.max(0, idx - contextLines)
    const end = Math.min(lines.length - 1, idx + contextLines)
    if (ranges.length > 0 && start <= ranges[ranges.length - 1][1] + 1) {
      // Extend the previous range
      ranges[ranges.length - 1][1] = end
    } else {
      ranges.push([start, end])
    }
  }

  // Build output, joining blocks with separator
  const blocks = ranges.map(([start, end]) => lines.slice(start, end + 1).join('\n'))
  const result = blocks.join('\n...\n')

  // Cap at ~200 lines to avoid overly large prompts
  const resultLines = result.split('\n')
  if (resultLines.length > 200) return resultLines.slice(0, 200).join('\n')
  return result
}

function DockApp() {
  const terminals = useDockStore((s) => s.terminals)
  const projectDir = useDockStore((s) => s.projectDir)
  const setDockInfo = useDockStore((s) => s.setDockInfo)
  const addTerminal = useDockStore((s) => s.addTerminal)
  const setTerminalAlive = useDockStore((s) => s.setTerminalAlive)
  const removeTerminal = useDockStore((s) => s.removeTerminal)
  const focusNextTerminal = useDockStore((s) => s.focusNextTerminal)
  const loadSettings = useSettingsStore((s) => s.load)
  const autoSpawn = useSettingsStore((s) => s.settings.behavior.autoSpawnFirstTerminal)

  const [showSettings, setShowSettings] = useState(false)
  const [initialized, setInitialized] = useState(false)
  const [initialTerminalCount, setInitialTerminalCount] = useState(1)

  // Initialize dock info and settings
  useEffect(() => {
    async function init() {
      const api = getDockApi()
      const info = await api.dock.getInfo()
      if (info) {
        setDockInfo(info.id, info.projectDir)
        if (info.savedSessionCount > 0) {
          setInitialTerminalCount(info.savedSessionCount)
        }
      }
      await loadSettings()
      setInitialized(true)
    }
    init()
  }, [setDockInfo, loadSettings])

  // Set window title to include project folder name
  useEffect(() => {
    if (projectDir) {
      const name = projectDir.split(/[/\\]/).pop() || projectDir
      document.title = `Claude Dock - ${name}`
    }
  }, [projectDir])

  // Auto-spawn terminals (matching saved session count or 1)
  useEffect(() => {
    if (initialized && autoSpawn && terminals.length === 0) {
      for (let i = 0; i < initialTerminalCount; i++) {
        handleAddTerminal()
      }
    }
  }, [initialized, autoSpawn])

  // Listen for terminal exits
  useEffect(() => {
    const api = getDockApi()
    const cleanup = api.terminal.onExit((terminalId, _exitCode) => {
      setTerminalAlive(terminalId, false)
    })
    return cleanup
  }, [setTerminalAlive])

  // "Fix with Claude" — show terminal picker, then send prompt to chosen terminal
  const [pendingFixData, setPendingFixData] = useState<Record<string, unknown> | null>(null)

  useEffect(() => {
    const handler = (data: Record<string, unknown>) => {
      if (data?.runId) setPendingFixData(data)
    }
    const domHandler = (e: Event) => handler((e as CustomEvent).detail as Record<string, unknown>)
    window.addEventListener('ci-fix-with-claude', domHandler)
    const api = getDockApi()
    const ipcCleanup = api.ci.onFixWithClaude(handler)
    return () => {
      window.removeEventListener('ci-fix-with-claude', domHandler)
      ipcCleanup()
    }
  }, [])

  // Track active CI fix terminals for completion monitoring
  const ciFixCleanups = useRef<Map<string, () => void>>(new Map())

  const stripAnsi = useCallback((str: string) =>
    str
      .replace(/\x1b\][^\x07]*\x07/g, '')
      .replace(/[\x1b\x9b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nq-uy=><~]/g, ''),
  [])

  const monitorForCompletion = useCallback((termId: string, fixData: Record<string, unknown>) => {
    const api = getDockApi()
    const MARKER = 'CI_FIX_COMPLETE'
    let buf = ''
    // The prompt text we sent contains the MARKER as an instruction to Claude.
    // The Claude CLI echoes the user prompt in the terminal output, so the first
    // occurrence of the marker is just the echo — skip it and only act on the second.
    let seenCount = 0

    const cleanup = api.terminal.onData((id, chunk) => {
      if (id !== termId) return
      buf += stripAnsi(chunk)
      // Keep buffer from growing unbounded
      if (buf.length > 5000) buf = buf.slice(-3000)

      // Count all occurrences of the marker in the buffer
      let count = 0
      let idx = 0
      while ((idx = buf.indexOf(MARKER, idx)) !== -1) {
        count++
        idx += MARKER.length
      }

      // Only trigger on the 2nd+ occurrence (first is the echoed prompt)
      if (count > seenCount) {
        if (count >= 2) {
          // Claude signalled completion — push triggers new CI run automatically
          doCleanup()
          window.dispatchEvent(new CustomEvent('ci-fix-complete', { detail: fixData }))
          setTimeout(() => {
            api.terminal.kill(termId)
            removeTerminal(termId)
          }, 2000)
        }
        seenCount = count
      }
    })

    const doCleanup = () => {
      cleanup()
      ciFixCleanups.current.delete(termId)
    }

    // Also clean up if the terminal is closed manually
    const exitCleanup = api.terminal.onExit((id) => {
      if (id !== termId) return
      doCleanup()
      exitCleanup()
    })

    ciFixCleanups.current.set(termId, () => { doCleanup(); exitCleanup() })
  }, [removeTerminal, stripAnsi])

  const handleFixTerminalSelected = useCallback(async (terminalId: string | null) => {
    const data = pendingFixData
    setPendingFixData(null)
    if (!data) return

    const api = getDockApi()
    const dir = useDockStore.getState().projectDir
    // Build prompt from failure data
    let failurePrompt = ''
    try {
      const runName = (data.runName as string) || 'CI Run'
      const runNumber = (data.runNumber as number) || 0
      const branch = (data.headBranch as string) || ''
      const failedJobs = (data.failedJobs as Array<{ id: number; name: string; failedSteps: string[] }>) || []

      // Fetch logs for all failed jobs (not just the first)
      const jobLogSnippets: { name: string; log: string }[] = []
      for (const fj of failedJobs) {
        if (!fj.id) continue
        try {
          const fullLog = await api.ci.getJobLog(dir, fj.id)
          if (fullLog) {
            const snippet = extractErrorContext(fullLog, 10)
            if (snippet) jobLogSnippets.push({ name: fj.name, log: snippet })
          }
        } catch { /* continue without log */ }
      }

      const jobList = failedJobs.map((j) => {
        const steps = j.failedSteps.length > 0 ? ` (failed steps: ${j.failedSteps.join(', ')})` : ''
        return `  - ${j.name}${steps}`
      }).join('\n')

      // Build log section — include all job logs with headers if multiple
      let logSection = ''
      if (jobLogSnippets.length === 1) {
        logSection = `\nRelevant error output from "${jobLogSnippets[0].name}":\n\`\`\`\n${jobLogSnippets[0].log}\n\`\`\`\n`
      } else if (jobLogSnippets.length > 1) {
        logSection = '\nRelevant error output:\n' + jobLogSnippets.map(
          (s) => `\n--- ${s.name} ---\n\`\`\`\n${s.log}\n\`\`\``
        ).join('\n') + '\n'
      }

      failurePrompt = `A CI build has failed and needs to be fixed.\n\n` +
        `Workflow: ${runName} #${runNumber}\n` +
        `Branch: ${branch}\n` +
        (jobList ? `Failed jobs:\n${jobList}\n` : '') +
        logSection +
        `\nPlease analyze this CI failure, find the relevant code, and fix the issue.\n\n` +
        `CRITICAL BRANCH SAFETY INSTRUCTIONS:\n` +
        `The fix MUST be committed and pushed to the branch "${branch}". ` +
        `You MUST NOT disturb the user's current working tree, staged files, or checked-out branch. ` +
        `Use a git worktree to work in isolation:\n` +
        `  1. Run: git worktree add ../ci-fix-${branch.replace(/[^a-zA-Z0-9_-]/g, '-')} ${branch}\n` +
        `  2. cd into the worktree directory and make your fix there\n` +
        `  IMPORTANT: The worktree will NOT have node_modules or other installed dependencies. ` +
        `Do NOT run tests, builds, or linters from the worktree. Always run those from the original project directory if needed. ` +
        `The worktree is ONLY for making code changes, committing, and pushing.\n` +
        `  3. Commit and push from the worktree: git push origin ${branch}\n` +
        `  4. cd back to the original directory and clean up: git worktree remove ../ci-fix-${branch.replace(/[^a-zA-Z0-9_-]/g, '-')}\n` +
        `Pushing the fix will automatically trigger a new CI run.\n\n` +
        `IMPORTANT: When you have successfully fixed the issue, committed, and pushed the changes, output the exact text CI_FIX_COMPLETE on its own line. ` +
        `If you cannot fix the issue or need more information, do NOT output this marker.`
    } catch {
      failurePrompt = 'A CI build has failed. Please check the CI logs and fix the issue.\n\n' +
        'IMPORTANT: When you have successfully fixed the issue, committed, and pushed the changes, output the exact text CI_FIX_COMPLETE on its own line.'
    }

    const sendToTerminal = (termId: string) => {
      const paste = `\x1b[200~${failurePrompt}\x1b[201~`
      api.terminal.write(termId, paste)
      setTimeout(() => api.terminal.write(termId, '\x1b'), 400)
      setTimeout(() => api.terminal.write(termId, '\r'), 700)
    }

    const startMonitoring = (termId: string) => {
      // Start monitoring after prompt is submitted (give time for paste + submit)
      setTimeout(() => monitorForCompletion(termId, data), 1500)
    }

    if (terminalId) {
      // Existing terminal — send prompt directly
      useDockStore.getState().setFocusedTerminal(terminalId)
      useDockStore.getState().setTerminalCiFix(terminalId, true)
      sendToTerminal(terminalId)
      startMonitoring(terminalId)
    } else {
      // New terminal — create, wait for Claude to start, then send
      const termId = `term-${nextTermId++}-${Date.now()}`
      addTerminal(termId)
      useDockStore.getState().setTerminalCiFix(termId, true)

      let sent = false
      const send = () => {
        if (sent) return
        sent = true
        sendToTerminal(termId)
        startMonitoring(termId)
      }

      let dataLen = 0
      const cleanup = api.terminal.onData((id, chunk) => {
        if (id !== termId) return
        dataLen += chunk.length
        if (dataLen > 2000) {
          cleanup()
          setTimeout(send, 500)
        }
      })
      setTimeout(() => { cleanup(); send() }, 8000)
    }
  }, [pendingFixData, addTerminal, monitorForCompletion])

  // Handle manual cancellation of CI fix terminals
  useEffect(() => {
    const handler = (e: Event) => {
      const termId = (e as CustomEvent).detail as string
      if (!termId) return
      // Clean up the completion monitor
      const cleanup = ciFixCleanups.current.get(termId)
      if (cleanup) cleanup()
      useDockStore.getState().setTerminalCiFix(termId, false)
    }
    window.addEventListener('ci-fix-cancelled', handler)
    return () => window.removeEventListener('ci-fix-cancelled', handler)
  }, [])

  // Cleanup CI fix monitors on unmount
  useEffect(() => {
    return () => {
      for (const cleanup of ciFixCleanups.current.values()) cleanup()
      ciFixCleanups.current.clear()
    }
  }, [])

  const DEFAULT_FONT_SIZE = 14

  // Apply zoom: changes font size and scales header height + font
  const applyZoom = useCallback((newSize: number) => {
    const size = Math.max(8, Math.min(32, newSize))
    const settings = useSettingsStore.getState().settings
    if (size === settings.terminal.fontSize) return

    useSettingsStore.getState().update({
      terminal: { ...settings.terminal, fontSize: size }
    })

    const scale = size / DEFAULT_FONT_SIZE
    const headerHeight = Math.round(Math.max(14, 18 * scale))
    const headerFont = Math.round(Math.max(8, 10 * scale))
    document.documentElement.style.setProperty('--term-header-height', `${headerHeight}px`)
    document.documentElement.style.setProperty('--term-header-font', `${headerFont}px`)
  }, [])

  // Directional terminal focus navigation
  const focusDirection = useCallback((direction: Direction) => {
    const state = useDockStore.getState()
    if (!state.focusedTerminalId || state.terminals.length < 2) return
    const maxCols = useSettingsStore.getState().settings.grid.maxColumns
    const { layout } = computeAutoLayout(state.terminals.map((t) => t.id), maxCols)
    const targetId = findAdjacentTerminal(layout, state.focusedTerminalId, direction)
    if (targetId) {
      useDockStore.getState().setFocusedTerminal(targetId)
    }
  }, [])

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Check directional focus keybinds first
      const { keybindings } = useSettingsStore.getState().settings
      const directionMap: [string, Direction][] = [
        [keybindings.focusUp, 'up'],
        [keybindings.focusDown, 'down'],
        [keybindings.focusLeft, 'left'],
        [keybindings.focusRight, 'right']
      ]
      for (const [bind, dir] of directionMap) {
        if (matchesKeybind(e, bind)) {
          e.preventDefault()
          focusDirection(dir)
          return
        }
      }

      if (e.ctrlKey || e.metaKey) {
        const currentSize = useSettingsStore.getState().settings.terminal.fontSize
        switch (e.key) {
          case '=':
          case '+':
            e.preventDefault()
            applyZoom(currentSize + 1)
            return
          case '-':
            e.preventDefault()
            applyZoom(currentSize - 1)
            return
          case '0':
            e.preventDefault()
            applyZoom(DEFAULT_FONT_SIZE)
            return
          case 't':
            e.preventDefault()
            handleAddTerminal()
            break
          case 'w':
            e.preventDefault()
            handleCloseFocused()
            break
          case ',':
            e.preventDefault()
            setShowSettings(true)
            break
          case 'n':
            e.preventDefault()
            getDockApi().app.newDock()
            break
          case 'Tab':
            e.preventDefault()
            focusNextTerminal()
            break
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [focusNextTerminal, applyZoom, focusDirection])

  // Ctrl+MouseWheel zoom
  useEffect(() => {
    const handler = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      const currentSize = useSettingsStore.getState().settings.terminal.fontSize
      applyZoom(currentSize + (e.deltaY < 0 ? 1 : -1))
    }
    window.addEventListener('wheel', handler, { passive: false })
    return () => window.removeEventListener('wheel', handler)
  }, [applyZoom])

  const handleAddTerminal = useCallback(() => {
    const id = `term-${nextTermId++}-${Date.now()}`
    addTerminal(id)
  }, [addTerminal])

  const handleCloseFocused = useCallback(() => {
    const state = useDockStore.getState()
    if (!state.focusedTerminalId) return
    if (state.ciFixTerminals.has(state.focusedTerminalId)) {
      if (!window.confirm('This terminal is running a CI fix. Close it and cancel the fix?')) return
      window.dispatchEvent(new CustomEvent('ci-fix-cancelled', { detail: state.focusedTerminalId }))
    }
    getDockApi().terminal.kill(state.focusedTerminalId)
    removeTerminal(state.focusedTerminalId)
  }, [removeTerminal])

  if (!initialized) {
    return <div className="loading">Loading...</div>
  }

  return (
    <div className="app">
      <Toolbar
        projectDir={projectDir}
        onAddTerminal={handleAddTerminal}
        onOpenSettings={() => setShowSettings(true)}
      />
      {terminals.length === 0 ? (
        <EmptyState onAddTerminal={handleAddTerminal} projectDir={projectDir} />
      ) : (
        <DockGrid />
      )}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {pendingFixData && (
        <TerminalPicker
          onSelect={handleFixTerminalSelected}
          onClose={() => setPendingFixData(null)}
        />
      )}
    </div>
  )
}

function TerminalPicker({ onSelect, onClose }: {
  onSelect: (terminalId: string | null) => void
  onClose: () => void
}) {
  const terminals = useDockStore((s) => s.terminals)
  const maxCols = useSettingsStore((s) => s.settings.grid.maxColumns)
  const [selected, setSelected] = useState<string | null>(null) // null = new terminal

  const backdropRef = useRef<HTMLDivElement>(null)

  // Compute grid layout including a "new" cell
  const allIds = [...terminals.map((t) => t.id), '__new__']
  const { cols, layout } = computeAutoLayout(allIds, maxCols)
  const rows = layout.length > 0 ? Math.max(...layout.map((l) => l.y)) + 1 : 1

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'Enter') onSelect(selected)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [selected, onSelect, onClose])

  return (
    <div
      className="tp-backdrop"
      ref={backdropRef}
      onClick={(e) => { if (e.target === backdropRef.current) onClose() }}
    >
      <div className="tp-modal">
        <div className="tp-header">
          <span className="tp-title">Send to terminal</span>
          <button className="tp-close" onClick={onClose}>{'\u2715'}</button>
        </div>
        <div
          className="tp-grid"
          style={{
            gridTemplateColumns: `repeat(${cols}, 1fr)`,
            gridTemplateRows: `repeat(${rows}, 1fr)`
          }}
        >
          {layout.map((cell) => {
            const isNew = cell.i === '__new__'
            const term = isNew ? null : terminals.find((t) => t.id === cell.i)
            const isSelected = isNew ? selected === null : selected === cell.i
            const isAlive = term ? term.isAlive : true
            return (
              <button
                key={cell.i}
                className={`tp-cell${isSelected ? ' tp-cell-selected' : ''}${isNew ? ' tp-cell-new' : ''}${!isAlive ? ' tp-cell-dead' : ''}`}
                style={{ gridColumn: cell.x + 1, gridRow: cell.y + 1 }}
                onClick={() => setSelected(isNew ? null : cell.i)}
                disabled={!isNew && !isAlive}
                title={isNew ? 'Create new terminal' : term?.title || ''}
              >
                {isNew ? (
                  <>
                    <span className="tp-cell-icon">+</span>
                    <span className="tp-cell-label">New</span>
                  </>
                ) : (
                  <>
                    <span className="tp-cell-num">{term?.title?.replace(/\D/g, '') || '?'}</span>
                    <span className="tp-cell-label">{term?.title || 'Terminal'}</span>
                  </>
                )}
              </button>
            )
          })}
        </div>
        <div className="tp-footer">
          <button className="tp-cancel" onClick={onClose}>Cancel</button>
          <button className="tp-confirm" onClick={() => onSelect(selected)}>
            {selected === null ? 'Create & Send' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default App
