import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { getDockApi } from '../../lib/ipc-bridge'
import type { CiWorkflow, CiWorkflowRun, CiJob, CiJobGroup } from '../../../../shared/ci-types'
import { groupJobsByMatrix } from '../../../../shared/ci-types'
import type { GitProvider } from '../../../../shared/remote-url'
import { ProviderIcon, providerLabel } from './ProviderIcons'

interface CiPanelProps {
  projectDir: string
  provider: GitProvider
}

type CiStatus = 'loading' | 'setup' | 'ready' | 'error'

interface SetupState {
  ghInstalled: boolean
  ghAuthenticated: boolean
  hasRemote: boolean
  checking: boolean
  loginOpened: boolean
}

type ConclusionFilter = 'success' | 'failure' | 'cancelled' | 'in_progress' | 'queued'

interface CiFilters {
  status: Set<ConclusionFilter>
  branch: string | null
  event: string | null
  showStaleQueued: boolean
}

// Session-level cache so we don't re-check CLI availability on every tab switch
const ciAvailabilityCache = new Map<string, { available: boolean; workflows: CiWorkflow[] }>()

// Persist expanded state for job panels across refreshes/tab switches
const CI_GROUPS_KEY = 'ci-expanded-groups'
const CI_JOBS_KEY = 'ci-expanded-jobs'

function loadExpandedGroups(): Set<string> {
  try {
    const raw = localStorage.getItem(CI_GROUPS_KEY)
    if (raw) return new Set(JSON.parse(raw))
  } catch { /* ignore */ }
  return new Set()
}

function saveExpandedGroups(groups: Set<string>): void {
  try { localStorage.setItem(CI_GROUPS_KEY, JSON.stringify([...groups])) } catch { /* ignore */ }
}

function loadExpandedJobs(): Set<number> {
  try {
    const raw = localStorage.getItem(CI_JOBS_KEY)
    if (raw) return new Set(JSON.parse(raw))
  } catch { /* ignore */ }
  return new Set()
}

function saveExpandedJobs(jobs: Set<number>): void {
  try { localStorage.setItem(CI_JOBS_KEY, JSON.stringify([...jobs])) } catch { /* ignore */ }
}

const STALE_QUEUED_HOURS = 24

function isStaleQueued(run: CiWorkflowRun): boolean {
  if (run.status !== 'queued') return false
  const age = Date.now() - new Date(run.createdAt).getTime()
  return age > STALE_QUEUED_HOURS * 60 * 60 * 1000
}

function getEffectiveStatus(run: CiWorkflowRun): ConclusionFilter {
  if (run.status === 'completed' && run.conclusion) {
    if (run.conclusion === 'success') return 'success'
    if (run.conclusion === 'failure') return 'failure'
    return 'cancelled' // cancelled, skipped, timed_out, action_required
  }
  if (run.status === 'in_progress' || run.status === 'waiting' || run.status === 'requested') return 'in_progress'
  return 'queued'
}

function getStatusColor(run: CiWorkflowRun): string {
  const s = getEffectiveStatus(run)
  if (s === 'success') return '#9ece6a'
  if (s === 'failure') return '#f7768e'
  if (s === 'in_progress') return '#e0af68'
  if (s === 'queued') return 'var(--accent-color)'
  return 'var(--text-secondary)' // cancelled
}

export default function CiPanel({ projectDir, provider }: CiPanelProps) {
  const [status, setStatus] = useState<CiStatus>('loading')
  const [errorMsg, setErrorMsg] = useState('')
  const [setup, setSetup] = useState<SetupState>({ ghInstalled: false, ghAuthenticated: false, hasRemote: false, checking: false, loginOpened: false })
  const [workflows, setWorkflows] = useState<CiWorkflow[]>([])
  const [selectedWorkflow, setSelectedWorkflow] = useState<number | 'all'>('all')
  const [runs, setRuns] = useState<CiWorkflowRun[]>([])
  const [activeRuns, setActiveRuns] = useState<CiWorkflowRun[]>([])
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(true)
  const [loadingRuns, setLoadingRuns] = useState(false)
  const loadingRunsRef = useRef(false)
  const [expandedRun, setExpandedRun] = useState<number | null>(null)
  const [runJobs, setRunJobs] = useState<CiJob[]>([])
  const [loadingJobs, setLoadingJobs] = useState(false)
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => loadExpandedGroups())
  const [filters, setFilters] = useState<CiFilters>({ status: new Set(), branch: null, event: null, showStaleQueued: false })
  const [filtersExpanded, setFiltersExpanded] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const detailRef = useRef<HTMLDivElement>(null)
  const pollingRef = useRef(false)

  const api = getDockApi()

  const checkSetup = useCallback(async () => {
    setSetup(prev => ({ ...prev, checking: true }))
    try {
      const ghInstalled = await api.ci.checkGhInstalled()
      if (!ghInstalled) {
        setSetup(prev => ({ ...prev, ghInstalled: false, ghAuthenticated: false, hasRemote: false, checking: false }))
        setStatus('setup')
        return false
      }
      const ghAuthenticated = await api.ci.checkGhAuth()
      if (!ghAuthenticated) {
        setSetup(prev => ({ ...prev, ghInstalled: true, ghAuthenticated: false, hasRemote: false, checking: false }))
        setStatus('setup')
        return false
      }
      const hasRemote = await api.ci.checkGithubRemote(projectDir)
      if (!hasRemote) {
        setSetup(prev => ({ ...prev, ghInstalled: true, ghAuthenticated: true, hasRemote: false, checking: false }))
        setStatus('setup')
        return false
      }
      setSetup(prev => ({ ...prev, ghInstalled: true, ghAuthenticated: true, hasRemote: true, checking: false }))
      return true
    } catch {
      setSetup(prev => ({ ...prev, checking: false }))
      return false
    }
  }, [projectDir])

  // Check availability + load workflows (cached per session)
  useEffect(() => {
    let cancelled = false
    async function init() {
      const cached = ciAvailabilityCache.get(projectDir)
      if (cached) {
        if (!cached.available) {
          await checkSetup()
          return
        }
        setWorkflows(cached.workflows)
        setStatus('ready')
        return
      }

      try {
        const available = await api.ci.checkAvailable(projectDir)
        if (cancelled) return
        if (!available) {
          ciAvailabilityCache.set(projectDir, { available: false, workflows: [] })
          await checkSetup()
          return
        }
        const wf = await api.ci.getWorkflows(projectDir)
        if (cancelled) return
        ciAvailabilityCache.set(projectDir, { available: true, workflows: wf })
        setWorkflows(wf)
        setStatus('ready')
      } catch (err) {
        if (cancelled) return
        setStatus('error')
        setErrorMsg(err instanceof Error ? err.message : 'Failed to check CI availability')
      }
    }
    init()
    return () => { cancelled = true }
  }, [projectDir])

  // Start polling when ready
  useEffect(() => {
    if (status !== 'ready') return
    pollingRef.current = true
    api.ci.startPolling(projectDir)
    return () => {
      pollingRef.current = false
      api.ci.stopPolling(projectDir)
    }
  }, [status, projectDir])

  // Load runs when workflow selection changes
  useEffect(() => {
    if (status !== 'ready') return
    setPage(1)
    setRuns([])
    setHasMore(true)
    loadRuns(1, true)
  }, [selectedWorkflow, status])

  // Poll active runs and update historical runs when completions are detected
  const prevActiveIdsRef = useRef<Set<number>>(new Set())

  useEffect(() => {
    if (status !== 'ready') return
    let timer: ReturnType<typeof setInterval>
    const pollActive = async () => {
      try {
        const active = await api.ci.getActiveRuns(projectDir)
        const activeIds = new Set(active.map((r) => r.id))

        // Detect runs that were active but are now gone (completed)
        const prevIds = prevActiveIdsRef.current
        let anyCompleted = false
        for (const id of prevIds) {
          if (!activeIds.has(id)) {
            anyCompleted = true
            break
          }
        }

        // Update runs list with latest active run data (keeps status in sync)
        if (active.length > 0) {
          setRuns((prev) => {
            const activeMap = new Map(active.map((r) => [r.id, r]))
            return prev.map((r) => activeMap.get(r.id) ?? r)
          })
        }

        // If a run just completed, reload page 1 to get its final state
        if (anyCompleted && prevIds.size > 0) {
          loadRuns(1, true)
        }

        prevActiveIdsRef.current = activeIds
        setActiveRuns(active)
      } catch { /* ignore */ }
    }
    pollActive()
    timer = setInterval(pollActive, 10_000)
    return () => clearInterval(timer)
  }, [status, projectDir])

  const loadRuns = useCallback(async (p: number, reset?: boolean) => {
    if (loadingRunsRef.current) return
    loadingRunsRef.current = true
    setLoadingRuns(true)
    try {
      let newRuns: CiWorkflowRun[] = []
      if (selectedWorkflow === 'all') {
        // Load from all workflows
        const allRuns: CiWorkflowRun[] = []
        for (const wf of workflows) {
          const r = await api.ci.getWorkflowRuns(projectDir, wf.id, p, 20)
          allRuns.push(...r)
        }
        // Sort by createdAt desc, deduplicate
        const seen = new Set<number>()
        newRuns = allRuns
          .filter((r) => { if (seen.has(r.id)) return false; seen.add(r.id); return true })
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
          .slice(0, 20)
      } else {
        newRuns = await api.ci.getWorkflowRuns(projectDir, selectedWorkflow, p, 20)
      }

      if (newRuns.length < 20) setHasMore(false)
      setRuns((prev) => reset ? newRuns : [...prev, ...newRuns])
      setPage(p)
    } catch {
      setHasMore(false)
    }
    loadingRunsRef.current = false
    setLoadingRuns(false)
  }, [selectedWorkflow, workflows, projectDir])

  // Infinite scroll
  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el || !hasMore || loadingRuns) return
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 100) {
      loadRuns(page + 1)
    }
  }, [hasMore, loadingRuns, page, loadRuns])

  // Load jobs when expanding a run
  const handleExpandRun = useCallback(async (runId: number) => {
    if (expandedRun === runId) {
      setExpandedRun(null)
      return
    }
    setExpandedRun(runId)
    setRunJobs([])
    setLoadingJobs(true)
    try {
      const jobs = await api.ci.getRunJobs(projectDir, runId)
      setRunJobs(jobs)
    } catch { /* ignore */ }
    setLoadingJobs(false)
  }, [expandedRun, projectDir])

  const handleCancel = useCallback(async (runId: number) => {
    await api.ci.cancelRun(projectDir, runId)
    // Refresh active runs
    const active = await api.ci.getActiveRuns(projectDir)
    setActiveRuns(active)
  }, [projectDir])

  const handleRefresh = useCallback(() => {
    setPage(1)
    setRuns([])
    setHasMore(true)
    loadRuns(1, true)
  }, [loadRuns])

  const toggleGroup = useCallback((key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      saveExpandedGroups(next)
      return next
    })
  }, [])

  // Derive unique branches and events from loaded runs
  const availableBranches = useMemo(() => [...new Set(runs.map((r) => r.headBranch))].sort(), [runs])
  const availableEvents = useMemo(() => [...new Set(runs.map((r) => r.event))].sort(), [runs])

  // Filter active runs to exclude stale queued
  const filteredActiveRuns = useMemo(() => {
    if (filters.showStaleQueued) return activeRuns
    return activeRuns.filter((r) => !isStaleQueued(r))
  }, [activeRuns, filters.showStaleQueued])

  // Count stale queued runs (across both lists)
  const staleQueuedCount = useMemo(() => {
    const staleInRuns = runs.filter(isStaleQueued).length
    const staleInActive = activeRuns.filter(isStaleQueued).length
    // Deduplicate by counting unique stale IDs
    const staleIds = new Set([
      ...runs.filter(isStaleQueued).map((r) => r.id),
      ...activeRuns.filter(isStaleQueued).map((r) => r.id)
    ])
    return staleIds.size
  }, [runs, activeRuns])

  // Emit CI status to parent via custom event
  useEffect(() => {
    let ciStatus: 'success' | 'failure' | 'in_progress' | 'none' = 'none'
    if (filteredActiveRuns.some((r) => r.status === 'in_progress' || r.status === 'queued')) {
      ciStatus = 'in_progress'
    } else if (runs.length > 0) {
      // Check the latest completed run
      const latest = runs.find((r) => r.status === 'completed')
      if (latest) {
        if (latest.conclusion === 'success') ciStatus = 'success'
        else if (latest.conclusion === 'failure') ciStatus = 'failure'
        else ciStatus = 'none'
      }
    }
    window.dispatchEvent(new CustomEvent('ci-status-change', { detail: ciStatus }))
  }, [runs, filteredActiveRuns])

  // Listen for navigate-to-run events from notifications
  useEffect(() => {
    const handler = (e: Event) => {
      const runId = (e as CustomEvent).detail as number
      if (runId) {
        setExpandedRun(runId)
        setRunJobs([])
        setLoadingJobs(true)
        api.ci.getRunJobs(projectDir, runId)
          .then((jobs) => setRunJobs(jobs))
          .catch(() => {})
          .finally(() => setLoadingJobs(false))
      }
    }
    window.addEventListener('ci-navigate-run', handler)
    return () => window.removeEventListener('ci-navigate-run', handler)
  }, [projectDir])

  // Apply filters
  const filteredRuns = useMemo(() => {
    return runs.filter((run) => {
      // Prune stale queued unless user opted in
      if (!filters.showStaleQueued && isStaleQueued(run)) return false
      // Status filter
      if (filters.status.size > 0 && !filters.status.has(getEffectiveStatus(run))) return false
      // Branch filter
      if (filters.branch && run.headBranch !== filters.branch) return false
      // Event filter
      if (filters.event && run.event !== filters.event) return false
      return true
    })
  }, [runs, filters])

  const toggleStatusFilter = useCallback((s: ConclusionFilter) => {
    setFilters((prev) => {
      const next = new Set(prev.status)
      if (next.has(s)) next.delete(s)
      else next.add(s)
      return { ...prev, status: next }
    })
  }, [])

  const hasActiveFilters = filters.status.size > 0 || filters.branch !== null || filters.event !== null

  if (status === 'loading') {
    return <div className="ci-panel-center"><div className="ci-spinner" /> Checking CI availability...</div>
  }

  if (status === 'setup') {
    return (
      <CiSetupWizard
        setup={setup}
        onRecheck={async () => {
          const ok = await checkSetup()
          if (ok) {
            // All checks passed — load workflows and update cache
            try {
              const wf = await api.ci.getWorkflows(projectDir)
              ciAvailabilityCache.set(projectDir, { available: true, workflows: wf })
              setWorkflows(wf)
              setStatus('ready')
            } catch (err) {
              setStatus('error')
              setErrorMsg(err instanceof Error ? err.message : 'Failed to load workflows')
            }
          }
        }}
        onOpenAuthLogin={async () => {
          setSetup(prev => ({ ...prev, loginOpened: true }))
          await api.ci.runGhAuthLogin()
        }}
        onOpenDownload={() => {
          api.app.openExternal('https://cli.github.com')
        }}
      />
    )
  }

  if (status === 'error') {
    return <div className="ci-panel-center ci-error">{errorMsg}</div>
  }

  if (workflows.length === 0) {
    return (
      <div className="ci-panel-center">
        <div className="ci-empty-title">No workflows found</div>
        <div className="ci-empty-hint">This repository has no GitHub Actions workflows configured.</div>
      </div>
    )
  }

  const selectedRun = expandedRun !== null ? [...filteredActiveRuns, ...filteredRuns].find((r) => r.id === expandedRun) ?? null : null
  const jobGroups = groupJobsByMatrix(runJobs)

  return (
    <div className="ci-panel">
      <div className="ci-list-pane">
        {/* Header */}
        <div className="ci-header">
          <select
            className="ci-workflow-select"
            value={selectedWorkflow}
            onChange={(e) => setSelectedWorkflow(e.target.value === 'all' ? 'all' : Number(e.target.value))}
          >
            <option value="all">All workflows</option>
            {workflows.map((wf) => (
              <option key={wf.id} value={wf.id}>{wf.name}</option>
            ))}
          </select>
          <button className="ci-refresh-btn" onClick={handleRefresh} title="Refresh">
            <RefreshIcon />
          </button>
        </div>

        {/* Filter bar */}
        <div className="ci-filter-bar">
          <button
            className={`ci-filter-toggle${hasActiveFilters ? ' ci-filter-toggle-active' : ''}`}
            onClick={() => setFiltersExpanded((p) => !p)}
            title="Toggle filters"
          >
            <FilterIcon />
            {hasActiveFilters && <span className="ci-filter-dot" />}
          </button>
          {filtersExpanded && (
            <div className="ci-filter-controls">
              <div className="ci-filter-group">
                {(['success', 'failure', 'in_progress', 'queued', 'cancelled'] as ConclusionFilter[]).map((s) => (
                  <button
                    key={s}
                    className={`ci-filter-chip ci-filter-chip-${s}${filters.status.has(s) ? ' ci-filter-chip-on' : ''}`}
                    onClick={() => toggleStatusFilter(s)}
                  >
                    {s === 'in_progress' ? 'running' : s}
                  </button>
                ))}
              </div>
              {availableBranches.length > 1 && (
                <select
                  className="ci-filter-select"
                  value={filters.branch ?? ''}
                  onChange={(e) => setFilters((p) => ({ ...p, branch: e.target.value || null }))}
                >
                  <option value="">All branches</option>
                  {availableBranches.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              )}
              {availableEvents.length > 1 && (
                <select
                  className="ci-filter-select"
                  value={filters.event ?? ''}
                  onChange={(e) => setFilters((p) => ({ ...p, event: e.target.value || null }))}
                >
                  <option value="">All events</option>
                  {availableEvents.map((ev) => <option key={ev} value={ev}>{ev}</option>)}
                </select>
              )}
              <label className="ci-filter-stale-toggle">
                <input
                  type="checkbox"
                  checked={filters.showStaleQueued}
                  onChange={(e) => setFilters((p) => ({ ...p, showStaleQueued: e.target.checked }))}
                />
                Show stale queued{staleQueuedCount > 0 ? ` (${staleQueuedCount})` : ''}
              </label>
              {hasActiveFilters && (
                <button className="ci-filter-clear" onClick={() => setFilters((p) => ({ ...p, status: new Set(), branch: null, event: null }))}>
                  Clear
                </button>
              )}
            </div>
          )}
          {!filtersExpanded && hasActiveFilters && (
            <span className="ci-filter-summary">
              {filters.status.size > 0 && [...filters.status].map((s) => s === 'in_progress' ? 'running' : s).join(', ')}
              {filters.branch && `${filters.status.size > 0 ? ' · ' : ''}${filters.branch}`}
              {filters.event && `${filters.status.size > 0 || filters.branch ? ' · ' : ''}${filters.event}`}
            </span>
          )}
        </div>

        {/* Active runs */}
        {filteredActiveRuns.length > 0 && (
          <div className="ci-active-section">
            <div className="ci-section-label">Active</div>
            {filteredActiveRuns.map((run) => (
              <div
                key={run.id}
                className={`ci-run-row ci-run-row-active${expandedRun === run.id ? ' ci-run-row-selected' : ''}`}
                onClick={() => handleExpandRun(run.id)}
              >
                <StatusDot color={getStatusColor(run)} animated={run.status === 'in_progress' || run.status === 'queued'} />
                <div className="ci-run-info">
                  <span className="ci-run-name">{run.name}</span>
                  <span className="ci-run-meta">#{run.runNumber} on <span className="ci-run-branch">{run.headBranch}</span></span>
                </div>
                <button className="ci-cancel-btn" onClick={(e) => { e.stopPropagation(); handleCancel(run.id) }} title="Cancel run">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" /><line x1="8" y1="8" x2="16" y2="16" /><line x1="16" y1="8" x2="8" y2="16" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Run history */}
        <div className="ci-run-list" ref={scrollRef} onScroll={handleScroll}>
          {filteredRuns.map((run) => (
            <div
              key={run.id}
              className={`ci-run-row${expandedRun === run.id ? ' ci-run-row-selected' : ''}`}
              onClick={() => handleExpandRun(run.id)}
            >
              <StatusDot color={getStatusColor(run)} />
              <div className="ci-run-info">
                <span className="ci-run-name">{run.name}</span>
                <span className="ci-run-meta">
                  #{run.runNumber} · <span className="ci-run-branch">{run.headBranch}</span> · {run.event} · {formatTime(run.createdAt)}
                </span>
              </div>
            </div>
          ))}
          {filteredRuns.length === 0 && !loadingRuns && runs.length > 0 && (
            <div className="ci-end-marker">No runs match filters</div>
          )}
          {loadingRuns && <div className="ci-loading-more"><div className="ci-spinner" /></div>}
          {!hasMore && filteredRuns.length > 0 && <div className="ci-end-marker">No more runs</div>}
        </div>
      </div>

      {/* Detail panel */}
      {selectedRun && (
        <>
          <CiResizeHandle targetRef={detailRef} min={280} max={910} storageKey="ci-detail-width" />
          <div className="ci-detail-pane" ref={detailRef}>
            <RunDetailPanel
              run={selectedRun}
              jobs={runJobs}
              jobGroups={jobGroups}
              loadingJobs={loadingJobs}
              expandedGroups={expandedGroups}
              provider={provider}
              projectDir={projectDir}
              onToggleGroup={toggleGroup}
              onClose={() => setExpandedRun(null)}
              onCancel={handleCancel}
              onOpenUrl={(url) => api.app.openExternal(url)}
            />
          </div>
        </>
      )}
    </div>
  )
}

function RunDetailPanel({ run, jobs, jobGroups, loadingJobs, expandedGroups, provider, projectDir, onToggleGroup, onClose, onCancel, onOpenUrl }: {
  run: CiWorkflowRun
  jobs: CiJob[]
  jobGroups: CiJobGroup[]
  loadingJobs: boolean
  expandedGroups: Set<string>
  provider: GitProvider
  projectDir: string
  onToggleGroup: (key: string) => void
  onClose: () => void
  onCancel: (runId: number) => void
  onOpenUrl: (url: string) => void
}) {
  const api = getDockApi()
  const [logJobId, setLogJobId] = useState<number | null>(null)
  const [logText, setLogText] = useState<string>('')
  const [logLoading, setLogLoading] = useState(false)
  const [logStepFilter, setLogStepFilter] = useState<string | null>(null)

  const effectiveStatus = getEffectiveStatus(run)
  const statusLabel = effectiveStatus === 'in_progress' ? 'Running' : effectiveStatus.charAt(0).toUpperCase() + effectiveStatus.slice(1)
  const totalDuration = run.status === 'completed' ? formatDuration(run.createdAt, run.updatedAt) : null

  const viewJobLog = useCallback(async (jobId: number, stepName?: string) => {
    setLogJobId(jobId)
    setLogStepFilter(stepName ?? null)
    setLogLoading(true)
    setLogText('')
    try {
      const text = await api.ci.getJobLog(projectDir, jobId)
      setLogText(text || 'No log output available.')
    } catch {
      setLogText('Failed to fetch logs.')
    }
    setLogLoading(false)
  }, [projectDir])

  const closeLog = useCallback(() => {
    setLogJobId(null)
    setLogText('')
    setLogStepFilter(null)
  }, [])

  // Filter log text to a specific step if requested
  const displayLog = useMemo(() => {
    if (!logStepFilter || !logText) return logText
    // GitHub logs format: each line starts with the step timestamp then step name
    // Try to extract lines belonging to the step section
    const lines = logText.split('\n')
    const stepLines: string[] = []
    let inStep = false
    for (const line of lines) {
      // GitHub job log sections are delimited by lines starting with "##[group]StepName"
      if (line.includes(`##[group]${logStepFilter}`)) {
        inStep = true
        continue
      }
      if (inStep && line.includes('##[endgroup]')) {
        break
      }
      if (inStep) stepLines.push(line)
    }
    return stepLines.length > 0 ? stepLines.join('\n') : logText
  }, [logText, logStepFilter])

  if (logJobId !== null) {
    return (
      <div className="ci-detail">
        <div className="ci-detail-header">
          <button className="ci-detail-back" onClick={closeLog} title="Back to run details">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <span className="ci-detail-title">{logStepFilter || 'Job Log'}</span>
          <button className="ci-detail-close" onClick={onClose}>{'\u2715'}</button>
        </div>
        <div className="ci-log-viewer">
          {logLoading ? (
            <div className="ci-jobs-loading"><div className="ci-spinner" /> Loading logs...</div>
          ) : (
            <pre className="ci-log-content">{displayLog}</pre>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="ci-detail">
      <div className="ci-detail-header">
        <span className="ci-detail-title">{run.name}</span>
        <div className="ci-detail-header-actions">
          {(effectiveStatus === 'in_progress' || effectiveStatus === 'queued') && (
            <button className="ci-detail-icon-btn ci-detail-icon-cancel" onClick={() => onCancel(run.id)} title="Cancel run">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" /><line x1="8" y1="8" x2="16" y2="16" /><line x1="16" y1="8" x2="8" y2="16" />
              </svg>
            </button>
          )}
          {run.url && (
            <button className="ci-detail-icon-btn" onClick={() => onOpenUrl(run.url)} title={`View on ${providerLabel(provider)}`}>
              <ProviderIcon provider={provider} />
            </button>
          )}
          <button className="ci-detail-close" onClick={onClose}>{'\u2715'}</button>
        </div>
      </div>

      <div className="ci-detail-body">
        {/* Status banner */}
        <div className={`ci-detail-status ci-detail-status-${effectiveStatus}`}>
          <StatusDot color={getStatusColor(run)} animated={effectiveStatus === 'in_progress' || effectiveStatus === 'queued'} />
          <span className="ci-detail-status-label">{statusLabel}</span>
          {totalDuration && <span className="ci-detail-duration">{totalDuration}</span>}
        </div>

        {/* Info grid */}
        <div className="ci-detail-info">
          <div className="ci-detail-row">
            <span className="ci-detail-label">Run</span>
            <span className="ci-detail-value">#{run.runNumber} (attempt {run.runAttempt})</span>
          </div>
          <div className="ci-detail-row">
            <span className="ci-detail-label">Branch</span>
            <span className="ci-detail-value ci-run-branch">{run.headBranch}</span>
          </div>
          <div className="ci-detail-row">
            <span className="ci-detail-label">Event</span>
            <span className="ci-detail-value">{run.event}</span>
          </div>
          <div className="ci-detail-row">
            <span className="ci-detail-label">Actor</span>
            <span className="ci-detail-value">{run.actor}</span>
          </div>
          <div className="ci-detail-row">
            <span className="ci-detail-label">Commit</span>
            <span className="ci-detail-value ci-detail-sha">{run.headSha.slice(0, 7)}</span>
          </div>
          <div className="ci-detail-row">
            <span className="ci-detail-label">Started</span>
            <span className="ci-detail-value">{new Date(run.createdAt).toLocaleString()}</span>
          </div>
        </div>

        {/* Jobs */}
        <div className="ci-detail-jobs-header">Jobs</div>
        <div className="ci-detail-jobs">
          {loadingJobs ? (
            <div className="ci-jobs-loading"><div className="ci-spinner" /> Loading jobs...</div>
          ) : jobs.length === 0 ? (
            <div className="ci-jobs-empty">No jobs found</div>
          ) : (
            jobGroups.map((group) => (
              <DetailJobGroup
                key={group.key}
                group={group}
                expanded={expandedGroups.has(group.key)}
                onToggle={() => onToggleGroup(group.key)}
                onViewLog={viewJobLog}
              />
            ))
          )}
        </div>
      </div>
    </div>
  )
}

function LogIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
    </svg>
  )
}

function DetailJobGroup({ group, expanded, onToggle, onViewLog }: {
  group: CiJobGroup; expanded: boolean; onToggle: () => void
  onViewLog: (jobId: number, stepName?: string) => void
}) {
  const [expandedJobs, setExpandedJobs] = useState<Set<number>>(() => loadExpandedJobs())

  const toggleJob = useCallback((jobId: number) => {
    setExpandedJobs((prev) => {
      const next = new Set(prev)
      if (next.has(jobId)) next.delete(jobId)
      else next.add(jobId)
      saveExpandedJobs(next)
      return next
    })
  }, [])

  const renderJob = (job: CiJob, label: string) => {
    const duration = job.completedAt && job.startedAt ? formatDuration(job.startedAt, job.completedAt) : null
    const jobExpanded = expandedJobs.has(job.id)
    const hasSteps = job.steps.length > 0
    return (
      <div key={job.id} className="ci-detail-job">
        <div className="ci-detail-job-header" onClick={hasSteps ? () => toggleJob(job.id) : undefined} style={hasSteps ? { cursor: 'pointer' } : undefined}>
          {hasSteps && <span className="ci-expand-icon">{jobExpanded ? '\u25BC' : '\u25B6'}</span>}
          <StatusDot color={jobStatusColor(job.status, job.conclusion)} animated={job.status === 'in_progress'} />
          <span className="ci-detail-job-name">{label}</span>
          {duration && <span className="ci-detail-job-duration">{duration}</span>}
          <button className="ci-detail-log-btn" onClick={(e) => { e.stopPropagation(); onViewLog(job.id) }} title="View log">
            <LogIcon />
          </button>
        </div>
        {hasSteps && jobExpanded && (
          <div className="ci-detail-steps">
            {job.steps.map((step) => (
              <div key={step.number} className="ci-detail-step">
                <StepIcon status={step.status} conclusion={step.conclusion} />
                <span className="ci-detail-step-name">{step.name}</span>
                <button
                  className="ci-detail-step-log-btn"
                  onClick={() => onViewLog(job.id, step.name)}
                  title="View step log"
                >
                  <LogIcon />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  if (!group.isMatrix) {
    return renderJob(group.jobs[0], group.jobs[0].name)
  }

  return (
    <div className="ci-detail-matrix">
      <div className="ci-detail-matrix-header" onClick={onToggle}>
        <span className="ci-expand-icon">{expanded ? '\u25BC' : '\u25B6'}</span>
        <StatusDot color={jobStatusColor(group.overallStatus, group.overallConclusion)} />
        <span className="ci-detail-job-name">{group.key}</span>
        <span className="ci-matrix-count">({group.jobs.length})</span>
      </div>
      {expanded && group.jobs.map((job) => {
        const label = job.matrixValues ? Object.values(job.matrixValues).join(' / ') : job.name
        return renderJob(job, label)
      })}
    </div>
  )
}

function StepIcon({ status, conclusion }: { status: string; conclusion: string | null }) {
  if (status === 'completed') {
    if (conclusion === 'success') return <span className="ci-step-icon ci-step-success">{'\u2713'}</span>
    if (conclusion === 'failure') return <span className="ci-step-icon ci-step-failure">{'\u2717'}</span>
    if (conclusion === 'skipped') return <span className="ci-step-icon ci-step-skipped">{'\u2013'}</span>
    return <span className="ci-step-icon ci-step-skipped">{'\u2013'}</span>
  }
  if (status === 'in_progress') return <span className="ci-step-icon ci-step-running"><div className="ci-spinner" /></span>
  return <span className="ci-step-icon ci-step-pending">{'\u25CB'}</span>
}

function JobGroupRow({ group, expanded, onToggle }: { group: CiJobGroup; expanded: boolean; onToggle: () => void }) {
  if (!group.isMatrix) {
    const job = group.jobs[0]
    return (
      <div className="ci-job-item">
        <StatusDot color={jobStatusColor(job.status, job.conclusion)} animated={job.status === 'in_progress'} />
        <span className="ci-job-name">{job.name}</span>
        {job.completedAt && job.startedAt && (
          <span className="ci-job-duration">{formatDuration(job.startedAt, job.completedAt)}</span>
        )}
      </div>
    )
  }

  return (
    <div className="ci-matrix-group">
      <div className="ci-matrix-header" onClick={onToggle}>
        <span className="ci-expand-icon">{expanded ? '\u25BC' : '\u25B6'}</span>
        <StatusDot color={jobStatusColor(group.overallStatus, group.overallConclusion)} />
        <span className="ci-job-name">{group.key}</span>
        <span className="ci-matrix-count">({group.jobs.length})</span>
      </div>
      {expanded && (
        <div className="ci-matrix-variants">
          {group.jobs.map((job) => {
            const label = job.matrixValues
              ? Object.values(job.matrixValues).join(' / ')
              : job.name
            return (
              <div key={job.id} className="ci-job-item ci-matrix-variant">
                <StatusDot color={jobStatusColor(job.status, job.conclusion)} animated={job.status === 'in_progress'} />
                <span className="ci-job-name">{label}</span>
                {job.completedAt && job.startedAt && (
                  <span className="ci-job-duration">{formatDuration(job.startedAt, job.completedAt)}</span>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function CiSetupWizard({ setup, onRecheck, onOpenAuthLogin, onOpenDownload }: {
  setup: SetupState
  onRecheck: () => void
  onOpenAuthLogin: () => void
  onOpenDownload: () => void
}) {
  const stepIcon = (done: boolean) => done
    ? <span className="ci-setup-icon ci-setup-done">&#10003;</span>
    : <span className="ci-setup-icon ci-setup-pending">&#9675;</span>

  // Determine which step is the current blocker
  const currentStep = !setup.ghInstalled ? 1 : !setup.ghAuthenticated ? 2 : 3

  const recheckBtn = (
    <button className="ci-setup-recheck-icon" onClick={onRecheck} disabled={setup.checking} title="Recheck">
      {setup.checking ? <div className="ci-spinner" /> : <SetupRefreshIcon />}
    </button>
  )

  return (
    <div className="ci-panel-center ci-setup-wizard">
      <div className="ci-empty-icon">CI</div>
      <div className="ci-empty-title">CI Setup Required</div>
      <div className="ci-setup-steps">
        <div className={`ci-setup-step${currentStep === 1 ? ' ci-setup-step-active' : ''}`}>
          {stepIcon(setup.ghInstalled)}
          <div className="ci-setup-step-content">
            <div className="ci-setup-step-label">Install GitHub CLI</div>
            {currentStep === 1 && (
              <div className="ci-setup-step-action">
                <span className="ci-setup-step-hint">The <code>gh</code> CLI is required to access GitHub Actions.</span>
                <div className="ci-setup-step-buttons">
                  <button className="ci-setup-btn" onClick={onOpenDownload}>Download CLI</button>
                  {recheckBtn}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className={`ci-setup-step${currentStep === 2 ? ' ci-setup-step-active' : ''}`}>
          {stepIcon(setup.ghAuthenticated)}
          <div className="ci-setup-step-content">
            <div className="ci-setup-step-label">Authenticate with GitHub</div>
            {currentStep === 2 && (
              <div className="ci-setup-step-action">
                <span className="ci-setup-step-hint">Sign in to your GitHub account via the CLI.</span>
                <div className="ci-setup-step-buttons">
                  <button className="ci-setup-btn" onClick={onOpenAuthLogin}>
                    {setup.loginOpened ? 'Open gh auth login again' : 'Run gh auth login'}
                  </button>
                  {recheckBtn}
                </div>
                {setup.loginOpened && (
                  <span className="ci-setup-step-hint ci-setup-step-hint-sub">Complete the login in the terminal window that opened, then recheck.</span>
                )}
              </div>
            )}
          </div>
        </div>

        <div className={`ci-setup-step${currentStep === 3 ? ' ci-setup-step-active' : ''}`}>
          {stepIcon(setup.hasRemote)}
          <div className="ci-setup-step-content">
            <div className="ci-setup-step-label">GitHub remote configured</div>
            {currentStep === 3 && (
              <div className="ci-setup-step-action">
                <span className="ci-setup-step-hint">This repository needs a GitHub remote. Add one with <code>git remote add origin &lt;url&gt;</code>.</span>
                <div className="ci-setup-step-buttons">
                  {recheckBtn}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function SetupRefreshIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 2v6h-6" /><path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M3 22v-6h6" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
    </svg>
  )
}

function FilterIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
    </svg>
  )
}

function StatusDot({ color, animated }: { color: string; animated?: boolean }) {
  return (
    <span className={`ci-status-dot${animated ? ' ci-status-dot-animated' : ''}`} style={{ background: color }} />
  )
}

function StatusBadge({ status, conclusion }: { status: string; conclusion: string | null }) {
  let cls = 'ci-badge'
  let label = status
  if (status === 'completed' && conclusion) {
    label = conclusion
    cls += ` ci-badge-${conclusion}`
  } else {
    cls += ` ci-badge-${status}`
  }
  return <span className={cls}>{label}</span>
}

function jobStatusColor(status: string, conclusion: string | null): string {
  if (status === 'completed' && conclusion) {
    if (conclusion === 'success') return '#9ece6a'
    if (conclusion === 'failure') return '#f7768e'
    return 'var(--text-secondary)'
  }
  if (status === 'in_progress') return '#e0af68'
  if (status === 'queued') return 'var(--accent-color)'
  return 'var(--text-secondary)'
}

function CiResizeHandle({ targetRef, min, max, storageKey }: {
  targetRef: React.RefObject<HTMLDivElement | null>
  min: number
  max: number
  storageKey: string
}) {
  useEffect(() => {
    if (!targetRef.current) return
    const saved = localStorage.getItem(storageKey)
    if (saved) {
      const w = parseInt(saved, 10)
      if (w >= min && w <= max) targetRef.current.style.width = `${w}px`
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

  return <div className="ci-resize-handle" onMouseDown={handleMouseDown} />
}

function RefreshIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 2v6h-6" /><path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M3 22v-6h6" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
    </svg>
  )
}

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

function formatDuration(start: string, end: string): string {
  const ms = new Date(end).getTime() - new Date(start).getTime()
  if (ms < 0) return ''
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  const remSec = sec % 60
  if (min < 60) return `${min}m ${remSec}s`
  const hr = Math.floor(min / 60)
  const remMin = min % 60
  return `${hr}h ${remMin}m`
}
