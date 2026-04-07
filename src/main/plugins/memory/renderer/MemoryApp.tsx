import './memory.css'
import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { getDockApi } from '@dock-renderer/lib/ipc-bridge'
import { useSettingsStore } from '@dock-renderer/stores/settings-store'
import type {
  MemoryAdapterInfo,
  MemoryDashboardStats,
  MemoryProject,
  MemorySession,
  MemoryBranch,
  MemoryMessage,
  MemoryTokenSnapshot,
  MemoryImportLogEntry,
  MemorySearchResult,
  MemoryContextSummaryParsed,
  MemorySessionListOptions,
  MemoryBranchListOptions
} from '../../../../shared/memory-types'

const params = new URLSearchParams(window.location.search)
const projectDir = decodeURIComponent(params.get('projectDir') || '')

type ViewId = 'dashboard' | 'sessions' | 'branches' | 'search' | 'tokens' | 'database' | 'adapters'

// ── Utility Helpers ──────────────────────────────────────────────────────────

function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return n.toLocaleString()
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return (bytes / 1_073_741_824).toFixed(2) + ' GB'
  if (bytes >= 1_048_576) return (bytes / 1_048_576).toFixed(1) + ' MB'
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return bytes + ' B'
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  return `${(seconds / 3600).toFixed(1)}h`
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—'
  try {
    const d = new Date(dateStr)
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
      ' ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
  } catch { return dateStr }
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str
  return str.slice(0, max) + '...'
}

function parseJsonSafe(json: string | null): unknown {
  if (!json) return null
  try { return JSON.parse(json) } catch { return null }
}

// ── Main App ─────────────────────────────────────────────────────────────────

export default function MemoryApp(): React.ReactElement {
  const [activeView, setActiveView] = useState<ViewId>('dashboard')
  const [adapters, setAdapters] = useState<MemoryAdapterInfo[]>([])
  const [selectedAdapter, setSelectedAdapter] = useState<string | undefined>()
  const [loading, setLoading] = useState(true)

  // Detail navigation state
  const [selectedSessionId, setSelectedSessionId] = useState<number | null>(null)
  const [selectedBranchId, setSelectedBranchId] = useState<number | null>(null)

  const api = getDockApi()

  // Theme — load() fetches settings, applies theme, and listens for changes
  const settings = useSettingsStore((s) => s.settings)
  const loadSettings = useSettingsStore((s) => s.load)
  useEffect(() => { loadSettings() }, [loadSettings])

  // Load adapters — use ref for selectedAdapter to avoid dependency loop
  const selectedAdapterRef = useRef(selectedAdapter)
  useEffect(() => { selectedAdapterRef.current = selectedAdapter }, [selectedAdapter])

  const loadAdapters = useCallback(async () => {
    try {
      const result = await api.memory.getAdapters()
      setAdapters(result)
      if (!selectedAdapterRef.current && result.length > 0) {
        const available = result.find(a => a.installed && a.enabled)
        if (available) setSelectedAdapter(available.id)
      }
    } catch { /* ignore */ }
    setLoading(false)
  }, [])

  useEffect(() => { loadAdapters() }, [])

  // Reopen handler — must return cleanup to avoid listener leak
  useEffect(() => {
    const cleanup = api.memory.onReopen(() => loadAdapters())
    return cleanup
  }, [loadAdapters])

  const activeAdapterInfo = useMemo(() => adapters.find(a => a.id === selectedAdapter), [adapters, selectedAdapter])

  const navigateToSession = useCallback((sessionId: number) => {
    setSelectedSessionId(sessionId)
    setSelectedBranchId(null)
    setActiveView('sessions')
  }, [])

  const navigateToBranch = useCallback((branchId: number) => {
    setSelectedBranchId(branchId)
    setActiveView('branches')
  }, [])

  if (loading) {
    return <div className="mem-app"><div className="mem-loading"><div className="mem-spinner" /> Loading...</div></div>
  }

  const noAdapters = adapters.length === 0 || !adapters.some(a => a.installed)

  return (
    <div className="mem-app">
      {/* Titlebar */}
      <div className="mem-titlebar">
        <h1>Memory</h1>
        {activeAdapterInfo && (
          <span style={{ fontSize: 11, color: 'var(--mem-text-muted)' }}>
            {activeAdapterInfo.name} v{activeAdapterInfo.version}
          </span>
        )}
        <div className="mem-titlebar-controls">
          <button className="mem-titlebar-btn" onClick={() => api.memory.refresh(selectedAdapter).then(() => loadAdapters())} title="Refresh">
            &#x21bb;
          </button>
          <button className="mem-titlebar-btn" onClick={() => api.win.minimize()}>&#x2013;</button>
          <button className="mem-titlebar-btn" onClick={() => api.win.maximize()}>&#x25a1;</button>
          <button className="mem-titlebar-btn close" onClick={() => api.win.close()}>&#x2715;</button>
        </div>
      </div>

      <div className="mem-body">
        {/* Sidebar */}
        <div className="mem-sidebar">
          {/* Adapter card */}
          {activeAdapterInfo && (
            <div className="mem-adapter-card">
              <div className="mem-adapter-name">{activeAdapterInfo.name}</div>
              <div className="mem-adapter-status">
                <span className={`mem-status-dot ${activeAdapterInfo.installed && activeAdapterInfo.enabled ? 'connected' : 'disconnected'}`} />
                <span style={{ color: 'var(--mem-text-secondary)', fontSize: 11 }}>{activeAdapterInfo.statusMessage}</span>
              </div>
            </div>
          )}

          {/* Navigation */}
          <div className="mem-sidebar-section">
            <div className="mem-sidebar-label">Views</div>
            {(activeAdapterInfo?.sections ?? []).map((section) => (
              <button
                key={section.id}
                className={`mem-sidebar-item ${activeView === section.id ? 'active' : ''}`}
                onClick={() => { setActiveView(section.id as ViewId); setSelectedSessionId(null); setSelectedBranchId(null) }}
              >
                <span className="mem-sidebar-icon">{sectionIcon(section.id)}</span>
                {section.label}
              </button>
            ))}
          </div>

          <div className="mem-sidebar-section" style={{ marginTop: 'auto' }}>
            <button
              className={`mem-sidebar-item ${activeView === 'adapters' ? 'active' : ''}`}
              onClick={() => setActiveView('adapters')}
            >
              <span className="mem-sidebar-icon">&#x2699;</span>
              Adapters
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="mem-content">
          {noAdapters ? (
            <NoAdaptersView onInstalled={loadAdapters} />
          ) : activeAdapterInfo && activeAdapterInfo.installed && !activeAdapterInfo.hasData ? (
            <div className="mem-empty">
              <div className="mem-empty-icon">{'\u{23F3}'}</div>
              <div className="mem-empty-title">Waiting for First Session</div>
              <div className="mem-empty-desc" style={{ maxWidth: 480 }}>
                {activeAdapterInfo.name} is installed and ready. Start a Claude Code session in any terminal
                and the memory database will be created automatically.
              </div>
              <div className="mem-empty-desc" style={{ maxWidth: 480, marginTop: 8, fontSize: 12, color: 'var(--mem-text-muted)' }}>
                Once populated, Claude will automatically recall relevant context from past conversations
                at the start of each new session — no manual setup needed.
              </div>
              <button className="mem-btn primary" onClick={loadAdapters} style={{ marginTop: 16 }}>Refresh</button>
            </div>
          ) : activeView === 'dashboard' ? (
            <DashboardView adapterId={selectedAdapter} onSessionClick={navigateToSession} />
          ) : activeView === 'sessions' ? (
            selectedSessionId != null ? (
              <SessionDetailView
                sessionId={selectedSessionId}
                adapterId={selectedAdapter}
                onBack={() => setSelectedSessionId(null)}
                onBranchClick={navigateToBranch}
              />
            ) : (
              <SessionListView adapterId={selectedAdapter} onSessionClick={navigateToSession} />
            )
          ) : activeView === 'branches' ? (
            selectedBranchId != null ? (
              <BranchDetailView
                branchId={selectedBranchId}
                adapterId={selectedAdapter}
                onBack={() => setSelectedBranchId(null)}
              />
            ) : (
              <BranchListView adapterId={selectedAdapter} onBranchClick={navigateToBranch} />
            )
          ) : activeView === 'search' ? (
            <SearchView adapterId={selectedAdapter} onBranchClick={navigateToBranch} onSessionClick={navigateToSession} />
          ) : activeView === 'tokens' ? (
            <TokenView adapterId={selectedAdapter} />
          ) : activeView === 'database' ? (
            <DatabaseView adapterId={selectedAdapter} />
          ) : activeView === 'adapters' ? (
            <AdaptersView adapters={adapters} onRefresh={loadAdapters} />
          ) : null}
        </div>
      </div>
    </div>
  )
}

function sectionIcon(id: string): string {
  const icons: Record<string, string> = {
    dashboard: '\u{1F4CA}',
    sessions: '\u{1F4AC}',
    branches: '\u{1F333}',
    search: '\u{1F50D}',
    tokens: '\u{1F4B0}',
    database: '\u{1F5C4}'
  }
  return icons[id] ?? '\u{2022}'
}

// ── No Adapters View ─────────────────────────────────────────────────────────

function NoAdaptersView({ onInstalled }: { onInstalled?: () => void }): React.ReactElement {
  const [installing, setInstalling] = useState(false)
  const [result, setResult] = useState<{ success: boolean; message: string; details?: string[] } | null>(null)
  const api = getDockApi()

  const handleInstall = useCallback(async () => {
    setInstalling(true)
    setResult(null)
    try {
      const r = await api.memory.installAdapter('claudest')
      if (r.success) {
        setResult({ success: true, message: 'Claudest installed successfully.' })
        onInstalled?.()
      } else {
        // Show command output details for debugging
        const details = r.results?.filter((x: any) => x.error || x.output).map((x: any) => x.error || x.output) ?? []
        setResult({
          success: false,
          message: r.error || 'Install failed',
          details
        })
      }
    } catch (err) {
      setResult({ success: false, message: `Error: ${err}` })
    }
    setInstalling(false)
  }, [onInstalled])

  return (
    <div className="mem-empty">
      <div className="mem-empty-icon">{'\u{1F9E0}'}</div>
      <div className="mem-empty-title">Enhance Claude with Persistent Memory</div>
      <div className="mem-empty-desc" style={{ marginBottom: 12, maxWidth: 480 }}>
        By default, Claude starts every session with a blank slate. <strong>Claudest</strong> changes that.
      </div>

      <div className="mem-features" style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20, maxWidth: 480, textAlign: 'left' }}>
        <div className="mem-feature-item" style={{ display: 'flex', gap: 8, fontSize: 12, color: 'var(--mem-text-secondary)' }}>
          <span style={{ color: 'var(--mem-accent)', flexShrink: 0 }}>{'\u{1F504}'}</span>
          <span><strong>Automatic recall</strong> — Claude automatically retrieves relevant context from past conversations at the start of each session</span>
        </div>
        <div className="mem-feature-item" style={{ display: 'flex', gap: 8, fontSize: 12, color: 'var(--mem-text-secondary)' }}>
          <span style={{ color: 'var(--mem-accent)', flexShrink: 0 }}>{'\u{1F4BE}'}</span>
          <span><strong>Persistent decisions</strong> — Architecture choices, naming conventions, and project context carry over between sessions</span>
        </div>
        <div className="mem-feature-item" style={{ display: 'flex', gap: 8, fontSize: 12, color: 'var(--mem-text-secondary)' }}>
          <span style={{ color: 'var(--mem-accent)', flexShrink: 0 }}>{'\u{1F50D}'}</span>
          <span><strong>Full-text search</strong> — Search across all your past conversations and branch context summaries</span>
        </div>
        <div className="mem-feature-item" style={{ display: 'flex', gap: 8, fontSize: 12, color: 'var(--mem-text-secondary)' }}>
          <span style={{ color: 'var(--mem-accent)', flexShrink: 0 }}>{'\u{1F4CA}'}</span>
          <span><strong>Usage insights</strong> — Track token spending, session patterns, and project activity over time</span>
        </div>
      </div>

      <button className="mem-btn primary" onClick={handleInstall} disabled={installing}>
        {installing ? 'Installing Claudest...' : 'Install Claudest'}
      </button>
      <div style={{ marginTop: 16, fontSize: 12, color: 'var(--mem-text-muted)' }}>
        Or install manually in a terminal:
      </div>
      <div className="mem-code-block" style={{ marginTop: 8, fontSize: 11, textAlign: 'left', maxWidth: 420 }}>
        <div>claude plugin marketplace add gupsammy/claudest</div>
        <div>claude plugin install claude-memory@Claudest</div>
      </div>
      {result && (
        <>
          <div className={`mem-tag ${result.success ? 'success' : 'error'}`} style={{ marginTop: 12, padding: '8px 12px', fontSize: 12 }}>
            {result.message}
          </div>
          {result.details && result.details.length > 0 && (
            <div className="mem-code-block" style={{ marginTop: 8, fontSize: 10, textAlign: 'left', maxWidth: 420, opacity: 0.7 }}>
              {result.details.map((d, i) => <div key={i}>{d}</div>)}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ── Dashboard View ───────────────────────────────────────────────────────────

function DashboardView({ adapterId, onSessionClick }: { adapterId?: string; onSessionClick: (id: number) => void }): React.ReactElement {
  const [stats, setStats] = useState<MemoryDashboardStats | null>(null)
  const [loading, setLoading] = useState(true)
  const api = getDockApi()

  useEffect(() => {
    setLoading(true)
    api.memory.getDashboard(adapterId).then(s => { setStats(s); setLoading(false) }).catch(() => setLoading(false))
  }, [adapterId])

  if (loading) return <div className="mem-loading"><div className="mem-spinner" /> Loading dashboard...</div>
  if (!stats) return <div className="mem-empty"><div className="mem-empty-title">No data available</div></div>

  const maxDailyMessages = Math.max(...stats.dailyActivity.map(d => d.messages), 1)

  return (
    <div>
      <h2 className="mem-page-title">Dashboard</h2>
      <p className="mem-page-subtitle">Overview of your Claude conversation memory</p>

      {/* Stats Grid */}
      <div className="mem-stats-grid">
        <StatCard label="Projects" value={formatNumber(stats.totalProjects)} />
        <StatCard label="Sessions" value={formatNumber(stats.totalSessions)} />
        <StatCard label="Branches" value={formatNumber(stats.totalBranches)} />
        <StatCard label="Messages" value={formatNumber(stats.totalMessages)} />
        <StatCard label="Input Tokens" value={formatNumber(stats.totalTokensIn)} detail="Total consumed" />
        <StatCard label="Output Tokens" value={formatNumber(stats.totalTokensOut)} detail="Total generated" />
        <StatCard label="Cache Read" value={formatNumber(stats.totalCacheRead)} detail="Tokens reused" />
        <StatCard label="Tool Uses" value={formatNumber(stats.totalToolUses)} />
        <StatCard label="Lines Modified" value={formatNumber(stats.totalLinesModified)} />
        <StatCard label="Avg Duration" value={formatDuration(stats.averageSessionDuration)} detail="Per session" />
      </div>

      {/* Activity Chart */}
      {stats.dailyActivity.length > 0 && (
        <div className="mem-section-card">
          <div className="mem-section-card-header">Activity (Last 30 Days)</div>
          <div className="mem-section-card-body">
            <div className="mem-chart-bar-group">
              {stats.dailyActivity.slice().reverse().map((d, i) => (
                <div
                  key={i}
                  className="mem-chart-bar"
                  style={{ height: `${Math.max((d.messages / maxDailyMessages) * 100, 2)}%` }}
                  title={`${d.date}: ${d.sessions} sessions, ${d.messages} messages`}
                />
              ))}
            </div>
            <div className="mem-chart-labels">
              {stats.dailyActivity.slice().reverse().map((d, i) => (
                <span key={i}>{i === 0 || i === stats.dailyActivity.length - 1 ? d.date.slice(5) : ''}</span>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Project Breakdown */}
      {stats.projectBreakdown.length > 0 && (
        <div className="mem-section-card">
          <div className="mem-section-card-header">Projects</div>
          <div className="mem-table-wrapper" style={{ border: 'none', margin: 0 }}>
            <table className="mem-table">
              <thead>
                <tr><th>Project</th><th>Sessions</th><th>Messages</th></tr>
              </thead>
              <tbody>
                {stats.projectBreakdown.map((p, i) => (
                  <tr key={i}>
                    <td style={{ fontWeight: 500 }}>{p.project}</td>
                    <td>{p.sessions}</td>
                    <td>{p.messages}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Recent Sessions */}
      {stats.recentSessions.length > 0 && (
        <div className="mem-section-card">
          <div className="mem-section-card-header">Recent Sessions</div>
          <div className="mem-table-wrapper" style={{ border: 'none', margin: 0 }}>
            <table className="mem-table">
              <thead>
                <tr><th>Project</th><th>Branch</th><th>Branches</th><th>Created</th></tr>
              </thead>
              <tbody>
                {stats.recentSessions.map((s) => (
                  <tr key={s.id} className="clickable" onClick={() => onSessionClick(s.id)}>
                    <td style={{ fontWeight: 500 }}>{s.projectName}</td>
                    <td><span className="mem-tag neutral">{s.gitBranch || '—'}</span></td>
                    <td>{s.branchCount}</td>
                    <td style={{ color: 'var(--mem-text-secondary)' }}>{formatDate(s.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

function StatCard({ label, value, detail }: { label: string; value: string; detail?: string }): React.ReactElement {
  return (
    <div className="mem-stat-card">
      <div className="mem-stat-label">{label}</div>
      <div className="mem-stat-value">{value}</div>
      {detail && <div className="mem-stat-detail">{detail}</div>}
    </div>
  )
}

// ── Session List View ────────────────────────────────────────────────────────

function SessionListView({ adapterId, onSessionClick }: { adapterId?: string; onSessionClick: (id: number) => void }): React.ReactElement {
  const [sessions, setSessions] = useState<MemorySession[]>([])
  const [projects, setProjects] = useState<MemoryProject[]>([])
  const [loading, setLoading] = useState(true)
  const [projectFilter, setProjectFilter] = useState<number | undefined>()
  const [page, setPage] = useState(0)
  const pageSize = 30
  const api = getDockApi()

  useEffect(() => { api.memory.getProjects(adapterId).then(setProjects).catch(() => {}) }, [adapterId])

  useEffect(() => {
    setLoading(true)
    const opts: MemorySessionListOptions = { limit: pageSize, offset: page * pageSize, orderBy: 'recent', projectId: projectFilter }
    api.memory.getSessions(opts, adapterId).then(s => { setSessions(s); setLoading(false) }).catch(() => setLoading(false))
  }, [adapterId, page, projectFilter])

  return (
    <div>
      <h2 className="mem-page-title">Sessions</h2>
      <p className="mem-page-subtitle">Browse all conversation sessions</p>

      <div className="mem-filters">
        <select className="mem-select" value={projectFilter ?? ''} onChange={e => { setProjectFilter(e.target.value ? Number(e.target.value) : undefined); setPage(0) }}>
          <option value="">All projects</option>
          {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>

      {loading ? (
        <div className="mem-loading"><div className="mem-spinner" /> Loading sessions...</div>
      ) : sessions.length === 0 ? (
        <div className="mem-empty"><div className="mem-empty-title">No sessions found</div></div>
      ) : (
        <>
          <div className="mem-table-wrapper">
            <table className="mem-table">
              <thead>
                <tr><th>ID</th><th>Project</th><th>Git Branch</th><th>Branches</th><th>Created</th></tr>
              </thead>
              <tbody>
                {sessions.map(s => (
                  <tr key={s.id} className="clickable" onClick={() => onSessionClick(s.id)}>
                    <td className="mem-mono">{s.id}</td>
                    <td style={{ fontWeight: 500 }}>{s.projectName}</td>
                    <td>{s.gitBranch ? <span className="mem-tag neutral">{s.gitBranch}</span> : '—'}</td>
                    <td><span className="mem-badge">{s.branchCount}</span></td>
                    <td style={{ color: 'var(--mem-text-secondary)' }}>{formatDate(s.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mem-pagination">
            <button className="mem-btn" disabled={page === 0} onClick={() => setPage(p => p - 1)}>Previous</button>
            <span style={{ fontSize: 12, color: 'var(--mem-text-secondary)' }}>Page {page + 1}</span>
            <button className="mem-btn" disabled={sessions.length < pageSize} onClick={() => setPage(p => p + 1)}>Next</button>
          </div>
        </>
      )}
    </div>
  )
}

// ── Session Detail View ──────────────────────────────────────────────────────

function SessionDetailView({ sessionId, adapterId, onBack, onBranchClick }: {
  sessionId: number; adapterId?: string; onBack: () => void; onBranchClick: (id: number) => void
}): React.ReactElement {
  const [session, setSession] = useState<MemorySession | null>(null)
  const [branches, setBranches] = useState<MemoryBranch[]>([])
  const [loading, setLoading] = useState(true)
  const api = getDockApi()

  useEffect(() => {
    setLoading(true)
    Promise.all([
      api.memory.getSession(sessionId, adapterId),
      api.memory.getBranches({ sessionId }, adapterId)
    ]).then(([s, b]) => { setSession(s); setBranches(b); setLoading(false) }).catch(() => setLoading(false))
  }, [sessionId, adapterId])

  if (loading) return <div className="mem-loading"><div className="mem-spinner" /> Loading session...</div>
  if (!session) return <div className="mem-empty"><div className="mem-empty-title">Session not found</div></div>

  return (
    <div>
      <div className="mem-breadcrumb">
        <button className="mem-breadcrumb-link" onClick={onBack}>Sessions</button>
        <span className="mem-breadcrumb-sep" />
        <span>Session #{session.id}</span>
      </div>

      <h2 className="mem-page-title">Session #{session.id}</h2>

      <div className="mem-stats-grid" style={{ marginBottom: 20 }}>
        <StatCard label="Project" value={session.projectName} />
        <StatCard label="Git Branch" value={session.gitBranch || '—'} />
        <StatCard label="Branches" value={String(session.branchCount)} />
        <StatCard label="Created" value={formatDate(session.createdAt)} />
      </div>

      {session.uuid && (
        <div style={{ marginBottom: 16 }}>
          <span style={{ fontSize: 11, color: 'var(--mem-text-muted)' }}>UUID: </span>
          <span className="mem-mono" style={{ fontSize: 11 }}>{session.uuid}</span>
        </div>
      )}

      {/* Branches */}
      <div className="mem-section-card">
        <div className="mem-section-card-header">Branches ({branches.length})</div>
        {branches.length === 0 ? (
          <div className="mem-section-card-body" style={{ color: 'var(--mem-text-muted)' }}>No branches</div>
        ) : (
          <div className="mem-table-wrapper" style={{ border: 'none', margin: 0 }}>
            <table className="mem-table">
              <thead>
                <tr><th>ID</th><th>Status</th><th>Messages</th><th>Exchanges</th><th>Started</th><th>Ended</th></tr>
              </thead>
              <tbody>
                {branches.map(b => (
                  <tr key={b.id} className="clickable" onClick={() => onBranchClick(b.id)}>
                    <td className="mem-mono">{b.id}</td>
                    <td>
                      <span className={`mem-tag ${b.isActive ? 'success' : 'neutral'}`}>
                        {b.isActive ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td>{b.messageCount}</td>
                    <td>{b.exchangeCount}</td>
                    <td style={{ color: 'var(--mem-text-secondary)' }}>{formatDate(b.startedAt)}</td>
                    <td style={{ color: 'var(--mem-text-secondary)' }}>{formatDate(b.endedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Branch List View ─────────────────────────────────────────────────────────

function BranchListView({ adapterId, onBranchClick }: { adapterId?: string; onBranchClick: (id: number) => void }): React.ReactElement {
  const [branches, setBranches] = useState<MemoryBranch[]>([])
  const [loading, setLoading] = useState(true)
  const [activeOnly, setActiveOnly] = useState(false)
  const [page, setPage] = useState(0)
  const pageSize = 30
  const api = getDockApi()

  useEffect(() => {
    setLoading(true)
    const opts: MemoryBranchListOptions = { limit: pageSize, offset: page * pageSize, activeOnly }
    api.memory.getBranches(opts, adapterId).then(b => { setBranches(b); setLoading(false) }).catch(() => setLoading(false))
  }, [adapterId, page, activeOnly])

  return (
    <div>
      <h2 className="mem-page-title">Branches</h2>
      <p className="mem-page-subtitle">Conversation branches with context summaries</p>

      <div className="mem-filters">
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
          <input type="checkbox" checked={activeOnly} onChange={e => { setActiveOnly(e.target.checked); setPage(0) }} />
          Active only
        </label>
      </div>

      {loading ? (
        <div className="mem-loading"><div className="mem-spinner" /> Loading branches...</div>
      ) : branches.length === 0 ? (
        <div className="mem-empty"><div className="mem-empty-title">No branches found</div></div>
      ) : (
        <>
          <div className="mem-table-wrapper">
            <table className="mem-table">
              <thead>
                <tr><th>ID</th><th>Status</th><th>Messages</th><th>Exchanges</th><th>Has Summary</th><th>Started</th></tr>
              </thead>
              <tbody>
                {branches.map(b => (
                  <tr key={b.id} className="clickable" onClick={() => onBranchClick(b.id)}>
                    <td className="mem-mono">{b.id}</td>
                    <td>
                      <span className={`mem-tag ${b.isActive ? 'success' : 'neutral'}`}>
                        {b.isActive ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td>{b.messageCount}</td>
                    <td>{b.exchangeCount}</td>
                    <td>{b.contextSummaryJson ? <span className="mem-tag info">Yes</span> : <span className="mem-tag neutral">No</span>}</td>
                    <td style={{ color: 'var(--mem-text-secondary)' }}>{formatDate(b.startedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mem-pagination">
            <button className="mem-btn" disabled={page === 0} onClick={() => setPage(p => p - 1)}>Previous</button>
            <span style={{ fontSize: 12, color: 'var(--mem-text-secondary)' }}>Page {page + 1}</span>
            <button className="mem-btn" disabled={branches.length < pageSize} onClick={() => setPage(p => p + 1)}>Next</button>
          </div>
        </>
      )}
    </div>
  )
}

// ── Branch Detail View ───────────────────────────────────────────────────────

function BranchDetailView({ branchId, adapterId, onBack }: {
  branchId: number; adapterId?: string; onBack: () => void
}): React.ReactElement {
  const [branch, setBranch] = useState<MemoryBranch | null>(null)
  const [messages, setMessages] = useState<MemoryMessage[]>([])
  const [summary, setSummary] = useState<MemoryContextSummaryParsed | null>(null)
  const [loading, setLoading] = useState(true)
  const [showMessages, setShowMessages] = useState(false)
  const [activeTab, setActiveTab] = useState<'summary' | 'messages' | 'metadata'>('summary')
  const api = getDockApi()

  useEffect(() => {
    setLoading(true)
    Promise.all([
      api.memory.getBranch(branchId, adapterId),
      api.memory.getContextSummary(branchId, adapterId)
    ]).then(([b, s]) => {
      setBranch(b)
      setSummary(s)
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [branchId, adapterId])

  const loadMessages = useCallback(() => {
    setShowMessages(true)
    api.memory.getMessages({ branchId, excludeNotifications: true }, adapterId)
      .then(setMessages).catch(() => {})
  }, [branchId, adapterId])

  if (loading) return <div className="mem-loading"><div className="mem-spinner" /> Loading branch...</div>
  if (!branch) return <div className="mem-empty"><div className="mem-empty-title">Branch not found</div></div>

  const filesModified = parseJsonSafe(branch.filesModified) as string[] | null
  const commits = parseJsonSafe(branch.commits) as string[] | null
  const toolCounts = parseJsonSafe(branch.toolCounts) as Record<string, number> | null

  return (
    <div>
      <div className="mem-breadcrumb">
        <button className="mem-breadcrumb-link" onClick={onBack}>Branches</button>
        <span className="mem-breadcrumb-sep" />
        <span>Branch #{branch.id}</span>
      </div>

      <h2 className="mem-page-title">Branch #{branch.id}</h2>

      <div className="mem-stats-grid" style={{ marginBottom: 20 }}>
        <StatCard label="Status" value={branch.isActive ? 'Active' : 'Inactive'} />
        <StatCard label="Messages" value={String(branch.messageCount)} />
        <StatCard label="Exchanges" value={String(branch.exchangeCount)} />
        <StatCard label="Summary Version" value={String(branch.summaryVersion ?? '—')} />
      </div>

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 2, marginBottom: 16, borderBottom: '1px solid var(--mem-border)' }}>
        {(['summary', 'messages', 'metadata'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => { setActiveTab(tab); if (tab === 'messages' && !showMessages) loadMessages() }}
            style={{
              padding: '8px 16px', border: 'none', background: 'none', cursor: 'pointer',
              color: activeTab === tab ? 'var(--mem-accent)' : 'var(--mem-text-secondary)',
              borderBottom: activeTab === tab ? '2px solid var(--mem-accent)' : '2px solid transparent',
              fontSize: 13, fontWeight: activeTab === tab ? 600 : 400, fontFamily: 'var(--mem-font)'
            }}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      {activeTab === 'summary' && (
        <>
          {summary ? (
            <div className="mem-context-summary">
              <div className="mem-context-header">
                <div className="mem-context-topic">{summary.topic || 'Untitled'}</div>
                <span className={`mem-tag ${summary.disposition === 'COMPLETED' ? 'success' : summary.disposition === 'IN_PROGRESS' ? 'warning' : 'neutral'}`}>
                  {summary.disposition}
                </span>
              </div>

              <div className="mem-context-meta">
                <span>{summary.metadata.exchangeCount} exchanges</span>
                {summary.metadata.gitBranch && <span>Branch: {summary.metadata.gitBranch}</span>}
                <span>{formatDate(summary.metadata.startedAt)} — {formatDate(summary.metadata.endedAt)}</span>
              </div>

              {summary.markers.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--mem-text-muted)', marginBottom: 4 }}>SIGNALS</div>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {summary.markers.map((m, i) => <span key={i} className="mem-tag accent">{m}</span>)}
                  </div>
                </div>
              )}

              {summary.firstExchanges.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--mem-text-muted)', marginBottom: 6 }}>FIRST EXCHANGES</div>
                  {summary.firstExchanges.map((ex, i) => (
                    <div key={i} className="mem-exchange">
                      <div className="mem-exchange-label">User</div>
                      <div>{truncate(ex.user, 500)}</div>
                      {ex.assistant && (
                        <>
                          <div className="mem-exchange-label" style={{ marginTop: 6 }}>Assistant</div>
                          <div>{truncate(ex.assistant, 300)}</div>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {summary.lastExchanges.length > 0 && (
                <div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--mem-text-muted)', marginBottom: 6 }}>LAST EXCHANGES</div>
                  {summary.lastExchanges.map((ex, i) => (
                    <div key={i} className="mem-exchange">
                      <div className="mem-exchange-label">User</div>
                      <div>{truncate(ex.user, 500)}</div>
                      {ex.assistant && (
                        <>
                          <div className="mem-exchange-label" style={{ marginTop: 6 }}>Assistant</div>
                          <div>{truncate(ex.assistant, 300)}</div>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="mem-empty" style={{ padding: '30px 20px' }}>
              <div className="mem-empty-title">No context summary</div>
              <div className="mem-empty-desc">This branch does not have a cached context summary.</div>
            </div>
          )}

          {/* Raw context_summary markdown */}
          {branch.contextSummary && (
            <div className="mem-section-card" style={{ marginTop: 16 }}>
              <div className="mem-section-card-header">Rendered Injection (Markdown)</div>
              <div className="mem-section-card-body">
                <div className="mem-code-block">{branch.contextSummary}</div>
              </div>
            </div>
          )}
        </>
      )}

      {activeTab === 'messages' && (
        <>
          {!showMessages ? (
            <div style={{ textAlign: 'center', padding: 20 }}>
              <button className="mem-btn primary" onClick={loadMessages}>Load Messages</button>
            </div>
          ) : messages.length === 0 ? (
            <div className="mem-empty" style={{ padding: '30px 20px' }}><div className="mem-empty-title">No messages</div></div>
          ) : (
            <div>
              <div style={{ fontSize: 12, color: 'var(--mem-text-muted)', marginBottom: 12 }}>{messages.length} messages</div>
              {messages.map(m => (
                <div key={m.id} className={`mem-message ${m.role}`}>
                  <div className="mem-message-header">
                    <span className="mem-message-role">{m.role}</span>
                    <span>{formatDate(m.timestamp)}</span>
                    {m.hasToolUse && <span className="mem-tag info" style={{ fontSize: 10 }}>Tools</span>}
                    {m.hasThinking && <span className="mem-tag accent" style={{ fontSize: 10 }}>Thinking</span>}
                  </div>
                  <div className="mem-message-content">{truncate(m.content, 2000)}</div>
                  {m.toolSummary && (
                    <div className="mem-message-tags" style={{ marginTop: 6 }}>
                      <span className="mem-tag neutral" style={{ fontSize: 10 }}>{truncate(m.toolSummary, 100)}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {activeTab === 'metadata' && (
        <div>
          <div className="mem-stats-grid">
            <StatCard label="Started" value={formatDate(branch.startedAt)} />
            <StatCard label="Ended" value={formatDate(branch.endedAt)} />
          </div>

          {filesModified && filesModified.length > 0 && (
            <div className="mem-section-card">
              <div className="mem-section-card-header">Files Modified ({filesModified.length})</div>
              <div className="mem-section-card-body">
                {filesModified.map((f, i) => (
                  <div key={i} className="mem-mono" style={{ padding: '2px 0', fontSize: 12 }}>{f}</div>
                ))}
              </div>
            </div>
          )}

          {commits && commits.length > 0 && (
            <div className="mem-section-card">
              <div className="mem-section-card-header">Commits ({commits.length})</div>
              <div className="mem-section-card-body">
                {commits.map((c, i) => (
                  <div key={i} className="mem-mono" style={{ padding: '2px 0', fontSize: 12 }}>{c}</div>
                ))}
              </div>
            </div>
          )}

          {toolCounts && Object.keys(toolCounts).length > 0 && (
            <div className="mem-section-card">
              <div className="mem-section-card-header">Tool Usage</div>
              <div className="mem-table-wrapper" style={{ border: 'none', margin: 0 }}>
                <table className="mem-table">
                  <thead><tr><th>Tool</th><th>Count</th></tr></thead>
                  <tbody>
                    {Object.entries(toolCounts).sort((a, b) => b[1] - a[1]).map(([tool, count]) => (
                      <tr key={tool}>
                        <td className="mem-mono">{tool}</td>
                        <td>{count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Raw JSON dump */}
          {branch.contextSummaryJson && (
            <div className="mem-section-card">
              <div className="mem-section-card-header">Raw Context Summary JSON</div>
              <div className="mem-section-card-body">
                <div className="mem-code-block">
                  {JSON.stringify(JSON.parse(branch.contextSummaryJson), null, 2)}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Search View ──────────────────────────────────────────────────────────────

function SearchView({ adapterId, onBranchClick, onSessionClick }: {
  adapterId?: string; onBranchClick: (id: number) => void; onSessionClick: (id: number) => void
}): React.ReactElement {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<MemorySearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [searched, setSearched] = useState(false)
  const api = getDockApi()

  const doSearch = useCallback(() => {
    if (!query.trim()) return
    setLoading(true)
    setSearched(true)
    api.memory.search({ query: query.trim(), limit: 30 }, adapterId)
      .then(r => { setResults(r); setLoading(false) })
      .catch(() => setLoading(false))
  }, [query, adapterId])

  return (
    <div>
      <h2 className="mem-page-title">Search</h2>
      <p className="mem-page-subtitle">Full-text search across all conversation branches</p>

      <div className="mem-search-bar">
        <input
          className="mem-search-input"
          placeholder="Search conversations..."
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') doSearch() }}
        />
        <button className="mem-btn primary" onClick={doSearch} disabled={loading || !query.trim()}>
          {loading ? 'Searching...' : 'Search'}
        </button>
      </div>

      {loading ? (
        <div className="mem-loading"><div className="mem-spinner" /> Searching...</div>
      ) : results.length === 0 && searched ? (
        <div className="mem-empty" style={{ padding: '30px 20px' }}>
          <div className="mem-empty-title">No results</div>
          <div className="mem-empty-desc">Try different search terms</div>
        </div>
      ) : results.length > 0 ? (
        <div>
          <div style={{ fontSize: 12, color: 'var(--mem-text-muted)', marginBottom: 12 }}>{results.length} results</div>
          {results.map((r, i) => (
            <div key={i} className="mem-section-card" style={{ cursor: 'pointer', marginBottom: 10 }} onClick={() => onBranchClick(r.branchId)}>
              <div className="mem-section-card-body" style={{ padding: '12px 16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <span style={{ fontWeight: 600, fontSize: 13 }}>{r.projectName}</span>
                  {r.gitBranch && <span className="mem-tag neutral">{r.gitBranch}</span>}
                  <span style={{ fontSize: 11, color: 'var(--mem-text-muted)', marginLeft: 'auto' }}>{formatDate(r.startedAt)}</span>
                </div>
                <div
                  style={{ fontSize: 12, color: 'var(--mem-text-secondary)', lineHeight: 1.4 }}
                  dangerouslySetInnerHTML={{ __html: r.snippet }}
                />
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

// ── Token View ───────────────────────────────────────────────────────────────

function TokenView({ adapterId }: { adapterId?: string }): React.ReactElement {
  const [snapshots, setSnapshots] = useState<MemoryTokenSnapshot[]>([])
  const [loading, setLoading] = useState(true)
  const api = getDockApi()

  useEffect(() => {
    setLoading(true)
    api.memory.getTokenSnapshots(undefined, adapterId)
      .then(s => { setSnapshots(s); setLoading(false) })
      .catch(() => setLoading(false))
  }, [adapterId])

  if (loading) return <div className="mem-loading"><div className="mem-spinner" /> Loading token data...</div>
  if (snapshots.length === 0) {
    return (
      <div>
        <h2 className="mem-page-title">Token Usage</h2>
        <div className="mem-empty">
          <div className="mem-empty-title">No token data</div>
          <div className="mem-empty-desc">Token snapshots will appear here once Claudest records usage data.</div>
        </div>
      </div>
    )
  }

  const totals = snapshots.reduce((acc, s) => ({
    input: acc.input + s.inputTokens,
    output: acc.output + s.outputTokens,
    cacheRead: acc.cacheRead + s.cacheReadTokens,
    cacheCreation: acc.cacheCreation + s.cacheCreationTokens,
    tools: acc.tools + s.toolUseCount,
    duration: acc.duration + s.duration,
    lines: acc.lines + s.linesModified
  }), { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, tools: 0, duration: 0, lines: 0 })

  return (
    <div>
      <h2 className="mem-page-title">Token Usage</h2>
      <p className="mem-page-subtitle">Aggregated token spending across sessions</p>

      <div className="mem-stats-grid">
        <StatCard label="Input Tokens" value={formatNumber(totals.input)} />
        <StatCard label="Output Tokens" value={formatNumber(totals.output)} />
        <StatCard label="Cache Read" value={formatNumber(totals.cacheRead)} />
        <StatCard label="Cache Creation" value={formatNumber(totals.cacheCreation)} />
        <StatCard label="Tool Uses" value={formatNumber(totals.tools)} />
        <StatCard label="Total Duration" value={formatDuration(totals.duration)} />
        <StatCard label="Lines Modified" value={formatNumber(totals.lines)} />
        <StatCard label="Snapshots" value={String(snapshots.length)} />
      </div>

      <div className="mem-table-wrapper">
        <table className="mem-table">
          <thead>
            <tr><th>Session</th><th>Input</th><th>Output</th><th>Cache</th><th>Tools</th><th>Duration</th><th>Lines</th><th>Time</th></tr>
          </thead>
          <tbody>
            {snapshots.slice(0, 100).map(s => (
              <tr key={s.id}>
                <td className="mem-mono" style={{ fontSize: 11 }}>{s.sessionUuid.slice(0, 8)}</td>
                <td>{formatNumber(s.inputTokens)}</td>
                <td>{formatNumber(s.outputTokens)}</td>
                <td>{formatNumber(s.cacheReadTokens)}</td>
                <td>{s.toolUseCount}</td>
                <td>{formatDuration(s.duration)}</td>
                <td>{s.linesModified}</td>
                <td style={{ color: 'var(--mem-text-secondary)', fontSize: 11 }}>{formatDate(s.timestamp)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Database View ────────────────────────────────────────────────────────────

function DatabaseView({ adapterId }: { adapterId?: string }): React.ReactElement {
  const [dbInfo, setDbInfo] = useState<{ path: string; sizeBytes: number; tables: { name: string; rowCount: number }[]; walSizeBytes: number } | null>(null)
  const [importLog, setImportLog] = useState<MemoryImportLogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const api = getDockApi()

  useEffect(() => {
    setLoading(true)
    Promise.all([
      api.memory.getDbInfo(adapterId),
      api.memory.getImportLog(adapterId)
    ]).then(([db, log]) => { setDbInfo(db); setImportLog(log); setLoading(false) }).catch(() => setLoading(false))
  }, [adapterId])

  if (loading) return <div className="mem-loading"><div className="mem-spinner" /> Loading database info...</div>

  return (
    <div>
      <h2 className="mem-page-title">Database</h2>
      <p className="mem-page-subtitle">Raw database information and import history</p>

      {dbInfo ? (
        <>
          <div className="mem-stats-grid">
            <StatCard label="Database Size" value={formatBytes(dbInfo.sizeBytes)} />
            <StatCard label="WAL Size" value={formatBytes(dbInfo.walSizeBytes)} />
            <StatCard label="Tables" value={String(dbInfo.tables.length)} />
          </div>

          <div style={{ marginBottom: 16 }}>
            <span style={{ fontSize: 11, color: 'var(--mem-text-muted)' }}>Path: </span>
            <span className="mem-mono" style={{ fontSize: 11 }}>{dbInfo.path}</span>
          </div>

          <div className="mem-section-card">
            <div className="mem-section-card-header">Tables</div>
            <div className="mem-table-wrapper" style={{ border: 'none', margin: 0 }}>
              <table className="mem-table">
                <thead><tr><th>Table</th><th>Rows</th></tr></thead>
                <tbody>
                  {dbInfo.tables.map(t => (
                    <tr key={t.name}>
                      <td className="mem-mono">{t.name}</td>
                      <td>{t.rowCount >= 0 ? formatNumber(t.rowCount) : 'Error'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : (
        <div className="mem-empty" style={{ padding: '30px 20px' }}>
          <div className="mem-empty-title">Database not accessible</div>
        </div>
      )}

      {/* Import Log */}
      {importLog.length > 0 && (
        <div className="mem-section-card">
          <div className="mem-section-card-header">Import Log ({importLog.length})</div>
          <div className="mem-table-wrapper" style={{ border: 'none', margin: 0 }}>
            <table className="mem-table">
              <thead><tr><th>File</th><th>Messages</th><th>Imported</th></tr></thead>
              <tbody>
                {importLog.map(e => (
                  <tr key={e.id}>
                    <td className="mem-mono" style={{ fontSize: 11, maxWidth: 400, overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.path}</td>
                    <td>{e.messageCount}</td>
                    <td style={{ color: 'var(--mem-text-secondary)' }}>{formatDate(e.importedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Adapters View ────────────────────────────────────────────────────────────

function AdaptersView({ adapters, onRefresh }: { adapters: MemoryAdapterInfo[]; onRefresh: () => void }): React.ReactElement {
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [actionResult, setActionResult] = useState<{ adapterId: string; success: boolean; message: string } | null>(null)
  const api = getDockApi()

  const handleEnable = useCallback(async (adapterId: string, enabled: boolean) => {
    setActionLoading(adapterId)
    setActionResult(null)
    try {
      const result = await api.memory.setAdapterEnabled(adapterId, enabled)
      setActionResult({ adapterId, success: result.success, message: enabled ? 'Enabled' : 'Disabled' })
      onRefresh()
    } catch (err) {
      setActionResult({ adapterId, success: false, message: String(err) })
    }
    setActionLoading(null)
  }, [onRefresh])

  const handleInstall = useCallback(async (adapterId: string) => {
    setActionLoading(adapterId)
    setActionResult(null)
    try {
      const result = await api.memory.installAdapter(adapterId)
      setActionResult({
        adapterId,
        success: result.success,
        message: result.success ? 'Installation complete. You may need to run a Claude session to create the memory database.' : `Install failed: ${result.error}`
      })
      onRefresh()
    } catch (err) {
      setActionResult({ adapterId, success: false, message: `Install error: ${err}` })
    }
    setActionLoading(null)
  }, [onRefresh])

  const handleUninstall = useCallback(async (adapterId: string) => {
    setActionLoading(adapterId)
    setActionResult(null)
    try {
      const result = await api.memory.uninstallAdapter(adapterId)
      setActionResult({
        adapterId,
        success: result.success,
        message: result.success ? 'Uninstalled. The conversation database at ~/.claude-memory/ is preserved.' : `Uninstall failed: ${result.error}`
      })
      onRefresh()
    } catch (err) {
      setActionResult({ adapterId, success: false, message: `Uninstall error: ${err}` })
    }
    setActionLoading(null)
  }, [onRefresh])

  return (
    <div>
      <h2 className="mem-page-title">Memory Adapters</h2>
      <p className="mem-page-subtitle">Manage installed memory tool integrations</p>

      <div style={{ marginBottom: 16 }}>
        <button className="mem-btn" onClick={onRefresh}>Refresh</button>
      </div>

      {adapters.length === 0 ? (
        <div className="mem-empty">
          <div className="mem-empty-title">No adapters registered</div>
        </div>
      ) : (
        adapters.map(a => (
          <div key={a.id} className="mem-section-card" style={{ marginBottom: 12 }}>
            <div className="mem-section-card-body">
              {/* Header */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 600 }}>{a.name}</div>
                  <div style={{ fontSize: 12, color: 'var(--mem-text-secondary)' }}>v{a.version}</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className={`mem-status-dot ${a.installed && a.enabled ? 'connected' : a.installed ? 'error' : 'disconnected'}`} />
                  <span className={`mem-tag ${a.installed && a.hasData ? (a.enabled ? 'success' : 'warning') : a.installed ? 'info' : 'neutral'}`}>
                    {!a.installed ? 'Not Installed' : !a.hasData ? 'No Data' : a.enabled ? 'Active' : 'Disabled'}
                  </span>
                </div>
              </div>

              <div style={{ fontSize: 13, color: 'var(--mem-text-secondary)', marginBottom: 10 }}>{a.description}</div>

              {/* How it works */}
              {a.id === 'claudest' && (
                <div style={{ fontSize: 12, color: 'var(--mem-text-muted)', marginBottom: 10, padding: '8px 10px', background: 'var(--mem-bg-elevated)', borderRadius: 6, lineHeight: 1.5 }}>
                  <strong style={{ color: 'var(--mem-text-secondary)' }}>How it works:</strong> Claudest hooks into Claude Code as a plugin. After each session, it stores conversation summaries and context in a local SQLite database.
                  At the start of a new session, it automatically injects relevant past context — so Claude remembers your project decisions, coding patterns, and prior discussions without you needing to re-explain them.
                </div>
              )}

              {/* Status details */}
              <div style={{ fontSize: 12, color: 'var(--mem-text-muted)', marginBottom: 10 }}>
                <div style={{ marginBottom: 2 }}>Status: {a.statusMessage}</div>
                {a.storePath && <div className="mem-mono" style={{ marginBottom: 2 }}>Database: {a.storePath}</div>}
                {a.pluginDir && <div className="mem-mono" style={{ marginBottom: 2 }}>Plugin: {a.pluginDir}</div>}
              </div>

              {/* Action buttons */}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--mem-border-subtle)' }}>
                {a.installed ? (
                  <>
                    {a.hasData && (
                      <button
                        className={`mem-btn ${a.enabled ? '' : 'primary'}`}
                        disabled={actionLoading === a.id}
                        onClick={() => handleEnable(a.id, !a.enabled)}
                      >
                        {actionLoading === a.id ? 'Working...' : a.enabled ? 'Disable' : 'Enable'}
                      </button>
                    )}
                    <button
                      className="mem-btn"
                      disabled={actionLoading === a.id}
                      onClick={() => handleUninstall(a.id)}
                      style={{ color: 'var(--mem-error)' }}
                    >
                      {actionLoading === a.id ? 'Working...' : 'Uninstall'}
                    </button>
                  </>
                ) : (
                  <>
                    {a.canAutoInstall && (
                      <button
                        className="mem-btn primary"
                        disabled={actionLoading === a.id}
                        onClick={() => handleInstall(a.id)}
                      >
                        {actionLoading === a.id ? 'Installing...' : 'Install'}
                      </button>
                    )}
                  </>
                )}
              </div>

              {/* Install commands (shown when not installed) */}
              {!a.installed && a.installCommands.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--mem-text-muted)', marginBottom: 6 }}>MANUAL INSTALL</div>
                  <div className="mem-code-block" style={{ fontSize: 11, padding: '8px 12px' }}>
                    {a.installCommands.map((cmd, i) => (
                      <div key={i}>{cmd}</div>
                    ))}
                  </div>
                </div>
              )}

              {/* Action result feedback */}
              {actionResult && actionResult.adapterId === a.id && (
                <div
                  className={`mem-tag ${actionResult.success ? 'success' : 'error'}`}
                  style={{ marginTop: 10, padding: '6px 10px', fontSize: 12, display: 'block' }}
                >
                  {actionResult.message}
                </div>
              )}

              {/* Available sections */}
              {a.sections.length > 0 && (
                <div style={{ marginTop: 10, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {a.sections.map(s => <span key={s.id} className="mem-tag neutral">{s.label}</span>)}
                </div>
              )}
            </div>
          </div>
        ))
      )}
    </div>
  )
}
