import React from 'react'
import { useDockStore } from '../stores/dock-store'
import type { GridMode } from '../types'

interface ToolbarProps {
  projectDir: string
  onAddTerminal: () => void
  onOpenSettings: () => void
}

const Toolbar: React.FC<ToolbarProps> = ({ projectDir, onAddTerminal, onOpenSettings }) => {
  const gridMode = useDockStore((s) => s.gridMode)
  const setGridMode = useDockStore((s) => s.setGridMode)
  const terminalCount = useDockStore((s) => s.terminals.length)

  const toggleMode = () => {
    setGridMode(gridMode === 'auto' ? 'freeform' : 'auto')
  }

  return (
    <div className="toolbar">
      <div className="toolbar-left">
        <span className="toolbar-project" title={projectDir}>
          {projectDir.split(/[/\\]/).pop()}
        </span>
        <span className="toolbar-count">{terminalCount} terminal{terminalCount !== 1 ? 's' : ''}</span>
      </div>
      <div className="toolbar-right">
        <button className="toolbar-btn" onClick={toggleMode} title={`Mode: ${gridMode}`}>
          {gridMode === 'auto' ? 'Auto' : 'Free'}
        </button>
        <button className="toolbar-btn" onClick={onAddTerminal} title="New terminal (Ctrl+T)">
          +
        </button>
        <button className="toolbar-btn" onClick={onOpenSettings} title="Settings (Ctrl+,)">
          &#9881;
        </button>
      </div>
    </div>
  )
}

export default Toolbar
