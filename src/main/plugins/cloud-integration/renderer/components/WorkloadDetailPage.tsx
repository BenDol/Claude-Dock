import React, { useState, useEffect } from 'react'
import { getDockApi } from '@dock-renderer/lib/ipc-bridge'
import type { CloudWorkloadDetail, CloudPage, WorkloadKind } from '../../../../../shared/cloud-types'
import StatusBadge from './StatusBadge'

interface Props {
  projectDir: string
  clusterName: string
  namespace: string
  workloadName: string
  kind: WorkloadKind
  onNavigate: (page: CloudPage) => void
  onOpenConsole: (section: string, params?: Record<string, string>) => void
}

export default function WorkloadDetailPage({
  projectDir, clusterName, namespace, workloadName, kind, onNavigate, onOpenConsole
}: Props) {
  const [workload, setWorkload] = useState<CloudWorkloadDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    getDockApi().cloudIntegration.getWorkloadDetail(projectDir, clusterName, namespace, workloadName, kind)
      .then((w) => {
        if (!cancelled) {
          setWorkload(w)
          setLoading(false)
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message || 'Failed to load workload details')
          setLoading(false)
        }
      })

    return () => { cancelled = true }
  }, [projectDir, clusterName, namespace, workloadName, kind])

  return (
    <div className="cloud-page">
      <div className="cloud-breadcrumb">
        <button className="cloud-breadcrumb-link" onClick={() => onNavigate({ view: 'kubernetes', tab: 'workloads' })}>
          Workloads
        </button>
        <span className="cloud-breadcrumb-sep">/</span>
        <button className="cloud-breadcrumb-link" onClick={() => onNavigate({ view: 'cluster-detail', clusterName })}>
          {clusterName}
        </button>
        <span className="cloud-breadcrumb-sep">/</span>
        <span>{workloadName}</span>
      </div>

      <div className="cloud-page-header">
        <h2>
          {workloadName}
          <span className="cloud-kind-badge" style={{ marginLeft: 8 }}>{kind}</span>
        </h2>
        <button
          className="cloud-console-link"
          onClick={() => onOpenConsole('workload', { name: workloadName, namespace })}
        >
          Open in Console
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
            <polyline points="15 3 21 3 21 9" />
            <line x1="10" y1="14" x2="21" y2="3" />
          </svg>
        </button>
      </div>

      {loading && <div className="cloud-loading-indicator">Loading workload details...</div>}
      {error && <div className="cloud-error"><p>{error}</p></div>}

      {!loading && !error && workload && (
        <>
          <div className="cloud-detail-grid">
            <div className="cloud-detail-field">
              <span className="cloud-detail-label">Status</span>
              <StatusBadge status={workload.status} />
            </div>
            <div className="cloud-detail-field">
              <span className="cloud-detail-label">Namespace</span>
              <span>{workload.namespace}</span>
            </div>
            <div className="cloud-detail-field">
              <span className="cloud-detail-label">Cluster</span>
              <button className="cloud-breadcrumb-link" onClick={() => onNavigate({ view: 'cluster-detail', clusterName })}>
                {workload.clusterName}
              </button>
            </div>
            <div className="cloud-detail-field">
              <span className="cloud-detail-label">Ready</span>
              <span>{workload.readyReplicas}/{workload.desiredReplicas}</span>
            </div>
            {workload.strategy && (
              <div className="cloud-detail-field">
                <span className="cloud-detail-label">Strategy</span>
                <span>{workload.strategy}</span>
              </div>
            )}
            <div className="cloud-detail-field">
              <span className="cloud-detail-label">Created</span>
              <span>{formatDate(workload.createdAt)}</span>
            </div>
          </div>

          {workload.images.length > 0 && (
            <div className="cloud-section">
              <h3>Images</h3>
              <div className="cloud-tag-list">
                {workload.images.map((img, i) => (
                  <span key={i} className="cloud-tag cloud-mono">{img}</span>
                ))}
              </div>
            </div>
          )}

          {workload.conditions.length > 0 && (
            <div className="cloud-section">
              <h3>Conditions</h3>
              <div className="cloud-table-wrapper">
                <table className="cloud-table">
                  <thead>
                    <tr>
                      <th>Type</th>
                      <th>Status</th>
                      <th>Reason</th>
                      <th>Message</th>
                      <th>Last Transition</th>
                    </tr>
                  </thead>
                  <tbody>
                    {workload.conditions.map((c, i) => (
                      <tr key={i}>
                        <td>{c.type}</td>
                        <td><StatusBadge status={c.status === 'True' ? 'Active' : c.status === 'False' ? 'Failed' : 'Unknown'} /></td>
                        <td>{c.reason || '-'}</td>
                        <td className="cloud-table-truncate" title={c.message}>{c.message || '-'}</td>
                        <td className="cloud-table-date">{formatDate(c.lastTransition)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {workload.pods.length > 0 && (
            <div className="cloud-section">
              <h3>Pods ({workload.pods.length})</h3>
              <div className="cloud-table-wrapper">
                <table className="cloud-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Status</th>
                      <th>Restarts</th>
                      <th>Age</th>
                      <th>Node</th>
                      <th>IP</th>
                      <th>Containers</th>
                    </tr>
                  </thead>
                  <tbody>
                    {workload.pods.map((pod) => (
                      <tr key={pod.name}>
                        <td className="cloud-table-name" title={pod.name}>{shortenPodName(pod.name)}</td>
                        <td><StatusBadge status={pod.status} /></td>
                        <td className={pod.restarts > 0 ? 'cloud-text-warning' : ''}>{pod.restarts}</td>
                        <td>{pod.age}</td>
                        <td className="cloud-table-truncate" title={pod.node}>{shortenNodeName(pod.node)}</td>
                        <td className="cloud-table-mono">{pod.ip || '-'}</td>
                        <td>
                          {pod.containers.map((c, ci) => (
                            <span key={ci} className="cloud-container-badge">
                              <span className={`cloud-status-dot ${c.ready ? 'success' : 'error'}`} />
                              {c.name}
                              {c.reason && <span className="cloud-container-reason"> ({c.reason})</span>}
                            </span>
                          ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {Object.keys(workload.labels).length > 0 && (
            <div className="cloud-section">
              <h3>Labels</h3>
              <div className="cloud-tag-list">
                {Object.entries(workload.labels).map(([k, v]) => (
                  <span key={k} className="cloud-tag cloud-mono">{k}: {v}</span>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function formatDate(iso: string): string {
  if (!iso) return '-'
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    })
  } catch {
    return iso
  }
}

function shortenPodName(name: string): string {
  if (name.length <= 40) return name
  // Show first 20 + ... + last 15 chars
  return name.slice(0, 20) + '...' + name.slice(-15)
}

function shortenNodeName(name: string): string {
  if (!name || name.length <= 30) return name || '-'
  return name.slice(0, 15) + '...' + name.slice(-10)
}
