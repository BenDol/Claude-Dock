import React, { useEffect, useState, useCallback } from 'react'
import { getDockApi } from '@dock-renderer/lib/ipc-bridge'
import { useSettingsStore } from '@dock-renderer/stores/settings-store'
import { applyThemeToDocument } from '@dock-renderer/lib/theme'
import type {
  CloudProviderInfo,
  CloudDashboardData,
  CloudCluster,
  CloudWorkload,
  CloudPage
} from '../../../../shared/cloud-types'

const params = new URLSearchParams(window.location.search)
const projectDir = decodeURIComponent(params.get('projectDir') || '')

export default function CloudApp(): React.ReactElement {
  const settings = useSettingsStore((s) => s.settings)
  const [page, setPage] = useState<CloudPage>({ view: 'dashboard' })
  const [providers, setProviders] = useState<CloudProviderInfo[]>([])
  const [dashboard, setDashboard] = useState<CloudDashboardData | null>(null)
  const [clusters, setClusters] = useState<CloudCluster[]>([])
  const [workloads, setWorkloads] = useState<CloudWorkload[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const api = getDockApi()

  useEffect(() => {
    if (settings) applyThemeToDocument(settings)
  }, [settings])

  const loadDashboard = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [provs, dash] = await Promise.all([
        api.cloudIntegration.getProviders(),
        api.cloudIntegration.getDashboard(projectDir)
      ])
      setProviders(provs)
      setDashboard(dash)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load dashboard')
    } finally {
      setLoading(false)
    }
  }, [api])

  const loadClusters = useCallback(async () => {
    setLoading(true)
    try {
      const c = await api.cloudIntegration.getClusters(projectDir)
      setClusters(c)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load clusters')
    } finally {
      setLoading(false)
    }
  }, [api])

  const loadWorkloads = useCallback(async () => {
    setLoading(true)
    try {
      const w = await api.cloudIntegration.getWorkloads(projectDir)
      setWorkloads(w)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load workloads')
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => {
    if (page.view === 'dashboard') {
      loadDashboard()
    } else if (page.view === 'kubernetes') {
      if (page.tab === 'clusters') loadClusters()
      else if (page.tab === 'workloads') loadWorkloads()
      else loadDashboard()
    }
  }, [page, loadDashboard, loadClusters, loadWorkloads])

  const navTo = (p: CloudPage) => setPage(p)

  return (
    <div className="cloud-app" style={{ height: '100%', display: 'flex', flexDirection: 'column', fontFamily: 'var(--font-family, system-ui, sans-serif)', color: 'var(--fg, #e0e0e0)', background: 'var(--bg, #0f0f14)' }}>
      {/* Title bar drag region */}
      <div style={{ height: 32, WebkitAppRegion: 'drag' as any, display: 'flex', alignItems: 'center', padding: '0 12px', fontSize: 12, opacity: 0.6, flexShrink: 0 }}>
        Cloud Integration
      </div>

      {/* Navigation */}
      <nav style={{ display: 'flex', gap: 4, padding: '0 12px 8px', flexShrink: 0 }}>
        <NavButton active={page.view === 'dashboard'} onClick={() => navTo({ view: 'dashboard' })}>Dashboard</NavButton>
        <NavButton active={page.view === 'kubernetes' && (page as any).tab === 'clusters'} onClick={() => navTo({ view: 'kubernetes', tab: 'clusters' })}>Clusters</NavButton>
        <NavButton active={page.view === 'kubernetes' && (page as any).tab === 'workloads'} onClick={() => navTo({ view: 'kubernetes', tab: 'workloads' })}>Workloads</NavButton>
      </nav>

      {/* Provider selector */}
      {providers.length > 0 && (
        <div style={{ padding: '0 12px 8px', display: 'flex', gap: 6, flexShrink: 0 }}>
          {providers.map((p) => (
            <button
              key={p.id}
              onClick={() => api.cloudIntegration.setProvider(projectDir, p.id).then(() => loadDashboard())}
              style={{
                padding: '4px 10px',
                fontSize: 12,
                border: '1px solid',
                borderColor: dashboard?.provider?.id === p.id ? 'var(--accent, #6c8cbf)' : 'var(--border, #333)',
                borderRadius: 4,
                background: dashboard?.provider?.id === p.id ? 'var(--accent, #6c8cbf)22' : 'transparent',
                color: 'inherit',
                cursor: 'pointer',
                opacity: p.available ? 1 : 0.4
              }}
            >
              {p.name}{p.available ? '' : ' (not configured)'}
            </button>
          ))}
        </div>
      )}

      {/* Content */}
      <div style={{ flex: 1, overflow: 'auto', padding: '0 12px 12px' }}>
        {loading && <div style={{ padding: 20, textAlign: 'center', opacity: 0.5 }}>Loading...</div>}
        {error && <div style={{ padding: 20, color: '#f87171' }}>{error}</div>}

        {!loading && !error && page.view === 'dashboard' && dashboard && (
          <DashboardView data={dashboard} />
        )}

        {!loading && !error && page.view === 'dashboard' && !dashboard && (
          <div style={{ padding: 20, textAlign: 'center', opacity: 0.5 }}>
            No cloud provider configured. Select a provider above to get started.
          </div>
        )}

        {!loading && !error && page.view === 'kubernetes' && (page as any).tab === 'clusters' && (
          <ClustersView clusters={clusters} />
        )}

        {!loading && !error && page.view === 'kubernetes' && (page as any).tab === 'workloads' && (
          <WorkloadsView workloads={workloads} />
        )}
      </div>
    </div>
  )
}

function NavButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '6px 14px',
        fontSize: 13,
        border: 'none',
        borderBottom: active ? '2px solid var(--accent, #6c8cbf)' : '2px solid transparent',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        opacity: active ? 1 : 0.6
      }}
    >
      {children}
    </button>
  )
}

function DashboardView({ data }: { data: CloudDashboardData }) {
  const { provider, project, kubernetes } = data
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card title="Provider">
        <div style={{ fontSize: 16, fontWeight: 600 }}>{provider.name}</div>
        <div style={{ fontSize: 12, opacity: 0.6, marginTop: 4 }}>
          Status: {provider.available ? 'Authenticated' : 'Not authenticated'}
        </div>
      </Card>
      <Card title="Project">
        <div>{project.name}</div>
        <div style={{ fontSize: 12, opacity: 0.6 }}>ID: {project.id}{project.region ? ` · ${project.region}` : ''}</div>
      </Card>
      <Card title="Kubernetes">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 12 }}>
          <Stat label="Clusters" value={kubernetes.clusterCount} />
          <Stat label="Healthy" value={kubernetes.healthyClusters} color="#34d399" />
          <Stat label="Unhealthy" value={kubernetes.unhealthyClusters} color={kubernetes.unhealthyClusters > 0 ? '#f87171' : undefined} />
          <Stat label="Nodes" value={kubernetes.totalNodes} />
          <Stat label="Pods" value={kubernetes.totalPods} />
        </div>
      </Card>
    </div>
  )
}

function ClustersView({ clusters }: { clusters: CloudCluster[] }) {
  if (clusters.length === 0) return <div style={{ padding: 20, textAlign: 'center', opacity: 0.5 }}>No clusters found</div>
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {clusters.map((c) => (
        <Card key={c.name} title={c.name}>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12 }}>
            <span>Status: <StatusBadge status={c.status} /></span>
            <span>Location: {c.location}</span>
            <span>Nodes: {c.nodeCount}</span>
            <span>Version: {c.version}</span>
          </div>
        </Card>
      ))}
    </div>
  )
}

function WorkloadsView({ workloads }: { workloads: CloudWorkload[] }) {
  if (workloads.length === 0) return <div style={{ padding: 20, textAlign: 'center', opacity: 0.5 }}>No workloads found</div>
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {workloads.map((w) => (
        <Card key={`${w.clusterName}/${w.namespace}/${w.name}`} title={w.name}>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12 }}>
            <span>{w.kind}</span>
            <span>{w.namespace}</span>
            <span>{w.readyReplicas}/{w.desiredReplicas} ready</span>
            <StatusBadge status={w.status} />
          </div>
        </Card>
      ))}
    </div>
  )
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ border: '1px solid var(--border, #333)', borderRadius: 6, padding: 12 }}>
      <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', opacity: 0.5, marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  )
}

function Stat({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div>
      <div style={{ fontSize: 20, fontWeight: 600, color }}>{value}</div>
      <div style={{ fontSize: 11, opacity: 0.5 }}>{label}</div>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    RUNNING: '#34d399', Active: '#34d399', Ready: '#34d399', Completed: '#34d399',
    PROVISIONING: '#fbbf24', Progressing: '#fbbf24',
    ERROR: '#f87171', Failed: '#f87171', DEGRADED: '#f87171', Degraded: '#f87171',
    STOPPING: '#fb923c', Suspended: '#94a3b8'
  }
  return (
    <span style={{ color: colors[status] || '#94a3b8', fontWeight: 500 }}>{status}</span>
  )
}
