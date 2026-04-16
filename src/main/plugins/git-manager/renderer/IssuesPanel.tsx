import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { marked } from 'marked'
import { getDockApi } from '../../../../renderer/src/lib/ipc-bridge'
import type {
  Issue,
  IssueState,
  IssueComment,
  IssueLabel,
  IssueUser,
  IssueMilestone,
  IssueStatus,
  IssueStatusCapability,
  IssueUpdateRequest,
  IssueTypeProfiles,
  IssueTypeProfile,
  IssueBehavior
} from '../../../../shared/issue-types'
import type { CiSetupStatus } from '../../../../shared/ci-types'

interface IssuesPanelProps {
  /** The repo currently being viewed in git-manager (may be a submodule of rootProjectDir). */
  projectDir: string
  /** The dock's top-level root project — same as projectDir unless the user has navigated into a submodule. */
  rootProjectDir: string
  active?: boolean
}

type PanelStatus = 'loading' | 'setup' | 'ready' | 'error'
type ViewMode = 'list' | 'split' | 'full'

// Session-level availability cache (matches PrPanel pattern)
const issueAvailabilityCache = new Map<string, { available: boolean; providerKey?: string }>()

function formatTime(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffMin = Math.floor(diffMs / 60_000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.floor(diffHr / 24)
  if (diffDay < 7) return `${diffDay}d ago`
  return d.toLocaleDateString()
}

function renderMarkdown(body: string): string {
  if (!body) return '<p class="gm-issue-empty-body">(no description)</p>'
  try {
    return marked.parse(body, { breaks: true }) as string
  } catch {
    // Fall back to plaintext wrapped in <pre>
    const escaped = body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    return `<pre>${escaped}</pre>`
  }
}

/** Pick black or white text for a given hex color by luminance. */
function pickContrastTextColor(hex?: string): string {
  if (!hex) return '#fff'
  const h = hex.replace(/^#/, '')
  if (h.length !== 6) return '#fff'
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  // Relative luminance per WCAG
  const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
  return l > 0.55 ? '#111' : '#fff'
}

// ============================================================================
// Main Panel
// ============================================================================

export default function IssuesPanel({ projectDir, rootProjectDir, active }: IssuesPanelProps) {
  const api = getDockApi()

  // Whether the current view is a submodule (i.e. activeDir differs from the dock's root).
  const isSubmodule = projectDir !== rootProjectDir

  // Mode state — for submodules, `useParent=true` means the Issues tab operates against
  // the parent repo's tracker instead of the submodule's own. For non-submodule views
  // this is always false and the banner is never shown.
  const [useParent, setUseParent] = useState(false)
  const [parentSettingLoaded, setParentSettingLoaded] = useState(false)

  // Load the parent's setting to determine the default mode when we're in a submodule
  useEffect(() => {
    if (!isSubmodule) {
      setParentSettingLoaded(true)
      setUseParent(false)
      return
    }
    let cancelled = false
    api.plugins.getSetting(rootProjectDir, 'git-manager', 'forceParentIssueTracker')
      .then((v) => {
        if (cancelled) return
        setUseParent(v === true)
        setParentSettingLoaded(true)
      })
      .catch(() => {
        if (cancelled) return
        setParentSettingLoaded(true)
      })
    return () => { cancelled = true }
  }, [isSubmodule, rootProjectDir])

  // The projectDir that all issue IPC calls use. Switches at runtime when the user
  // toggles the banner.
  const effectiveProjectDir = useParent ? rootProjectDir : projectDir

  const [status, setStatus] = useState<PanelStatus>('loading')
  const [errorMsg, setErrorMsg] = useState('')
  const [setup, setSetup] = useState<CiSetupStatus | null>(null)

  const [issues, setIssues] = useState<Issue[]>([])
  const [filter, setFilter] = useState<IssueState | 'all'>('open')
  const [searchText, setSearchText] = useState('')
  const [loading, setLoading] = useState(false)
  const [statusCapability, setStatusCapability] = useState<IssueStatusCapability | null>(null)
  const [availableStatuses, setAvailableStatuses] = useState<IssueStatus[]>([])
  const [statusFilter, setStatusFilter] = useState<string | null>(null)
  const [createdByMeOnly, setCreatedByMeOnly] = useState(false)
  const [assignedToMeOnly, setAssignedToMeOnly] = useState(false)

  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>('list')
  const [selectedIssue, setSelectedIssue] = useState<Issue | null>(null)
  const [selectedLoading, setSelectedLoading] = useState(false)

  const [currentUser, setCurrentUser] = useState<IssueUser | null>(null)
  const [providerKey, setProviderKey] = useState<'github' | 'gitlab' | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [showProfiles, setShowProfiles] = useState(false)

  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const detailPaneRef = useRef<HTMLDivElement | null>(null)

  // Check availability on mount / effective-project change.
  // We intentionally delay until the parent setting has loaded so the first fetch goes
  // to the correct target and we don't briefly query the wrong repo.
  useEffect(() => {
    if (!parentSettingLoaded) return
    let cancelled = false
    async function init() {
      setStatus('loading')
      setIssues([])
      setSelectedId(null)
      setViewMode('list')

      const cached = issueAvailabilityCache.get(effectiveProjectDir)
      if (cached) {
        if (!cached.available) {
          const s = await api.issues.getSetupStatus(effectiveProjectDir)
          if (cancelled) return
          setSetup(s)
          setStatus(s.ready ? 'ready' : 'setup')
          if (s.ready && cached.providerKey) setProviderKey(cached.providerKey as 'github' | 'gitlab')
          return
        }
        setProviderKey((cached.providerKey as 'github' | 'gitlab') || null)
        setStatus('ready')
        return
      }

      try {
        const result = await api.issues.checkAvailable(effectiveProjectDir)
        if (cancelled) return
        if (!result) {
          issueAvailabilityCache.set(effectiveProjectDir, { available: false })
          const s = await api.issues.getSetupStatus(effectiveProjectDir)
          if (cancelled) return
          setSetup(s)
          setStatus(s.ready ? 'ready' : 'setup')
          return
        }
        issueAvailabilityCache.set(effectiveProjectDir, { available: true, providerKey: result })
        setProviderKey(result as 'github' | 'gitlab')
        setStatus('ready')
      } catch (err) {
        if (cancelled) return
        console.warn('[issues] availability check failed:', err)
        setStatus('error')
        setErrorMsg(err instanceof Error ? err.message : 'Failed to check issue availability')
      }
    }
    init()
    return () => { cancelled = true }
  }, [effectiveProjectDir, parentSettingLoaded])

  // Fetch current user once we're ready
  useEffect(() => {
    if (status !== 'ready') return
    let cancelled = false
    api.issues.getCurrentUser(effectiveProjectDir).then((u) => {
      if (!cancelled) setCurrentUser(u)
    }).catch((err) => {
      console.warn('[issues] getCurrentUser failed:', err)
    })
    return () => { cancelled = true }
  }, [status, effectiveProjectDir])

  // Probe status capability + load available statuses for the filter dropdown.
  // Both calls are cached server-side so this is cheap on subsequent panel mounts.
  useEffect(() => {
    if (status !== 'ready') return
    let cancelled = false
    setStatusCapability(null)
    setAvailableStatuses([])
    api.issues.getStatusCapability(effectiveProjectDir).then(async (cap) => {
      if (cancelled) return
      setStatusCapability(cap)
      if (!cap.supported) return
      try {
        const list = await api.issues.listStatuses(effectiveProjectDir)
        if (!cancelled) setAvailableStatuses(list)
      } catch (err) {
        console.warn('[issues] listStatuses failed:', err)
      }
    }).catch((err) => {
      console.warn('[issues] getStatusCapability failed:', err)
      if (!cancelled) setStatusCapability({ supported: false })
    })
    return () => { cancelled = true }
  }, [status, effectiveProjectDir])

  // Reset the secondary filters when the underlying repo changes — they don't
  // make sense across project boundaries (status ids are provider-opaque, and
  // user-scoped filters depend on the current user for that provider).
  useEffect(() => {
    setStatusFilter(null)
    setCreatedByMeOnly(false)
    setAssignedToMeOnly(false)
  }, [effectiveProjectDir])

  const loadIssues = useCallback(async () => {
    if (status !== 'ready') return
    setLoading(true)
    try {
      const state = filter === 'all' ? 'all' : filter
      const result = await api.issues.list(effectiveProjectDir, state)
      setIssues(result)
    } catch (err) {
      console.warn('[issues] list failed:', err)
    }
    setLoading(false)
  }, [status, filter, effectiveProjectDir])

  useEffect(() => {
    loadIssues()
  }, [loadIssues])

  // Escape closes the detail panel (or exits full view first)
  useEffect(() => {
    if (!active || status !== 'ready') return
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Don't steal Escape from modals / popovers
      if (document.querySelector('.modal-overlay')) return
      if (viewMode === 'full') {
        e.stopPropagation()
        setViewMode('split')
      } else if (selectedId != null) {
        e.stopPropagation()
        setSelectedId(null)
        setViewMode('list')
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [active, status, viewMode, selectedId])

  // Start / stop polling when tab becomes active
  useEffect(() => {
    if (!active || status !== 'ready') return
    api.issues.startPolling(effectiveProjectDir).catch((err) => {
      console.warn('[issues] startPolling failed:', err)
    })
    const poll = () => {
      pollTimerRef.current = setTimeout(async () => {
        await loadIssues()
        if (selectedId != null) await refreshSelected(selectedId)
        poll()
      }, 120_000)
    }
    poll()
    return () => {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current)
      api.issues.stopPolling(effectiveProjectDir).catch(() => { /* ok */ })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, status, loadIssues, effectiveProjectDir])

  // Load full issue when selection changes
  const refreshSelected = useCallback(async (id: number) => {
    setSelectedLoading(true)
    try {
      const fresh = await api.issues.get(effectiveProjectDir, id)
      setSelectedIssue(fresh)
    } catch (err) {
      console.warn('[issues] get failed:', err)
    }
    setSelectedLoading(false)
  }, [effectiveProjectDir])

  useEffect(() => {
    if (selectedId == null) {
      setSelectedIssue(null)
      return
    }
    refreshSelected(selectedId)
  }, [selectedId, refreshSelected])

  const openIssue = (id: number) => {
    setSelectedId(id)
    setViewMode('split')
  }

  const closeDetail = () => {
    setSelectedId(null)
    setViewMode('list')
  }

  const enterFull = () => setViewMode('full')
  const exitFull = () => setViewMode('split')

  // Filtered list — applies the secondary filters on top of the
  // server-side state filter (open/closed/all). Created/Assigned are
  // independent ANDs (matching GitHub/GitLab convention), so enabling
  // both narrows to issues you opened AND that are assigned to you.
  const filtered = useMemo(() => {
    let result = issues
    if (createdByMeOnly && currentUser) {
      const me = currentUser.login
      result = result.filter((i) => i.author.login === me)
    }
    if (assignedToMeOnly && currentUser) {
      const me = currentUser.login
      result = result.filter((i) => i.assignees.some((a) => a.login === me))
    }
    if (statusFilter) {
      result = result.filter((i) => i.status?.id === statusFilter)
    }
    const q = searchText.trim().toLowerCase()
    if (q) {
      result = result.filter((i) =>
        i.title.toLowerCase().includes(q) ||
        String(i.id).includes(q) ||
        i.labels.some((l) => l.name.toLowerCase().includes(q)) ||
        i.assignees.some((a) => a.login.toLowerCase().includes(q))
      )
    }
    return result
  }, [issues, searchText, statusFilter, createdByMeOnly, assignedToMeOnly, currentUser])

  // -----------------------------------------------------------------------
  // Render

  if (status === 'loading') {
    return <div className="gm-issues-panel"><div className="gm-loading">Loading...</div></div>
  }

  if (status === 'error') {
    return (
      <div className="gm-issues-panel">
        {isSubmodule && (
          <ParentModeBanner
            useParent={useParent}
            onToggle={() => setUseParent((v) => !v)}
            rootProjectDir={rootProjectDir}
            projectDir={projectDir}
          />
        )}
        <div className="gm-loading">{errorMsg || 'Error'}</div>
        <button className="gm-small-btn" onClick={() => { issueAvailabilityCache.delete(effectiveProjectDir); setStatus('loading') }}>
          Retry
        </button>
      </div>
    )
  }

  if (status === 'setup' && setup) {
    return (
      <div className="gm-issues-panel gm-issues-setup-wrap">
        {isSubmodule && (
          <ParentModeBanner
            useParent={useParent}
            onToggle={() => setUseParent((v) => !v)}
            rootProjectDir={rootProjectDir}
            projectDir={projectDir}
          />
        )}
        <div className="gm-pr-setup">
          <div className="gm-pr-setup-title">Setup Required</div>
          <div className="gm-pr-setup-provider">{setup.providerName}</div>
          {setup.steps.map((step) => (
            <div key={step.id} className={`gm-pr-setup-step gm-pr-setup-step-${step.status}`}>
              <span className="gm-pr-setup-icon">{step.status === 'ok' ? '\u2713' : '\u25CB'}</span>
              <span>{step.label}</span>
              {step.status === 'missing' && step.helpText && (
                <div className="gm-pr-setup-help">{step.helpText}</div>
              )}
              {step.status === 'missing' && step.actionId && (
                <button
                  className="gm-small-btn"
                  onClick={async () => {
                    await api.issues.runSetupAction(effectiveProjectDir, step.actionId!)
                  }}
                >
                  {step.actionLabel || 'Run'}
                </button>
              )}
            </div>
          ))}
          <button className="gm-small-btn" onClick={async () => {
            issueAvailabilityCache.delete(effectiveProjectDir)
            const s = await api.issues.getSetupStatus(effectiveProjectDir)
            setSetup(s)
            if (s.ready) setStatus('ready')
          }}>Recheck</button>
        </div>
      </div>
    )
  }

  const showList = viewMode !== 'full'
  const showDetail = viewMode !== 'list' && selectedId != null

  return (
    <div className={`gm-issues-panel gm-issues-view-${viewMode}`}>
      {isSubmodule && (
        <ParentModeBanner
          useParent={useParent}
          onToggle={() => setUseParent((v) => !v)}
          rootProjectDir={rootProjectDir}
          projectDir={projectDir}
        />
      )}
      <div className="gm-issues-body">
        {showList && (
          <div className="gm-issues-list-wrap">
            <div className="gm-issues-header">
              <div className="gm-pr-filters">
                {(['open', 'closed', 'all'] as const).map((f) => (
                  <button
                    key={f}
                    className={`gm-pr-filter${filter === f ? ' gm-pr-filter-active' : ''}`}
                    onClick={() => setFilter(f)}
                  >
                    {f.charAt(0).toUpperCase() + f.slice(1)}
                  </button>
                ))}
                {currentUser && (
                  <>
                    <button
                      className={`gm-pr-filter${createdByMeOnly ? ' gm-pr-filter-active' : ''}`}
                      onClick={() => setCreatedByMeOnly((v) => !v)}
                      title={`Show only issues opened by @${currentUser.login}`}
                    >
                      Created
                    </button>
                    <button
                      className={`gm-pr-filter${assignedToMeOnly ? ' gm-pr-filter-active' : ''}`}
                      onClick={() => setAssignedToMeOnly((v) => !v)}
                      title={`Show only issues assigned to @${currentUser.login}`}
                    >
                      Assigned
                    </button>
                  </>
                )}
              </div>
              {statusCapability?.supported && availableStatuses.length > 0 && (
                <select
                  className="gm-issues-status-select"
                  value={statusFilter ?? ''}
                  onChange={(e) => setStatusFilter(e.target.value || null)}
                  title="Filter by status"
                >
                  <option value="">All statuses</option>
                  {availableStatuses.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              )}
              <input
                type="text"
                className="gm-issues-search"
                placeholder="Search issues..."
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
              />
              <div className="gm-pr-header-right">
                <button className="gm-small-btn" onClick={loadIssues} disabled={loading} title="Refresh">
                  {loading ? '…' : '\u21BB'}
                </button>
                <button className="gm-small-btn" onClick={() => setShowProfiles(true)} title="Configure Claude behavior profiles">
                  Profiles
                </button>
                <button className="gm-small-btn gm-pr-create-btn" onClick={() => setShowCreate(true)}>
                  + New Issue
                </button>
              </div>
            </div>

            <IssueList
              issues={filtered}
              selectedId={selectedId}
              onSelect={openIssue}
              loading={loading}
            />
          </div>
        )}

        {showDetail && selectedId != null && (
          <>
            {viewMode === 'split' && (
              <IssueResizeHandle
                targetRef={detailPaneRef}
                min={320}
                max={900}
                storageKey="gm-issue-detail-width"
              />
            )}
            <div
              className={`gm-issue-detail-pane gm-issue-detail-pane--${viewMode}`}
              ref={detailPaneRef}
            >
              <IssueDetailPanel
                key={`${effectiveProjectDir}:${selectedId}`}
                projectDir={effectiveProjectDir}
                issueId={selectedId}
                issue={selectedIssue}
                loading={selectedLoading}
                viewMode={viewMode}
                onClose={closeDetail}
                onEnterFull={enterFull}
                onExitFull={exitFull}
                onRefresh={() => refreshSelected(selectedId)}
                currentUser={currentUser}
                providerKey={providerKey}
                onListChanged={loadIssues}
              />
            </div>
          </>
        )}
      </div>

      {showCreate && (
        <CreateIssueDialog
          projectDir={effectiveProjectDir}
          onClose={() => setShowCreate(false)}
          onCreated={(issue) => {
            setShowCreate(false)
            loadIssues()
            if (issue?.id) openIssue(issue.id)
          }}
        />
      )}

      {showProfiles && (
        <IssueTypeProfilesDialog
          projectDir={effectiveProjectDir}
          onClose={() => setShowProfiles(false)}
        />
      )}
    </div>
  )
}

// ============================================================================
// Parent Mode Banner
// ============================================================================

function ParentModeBanner({
  useParent,
  onToggle,
  rootProjectDir,
  projectDir
}: {
  useParent: boolean
  onToggle: () => void
  rootProjectDir: string
  projectDir: string
}) {
  const rootName = rootProjectDir.split(/[/\\]/).pop() || rootProjectDir
  const subName = projectDir.split(/[/\\]/).pop() || projectDir
  return (
    <div className={`gm-issues-parent-banner ${useParent ? 'gm-issues-parent-banner-active' : ''}`}>
      <span className="gm-issues-parent-banner-icon">{useParent ? '⬆' : '◆'}</span>
      <div className="gm-issues-parent-banner-text">
        {useParent ? (
          <>
            Showing <strong>{rootName}</strong>'s issue tracker (parent repository)
            <span className="gm-issues-parent-banner-sub">
              Submodule: <em>{subName}</em>
            </span>
          </>
        ) : (
          <>
            Showing <strong>{subName}</strong>'s own issue tracker (submodule)
            <span className="gm-issues-parent-banner-sub">
              Parent: <em>{rootName}</em>
            </span>
          </>
        )}
      </div>
      <button
        className="gm-small-btn"
        onClick={onToggle}
        title={useParent ? `Switch to ${subName}'s own tracker` : `Switch to parent (${rootName}) tracker`}
      >
        Switch to {useParent ? 'submodule' : 'parent'}
      </button>
    </div>
  )
}

// ============================================================================
// Resize Handle (modeled on CiResizeHandle)
// ============================================================================

function IssueResizeHandle({
  targetRef,
  min,
  max,
  storageKey
}: {
  targetRef: React.RefObject<HTMLDivElement | null>
  min: number
  max: number
  storageKey: string
}) {
  // Restore saved width on mount
  useEffect(() => {
    if (!targetRef.current) return
    const saved = localStorage.getItem(storageKey)
    if (saved) {
      const w = parseInt(saved, 10)
      if (!Number.isNaN(w) && w >= min && w <= max) {
        targetRef.current.style.width = `${w}px`
      }
    }
  }, [storageKey, targetRef, min, max])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const el = targetRef.current
    if (!el) return
    const zoom = parseFloat(document.documentElement.style.zoom) || 1
    const startX = e.clientX
    const startW = el.getBoundingClientRect().width / zoom

    const onMove = (ev: MouseEvent) => {
      // Dragging left (clientX decreases) widens the right-side pane.
      const delta = (startX - ev.clientX) / zoom
      const newW = Math.min(max, Math.max(min, startW + delta))
      el.style.width = `${newW}px`
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      if (el) {
        const z = parseFloat(document.documentElement.style.zoom) || 1
        localStorage.setItem(storageKey, String(Math.round(el.getBoundingClientRect().width / z)))
      }
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [targetRef, min, max, storageKey])

  return <div className="gm-issue-resize-handle" onMouseDown={handleMouseDown} />
}

// ============================================================================
// Issue List
// ============================================================================

function StateDot({ state }: { state: IssueState }) {
  const color = state === 'open' ? 'var(--accent-color, #da7756)' : '#9ece6a'
  return <span className="gm-pr-status-dot" style={{ background: color }} />
}

function IssueList({
  issues,
  selectedId,
  onSelect,
  loading
}: {
  issues: Issue[]
  selectedId: number | null
  onSelect: (id: number) => void
  loading: boolean
}) {
  if (issues.length === 0 && !loading) {
    return <div className="gm-issues-list"><div className="gm-pr-empty">No issues found.</div></div>
  }
  return (
    <div className="gm-issues-list" role="list">
      {issues.map((issue) => (
        <div
          key={issue.id}
          role="listitem"
          className={`gm-issue-row${selectedId === issue.id ? ' gm-issue-row-selected' : ''}`}
          onClick={() => onSelect(issue.id)}
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter') onSelect(issue.id) }}
        >
          <StateDot state={issue.state} />
          <div className="gm-issue-row-content">
            <div className="gm-issue-row-title">
              <span>{issue.title}</span>
              <span className="gm-pr-number">#{issue.id}</span>
            </div>
            <div className="gm-issue-row-meta">
              <span>@{issue.author.login}</span>
              <span className="gm-pr-sep">·</span>
              <span>{formatTime(issue.updatedAt || issue.createdAt)}</span>
              {issue.commentsCount > 0 && (
                <>
                  <span className="gm-pr-sep">·</span>
                  <span title={`${issue.commentsCount} comment${issue.commentsCount === 1 ? '' : 's'}`}>
                    💬 {issue.commentsCount}
                  </span>
                </>
              )}
              {issue.labels.length > 0 && (
                <>
                  <span className="gm-pr-sep">·</span>
                  {issue.labels.slice(0, 4).map((l) => (
                    <span
                      key={l.name}
                      className="gm-issue-label-chip"
                      title={l.description || l.name}
                      style={l.color ? { background: '#' + l.color, color: pickContrastTextColor(l.color) } : undefined}
                    >
                      {l.name}
                    </span>
                  ))}
                  {issue.labels.length > 4 && (
                    <span className="gm-pr-sep">+{issue.labels.length - 4}</span>
                  )}
                </>
              )}
              {issue.assignees.length > 0 && (
                <>
                  <span className="gm-pr-sep">·</span>
                  <span>{issue.assignees.map((a) => '@' + a.login).join(', ')}</span>
                </>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

// ============================================================================
// Detail Panel
// ============================================================================

interface IssueDetailPanelProps {
  projectDir: string
  issueId: number
  issue: Issue | null
  loading: boolean
  viewMode: ViewMode
  onClose: () => void
  onEnterFull: () => void
  onExitFull: () => void
  onRefresh: () => void
  currentUser: IssueUser | null
  providerKey: 'github' | 'gitlab' | null
  onListChanged: () => void
}

function IssueDetailPanel({
  projectDir,
  issueId,
  issue,
  loading,
  viewMode,
  onClose,
  onEnterFull,
  onExitFull,
  onRefresh,
  currentUser,
  providerKey,
  onListChanged
}: IssueDetailPanelProps) {
  const api = getDockApi()
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [editingBody, setEditingBody] = useState(false)
  const [bodyDraft, setBodyDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [claudeRunning, setClaudeRunning] = useState(false)
  const [comments, setComments] = useState<IssueComment[] | null>(null)
  const [commentsLoading, setCommentsLoading] = useState(false)

  // Reset drafts whenever the underlying issue changes
  useEffect(() => {
    if (!issue) return
    setTitleDraft(issue.title)
    setBodyDraft(issue.body)
    setEditingTitle(false)
    setEditingBody(false)
    setError('')
  }, [issue?.id, issue?.updatedAt])

  // Load comments when issue id changes
  useEffect(() => {
    if (!issue) { setComments(null); return }
    let cancelled = false
    setCommentsLoading(true)
    api.issues.listComments(projectDir, issue.id).then((c) => {
      if (!cancelled) setComments(c)
    }).catch((err) => {
      console.warn('[issues] listComments failed:', err)
    }).finally(() => {
      if (!cancelled) setCommentsLoading(false)
    })
    return () => { cancelled = true }
  }, [projectDir, issue?.id, issue?.updatedAt])

  const handleSaveTitle = async () => {
    if (!issue || !titleDraft.trim() || titleDraft === issue.title) {
      setEditingTitle(false)
      return
    }
    setSaving(true)
    setError('')
    try {
      const result = await api.issues.update(projectDir, issue.id, { title: titleDraft.trim() })
      if (!result.success) throw new Error(result.error || 'Update failed')
      setEditingTitle(false)
      onRefresh()
      onListChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save title')
    }
    setSaving(false)
  }

  const handleSaveBody = async () => {
    if (!issue || bodyDraft === issue.body) {
      setEditingBody(false)
      return
    }
    setSaving(true)
    setError('')
    try {
      const result = await api.issues.update(projectDir, issue.id, { body: bodyDraft })
      if (!result.success) throw new Error(result.error || 'Update failed')
      setEditingBody(false)
      onRefresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save description')
    }
    setSaving(false)
  }

  const handleToggleState = async () => {
    if (!issue) return
    setSaving(true)
    setError('')
    try {
      const nextState: IssueState = issue.state === 'open' ? 'closed' : 'open'
      const result = await api.issues.setState(projectDir, issue.id, nextState)
      if (!result.success) throw new Error(result.error || 'Failed')
      onRefresh()
      onListChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change state')
    }
    setSaving(false)
  }

  const handleSolveWithClaude = async (force = false) => {
    if (!issue) return
    setError('')
    setClaudeRunning(true)
    try {
      const result = await api.issues.fixWithClaude(projectDir, { issueId: issue.id, force })
      if (!result.success) {
        if (result.alreadyRunning) {
          const ageMin = result.startedAt ? Math.round((Date.now() - result.startedAt) / 60_000) : 0
          const msg = `A Solve-with-Claude run is already in progress for this issue (started ${ageMin}m ago). Start another?`
          if (window.confirm(msg)) {
            return handleSolveWithClaude(true)
          }
        } else {
          setError(result.error || 'Failed to dispatch Claude task')
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to dispatch Claude task')
    }
    setClaudeRunning(false)
  }

  const handleAddComment = async (body: string): Promise<boolean> => {
    if (!issue || !body.trim()) return false
    try {
      const result = await api.issues.addComment(projectDir, issue.id, body.trim())
      if (!result) {
        setError('Failed to add comment')
        return false
      }
      // Reload comments
      const fresh = await api.issues.listComments(projectDir, issue.id)
      setComments(fresh)
      onRefresh()
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add comment')
      return false
    }
  }

  const handleUpdateComment = async (commentId: number | string, body: string): Promise<boolean> => {
    if (!issue) return false
    try {
      const result = await api.issues.updateComment(projectDir, issue.id, commentId, body)
      if (!result) {
        setError('Failed to update comment')
        return false
      }
      const fresh = await api.issues.listComments(projectDir, issue.id)
      setComments(fresh)
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update comment')
      return false
    }
  }

  const handleDeleteComment = async (commentId: number | string): Promise<boolean> => {
    if (!issue) return false
    if (!window.confirm('Delete this comment? This cannot be undone.')) return false
    try {
      const ok = await api.issues.deleteComment(projectDir, issue.id, commentId)
      if (!ok) {
        setError('Failed to delete comment')
        return false
      }
      const fresh = await api.issues.listComments(projectDir, issue.id)
      setComments(fresh)
      onRefresh()
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete comment')
      return false
    }
  }

  if (loading && !issue) {
    return <div className={`gm-issue-detail gm-issue-detail--${viewMode}`}><div className="gm-loading">Loading issue...</div></div>
  }

  if (!issue) {
    return (
      <div className={`gm-issue-detail gm-issue-detail--${viewMode}`}>
        <div className="gm-loading">Issue not found.</div>
        <button className="gm-small-btn" onClick={onClose}>Close</button>
      </div>
    )
  }

  return (
    <div className={`gm-issue-detail gm-issue-detail--${viewMode}`}>
      <div className="gm-issue-detail-toolbar">
        <button className="gm-small-btn" onClick={onClose} title="Close detail">× Close</button>
        {viewMode === 'split' ? (
          <button className="gm-small-btn" onClick={onEnterFull} title="Expand to full view">⛶ Full</button>
        ) : (
          <button className="gm-small-btn" onClick={onExitFull} title="Back to list + detail view">← Back</button>
        )}
        <button className="gm-small-btn" onClick={onRefresh} disabled={loading} title="Refresh">↻</button>
        {issue.url && (
          <button className="gm-small-btn" onClick={() => api.app.openExternal(issue.url)}>
            Open on {providerKey === 'gitlab' ? 'GitLab' : 'GitHub'}
          </button>
        )}
        <div className="gm-issue-detail-toolbar-spacer" />
        <button
          className={`gm-small-btn gm-issue-state-btn gm-issue-state-${issue.state}`}
          onClick={handleToggleState}
          disabled={saving}
        >
          {issue.state === 'open' ? 'Close issue' : 'Reopen issue'}
        </button>
      </div>

      <div className="gm-issue-detail-title">
        <StateDot state={issue.state} />
        {editingTitle ? (
          <>
            <input
              className="gm-issue-title-input"
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSaveTitle()
                if (e.key === 'Escape') { setTitleDraft(issue.title); setEditingTitle(false) }
              }}
            />
            <button className="gm-small-btn" onClick={handleSaveTitle} disabled={saving}>Save</button>
            <button className="gm-small-btn" onClick={() => { setTitleDraft(issue.title); setEditingTitle(false) }}>Cancel</button>
          </>
        ) : (
          <>
            <h2 className="gm-issue-title-text">
              {issue.title} <span className="gm-pr-number">#{issue.id}</span>
            </h2>
            <button className="gm-small-btn" onClick={() => setEditingTitle(true)} title="Edit title">✎</button>
          </>
        )}
      </div>

      {error && <div className="gm-issue-detail-error">{error}</div>}

      <div className="gm-issue-detail-grid">
        <div className="gm-issue-detail-main">
          <div className="gm-issue-section">
            <div className="gm-issue-section-header">
              <span>Description</span>
              {!editingBody && (
                <button className="gm-small-btn" onClick={() => setEditingBody(true)} title="Edit description">✎ Edit</button>
              )}
            </div>
            {editingBody ? (
              <>
                <textarea
                  className="gm-issue-body-editor"
                  value={bodyDraft}
                  onChange={(e) => setBodyDraft(e.target.value)}
                  rows={viewMode === 'full' ? 16 : 10}
                />
                <div className="gm-issue-editor-buttons">
                  <button className="gm-small-btn" onClick={handleSaveBody} disabled={saving}>Save</button>
                  <button className="gm-small-btn" onClick={() => { setBodyDraft(issue.body); setEditingBody(false) }}>Cancel</button>
                </div>
              </>
            ) : (
              <div
                className="gm-issue-body-rendered gm-md"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(issue.body) }}
              />
            )}
          </div>

          <IssueCommentList
            comments={comments}
            loading={commentsLoading}
            currentUser={currentUser}
            onAdd={handleAddComment}
            onUpdate={handleUpdateComment}
            onDelete={handleDeleteComment}
          />
        </div>

        <div className="gm-issue-detail-side">
          <div className="gm-issue-section">
            <div className="gm-issue-section-header">
              <button
                className="gm-small-btn gm-claude-btn"
                onClick={() => handleSolveWithClaude(false)}
                disabled={claudeRunning}
                title="Dispatch a tailored Solve-with-Claude task"
              >
                {claudeRunning ? '…' : '✨ Solve with Claude'}
              </button>
            </div>
          </div>

          <StatusEditor
            projectDir={projectDir}
            issueId={issue.id}
            current={issue.status ?? null}
            onChanged={() => { onRefresh(); onListChanged() }}
          />
          <LabelEditor
            projectDir={projectDir}
            issueId={issue.id}
            current={issue.labels}
            onChanged={() => { onRefresh(); onListChanged() }}
          />
          <AssigneeEditor
            projectDir={projectDir}
            issueId={issue.id}
            current={issue.assignees}
            onChanged={() => { onRefresh(); onListChanged() }}
          />
          <MilestoneEditor
            projectDir={projectDir}
            issueId={issue.id}
            current={issue.milestone}
            onChanged={() => { onRefresh(); onListChanged() }}
          />

          <div className="gm-issue-section">
            <div className="gm-issue-section-header">Author</div>
            <div>@{issue.author.login}</div>
          </div>
          <div className="gm-issue-section">
            <div className="gm-issue-section-header">Created</div>
            <div>{formatTime(issue.createdAt)}</div>
          </div>
          <div className="gm-issue-section">
            <div className="gm-issue-section-header">Updated</div>
            <div>{formatTime(issue.updatedAt)}</div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ============================================================================
// Comment List
// ============================================================================

function IssueCommentList({
  comments,
  loading,
  currentUser,
  onAdd,
  onUpdate,
  onDelete
}: {
  comments: IssueComment[] | null
  loading: boolean
  currentUser: IssueUser | null
  onAdd: (body: string) => Promise<boolean>
  onUpdate: (commentId: number | string, body: string) => Promise<boolean>
  onDelete: (commentId: number | string) => Promise<boolean>
}) {
  const [newBody, setNewBody] = useState('')
  const [adding, setAdding] = useState(false)

  const handleAdd = async () => {
    if (!newBody.trim()) return
    setAdding(true)
    const ok = await onAdd(newBody)
    if (ok) setNewBody('')
    setAdding(false)
  }

  const visible = comments ? comments.filter((c) => !c.isSystem || c.body) : []

  return (
    <div className="gm-issue-section">
      <div className="gm-issue-section-header">
        Comments {comments && `(${visible.length})`}
      </div>
      {loading && <div className="gm-loading">Loading comments...</div>}
      {!loading && visible.length === 0 && (
        <div className="gm-pr-empty">No comments yet.</div>
      )}
      {visible.map((c) => (
        <CommentRow
          key={String(c.id)}
          comment={c}
          isCurrentUser={!!currentUser && c.author.login === currentUser.login}
          onUpdate={onUpdate}
          onDelete={onDelete}
        />
      ))}
      <div className="gm-issue-new-comment">
        <textarea
          value={newBody}
          onChange={(e) => setNewBody(e.target.value)}
          placeholder="Leave a comment…"
          rows={3}
        />
        <div className="gm-issue-editor-buttons">
          <button className="gm-small-btn" onClick={handleAdd} disabled={adding || !newBody.trim()}>
            {adding ? 'Posting…' : 'Comment'}
          </button>
        </div>
      </div>
    </div>
  )
}

function CommentRow({
  comment,
  isCurrentUser,
  onUpdate,
  onDelete
}: {
  comment: IssueComment
  isCurrentUser: boolean
  onUpdate: (commentId: number | string, body: string) => Promise<boolean>
  onDelete: (commentId: number | string) => Promise<boolean>
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(comment.body)
  const [saving, setSaving] = useState(false)

  useEffect(() => { setDraft(comment.body) }, [comment.body])

  const handleSave = async () => {
    setSaving(true)
    const ok = await onUpdate(comment.id, draft)
    if (ok) setEditing(false)
    setSaving(false)
  }

  const html = useMemo(() => renderMarkdown(comment.body), [comment.body])

  return (
    <div className={`gm-issue-comment${comment.isSystem ? ' gm-issue-comment-system' : ''}`}>
      <div className="gm-issue-comment-header">
        <strong>@{comment.author.login}</strong>
        <span className="gm-pr-sep">·</span>
        <span>{formatTime(comment.createdAt)}</span>
        {comment.updatedAt && comment.updatedAt !== comment.createdAt && (
          <span className="gm-issue-comment-edited" title="edited">(edited)</span>
        )}
        {isCurrentUser && !editing && !comment.isSystem && (
          <div className="gm-issue-comment-actions">
            <button className="gm-small-btn" onClick={() => setEditing(true)}>Edit</button>
            <button className="gm-small-btn" onClick={() => onDelete(comment.id)}>Delete</button>
          </div>
        )}
      </div>
      {editing ? (
        <>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={6}
          />
          <div className="gm-issue-editor-buttons">
            <button className="gm-small-btn" onClick={handleSave} disabled={saving}>Save</button>
            <button className="gm-small-btn" onClick={() => { setDraft(comment.body); setEditing(false) }}>Cancel</button>
          </div>
        </>
      ) : (
        <div className="gm-issue-comment-body gm-md" dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </div>
  )
}

// ============================================================================
// Meta Editors (label / assignee / milestone)
// ============================================================================

function LabelEditor({
  projectDir,
  issueId,
  current,
  onChanged
}: {
  projectDir: string
  issueId: number
  current: IssueLabel[]
  onChanged: () => void
}) {
  const api = getDockApi()
  const [open, setOpen] = useState(false)
  const [available, setAvailable] = useState<IssueLabel[] | null>(null)
  const [busy, setBusy] = useState(false)

  const currentNames = new Set(current.map((l) => l.name))

  const loadAvailable = useCallback(async () => {
    if (available) return
    try {
      const list = await api.issues.listLabels(projectDir)
      setAvailable(list)
    } catch (err) {
      console.warn('[issues] listLabels failed:', err)
    }
  }, [api, projectDir, available])

  const toggle = async (label: IssueLabel) => {
    setBusy(true)
    try {
      if (currentNames.has(label.name)) {
        await api.issues.removeLabel(projectDir, issueId, [label.name])
      } else {
        await api.issues.addLabel(projectDir, issueId, [label.name])
      }
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="gm-issue-section">
      <div className="gm-issue-section-header">
        <span>Labels</span>
        <button
          className="gm-small-btn"
          onClick={async () => { await loadAvailable(); setOpen((o) => !o) }}
          disabled={busy}
        >
          {open ? 'Done' : 'Edit'}
        </button>
      </div>
      <div className="gm-issue-label-list">
        {current.length === 0 && <span className="gm-pr-empty">No labels.</span>}
        {current.map((l) => (
          <span
            key={l.name}
            className="gm-issue-label-chip"
            title={l.description || l.name}
            style={l.color ? { background: '#' + l.color, color: pickContrastTextColor(l.color) } : undefined}
          >
            {l.name}
          </span>
        ))}
      </div>
      {open && (
        <div className="gm-issue-popover">
          {(available || []).map((l) => (
            <div
              key={l.name}
              className={`gm-issue-popover-item${currentNames.has(l.name) ? ' gm-issue-popover-item-active' : ''}`}
              onClick={() => toggle(l)}
            >
              <span
                className="gm-issue-label-chip"
                style={l.color ? { background: '#' + l.color, color: pickContrastTextColor(l.color) } : undefined}
              >
                {l.name}
              </span>
              {currentNames.has(l.name) && <span className="gm-issue-popover-check">✓</span>}
            </div>
          ))}
          {(available || []).length === 0 && <div className="gm-pr-empty">No labels available.</div>}
        </div>
      )}
    </div>
  )
}

function AssigneeEditor({
  projectDir,
  issueId,
  current,
  onChanged
}: {
  projectDir: string
  issueId: number
  current: IssueUser[]
  onChanged: () => void
}) {
  const api = getDockApi()
  const [open, setOpen] = useState(false)
  const [available, setAvailable] = useState<IssueUser[] | null>(null)
  const [busy, setBusy] = useState(false)

  const currentLogins = new Set(current.map((u) => u.login))

  const loadAvailable = useCallback(async () => {
    if (available) return
    try {
      const list = await api.issues.listAssignees(projectDir)
      setAvailable(list)
    } catch (err) {
      console.warn('[issues] listAssignees failed:', err)
    }
  }, [api, projectDir, available])

  const toggle = async (u: IssueUser) => {
    setBusy(true)
    try {
      if (currentLogins.has(u.login)) {
        await api.issues.removeAssignee(projectDir, issueId, [u.login])
      } else {
        await api.issues.addAssignee(projectDir, issueId, [u.login])
      }
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="gm-issue-section">
      <div className="gm-issue-section-header">
        <span>Assignees</span>
        <button
          className="gm-small-btn"
          onClick={async () => { await loadAvailable(); setOpen((o) => !o) }}
          disabled={busy}
        >
          {open ? 'Done' : 'Edit'}
        </button>
      </div>
      <div>
        {current.length === 0 ? <span className="gm-pr-empty">No assignees.</span> : current.map((u) => '@' + u.login).join(', ')}
      </div>
      {open && (
        <div className="gm-issue-popover">
          {(available || []).map((u) => (
            <div
              key={u.login}
              className={`gm-issue-popover-item${currentLogins.has(u.login) ? ' gm-issue-popover-item-active' : ''}`}
              onClick={() => toggle(u)}
            >
              <span>@{u.login}</span>
              {currentLogins.has(u.login) && <span className="gm-issue-popover-check">✓</span>}
            </div>
          ))}
          {(available || []).length === 0 && <div className="gm-pr-empty">No users available.</div>}
        </div>
      )}
    </div>
  )
}

function MilestoneEditor({
  projectDir,
  issueId,
  current,
  onChanged
}: {
  projectDir: string
  issueId: number
  current: IssueMilestone | null
  onChanged: () => void
}) {
  const api = getDockApi()
  const [open, setOpen] = useState(false)
  const [available, setAvailable] = useState<IssueMilestone[] | null>(null)
  const [busy, setBusy] = useState(false)

  const loadAvailable = useCallback(async () => {
    if (available) return
    try {
      const list = await api.issues.listMilestones(projectDir)
      setAvailable(list)
    } catch (err) {
      console.warn('[issues] listMilestones failed:', err)
    }
  }, [api, projectDir, available])

  const choose = async (m: IssueMilestone | null) => {
    setBusy(true)
    try {
      await api.issues.setMilestone(projectDir, issueId, m ? m.id : null)
      onChanged()
      setOpen(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="gm-issue-section">
      <div className="gm-issue-section-header">
        <span>Milestone</span>
        <button
          className="gm-small-btn"
          onClick={async () => { await loadAvailable(); setOpen((o) => !o) }}
          disabled={busy}
        >
          {open ? 'Done' : 'Edit'}
        </button>
      </div>
      <div>{current ? current.title : <span className="gm-pr-empty">None.</span>}</div>
      {open && (
        <div className="gm-issue-popover">
          <div className="gm-issue-popover-item" onClick={() => choose(null)}>
            <span><em>(no milestone)</em></span>
            {!current && <span className="gm-issue-popover-check">✓</span>}
          </div>
          {(available || []).map((m) => (
            <div
              key={String(m.id)}
              className={`gm-issue-popover-item${current && String(current.id) === String(m.id) ? ' gm-issue-popover-item-active' : ''}`}
              onClick={() => choose(m)}
            >
              <span>{m.title}</span>
              {current && String(current.id) === String(m.id) && <span className="gm-issue-popover-check">✓</span>}
            </div>
          ))}
          {(available || []).length === 0 && <div className="gm-pr-empty">No milestones available.</div>}
        </div>
      )}
    </div>
  )
}

/**
 * Fallback colors when a status has no provider-supplied color.
 * Keyed by the normalized `IssueStatus.category` hint.
 */
const STATUS_CATEGORY_COLORS: Record<NonNullable<IssueStatus['category']>, string> = {
  todo: '#6e7681',
  triage: '#9e6a03',
  in_progress: '#2f81f7',
  done: '#3fb950',
  canceled: '#8b949e'
}

function statusBadgeBg(status: IssueStatus): string {
  if (status.color) return status.color.startsWith('#') ? status.color : `#${status.color}`
  if (status.category) return STATUS_CATEGORY_COLORS[status.category]
  return '#6e7681'
}

function StatusBadge({ status }: { status: IssueStatus }) {
  const bg = statusBadgeBg(status)
  const fg = pickContrastTextColor(bg)
  return (
    <span className="gm-issue-status-badge" style={{ background: bg, color: fg }}>
      {status.name}
    </span>
  )
}

/**
 * Edits the provider-native status of an issue (GitHub Projects v2 single-select
 * Status field, GitLab work-item status widget). Capability is probed once per
 * `projectDir`; when unsupported the editor renders an inline note instead of
 * a broken popover. Status cannot be cleared via the existing IPC contract
 * (`statusId: string` is required), so only set-to-value is offered — matching
 * what both providers actually support.
 */
function StatusEditor({
  projectDir,
  issueId,
  current,
  onChanged
}: {
  projectDir: string
  issueId: number
  current: IssueStatus | null | undefined
  onChanged: () => void
}) {
  const api = getDockApi()
  const [open, setOpen] = useState(false)
  const [available, setAvailable] = useState<IssueStatus[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [capability, setCapability] = useState<IssueStatusCapability | null>(null)

  // Reset cached options + popover state when switching repos.
  useEffect(() => {
    setAvailable(null)
    setOpen(false)
    setError(null)
    setCapability(null)
  }, [projectDir])

  // Probe capability whenever the repo changes.
  useEffect(() => {
    let cancelled = false
    api.issues.getStatusCapability(projectDir).then((cap) => {
      if (!cancelled) setCapability(cap)
    }).catch((err) => {
      console.warn('[issues] getStatusCapability failed:', err)
      if (!cancelled) setCapability({ supported: false, reason: 'Failed to probe status capability.' })
    })
    return () => { cancelled = true }
  }, [api, projectDir])

  const loadAvailable = useCallback(async () => {
    if (available) return
    try {
      const list = await api.issues.listStatuses(projectDir)
      setAvailable(list)
    } catch (err) {
      console.warn('[issues] listStatuses failed:', err)
      setAvailable([])
      setError(err instanceof Error ? err.message : 'Failed to load statuses')
    }
  }, [api, projectDir, available])

  const choose = async (s: IssueStatus) => {
    if (current && current.id === s.id) { setOpen(false); return }
    setBusy(true)
    setError(null)
    try {
      const result = await api.issues.setStatus(projectDir, issueId, s.id)
      if (!result.success) {
        setError(result.error || 'Failed to update status')
      } else {
        onChanged()
        setOpen(false)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update status')
    } finally {
      setBusy(false)
    }
  }

  // Hide section entirely while we don't yet know whether status is supported,
  // to avoid a flash of an empty editor.
  if (capability === null) return null

  if (!capability.supported) {
    return (
      <div className="gm-issue-section">
        <div className="gm-issue-section-header"><span>Status</span></div>
        <div className="gm-pr-empty" title={capability.reason || ''}>
          {capability.reason || 'Status not supported by this provider.'}
        </div>
      </div>
    )
  }

  return (
    <div className="gm-issue-section">
      <div className="gm-issue-section-header">
        <span>Status</span>
        <button
          className="gm-small-btn"
          onClick={async () => { await loadAvailable(); setOpen((o) => !o) }}
          disabled={busy}
        >
          {open ? 'Done' : 'Edit'}
        </button>
      </div>
      <div>
        {current ? <StatusBadge status={current} /> : <span className="gm-pr-empty">Not set.</span>}
      </div>
      {open && (
        <div className="gm-issue-popover">
          {available === null && <div className="gm-loading">Loading...</div>}
          {available !== null && available.length === 0 && (
            <div className="gm-pr-empty">No statuses available.</div>
          )}
          {(available || []).map((s) => {
            const isActive = !!current && current.id === s.id
            return (
              <div
                key={s.id}
                className={`gm-issue-popover-item${isActive ? ' gm-issue-popover-item-active' : ''}`}
                onClick={() => { if (!busy) choose(s) }}
              >
                <StatusBadge status={s} />
                {isActive && <span className="gm-issue-popover-check">✓</span>}
              </div>
            )
          })}
          {error && <div className="gm-issue-popover-error">{error}</div>}
        </div>
      )}
    </div>
  )
}

// ============================================================================
// Create Issue Dialog
// ============================================================================

function CreateIssueDialog({
  projectDir,
  onClose,
  onCreated
}: {
  projectDir: string
  onClose: () => void
  onCreated: (issue: Issue | null) => void
}) {
  const api = getDockApi()
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')

  const handleCreate = async () => {
    if (!title.trim()) return
    setCreating(true)
    setError('')
    try {
      const result = await api.issues.create(projectDir, { title: title.trim(), body: body.trim() })
      if (!result.success) {
        setError(result.error || 'Failed to create issue')
      } else {
        onCreated(result.issue || null)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed')
    }
    setCreating(false)
  }

  return (
    <div className="modal-overlay">
      <div className="gm-pr-create-dialog">
        <div className="gm-pr-create-header">
          <h3>New Issue</h3>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="gm-pr-create-body">
          <label className="gm-pr-create-field">
            Title
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && title.trim()) handleCreate() }}
            />
          </label>
          <label className="gm-pr-create-field">
            Description
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={8}
              placeholder="Describe the issue..."
            />
          </label>
          {error && <div className="gm-pr-create-error">{error}</div>}
        </div>
        <div className="gm-pr-create-footer">
          <button className="gm-small-btn" onClick={onClose}>Cancel</button>
          <button
            className="gm-small-btn gm-pr-create-submit"
            onClick={handleCreate}
            disabled={creating || !title.trim()}
          >
            {creating ? 'Creating...' : 'Create Issue'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ============================================================================
// Issue Type Profiles Dialog
// ============================================================================

const BEHAVIOR_OPTIONS: IssueBehavior[] = [
  'fix', 'investigate', 'design', 'improve', 'cleanup', 'collaborate', 'generic'
]

function IssueTypeProfilesDialog({
  projectDir,
  onClose
}: {
  projectDir: string
  onClose: () => void
}) {
  const api = getDockApi()
  const [profiles, setProfiles] = useState<IssueTypeProfiles | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    api.issues.getTypeProfiles(projectDir).then(setProfiles).catch((err) => {
      console.warn('[issues] getTypeProfiles failed:', err)
      setError('Failed to load profiles.')
    })
  }, [projectDir])

  const updateProfile = (idx: number, changes: Partial<IssueTypeProfile>) => {
    if (!profiles) return
    const next = { ...profiles, profiles: profiles.profiles.map((p, i) => (i === idx ? { ...p, ...changes } : p)) }
    setProfiles(next)
  }

  const removeProfile = (idx: number) => {
    if (!profiles) return
    setProfiles({ ...profiles, profiles: profiles.profiles.filter((_, i) => i !== idx) })
  }

  const addProfile = () => {
    if (!profiles) return
    setProfiles({
      ...profiles,
      profiles: [...profiles.profiles, { labelPatterns: [], behavior: 'generic' }]
    })
  }

  const handleSave = async () => {
    if (!profiles) return
    setSaving(true)
    setError('')
    try {
      // Validate via main process, then persist via plugin setting.
      const result = await api.issues.setTypeProfiles(projectDir, profiles)
      if (!result.success || !result.json) {
        throw new Error(result.error || 'Failed to validate profiles')
      }
      await api.plugins.setSetting(projectDir, 'git-manager', 'issueTypeProfilesJson', result.json)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    }
    setSaving(false)
  }

  const handleResetDefaults = async () => {
    if (!window.confirm('Reset to shipped defaults? Your customizations will be lost.')) return
    try {
      await api.plugins.setSetting(projectDir, 'git-manager', 'issueTypeProfilesJson', '')
      const fresh = await api.issues.getTypeProfiles(projectDir)
      setProfiles(fresh)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset')
    }
  }

  return (
    <div className="modal-overlay">
      <div className="gm-pr-create-dialog gm-issue-profiles-dialog">
        <div className="gm-pr-create-header">
          <h3>Claude Behavior Profiles</h3>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="gm-pr-create-body">
          <p className="gm-issue-profiles-intro">
            Map issue labels to Claude behaviors for "Solve with Claude". Label matching is
            case-insensitive; end a pattern with <code>*</code> for prefix matching (e.g. <code>bug*</code>).
            First match wins.
          </p>
          {!profiles && <div className="gm-loading">Loading…</div>}
          {profiles && (
            <>
              {profiles.profiles.map((p, idx) => (
                <div key={idx} className="gm-issue-profile-row">
                  <input
                    type="text"
                    placeholder="label, label*, ..."
                    value={p.labelPatterns.join(', ')}
                    onChange={(e) => updateProfile(idx, {
                      labelPatterns: e.target.value.split(',').map((s) => s.trim()).filter(Boolean)
                    })}
                  />
                  <select
                    value={p.behavior}
                    onChange={(e) => updateProfile(idx, { behavior: e.target.value as IssueBehavior })}
                  >
                    {BEHAVIOR_OPTIONS.map((b) => <option key={b} value={b}>{b}</option>)}
                  </select>
                  <input
                    type="text"
                    placeholder="Optional addendum for Claude"
                    value={p.promptAddendum || ''}
                    onChange={(e) => updateProfile(idx, { promptAddendum: e.target.value || undefined })}
                  />
                  <button className="gm-small-btn" onClick={() => removeProfile(idx)}>Remove</button>
                </div>
              ))}
              <button className="gm-small-btn" onClick={addProfile}>+ Add Profile</button>
              <label className="gm-pr-create-field" style={{ marginTop: 12 }}>
                Fallback behavior (when no label matches)
                <select
                  value={profiles.defaultBehavior}
                  onChange={(e) => setProfiles({ ...profiles, defaultBehavior: e.target.value as IssueBehavior })}
                >
                  {BEHAVIOR_OPTIONS.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              </label>
            </>
          )}
          {error && <div className="gm-pr-create-error">{error}</div>}
        </div>
        <div className="gm-pr-create-footer">
          <button className="gm-small-btn" onClick={handleResetDefaults}>Reset to defaults</button>
          <div style={{ flex: 1 }} />
          <button className="gm-small-btn" onClick={onClose}>Cancel</button>
          <button
            className="gm-small-btn gm-pr-create-submit"
            onClick={handleSave}
            disabled={saving || !profiles}
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
