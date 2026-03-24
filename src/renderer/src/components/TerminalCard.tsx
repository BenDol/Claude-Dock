import React, { useCallback, useEffect, useRef, useState, lazy, Suspense } from 'react'
import { createPortal } from 'react-dom'
import TerminalView from './TerminalView'
import TerminalTitle from './TerminalTitle'
import { useDockStore } from '../stores/dock-store'
import { useSettingsStore } from '../stores/settings-store'
import { getDockApi } from '../lib/ipc-bridge'

const ShellArea = lazy(() => import('./ShellArea'))

interface TerminalCardProps {
  terminalId: string
  title: string
  isAlive: boolean
  isFocused: boolean
}

const LockIcon: React.FC<{ locked: boolean }> = ({ locked }) => (
  <svg
    width="11"
    height="11"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {locked ? (
      <>
        <rect x="3" y="11" width="18" height="11" rx="2" />
        <path d="M7 11V7a5 5 0 0110 0v4" />
      </>
    ) : (
      <>
        <rect x="3" y="11" width="18" height="11" rx="2" />
        <path d="M7 11V7a5 5 0 019.9-1" />
      </>
    )}
  </svg>
)

const ClearIcon: React.FC = () => (
  <svg
    width="11"
    height="11"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M14 2l6 6-8 8H6l-2-2V8z" />
    <path d="M3 21h18" />
  </svg>
)

const CopyIdIcon: React.FC<{ copied?: boolean }> = ({ copied }) => (
  <svg
    width="11"
    height="11"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {copied ? (
      <path d="M20 6L9 17l-5-5" />
    ) : (
      <>
        <rect x="9" y="9" width="13" height="13" rx="2" />
        <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
      </>
    )}
  </svg>
)

/** Parse a flags string like "--allowedTools Bash,Read --permission-mode acceptEdits" into a tooltip + label */
function parsePermissionIndicator(flags: string | undefined): { label: string; tooltip: string } | null {
  if (!flags) return null

  const toolsMatch = flags.match(/--allowedTools\s+(\S+)/)
  const modeMatch = flags.match(/--permission-mode\s+(\S+)/)
  if (!toolsMatch && !modeMatch) return null

  const parts: string[] = []
  let label = ''

  if (modeMatch) {
    const mode = modeMatch[1]
    if (mode === 'acceptEdits') { parts.push('Mode: accept edits'); label = 'AE' }
    else if (mode === 'bypassPermissions') { parts.push('Mode: bypass all'); label = 'BP' }
  }

  if (toolsMatch) {
    const tools = toolsMatch[1].split(',')
    parts.push(`Tools: ${tools.join(', ')}`)
    if (!label) label = `${tools.length}T`
  }

  return { label, tooltip: parts.join(' · ') }
}

const ShellIcon: React.FC = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="4 17 10 11 4 5" />
    <line x1="12" y1="19" x2="20" y2="19" />
  </svg>
)

const WorktreeIcon: React.FC = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="22" x2="12" y2="10" />
    <polyline points="6 4 12 10 18 4" />
    <line x1="12" y1="10" x2="12" y2="2" />
  </svg>
)

const ExternalTerminalIcon: React.FC = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
    <polyline points="15 3 21 3 21 9" />
    <line x1="10" y1="14" x2="21" y2="3" />
  </svg>
)

const TerminalCard: React.FC<TerminalCardProps> = ({ terminalId, title, isAlive, isFocused }) => {
  const removeTerminal = useDockStore((s) => s.removeTerminal)
  const isUnlocked = useDockStore((s) => s.unlockedTerminals.has(terminalId))
  const toggleTerminalLock = useDockStore((s) => s.toggleTerminalLock)
  const isActive = useDockStore((s) => s.activeTerminals.has(terminalId))
  const claudeFlags = useDockStore((s) => s.claudeTaskFlags.get(terminalId))
  const permIndicator = parsePermissionIndicator(claudeFlags)
  const shellEnabled = useSettingsStore((s) => s.settings.shellPanel?.enabled ?? true)
  const defaultShellHeight = useSettingsStore((s) => s.settings.shellPanel?.defaultHeight ?? 200)
  const pendingShellCommand = useDockStore((s) => s.pendingShellCommand)
  const setPendingShellCommand = useDockStore((s) => s.setPendingShellCommand)
  const [shellAreaOpen, setShellAreaOpen] = useState(false)
  const [shellAreaMounted, setShellAreaMounted] = useState(false)
  const [shellInitialCommand, setShellInitialCommand] = useState<string | null>(null)
  const worktreePath = useDockStore((s) => s.terminalWorktrees.get(terminalId))
  const projectDir = useDockStore((s) => s.projectDir)
  const addTerminal = useDockStore((s) => s.addTerminal)
  const setTerminalWorktree = useDockStore((s) => s.setTerminalWorktree)
  const [worktreePopover, setWorktreePopover] = useState(false)
  const [worktreePos, setWorktreePos] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [worktrees, setWorktrees] = useState<{ path: string; branch: string; head: string; isMain: boolean }[]>([])
  const [branches, setBranches] = useState<{ name: string; current: boolean }[]>([])
  const [wtLoading, setWtLoading] = useState(false)
  const wtBtnRef = useRef<HTMLButtonElement>(null)

  // Recalculate popover position when it opens
  useEffect(() => {
    if (!worktreePopover || !wtBtnRef.current) return
    const rect = wtBtnRef.current.getBoundingClientRect()
    // Position above the button, aligned to right edge
    setWorktreePos({ x: rect.right - 240, y: rect.top - 4 })
  }, [worktreePopover])

  const openWorktreePopover = useCallback(async () => {
    setWorktreePopover(true)
    setWtLoading(true)
    const api = getDockApi()
    try {
      const [wts, brs] = await Promise.all([
        api.gitManager.listWorktrees(projectDir),
        api.gitManager.getBranches(projectDir)
      ])
      setWorktrees(wts)
      // Include all branches (local + remote) — worktrees can be created from any
      // Strip remote prefix for display but keep the full name for checkout
      const allBranches = brs.map((b: any) => ({
        name: b.name as string,
        displayName: b.remote ? (b.name as string).replace(/^[^/]+\//, '') : b.name as string,
        current: b.current as boolean,
        remote: b.remote as boolean
      }))
      // Deduplicate: if a local and remote branch have the same name, keep local
      const seen = new Set<string>()
      const deduped: typeof allBranches = []
      for (const b of allBranches.filter((b: any) => !b.remote)) {
        seen.add(b.displayName)
        deduped.push(b)
      }
      for (const b of allBranches.filter((b: any) => b.remote)) {
        if (!seen.has(b.displayName)) {
          seen.add(b.displayName)
          deduped.push(b)
        }
      }
      // Exclude branches that already have a worktree
      const wtBranches = new Set(wts.map((w: any) => w.branch))
      setBranches(deduped.filter((b) => !wtBranches.has(b.displayName)).map((b) => ({ name: b.name, current: b.current })))
    } catch { /* ignore */ }
    setWtLoading(false)
  }, [projectDir])

  const handleCreateWorktree = useCallback(async (branch: string) => {
    setWorktreePopover(false)
    const api = getDockApi()
    try {
      const result = await api.gitManager.addWorktree(projectDir, branch)
      if (result.success && result.path) {
        // Spawn a new terminal in the worktree
        const nextId = `term-${Date.now()}-wt`
        addTerminal(nextId)
        setTerminalWorktree(nextId, result.path)
      }
    } catch { /* ignore */ }
  }, [projectDir, addTerminal, setTerminalWorktree])

  const handleSelectWorktree = useCallback((wtPath: string) => {
    setWorktreePopover(false)
    // Spawn a new terminal in the existing worktree
    const nextId = `term-${Date.now()}-wt`
    addTerminal(nextId)
    setTerminalWorktree(nextId, wtPath)
  }, [addTerminal, setTerminalWorktree])

  const toggleShell = useCallback(() => {
    setShellAreaOpen((prev) => {
      if (!prev) setShellAreaMounted(true)
      return !prev
    })
  }, [])

  // When a pending shell command arrives, route it to the targeted terminal
  // (or the focused terminal if no target is specified)
  const [shellSubmitCommand, setShellSubmitCommand] = useState(true)
  useEffect(() => {
    if (!pendingShellCommand) return
    const { command: cmd, submit, targetTerminalId } = pendingShellCommand
    // If a specific terminal is targeted, only that terminal handles it
    // Otherwise fall back to the focused terminal
    const isTarget = targetTerminalId ? targetTerminalId === terminalId : isFocused
    if (!isTarget) return
    setPendingShellCommand(null)

    if (shellAreaOpen) {
      // Shell already open — write the command to the first shell
      getDockApi().shell.write(`shell:${terminalId}:0`, submit ? cmd + '\r' : cmd)
    } else {
      // Open shell area with the command as initialCommand
      setShellInitialCommand(cmd)
      setShellSubmitCommand(submit)
      setShellAreaMounted(true)
      setShellAreaOpen(true)
    }
  }, [pendingShellCommand, isFocused, shellAreaOpen, terminalId, setPendingShellCommand])

  const handleClose = useCallback(() => {
    const state = useDockStore.getState()
    const taskType = state.claudeTaskTerminals.get(terminalId)
    if (taskType) {
      const labels: Record<string, string> = { 'ci-fix': 'a CI fix', 'write-tests': 'a Write Tests task', 'reference-this': 'a Reference This session' }
      const label = labels[taskType] || 'a Claude task'
      if (!window.confirm(`This terminal is running ${label}. Close it and cancel?`)) return
      window.dispatchEvent(new CustomEvent('claude-task-cancelled', { detail: terminalId }))
    }
    getDockApi().terminal.kill(terminalId)
    removeTerminal(terminalId)
  }, [terminalId, removeTerminal])

  const handleClear = useCallback(() => {
    const api = getDockApi()
    api.terminal.write(terminalId, '/clear\r')
  }, [terminalId])

  const [copied, setCopied] = useState(false)

  const handleCopySessionId = useCallback(async () => {
    const api = getDockApi()
    const sessionId = await api.terminal.getSessionId(terminalId)
    if (sessionId) {
      navigator.clipboard.writeText(sessionId)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }, [terminalId])

  const [resuming, setResuming] = useState(false)
  const handleResumeInNative = useCallback(async () => {
    setResuming(true)
    try {
      const result = await getDockApi().terminal.resumeInNative(terminalId, claudeFlags)
      if (result.success) {
        // Terminal will be killed by the backend after Ctrl+C propagates;
        // remove it from the dock after a short delay
        setTimeout(() => {
          removeTerminal(terminalId)
        }, 800)
      }
    } catch { /* ignore */ }
    setResuming(false)
  }, [terminalId, claudeFlags, removeTerminal])

  const [actionsOpen, setActionsOpen] = useState(false)

  return (
    <div className={`terminal-card ${isFocused ? 'focused' : ''} ${!isAlive ? 'exited' : ''}`}>
      <div className="terminal-card-header">
        <div className="terminal-card-status">
          <span className={`status-dot ${!isAlive ? 'dead' : isActive ? 'active' : 'inactive'}`} />
          <TerminalTitle terminalId={terminalId} title={title} />
          {permIndicator && (
            <span className="terminal-perms-badge" title={permIndicator.tooltip}>
              {permIndicator.label}
            </span>
          )}
        </div>
        <div className="terminal-card-actions">
          <div className={`terminal-actions-panel ${actionsOpen ? 'open' : ''}`}>
            {shellEnabled && (
              <button
                className={`terminal-action-btn${shellAreaOpen ? ' terminal-action-active' : ''}`}
                onClick={toggleShell}
                title={shellAreaOpen ? 'Close shell panel' : 'Open shell panel'}
              >
                <ShellIcon />
              </button>
            )}
            <button className="terminal-action-btn" onClick={handleCopySessionId} title="Copy session ID">
              <CopyIdIcon copied={copied} />
            </button>
            <button className="terminal-action-btn" onClick={handleClear} title="Clear (/clear)">
              <ClearIcon />
            </button>
            <button
              className="terminal-action-btn"
              onClick={handleResumeInNative}
              disabled={resuming}
              title="Resume in native terminal"
            >
              <ExternalTerminalIcon />
            </button>
          </div>
          <button
            className="terminal-action-btn terminal-actions-toggle"
            onClick={() => setActionsOpen(!actionsOpen)}
            title={actionsOpen ? 'Collapse actions' : 'Expand actions'}
          >
            {actionsOpen ? '\u203A' : '\u2039'}
          </button>
          <button
            className={`terminal-action-btn terminal-lock-btn${isUnlocked ? ' unlocked' : ''}`}
            onClick={() => toggleTerminalLock(terminalId)}
            title={isUnlocked ? 'Lock (disable drag)' : 'Unlock (enable drag)'}
          >
            <LockIcon locked={!isUnlocked} />
          </button>
          <button className="terminal-close-btn" onClick={handleClose} title="Close terminal">
            &times;
          </button>
        </div>
      </div>
      <div className="terminal-card-body">
        <div className="terminal-card-split" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
          <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', position: 'relative' }}>
            <TerminalView terminalId={terminalId} isFocused={isFocused} />
            {shellEnabled && !shellAreaOpen && (
              <button className="shell-toggle-bottom" onClick={toggleShell} title="Open shell panel">
                <ShellIcon />
              </button>
            )}
            <button ref={wtBtnRef} className={`worktree-toggle-bottom${worktreePath ? ' worktree-toggle-active' : ''}`} onClick={openWorktreePopover} title={worktreePath ? `Worktree: ${worktreePath}` : 'Start a git worktree'}>
              <WorktreeIcon />
            </button>
          </div>
          {shellEnabled && shellAreaMounted && (
            <Suspense fallback={null}>
              <div style={shellAreaOpen ? undefined : { height: 0, overflow: 'hidden' }}>
                <ShellArea
                  terminalId={terminalId}
                  defaultHeight={defaultShellHeight}
                  initialCommand={shellInitialCommand}
                  submitCommand={shellSubmitCommand}
                  onAllClosed={() => setShellAreaOpen(false)}
                />
              </div>
            </Suspense>
          )}
        </div>
      </div>
      {worktreePopover && createPortal(
        <>
          <div className="worktree-popover-backdrop" onClick={() => setWorktreePopover(false)} />
          <div className="worktree-popover" style={{ top: Math.max(8, worktreePos.y - 310), left: Math.max(8, worktreePos.x) }}>
            <div className="worktree-popover-header">
              <span>Git Worktrees</span>
              <button className="worktree-popover-close" onClick={() => setWorktreePopover(false)}>&times;</button>
            </div>
            {wtLoading ? (
              <div className="worktree-popover-loading">Loading...</div>
            ) : (
              <div className="worktree-popover-body">
                {worktrees.filter(wt => !wt.isMain).length > 0 && (
                  <>
                    <div className="worktree-popover-label">Existing Worktrees</div>
                    {worktrees.filter(wt => !wt.isMain).map(wt => (
                      <button key={wt.path} className="worktree-popover-item" onClick={() => handleSelectWorktree(wt.path)} title={wt.path}>
                        <span className="worktree-popover-branch">{wt.branch || wt.head}</span>
                      </button>
                    ))}
                    <div className="worktree-popover-divider" />
                  </>
                )}
                <div className="worktree-popover-label">New Worktree from Branch</div>
                {branches.slice(0, 30).map(b => (
                  <button key={b.name} className="worktree-popover-item" onClick={() => handleCreateWorktree(b.name)}>
                    <span className="worktree-popover-branch">{b.name.replace(/^[^/]+\//, '')}</span>
                    {b.current && <span style={{ fontSize: 9, color: 'var(--accent-color)', marginLeft: 4 }}>current</span>}
                  </button>
                ))}
                {branches.length === 0 && (
                  <div className="worktree-popover-empty">No branches available</div>
                )}
              </div>
            )}
          </div>
        </>,
        document.body
      )}
    </div>
  )
}

export default React.memo(TerminalCard)
