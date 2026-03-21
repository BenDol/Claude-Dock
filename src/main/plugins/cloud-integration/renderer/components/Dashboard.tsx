import React, { useState, useEffect } from 'react'
import { getDockApi } from '@dock-renderer/lib/ipc-bridge'
import type { CloudDashboardData, CloudPage, CloudProviderInfo } from '../../../../../shared/cloud-types'

interface Props {
  projectDir: string
  provider: CloudProviderInfo | null
  onNavigate: (page: CloudPage) => void
  onOpenConsole: (section: string, params?: Record<string, string>) => void
}

export default function Dashboard({ projectDir, provider, onNavigate, onOpenConsole }: Props) {
  const [data, setData] = useState<CloudDashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    getDockApi().cloudIntegration.getDashboard(projectDir)
      .then((d) => {
        if (!cancelled) {
          setData(d)
          setLoading(false)
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message || 'Failed to load dashboard')
          setLoading(false)
        }
      })

    return () => { cancelled = true }
  }, [projectDir])

  if (loading) {
    return <div className="cloud-page"><div className="cloud-loading-indicator">Loading dashboard...</div></div>
  }

  if (error) {
    return (
      <div className="cloud-page">
        <div className="cloud-error">
          <h3>Failed to load dashboard</h3>
          <p>{error}</p>
        </div>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="cloud-page">
        <div className="cloud-empty">
          <h3>No Data Available</h3>
          <p>
            {provider && !provider.available
              ? `${provider.name} is not authenticated. Please authenticate using your provider's CLI.`
              : 'Could not fetch cloud data. Ensure your cloud CLI is installed and authenticated.'}
          </p>
        </div>
      </div>
    )
  }

  const { project, kubernetes } = data

  return (
    <div className="cloud-page">
      <div className="cloud-page-header">
        <h2>Dashboard</h2>
        <button className="cloud-console-link" onClick={() => onOpenConsole('dashboard')}>
          Open in Console
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
            <polyline points="15 3 21 3 21 9" />
            <line x1="10" y1="14" x2="21" y2="3" />
          </svg>
        </button>
      </div>

      <div className="cloud-info-bar">
        <div className="cloud-info-item">
          <span className="cloud-info-label">Project</span>
          <span className="cloud-info-value">{project.name}</span>
        </div>
        {project.region && (
          <div className="cloud-info-item">
            <span className="cloud-info-label">Region</span>
            <span className="cloud-info-value">{project.region}</span>
          </div>
        )}
        <div className="cloud-info-item">
          <span className="cloud-info-label">Provider</span>
          <span className="cloud-info-value">{data.provider.name}</span>
        </div>
      </div>

      <div className="cloud-cards">
        <div
          className="cloud-card cloud-card-clickable"
          onClick={() => onNavigate({ view: 'kubernetes', tab: 'clusters' })}
        >
          <div className="cloud-card-title">Clusters</div>
          <div className="cloud-card-value">{kubernetes.clusterCount}</div>
          <div className="cloud-card-meta">
            <span className="cloud-status-dot success" /> {kubernetes.healthyClusters} healthy
            {kubernetes.unhealthyClusters > 0 && (
              <><span className="cloud-status-dot error" /> {kubernetes.unhealthyClusters} unhealthy</>
            )}
          </div>
        </div>

        <div className="cloud-card">
          <div className="cloud-card-title">Nodes</div>
          <div className="cloud-card-value">{kubernetes.totalNodes}</div>
          <div className="cloud-card-meta">Across all clusters</div>
        </div>

        <div
          className="cloud-card cloud-card-clickable"
          onClick={() => onNavigate({ view: 'kubernetes', tab: 'workloads' })}
        >
          <div className="cloud-card-title">Pods</div>
          <div className="cloud-card-value">{kubernetes.totalPods}</div>
          <div className="cloud-card-meta">Running across clusters</div>
        </div>
      </div>
    </div>
  )
}
