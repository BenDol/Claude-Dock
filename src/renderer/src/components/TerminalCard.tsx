import React, { useCallback, useState, lazy, Suspense } from 'react'
import TerminalView from './TerminalView'
import TerminalTitle from './TerminalTitle'
import { useDockStore } from '../stores/dock-store'
import { useSettingsStore } from '../stores/settings-store'
import { getDockApi } from '../lib/ipc-bridge'

const ShellPanel = lazy(() => import('./ShellPanel'))

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

const TerminalCard: React.FC<TerminalCardProps> = ({ terminalId, title, isAlive, isFocused }) => {
  const removeTerminal = useDockStore((s) => s.removeTerminal)
  const isUnlocked = useDockStore((s) => s.unlockedTerminals.has(terminalId))
  const toggleTerminalLock = useDockStore((s) => s.toggleTerminalLock)
  const isActive = useDockStore((s) => s.activeTerminals.has(terminalId))
  const claudeFlags = useDockStore((s) => s.claudeTaskFlags.get(terminalId))
  const permIndicator = parsePermissionIndicator(claudeFlags)
  const shellEnabled = useSettingsStore((s) => s.settings.shellPanel?.enabled ?? true)
  const defaultShellHeight = useSettingsStore((s) => s.settings.shellPanel?.defaultHeight ?? 200)
  const [shellOpen, setShellOpen] = useState(false)
  const [shellHeight, setShellHeight] = useState(defaultShellHeight)
  const [shellMounted, setShellMounted] = useState(false)

  const toggleShell = useCallback(() => {
    setShellOpen((prev) => {
      if (!prev) setShellMounted(true) // mount on first open, keep mounted after
      return !prev
    })
  }, [])

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
                className={`terminal-action-btn${shellOpen ? ' terminal-action-active' : ''}`}
                onClick={toggleShell}
                title={shellOpen ? 'Close shell panel' : 'Open shell panel'}
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
            {shellEnabled && !shellOpen && (
              <button className="shell-toggle-bottom" onClick={toggleShell} title="Open shell panel">
                <ShellIcon />
              </button>
            )}
          </div>
          {shellEnabled && shellMounted && (
            <Suspense fallback={null}>
              <div style={shellOpen ? undefined : { height: 0, overflow: 'hidden' }}>
                <ShellPanel
                  terminalId={terminalId}
                  height={shellHeight}
                  onHeightChange={setShellHeight}
                  onClose={toggleShell}
                />
              </div>
            </Suspense>
          )}
        </div>
      </div>
    </div>
  )
}

export default React.memo(TerminalCard)
