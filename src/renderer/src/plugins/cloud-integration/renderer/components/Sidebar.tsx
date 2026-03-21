import React from 'react'
import type { CloudPage, CloudProviderInfo } from '../../../../../../shared/cloud-types'

interface Props {
  currentPage: CloudPage
  onNavigate: (page: CloudPage) => void
  provider: CloudProviderInfo | null
  needsSetup: boolean
}

export default function Sidebar({ currentPage, onNavigate, provider, needsSetup }: Props) {
  const isActive = (view: string) => {
    if (view === 'setup') return currentPage.view === 'setup'
    if (view === 'dashboard') return currentPage.view === 'dashboard'
    if (view === 'kubernetes') return (
      currentPage.view === 'kubernetes' ||
      currentPage.view === 'cluster-detail' ||
      currentPage.view === 'workload-detail'
    )
    return false
  }

  return (
    <div className="cloud-sidebar">
      <div className="cloud-sidebar-header">
        {provider && (
          <div className="cloud-provider-badge">
            <span
              className="cloud-provider-icon"
              dangerouslySetInnerHTML={{ __html: provider.icon }}
            />
            <span className="cloud-provider-name">{provider.name}</span>
            <span className={`cloud-provider-status ${provider.available ? 'connected' : 'disconnected'}`}>
              {provider.available ? 'Connected' : 'Not Connected'}
            </span>
          </div>
        )}
      </div>

      <nav className="cloud-sidebar-nav">
        {needsSetup && (
          <button
            className={`cloud-sidebar-item cloud-sidebar-setup ${isActive('setup') ? 'active' : ''}`}
            onClick={() => onNavigate({ view: 'setup' })}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
            </svg>
            Setup
            <span className="cloud-sidebar-badge">!</span>
          </button>
        )}

        <button
          className={`cloud-sidebar-item ${isActive('dashboard') ? 'active' : ''}`}
          onClick={() => onNavigate({ view: 'dashboard' })}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="7" height="7" />
            <rect x="14" y="3" width="7" height="7" />
            <rect x="14" y="14" width="7" height="7" />
            <rect x="3" y="14" width="7" height="7" />
          </svg>
          Dashboard
        </button>

        <div className="cloud-sidebar-section">Kubernetes</div>

        <button
          className={`cloud-sidebar-item ${isActive('kubernetes') ? 'active' : ''}`}
          onClick={() => onNavigate({ view: 'kubernetes', tab: 'overview' })}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 6v6l4 2" />
          </svg>
          Kubernetes
        </button>
      </nav>
    </div>
  )
}
