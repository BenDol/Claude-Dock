import React, { useCallback } from 'react'
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

const TerminalCard: React.FC<TerminalCardProps> = ({ terminalId, title, isAlive, isFocused }) => {
  const removeTerminal = useDockStore((s) => s.removeTerminal)

  const handleClose = useCallback(() => {
    getDockApi().terminal.kill(terminalId)
    removeTerminal(terminalId)
  }, [terminalId, removeTerminal])

  return (
    <div className={`terminal-card ${isFocused ? 'focused' : ''} ${!isAlive ? 'exited' : ''}`}>
      <div className="terminal-card-header">
        <div className="terminal-card-status">
          <span className={`status-dot ${isAlive ? 'alive' : 'dead'}`} />
          <TerminalTitle terminalId={terminalId} title={title} />
        </div>
        <button className="terminal-close-btn" onClick={handleClose} title="Close terminal">
          &times;
        </button>
      </div>
      <div className="terminal-card-body">
        <TerminalView terminalId={terminalId} isFocused={isFocused} />
      </div>
    </div>
  )
}

export default React.memo(TerminalCard)
