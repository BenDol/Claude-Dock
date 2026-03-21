import React from 'react'
import type { CloudPage, CloudProviderInfo } from '../../../../../../shared/cloud-types'

interface Props {
  currentPage: CloudPage
  onNavigate: (page: CloudPage) => void
  provider: CloudProviderInfo | null
}

export default function Sidebar({ currentPage, onNavigate, provider }: Props) {
  const isActive = (view: string) => {
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
