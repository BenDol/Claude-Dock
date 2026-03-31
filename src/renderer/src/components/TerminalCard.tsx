import React, { useCallback, useEffect, useRef, useState, lazy, Suspense } from 'react'
import { createPortal } from 'react-dom'
import TerminalView from './TerminalView'
import TerminalTitle from './TerminalTitle'
import { useDockStore } from '../stores/dock-store'
import { useSettingsStore } from '../stores/settings-store'
import { getDockApi } from '../lib/ipc-bridge'

const ShellArea = lazy(() => import('./ShellArea'))
const ShellEventCards = lazy(() => import('./ShellEventCards'))

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

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

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

const SessionPickerIcon: React.FC = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="1 4 1 10 7 10" />
    <path d="M3.51 15a9 9 0 102.13-9.36L1 10" />
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
  const [sessionId, setSessionId] = useState<string | null>(null)
  const worktreePath = useDockStore((s) => s.terminalWorktrees.get(terminalId))
  const pendingWorktreeBranch = useDockStore((s) => s.pendingWorktrees.get(terminalId))
  const projectDir = useDockStore((s) => s.projectDir)
  const addTerminal = useDockStore((s) => s.addTerminal)
  const setTerminalWorktree = useDockStore((s) => s.setTerminalWorktree)
  const setPendingWorktree = useDockStore((s) => s.setPendingWorktree)
  const [worktreePopover, setWorktreePopover] = useState(false)
  const [worktreePos, setWorktreePos] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [worktrees, setWorktrees] = useState<{ path: string; branch: string; head: string; isMain: boolean }[]>([])
  const [branches, setBranches] = useState<{ name: string; current: boolean }[]>([])
  const [wtLoading, setWtLoading] = useState(false)
  const [resolveMode, setResolveMode] = useState(false)
  const [resolveCommitMsg, setResolveCommitMsg] = useState('')
  const [resolveTarget, setResolveTarget] = useState<string>('')
  const [resolving, setResolving] = useState(false)
  const [resolveError, setResolveError] = useState<string | null>(null)
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
      // Include all branches (local + remote) — worktrees can be created from any.
      const allBranches = brs
        .map((b: any) => ({
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
      // Exclude branches that already have a non-main worktree (the main worktree
      // is the project itself — its branch should still be available for new worktrees)
      const wtBranches = new Set(wts.filter((w: any) => !w.isMain).map((w: any) => w.branch))
      setBranches(deduped.filter((b) => !wtBranches.has(b.displayName)).map((b) => ({ name: b.name, current: b.current })))
    } catch (err) {
      console.error('[worktree] failed to load branches/worktrees:', err)
    }
    setWtLoading(false)
  }, [projectDir])

  const spawnWorktreeTerminal = useCallback((wtPath: string) => {
    const nextId = `term-${Date.now()}-wt`
    // Set worktree path BEFORE adding terminal so the spawn useEffect picks it up
    setTerminalWorktree(nextId, wtPath)
    // Use setTimeout to ensure the store update from setTerminalWorktree is committed
    // before addTerminal triggers the new TerminalCard mount + spawn useEffect
    setTimeout(() => addTerminal(nextId), 0)
  }, [addTerminal, setTerminalWorktree])

  const handleCreateWorktree = useCallback(async (branch: string) => {
    setWorktreePopover(false)

    // Immediately create a terminal card with a loading indicator.
    // The PTY spawn is deferred until pendingWorktrees is cleared.
    const nextId = `term-${Date.now()}-wt`
    setPendingWorktree(nextId, branch)
    addTerminal(nextId)

    const api = getDockApi()
    try {
      const result = await api.gitManager.addWorktree(projectDir, branch)
      if (result.success && result.path) {
        // Worktree ready — set the real path and clear pending so spawn proceeds
        setTerminalWorktree(nextId, result.path)
        setPendingWorktree(nextId, null)
      } else if (result.error) {
        // If worktree already exists, try to use it directly
        if (result.error.includes('already exists')) {
          const wts = await api.gitManager.listWorktrees(projectDir)
          const strippedBranch = branch.replace(/^[^/]+\//, '')
          const existing = wts.find((w: any) => w.branch === strippedBranch || w.branch === branch)
          if (existing) {
            setTerminalWorktree(nextId, existing.path)
            setPendingWorktree(nextId, null)
            return
          }
        }
        // Failed — remove the placeholder terminal
        useDockStore.getState().removeTerminal(nextId)
        alert(`Failed to create worktree: ${result.error}`)
      }
    } catch (e) {
      useDockStore.getState().removeTerminal(nextId)
      alert(`Failed to create worktree: ${e instanceof Error ? e.message : String(e)}`)
    }
  }, [projectDir, addTerminal, setTerminalWorktree, setPendingWorktree])

  const handleSelectWorktree = useCallback((wtPath: string) => {
    setWorktreePopover(false)
    spawnWorktreeTerminal(wtPath)
  }, [spawnWorktreeTerminal])

  const handleResolveWorktree = useCallback(async () => {
    if (!worktreePath || !resolveCommitMsg.trim()) return
    setResolving(true)
    setResolveError(null)
    try {
      const result = await getDockApi().gitManager.resolveWorktree(
        projectDir,
        worktreePath,
        resolveCommitMsg.trim(),
        resolveTarget || undefined
      )
      if (result.success) {
        setWorktreePopover(false)
        setResolveMode(false)
        setTerminalWorktree(terminalId, null)
        // Close this terminal since the worktree is gone
        getDockApi().terminal.kill(terminalId)
        removeTerminal(terminalId)
      } else {
        setResolveError(result.error || 'Resolve failed')
      }
    } catch (e: any) {
      setResolveError(e.message || 'Resolve failed')
    }
    setResolving(false)
  }, [worktreePath, resolveCommitMsg, resolveTarget, projectDir, terminalId, setTerminalWorktree, removeTerminal])

  const handleDiscardWorktree = useCallback(async () => {
    if (!worktreePath) return
    if (!window.confirm('Discard all changes and remove this worktree? This cannot be undone.')) return
    setResolving(true)
    try {
      await getDockApi().gitManager.removeWorktree(projectDir, worktreePath, true)
      setWorktreePopover(false)
      setResolveMode(false)
      setTerminalWorktree(terminalId, null)
      getDockApi().terminal.kill(terminalId)
      removeTerminal(terminalId)
    } catch (e: any) {
      setResolveError(e.message || 'Failed to remove worktree')
    }
    setResolving(false)
  }, [worktreePath, projectDir, terminalId, setTerminalWorktree, removeTerminal])

  // Fetch session ID for this terminal (used to filter shell events)
  useEffect(() => {
    getDockApi().terminal.getSessionId(terminalId).then((id: string | null) => setSessionId(id))
  }, [terminalId])

  const toggleShell = useCallback(() => {
    setShellAreaOpen((prev) => {
      if (!prev) setShellAreaMounted(true)
      return !prev
    })
  }, [])

  // When a pending shell command arrives, route it to the targeted terminal
  // (or the focused terminal if no target is specified)
  const [shellSubmitCommand, setShellSubmitCommand] = useState(true)
  const [shellTypeOverride, setShellTypeOverride] = useState<string | null>(null)
  const [newShellCommand, setNewShellCommand] = useState<{ command: string; submit?: boolean; shellType?: string | null; layout?: 'split' | 'stack' | null } | null>(null)
  useEffect(() => {
    if (!pendingShellCommand) return
    const { command: cmd, submit, targetTerminalId, shellType, targetShellId, shellLayout } = pendingShellCommand
    // If a specific terminal is targeted, only that terminal handles it
    // Otherwise fall back to the focused terminal
    const isTarget = targetTerminalId ? targetTerminalId === terminalId : isFocused
    if (!isTarget) return
    setPendingShellCommand(null)

    // "__first__" sentinel = reuse the default shell (shell:0), same as the old behavior.
    // null/undefined = open a NEW shell panel.
    const isFirstShellRequest = targetShellId === '__first__'
    const effectiveShellId = isFirstShellRequest ? null : targetShellId

    // If the shell ID references a different terminal (stale from a previous session),
    // treat it as null — the caller intended a specific panel that no longer exists.
    const isStaleShellId = effectiveShellId && !effectiveShellId.includes(terminalId)
    const resolvedShellId = isStaleShellId ? null : effectiveShellId

    if (shellAreaOpen && !resolvedShellId) {
      // No shell_id specified (or stale) and shell area already open — open a NEW shell
      // panel instead of clobbering the existing one.
      setNewShellCommand({ command: cmd, submit, shellType, layout: shellLayout })
      return
    }

    // Determine which shell ID to write to.
    const defaultShellId = `shell:${terminalId}:0`
    const writeShellId = resolvedShellId || defaultShellId

    if (shellAreaOpen) {
      // Shell already open — if the requested shell type matches (or none specified),
      // write the command directly. Only kill+reopen if the type is explicitly different.
      const needsRespawn = shellType && shellTypeOverride !== shellType && shellType !== 'default'
      if (needsRespawn) {
        getDockApi().shell.kill(writeShellId)
        setShellAreaOpen(false)
        setShellAreaMounted(false)
        setTimeout(() => {
          setShellInitialCommand(cmd)
          setShellSubmitCommand(submit)
          setShellTypeOverride(shellType)
          setShellAreaMounted(true)
          setShellAreaOpen(true)
        }, 200)
      } else {
        // Send Ctrl+C twice to cancel any running process (double for confirmation prompts),
        // wait for prompt to return, then send the command.
        // Monitor shell output to verify the command was accepted.
        const api = getDockApi()
        api.shell.write(writeShellId, '\x03') // First Ctrl+C
        setTimeout(() => {
          api.shell.write(writeShellId, '\x03') // Second Ctrl+C (for confirmation prompts)
          setTimeout(() => {
            // Track output to detect if the command started
            let gotOutput = false
            const cleanup = api.shell.onData((id, _data) => {
              if (id === writeShellId) gotOutput = true
            })

            api.shell.write(writeShellId, submit ? cmd + '\r' : cmd)

            // After 5 seconds, if no output was received the command likely didn't start
            setTimeout(() => {
              cleanup()
              if (!gotOutput && submit) {
                // Command didn't produce any output — shell may still be busy.
                // Send another Ctrl+C and retry once.
                api.shell.write(writeShellId, '\x03')
                setTimeout(() => {
                  api.shell.write(writeShellId, submit ? cmd + '\r' : cmd)
                }, 300)
              }
            }, 5000)
          }, 300)
        }, 200)
      }
    } else {
      // Shell not open — open with the requested type
      setShellInitialCommand(cmd)
      setShellSubmitCommand(submit)
      setShellTypeOverride(shellType)
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

  // Session picker popup state
  const [sessionPopover, setSessionPopover] = useState(false)
  const [sessionPos, setSessionPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [sessions, setSessions] = useState<{ sessionId: string; timestamp: number; summary: string }[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const sessionBtnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!sessionPopover || !sessionBtnRef.current) return
    const rect = sessionBtnRef.current.getBoundingClientRect()
    setSessionPos({ x: rect.right - 320, y: rect.top - 4 })
  }, [sessionPopover])

  const openSessionPicker = useCallback(async () => {
    setSessionPopover(true)
    setSessionsLoading(true)
    try {
      const list = await getDockApi().terminal.listSessions(10)
      setSessions(list)
    } catch (e) {
      console.error('[session-picker] failed to load sessions:', e)
    }
    setSessionsLoading(false)
  }, [])

  const handleSelectSession = useCallback(async (sessionId: string) => {
    setSessionPopover(false)
    try {
      await getDockApi().terminal.respawn(terminalId, sessionId)
      useDockStore.getState().setTerminalAlive(terminalId, true)
    } catch (e) {
      console.error('[session-picker] respawn failed:', e)
    }
  }, [terminalId])

  return (
    <div className={`terminal-card ${isFocused ? 'focused' : ''} ${!isAlive ? 'exited' : ''}`} data-terminal-id={terminalId}>
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
            <button
              ref={sessionBtnRef}
              className="terminal-action-btn"
              onClick={openSessionPicker}
              title="Switch to a recent session"
            >
              <SessionPickerIcon />
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
            <button ref={wtBtnRef} className={`worktree-toggle-bottom${worktreePath || pendingWorktreeBranch ? ' worktree-toggle-active' : ''}`} onClick={openWorktreePopover} title={worktreePath ? `Worktree: ${worktreePath}` : pendingWorktreeBranch ? `Creating worktree (${pendingWorktreeBranch.replace(/^[^/]+\//, '')})...` : 'Start a git worktree'}>
              <WorktreeIcon />
            </button>
          </div>
          <Suspense fallback={null}>
            <ShellEventCards terminalId={terminalId} sessionId={sessionId} />
          </Suspense>
          {shellEnabled && shellAreaMounted && (
            <Suspense fallback={null}>
              <div style={shellAreaOpen ? undefined : { height: 0, overflow: 'hidden' }}>
                <ShellArea
                  terminalId={terminalId}
                  defaultHeight={defaultShellHeight}
                  initialCommand={shellInitialCommand}
                  submitCommand={shellSubmitCommand}
                  shellType={shellTypeOverride}
                  newShellCommand={newShellCommand}
                  onNewShellConsumed={() => setNewShellCommand(null)}
                  onAllClosed={() => setShellAreaOpen(false)}
                />
              </div>
            </Suspense>
          )}
        </div>
      </div>
      {sessionPopover && createPortal(
        <>
          <div className="worktree-popover-backdrop" onClick={() => setSessionPopover(false)} />
          <div className="session-popover" style={{ top: Math.max(8, sessionPos.y - 360), left: Math.max(8, sessionPos.x) }}>
            <div className="worktree-popover-header">
              <span>Recent Sessions</span>
              <button className="worktree-popover-close" onClick={() => setSessionPopover(false)}>&times;</button>
            </div>
            {sessionsLoading ? (
              <div className="worktree-popover-loading">Loading...</div>
            ) : (
              <div className="worktree-popover-body">
                {sessions.length === 0 && (
                  <div className="worktree-popover-empty">No sessions found</div>
                )}
                {sessions.map((s) => (
                  <button
                    key={s.sessionId}
                    className="session-popover-item"
                    onClick={() => handleSelectSession(s.sessionId)}
                    title={`${s.sessionId}\n${new Date(s.timestamp).toLocaleString()}`}
                  >
                    <span className="session-popover-summary">{s.summary || '(no message)'}</span>
                    <span className="session-popover-time">{formatRelativeTime(s.timestamp)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </>,
        document.body
      )}
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
            ) : resolveMode && worktreePath ? (
              <div className="worktree-popover-body">
                <div className="worktree-popover-label">Resolve Worktree</div>
                <div className="worktree-resolve-form">
                  <input
                    type="text"
                    className="worktree-resolve-input"
                    placeholder="Commit message"
                    value={resolveCommitMsg}
                    onChange={(e) => setResolveCommitMsg(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && resolveCommitMsg.trim()) handleResolveWorktree() }}
                    spellCheck={false}
                    autoFocus
                  />
                  <select
                    className="worktree-resolve-select"
                    value={resolveTarget}
                    onChange={(e) => setResolveTarget(e.target.value)}
                  >
                    <option value="">Commit only (no merge)</option>
                    {branches.map(b => (
                      <option key={b.name} value={b.name}>{b.name.replace(/^[^/]+\//, '')}{b.current ? ' (current)' : ''}</option>
                    ))}
                  </select>
                  {resolveError && <div className="worktree-resolve-error">{resolveError}</div>}
                  <div className="worktree-resolve-actions">
                    <button className="worktree-resolve-cancel" onClick={() => setResolveMode(false)} disabled={resolving}>Cancel</button>
                    <button
                      className="worktree-resolve-confirm"
                      onClick={handleResolveWorktree}
                      disabled={resolving || !resolveCommitMsg.trim()}
                    >
                      {resolving ? 'Resolving...' : resolveTarget ? 'Commit & Merge' : 'Commit & Remove'}
                    </button>
                  </div>
                  <button className="worktree-discard-btn" onClick={handleDiscardWorktree} disabled={resolving}>
                    Discard & Remove Worktree
                  </button>
                </div>
              </div>
            ) : (
              <div className="worktree-popover-body">
                {worktreePath && (
                  <>
                    <div className="worktree-popover-label">Current Worktree</div>
                    <button className="worktree-popover-item worktree-resolve-btn" onClick={() => { setResolveMode(true); setResolveCommitMsg(''); setResolveTarget(''); setResolveError(null) }}>
                      <span className="worktree-popover-branch">Resolve Worktree</span>
                    </button>
                    <button className="worktree-popover-item" onClick={handleDiscardWorktree} style={{ color: '#f87171' }}>
                      <span className="worktree-popover-branch">Discard & Remove</span>
                    </button>
                    <div className="worktree-popover-divider" />
                  </>
                )}
                {worktrees.filter(wt => !wt.isMain).length > 0 && (
                  <>
                    <div className="worktree-popover-label">Existing Worktrees</div>
                    {worktrees.filter(wt => !wt.isMain).map(wt => (
                      <div key={wt.path} className="worktree-popover-item" title={wt.path}>
                        <span className="worktree-popover-branch" onClick={() => handleSelectWorktree(wt.path)}>{wt.branch || wt.head}</span>
                        {wt.path === worktreePath && <span style={{ fontSize: 9, color: 'var(--accent-color)', marginLeft: 4 }}>active</span>}
                        <button
                          className="worktree-delete-btn"
                          onClick={async (e) => {
                            e.stopPropagation()
                            if (!confirm(`Delete worktree "${wt.branch || wt.head}"?\n\nThis will remove the directory:\n${wt.path}`)) return
                            const api = getDockApi()
                            const r = await api.gitManager.removeWorktree(projectDir, wt.path, true)
                            if (r.success) {
                              setWorktrees(prev => prev.filter(w => w.path !== wt.path))
                            } else {
                              alert(`Failed to remove worktree: ${r.error || 'Unknown error'}`)
                            }
                          }}
                          title="Delete worktree"
                        >
                          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                            <line x1="2" y1="2" x2="8" y2="8" /><line x1="8" y1="2" x2="2" y2="8" />
                          </svg>
                        </button>
                      </div>
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
