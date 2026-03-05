import React from 'react'
import { useDockStore } from '../stores/dock-store'
import { getDockApi } from '../lib/ipc-bridge'

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

  const api = getDockApi()

  return (
    <div className="toolbar">
      <div className="toolbar-left">
        <span className="toolbar-project" title={projectDir}>
          {projectDir.split(/[/\\]/).pop()}
        </span>
        <span className="toolbar-count">{terminalCount} terminal{terminalCount !== 1 ? 's' : ''}</span>
      </div>
      <div className="toolbar-center" />
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
        <div className="toolbar-separator" />
        <button className="win-btn win-minimize" onClick={() => api.win.minimize()} title="Minimize">
          &#x2015;
        </button>
        <button className="win-btn win-maximize" onClick={() => api.win.maximize()} title="Maximize">
          &#9744;
        </button>
        <button className="win-btn win-close" onClick={() => api.win.close()} title="Close">
          &#10005;
        </button>
      </div>
    </div>
  )
}

export default Toolbar
