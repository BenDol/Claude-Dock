import React from 'react'

interface EmptyStateProps {
  onAddTerminal: () => void
  projectDir: string
}

const EmptyState: React.FC<EmptyStateProps> = ({ onAddTerminal, projectDir }) => {
  return (
    <div className="empty-state">
      <div className="empty-state-content">
        <div className="empty-state-icon">{'>'}_</div>
        <h2>No terminals open</h2>
        <p className="empty-state-path">{projectDir}</p>
        <button className="empty-state-btn" onClick={onAddTerminal}>
          New Terminal (Ctrl+T)
        </button>
      </div>
    </div>
  )
}

export default EmptyState
