import React, { useState, useEffect, useCallback } from 'react'
import { getDockApi } from '@dock-renderer/lib/ipc-bridge'
import type { CloudPage, CloudCluster, CloudWorkload } from '../../../../../shared/cloud-types'
import type { WorkloadKind } from '../../../../../shared/cloud-types'
import StatusBadge from './StatusBadge'

type Tab = 'overview' | 'clusters' | 'workloads'

interface Props {
  projectDir: string
  tab: Tab
  onNavigate: (page: CloudPage) => void
  onOpenConsole: (section: string, params?: Record<string, string>) => void
}

export default function KubernetesPage({ projectDir, tab, onNavigate, onOpenConsole }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>(tab)
  const [clusters, setClusters] = useState<CloudCluster[]>([])
  const [workloads, setWorkloads] = useState<CloudWorkload[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [authExpired, setAuthExpired] = useState(false)
  const [reauthenticating, setReauthenticating] = useState(false)

  const loadData = useCallback(async () => {
    setLoading(true)
    setError(null)
    setAuthExpired(false)
    const errors: string[] = []
    const api = getDockApi().cloudIntegration

    // Load clusters and workloads independently so one failure doesn't block the other
    const [clustersResult, workloadsResult] = await Promise.allSettled([
      api.getClusters(projectDir),
      api.getWorkloads(projectDir)
    ])

    if (clustersResult.status === 'fulfilled') {
      setClusters(clustersResult.value)
    } else {
      errors.push('Clusters: ' + (clustersResult.reason?.message || 'Failed to fetch'))
    }

    if (workloadsResult.status === 'fulfilled') {
      setWorkloads(workloadsResult.value)
    } else {
      errors.push('Workloads: ' + (workloadsResult.reason?.message || 'Failed to fetch'))
    }

    if (errors.length > 0) {
      const joined = errors.join('\n')
      setError(joined)
      // Detect auth errors from the message itself — most robust, avoids IPC serialization issues
      const authPatterns = ['credentials have expired', 'please re-authenticate', 'invalid_grant', 'auth tokens', 'gcloud auth login']
      const lower = joined.toLowerCase()
      if (authPatterns.some((p) => lower.includes(p))) {
        setAuthExpired(true)
      }
    }
    setLoading(false)
  }, [projectDir])

  const handleReauth = useCallback(async () => {
    setReauthenticating(true)
    try {
      const sent = await getDockApi().cloudIntegration.reauth(projectDir)
      if (sent) {
        // Command was sent to the dock's shell panel — switch to "waiting for auth" state
        setError('Authentication started in the dock terminal. Click "Retry" after signing in.')
        setAuthExpired(false)
      } else {
        setError('Could not open shell. Please run "gcloud auth login" manually in a terminal.')
        setAuthExpired(false)
      }
    } catch {
      setError('Could not open shell. Please run "gcloud auth login" manually in a terminal.')
      setAuthExpired(false)
    }
    setReauthenticating(false)
  }, [projectDir])

  useEffect(() => {
    loadData()
  }, [loadData])

  useEffect(() => {
    setActiveTab(tab)
  }, [tab])

  const switchTab = (t: Tab) => {
    setActiveTab(t)
    onNavigate({ view: 'kubernetes', tab: t })
  }

  return (
    <div className="cloud-page">
      <div className="cloud-page-header">
        <h2>Kubernetes</h2>
        <button className="cloud-console-link" onClick={() => onOpenConsole('clusters')}>
          Open in Console
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
            <polyline points="15 3 21 3 21 9" />
            <line x1="10" y1="14" x2="21" y2="3" />
          </svg>
        </button>
      </div>

      <div className="cloud-tabs">
        <button className={`cloud-tab ${activeTab === 'overview' ? 'active' : ''}`} onClick={() => switchTab('overview')}>
          Overview
        </button>
        <button className={`cloud-tab ${activeTab === 'clusters' ? 'active' : ''}`} onClick={() => switchTab('clusters')}>
          Clusters ({clusters.length})
        </button>
        <button className={`cloud-tab ${activeTab === 'workloads' ? 'active' : ''}`} onClick={() => switchTab('workloads')}>
          Workloads ({workloads.length})
        </button>
      </div>

      {loading && <div className="cloud-loading-indicator">Loading Kubernetes data...</div>}
      {error && (
        <div className="cloud-error">
          {authExpired ? (
            <>
              <p>Your cloud credentials have expired.</p>
              <button
                className="cloud-reauth-btn"
                onClick={handleReauth}
                disabled={reauthenticating}
              >
                {reauthenticating ? 'Authenticating...' : 'Re-authenticate'}
              </button>
              <p className="cloud-error-hint">Runs the auth command in a dock shell terminal.</p>
            </>
          ) : (
            <>
              <p>{error}</p>
              <button className="cloud-retry-btn" onClick={loadData}>Retry</button>
            </>
          )}
        </div>
      )}

      {!loading && !error && activeTab === 'overview' && (
        <OverviewTab clusters={clusters} workloads={workloads} onNavigate={onNavigate} />
      )}
      {!loading && !error && activeTab === 'clusters' && (
        <ClustersTab clusters={clusters} onNavigate={onNavigate} onOpenConsole={onOpenConsole} />
      )}
      {!loading && !error && activeTab === 'workloads' && (
        <WorkloadsTab workloads={workloads} onNavigate={onNavigate} onOpenConsole={onOpenConsole} />
      )}
    </div>
  )
}

function OverviewTab({ clusters, workloads, onNavigate }: {
  clusters: CloudCluster[]
  workloads: CloudWorkload[]
  onNavigate: (page: CloudPage) => void
}) {
  const healthyClusters = clusters.filter((c) => c.status === 'RUNNING').length
  const activeWorkloads = workloads.filter((w) => w.status === 'Active').length
  const degradedWorkloads = workloads.filter((w) => w.status === 'Degraded' || w.status === 'Failed').length

  return (
    <div className="cloud-overview">
      <div className="cloud-cards">
        <div className="cloud-card cloud-card-clickable" onClick={() => onNavigate({ view: 'kubernetes', tab: 'clusters' })}>
          <div className="cloud-card-title">Clusters</div>
          <div className="cloud-card-value">{clusters.length}</div>
          <div className="cloud-card-meta">
            <span className="cloud-status-dot success" /> {healthyClusters} running
          </div>
        </div>
        <div className="cloud-card cloud-card-clickable" onClick={() => onNavigate({ view: 'kubernetes', tab: 'workloads' })}>
          <div className="cloud-card-title">Workloads</div>
          <div className="cloud-card-value">{workloads.length}</div>
          <div className="cloud-card-meta">
            <span className="cloud-status-dot success" /> {activeWorkloads} active
            {degradedWorkloads > 0 && (
              <>{' '}<span className="cloud-status-dot error" /> {degradedWorkloads} degraded</>
            )}
          </div>
        </div>
        <div className="cloud-card">
          <div className="cloud-card-title">Total Nodes</div>
          <div className="cloud-card-value">{clusters.reduce((s, c) => s + c.nodeCount, 0)}</div>
          <div className="cloud-card-meta">Across all clusters</div>
        </div>
      </div>

      {degradedWorkloads > 0 && (
        <div className="cloud-section">
          <h3>Attention Required</h3>
          <div className="cloud-list">
            {workloads
              .filter((w) => w.status === 'Degraded' || w.status === 'Failed')
              .map((w) => (
                <div
                  key={`${w.clusterName}/${w.namespace}/${w.name}`}
                  className="cloud-list-item cloud-list-item-clickable"
                  onClick={() => onNavigate({
                    view: 'workload-detail',
                    clusterName: w.clusterName,
                    namespace: w.namespace,
                    workloadName: w.name,
                    kind: w.kind
                  })}
                >
                  <div className="cloud-list-item-main">
                    <span className="cloud-list-item-name">{w.name}</span>
                    <span className="cloud-list-item-meta">{w.namespace} / {w.clusterName}</span>
                  </div>
                  <StatusBadge status={w.status} />
                </div>
              ))
            }
          </div>
        </div>
      )}
    </div>
  )
}

function ClustersTab({ clusters, onNavigate, onOpenConsole }: {
  clusters: CloudCluster[]
  onNavigate: (page: CloudPage) => void
  onOpenConsole: (section: string, params?: Record<string, string>) => void
}) {
  if (clusters.length === 0) {
    return <div className="cloud-empty"><p>No Kubernetes clusters found.</p></div>
  }

  return (
    <div className="cloud-table-wrapper">
      <table className="cloud-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Status</th>
            <th>Location</th>
            <th>Nodes</th>
            <th>Version</th>
            <th>Created</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {clusters.map((cluster) => (
            <tr
              key={cluster.name}
              className="cloud-table-row-clickable"
              onClick={() => onNavigate({ view: 'cluster-detail', clusterName: cluster.name })}
            >
              <td className="cloud-table-name">{cluster.name}</td>
              <td><StatusBadge status={cluster.status} /></td>
              <td>{cluster.location}</td>
              <td>{cluster.nodeCount}</td>
              <td className="cloud-table-mono">{cluster.version}</td>
              <td className="cloud-table-date">{formatDate(cluster.createdAt)}</td>
              <td>
                <button
                  className="cloud-icon-btn"
                  title="Open in Console"
                  onClick={(e) => {
                    e.stopPropagation()
                    onOpenConsole('cluster', { name: cluster.name, location: cluster.location })
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
                    <polyline points="15 3 21 3 21 9" />
                    <line x1="10" y1="14" x2="21" y2="3" />
                  </svg>
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function WorkloadsTab({ workloads, onNavigate, onOpenConsole }: {
  workloads: CloudWorkload[]
  onNavigate: (page: CloudPage) => void
  onOpenConsole: (section: string, params?: Record<string, string>) => void
}) {
  const [filter, setFilter] = useState('')
  const filtered = workloads.filter((w) =>
    w.name.toLowerCase().includes(filter.toLowerCase()) ||
    w.namespace.toLowerCase().includes(filter.toLowerCase())
  )

  if (workloads.length === 0) {
    return <div className="cloud-empty"><p>No workloads found.</p></div>
  }

  return (
    <div>
      <div className="cloud-filter-bar">
        <input
          type="text"
          className="cloud-filter-input"
          placeholder="Filter workloads..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <div className="cloud-table-wrapper">
        <table className="cloud-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Kind</th>
              <th>Status</th>
              <th>Ready</th>
              <th>Namespace</th>
              <th>Cluster</th>
              <th>Images</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((w) => (
              <tr
                key={`${w.clusterName}/${w.namespace}/${w.name}`}
                className="cloud-table-row-clickable"
                onClick={() => onNavigate({
                  view: 'workload-detail',
                  clusterName: w.clusterName,
                  namespace: w.namespace,
                  workloadName: w.name,
                  kind: w.kind as WorkloadKind
                })}
              >
                <td className="cloud-table-name">{w.name}</td>
                <td><span className="cloud-kind-badge">{w.kind}</span></td>
                <td><StatusBadge status={w.status} /></td>
                <td>{w.readyReplicas}/{w.desiredReplicas}</td>
                <td>{w.namespace}</td>
                <td>{w.clusterName}</td>
                <td className="cloud-table-mono cloud-table-truncate" title={w.images.join(', ')}>
                  {w.images[0] ? shortenImage(w.images[0]) : '-'}
                  {w.images.length > 1 && ` +${w.images.length - 1}`}
                </td>
                <td>
                  <button
                    className="cloud-icon-btn"
                    title="Open in Console"
                    onClick={(e) => {
                      e.stopPropagation()
                      onOpenConsole('workload', { name: w.name, namespace: w.namespace })
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
                      <polyline points="15 3 21 3 21 9" />
                      <line x1="10" y1="14" x2="21" y2="3" />
                    </svg>
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function formatDate(iso: string): string {
  if (!iso) return '-'
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  } catch {
    return iso
  }
}

function shortenImage(image: string): string {
  // Show just the image name:tag, not the full registry path
  const parts = image.split('/')
  return parts[parts.length - 1] || image
}
