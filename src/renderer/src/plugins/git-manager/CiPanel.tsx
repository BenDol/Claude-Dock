import React, { useEffect, useState, useCallback, useRef } from 'react'
import { getDockApi } from '../../lib/ipc-bridge'
import type { CiWorkflow, CiWorkflowRun, CiJob, CiJobGroup } from '../../../../shared/ci-types'
import { groupJobsByMatrix } from '../../../../shared/ci-types'

interface CiPanelProps {
  projectDir: string
}

type CiStatus = 'loading' | 'setup' | 'ready' | 'error'

interface SetupState {
  ghInstalled: boolean
  ghAuthenticated: boolean
  hasRemote: boolean
  checking: boolean
  loginOpened: boolean
}

export default function CiPanel({ projectDir }: CiPanelProps) {
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
  const [expandedRun, setExpandedRun] = useState<number | null>(null)
  const [runJobs, setRunJobs] = useState<CiJob[]>([])
  const [loadingJobs, setLoadingJobs] = useState(false)
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const scrollRef = useRef<HTMLDivElement>(null)
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

  // Check availability + load workflows
  useEffect(() => {
    let cancelled = false
    async function init() {
      try {
        const available = await api.ci.checkAvailable(projectDir)
        if (cancelled) return
        if (!available) {
          await checkSetup()
          return
        }
        const wf = await api.ci.getWorkflows(projectDir)
        if (cancelled) return
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

  // Poll active runs
  useEffect(() => {
    if (status !== 'ready') return
    let timer: ReturnType<typeof setInterval>
    const pollActive = async () => {
      try {
        const active = await api.ci.getActiveRuns(projectDir)
        setActiveRuns(active)
      } catch { /* ignore */ }
    }
    pollActive()
    timer = setInterval(pollActive, 10_000)
    return () => clearInterval(timer)
  }, [status, projectDir])

  const loadRuns = useCallback(async (p: number, reset?: boolean) => {
    if (loadingRuns) return
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
    setLoadingRuns(false)
  }, [loadingRuns, selectedWorkflow, workflows, projectDir])

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
      return next
    })
  }, [])

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
            // All checks passed — load workflows
            try {
              const wf = await api.ci.getWorkflows(projectDir)
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

  const jobGroups = groupJobsByMatrix(runJobs)

  return (
    <div className="ci-panel">
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

      {/* Active runs */}
      {activeRuns.length > 0 && (
        <div className="ci-active-section">
          <div className="ci-section-label">Active Runs</div>
          {activeRuns.map((run) => (
            <div key={run.id} className="ci-active-card">
              <StatusBadge status={run.status} conclusion={run.conclusion} />
              <div className="ci-run-info">
                <span className="ci-run-name">{run.name}</span>
                <span className="ci-run-meta">#{run.runNumber} on {run.headBranch}</span>
              </div>
              <button className="ci-cancel-btn" onClick={() => handleCancel(run.id)} title="Cancel">Cancel</button>
              {run.url && (
                <button className="ci-view-btn" onClick={() => api.app.openExternal(run.url)} title="View on GitHub">View</button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Run history */}
      <div className="ci-section-label">Run History</div>
      <div className="ci-run-list" ref={scrollRef} onScroll={handleScroll}>
        {runs.map((run) => (
          <div key={run.id} className="ci-run-item">
            <div className="ci-run-row" onClick={() => handleExpandRun(run.id)}>
              <span className="ci-expand-icon">{expandedRun === run.id ? '\u25BE' : '\u25B8'}</span>
              <StatusBadge status={run.status} conclusion={run.conclusion} />
              <div className="ci-run-info">
                <span className="ci-run-name">{run.name}</span>
                <span className="ci-run-meta">
                  #{run.runNumber} · {run.headBranch} · {run.actor} · {formatTime(run.createdAt)}
                </span>
              </div>
              {run.url && (
                <button
                  className="ci-view-btn ci-view-btn-sm"
                  onClick={(e) => { e.stopPropagation(); api.app.openExternal(run.url) }}
                  title="View on GitHub"
                >
                  View
                </button>
              )}
            </div>
            {expandedRun === run.id && (
              <div className="ci-jobs-panel">
                {loadingJobs ? (
                  <div className="ci-jobs-loading"><div className="ci-spinner" /> Loading jobs...</div>
                ) : runJobs.length === 0 ? (
                  <div className="ci-jobs-empty">No jobs found</div>
                ) : (
                  jobGroups.map((group) => (
                    <JobGroupRow
                      key={group.key}
                      group={group}
                      expanded={expandedGroups.has(group.key)}
                      onToggle={() => toggleGroup(group.key)}
                    />
                  ))
                )}
              </div>
            )}
          </div>
        ))}
        {loadingRuns && <div className="ci-loading-more"><div className="ci-spinner" /></div>}
        {!hasMore && runs.length > 0 && <div className="ci-end-marker">No more runs</div>}
      </div>
    </div>
  )
}

function JobGroupRow({ group, expanded, onToggle }: { group: CiJobGroup; expanded: boolean; onToggle: () => void }) {
  if (!group.isMatrix) {
    const job = group.jobs[0]
    return (
      <div className="ci-job-item">
        <StatusBadge status={job.status} conclusion={job.conclusion} />
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
        <span className="ci-expand-icon">{expanded ? '\u25BE' : '\u25B8'}</span>
        <StatusBadge status={group.overallStatus} conclusion={group.overallConclusion} />
        <span className="ci-job-name">{group.key}</span>
        <span className="ci-matrix-count">({group.jobs.length} variants)</span>
      </div>
      {expanded && (
        <div className="ci-matrix-variants">
          {group.jobs.map((job) => {
            const label = job.matrixValues
              ? Object.values(job.matrixValues).join(' / ')
              : job.name
            return (
              <div key={job.id} className="ci-job-item ci-matrix-variant">
                <StatusBadge status={job.status} conclusion={job.conclusion} />
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
