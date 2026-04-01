/**
 * Header actions for the workspace panel — rendered in the
 * DockPanelLayout header bar via the headerActions registration.
 */
import React from 'react'
import type { PanelProps } from '@dock-renderer/panel-registry'

const HeaderActions: React.FC<PanelProps> = () => {
  return (
    <div className="ws-header-actions">
      <button
        className="ws-header-btn"
        onClick={() => window.dispatchEvent(new CustomEvent('workspace:collapse-all'))}
        title="Collapse all"
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="4 14 10 14 10 20" /><polyline points="20 10 14 10 14 4" /><line x1="14" y1="10" x2="21" y2="3" /><line x1="3" y1="21" x2="10" y2="14" />
        </svg>
      </button>
    </div>
  )
}

export default HeaderActions
