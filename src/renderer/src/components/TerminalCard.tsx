import React, { useCallback, useState } from 'react'
import TerminalView from './TerminalView'
import TerminalTitle from './TerminalTitle'
import { useDockStore } from '../stores/dock-store'
import { getDockApi } from '../lib/ipc-bridge'

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

const TerminalCard: React.FC<TerminalCardProps> = ({ terminalId, title, isAlive, isFocused }) => {
  const removeTerminal = useDockStore((s) => s.removeTerminal)
  const isUnlocked = useDockStore((s) => s.unlockedTerminals.has(terminalId))
  const toggleTerminalLock = useDockStore((s) => s.toggleTerminalLock)

  const handleClose = useCallback(() => {
    const state = useDockStore.getState()
    const taskType = state.claudeTaskTerminals.get(terminalId)
    if (taskType) {
      const labels: Record<string, string> = { 'ci-fix': 'a CI fix', 'write-tests': 'a Write Tests task' }
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
          <span className={`status-dot ${isAlive ? 'alive' : 'dead'}`} />
          <TerminalTitle terminalId={terminalId} title={title} />
        </div>
        <div className="terminal-card-actions">
          <div className={`terminal-actions-panel ${actionsOpen ? 'open' : ''}`}>
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
        <TerminalView terminalId={terminalId} isFocused={isFocused} />
      </div>
    </div>
  )
}

export default React.memo(TerminalCard)
