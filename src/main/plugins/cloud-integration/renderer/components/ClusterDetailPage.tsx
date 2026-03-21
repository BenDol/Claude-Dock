import React, { useState, useEffect } from 'react'
import { getDockApi } from '@dock-renderer/lib/ipc-bridge'
import type { CloudClusterDetail, CloudPage } from '../../../../../shared/cloud-types'
import StatusBadge from './StatusBadge'

interface Props {
  projectDir: string
  clusterName: string
  onNavigate: (page: CloudPage) => void
  onOpenConsole: (section: string, params?: Record<string, string>) => void
}

export default function ClusterDetailPage({ projectDir, clusterName, onNavigate, onOpenConsole }: Props) {
  const [cluster, setCluster] = useState<CloudClusterDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    getDockApi().cloudIntegration.getClusterDetail(projectDir, clusterName)
      .then((c) => {
        if (!cancelled) {
          setCluster(c)
          setLoading(false)
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message || 'Failed to load cluster details')
          setLoading(false)
        }
      })

    return () => { cancelled = true }
  }, [projectDir, clusterName])

  return (
    <div className="cloud-page">
      <div className="cloud-breadcrumb">
        <button className="cloud-breadcrumb-link" onClick={() => onNavigate({ view: 'kubernetes', tab: 'clusters' })}>
          Clusters
        </button>
        <span className="cloud-breadcrumb-sep">/</span>
        <span>{clusterName}</span>
      </div>

      <div className="cloud-page-header">
        <h2>{clusterName}</h2>
        <button
          className="cloud-console-link"
          onClick={() => onOpenConsole('cluster', { name: clusterName, location: cluster?.location || '' })}
        >
          Open in Console
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
            <polyline points="15 3 21 3 21 9" />
            <line x1="10" y1="14" x2="21" y2="3" />
          </svg>
        </button>
      </div>

      {loading && <div className="cloud-loading-indicator">Loading cluster details...</div>}
      {error && <div className="cloud-error"><p>{error}</p></div>}

      {!loading && !error && cluster && (
        <>
          <div className="cloud-detail-grid">
            <div className="cloud-detail-field">
              <span className="cloud-detail-label">Status</span>
              <StatusBadge status={cluster.status} />
            </div>
            <div className="cloud-detail-field">
              <span className="cloud-detail-label">Location</span>
              <span>{cluster.location}</span>
            </div>
            <div className="cloud-detail-field">
              <span className="cloud-detail-label">Version</span>
              <span className="cloud-mono">{cluster.version}</span>
            </div>
            <div className="cloud-detail-field">
              <span className="cloud-detail-label">Nodes</span>
              <span>{cluster.nodeCount}</span>
            </div>
            <div className="cloud-detail-field">
              <span className="cloud-detail-label">Total Pods</span>
              <span>{cluster.totalPods}</span>
            </div>
            <div className="cloud-detail-field">
              <span className="cloud-detail-label">Endpoint</span>
              <span className="cloud-mono">{cluster.endpoint || '-'}</span>
            </div>
            <div className="cloud-detail-field">
              <span className="cloud-detail-label">Created</span>
              <span>{formatDate(cluster.createdAt)}</span>
            </div>
          </div>

          {cluster.namespaces.length > 0 && (
            <div className="cloud-section">
              <h3>Namespaces ({cluster.namespaces.length})</h3>
              <div className="cloud-tag-list">
                {cluster.namespaces.map((ns) => (
                  <span key={ns} className="cloud-tag">{ns}</span>
                ))}
              </div>
            </div>
          )}

          {cluster.nodes.length > 0 && (
            <div className="cloud-section">
              <h3>Nodes ({cluster.nodes.length})</h3>
              <div className="cloud-table-wrapper">
                <table className="cloud-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Status</th>
                      <th>Machine Type</th>
                      <th>Zone</th>
                      <th>Version</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cluster.nodes.map((node) => (
                      <tr key={node.name}>
                        <td className="cloud-table-name">{node.name}</td>
                        <td><StatusBadge status={node.status} /></td>
                        <td className="cloud-table-mono">{node.machineType}</td>
                        <td>{node.zone}</td>
                        <td className="cloud-table-mono">{node.version}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {cluster.resourceUsage && (
            <div className="cloud-section">
              <h3>Resource Usage</h3>
              <div className="cloud-detail-grid">
                <div className="cloud-detail-field">
                  <span className="cloud-detail-label">CPU Requested</span>
                  <span>{cluster.resourceUsage.cpuRequested} / {cluster.resourceUsage.cpuCapacity}</span>
                </div>
                <div className="cloud-detail-field">
                  <span className="cloud-detail-label">Memory Requested</span>
                  <span>{cluster.resourceUsage.memoryRequested} / {cluster.resourceUsage.memoryCapacity}</span>
                </div>
              </div>
            </div>
          )}

          <div className="cloud-section">
            <button
              className="cloud-btn cloud-btn-secondary"
              onClick={() => onNavigate({ view: 'kubernetes', tab: 'workloads' })}
            >
              View Workloads
            </button>
          </div>
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
