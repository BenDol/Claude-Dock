import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { getDockApi } from '../../lib/ipc-bridge'
import type { CiWorkflow, CiWorkflowRun, CiJob, CiJobGroup, CiSetupStatus } from '../../../../shared/ci-types'
import { groupJobsByMatrix } from '../../../../shared/ci-types'
import type { GitProvider } from '../../../../shared/remote-url'
import { ProviderIcon, providerLabel } from './ProviderIcons'

export interface CiLogSearchMatch {
  id: string
  runId: number
  runName: string
  runNumber: number
  jobId: number
  jobName: string
  matchCount: number
  firstMatchPreview: string
}

export interface CiSearchProgress {
  searched: number
  total: number
  done?: boolean
  scope?: 'run' | 'all'
}

interface CiPanelProps {
  projectDir: string
  provider: GitProvider
  searchQuery?: string
  currentBranch?: string
  active?: boolean
  pendingRunId?: number | null
  onNavigated?: () => void
}

type CiStatus = 'loading' | 'setup' | 'ready' | 'error'

interface SetupState {
  setupStatus: CiSetupStatus | null
  checking: boolean
  actionTriggered: Set<string>
}

type ConclusionFilter = 'success' | 'failure' | 'cancelled' | 'in_progress' | 'queued'

interface CiFilters {
  status: Set<ConclusionFilter>
  branches: Set<string>
  event: string | null
  showStaleQueued: boolean
}

// Session-level cache so we don't re-check CLI availability on every tab switch
const ciAvailabilityCache = new Map<string, { available: boolean; workflows: CiWorkflow[]; providerKey?: string }>()

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

export default function CiPanel({ projectDir, provider, searchQuery, currentBranch, active, pendingRunId, onNavigated }: CiPanelProps) {
  const [status, setStatus] = useState<CiStatus>('loading')
  const [errorMsg, setErrorMsg] = useState('')
  const [setup, setSetup] = useState<SetupState>({ setupStatus: null, checking: false, actionTriggered: new Set() })
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
  const [runProgress, setRunProgress] = useState<Map<number, number>>(new Map())
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => loadExpandedGroups())
  const [filters, setFilters] = useState<CiFilters>(() => ({
    status: new Set(),
    branches: currentBranch ? new Set([currentBranch]) : new Set(),
    event: null,
    showStaleQueued: false
  }))
  const [filtersExpanded, setFiltersExpanded] = useState(false)
  const [ciProviderKey, setCiProviderKey] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const detailRef = useRef<HTMLDivElement>(null)
  const pollingRef = useRef(false)
  const lastCiRefreshRef = useRef(0)

  // Cross-log search state
  const [ciLogOpenLocal, setCiLogOpenLocal] = useState(false)
  const [autoOpenJob, setAutoOpenJob] = useState<{ runId: number; jobId: number } | null>(null)
  const logCacheRef = useRef<Map<number, string>>(new Map())
  const searchAbortRef = useRef<AbortController | null>(null)

  const api = getDockApi()

  const checkSetup = useCallback(async () => {
    setSetup(prev => ({ ...prev, checking: true }))
    try {
      const setupStatus = await api.ci.getSetupStatus(projectDir)
      setSetup(prev => ({ ...prev, setupStatus, checking: false }))
      if (!setupStatus.ready) {
        setStatus('setup')
        return false
      }
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
        if (cached.providerKey) setCiProviderKey(cached.providerKey)
        setWorkflows(cached.workflows)
        setStatus('ready')
        return
      }

      try {
        const result = await api.ci.checkAvailable(projectDir)
        if (cancelled) return
        if (!result) {
          ciAvailabilityCache.set(projectDir, { available: false, workflows: [] })
          await checkSetup()
          return
        }
        setCiProviderKey(result)
        const wf = await api.ci.getWorkflows(projectDir)
        if (cancelled) return
        ciAvailabilityCache.set(projectDir, { available: true, workflows: wf, providerKey: result })
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

  // Reset state when project dir changes (e.g. submodule navigation)
  useEffect(() => {
    setRuns([])
    setActiveRuns([])
    setPage(1)
    setHasMore(true)
    setExpandedRun(null)
    setRunJobs([])
    setFilters({
      status: new Set(),
      branches: currentBranch ? new Set([currentBranch]) : new Set(),
      event: null,
      showStaleQueued: false
    })
  }, [projectDir])

  // Update branch filter when currentBranch changes (new repo detected)
  useEffect(() => {
    if (!currentBranch) return
    setFilters((prev) => ({
      ...prev,
      branches: new Set([currentBranch])
    }))
  }, [currentBranch])

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

        // Fetch job progress for in-progress runs only (queued runs have no jobs yet)
        const progressMap = new Map<number, number>()
        const inProgressRuns = active.filter((r) => r.status === 'in_progress')
        await Promise.all(inProgressRuns.map(async (run) => {
          try {
            const jobs = await api.ci.getRunJobs(projectDir, run.id)
            if (jobs.length === 0) return
            // Exclude skipped jobs — they don't contribute to progress
            const relevant = jobs.filter((j) => j.conclusion !== 'skipped')
            if (relevant.length === 0) return
            let done = 0
            for (const j of relevant) {
              if (j.status === 'completed') { done += 1; continue }
              // For in-progress jobs, use step ratio as a fractional contribution
              if (j.status === 'in_progress' && j.steps.length > 0) {
                const completedSteps = j.steps.filter((s) => s.status === 'completed').length
                done += completedSteps / j.steps.length
              }
              // queued/waiting = 0 contribution
            }
            progressMap.set(run.id, Math.round((done / relevant.length) * 100))
          } catch { /* ignore */ }
        }))
        setRunProgress((prev) => {
          const next = new Map(prev)
          for (const [id, pct] of progressMap) next.set(id, pct)
          // Clean up runs no longer active
          for (const id of next.keys()) { if (!activeIds.has(id)) next.delete(id) }
          return next
        })

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
      if (reset) lastCiRefreshRef.current = Date.now()
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
      setAutoOpenJob(null)
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

  const [cancellingRuns, setCancellingRuns] = useState<Set<number>>(new Set())

  const handleCancel = useCallback(async (runId: number) => {
    setCancellingRuns((prev) => new Set(prev).add(runId))
    try {
      await api.ci.cancelRun(projectDir, runId)
      // Refresh active runs immediately
      const active = await api.ci.getActiveRuns(projectDir)
      setActiveRuns(active)
      // Refresh the full run list after a short delay to show final state
      setTimeout(() => {
        loadRuns(1, true)
        setCancellingRuns((prev) => { const next = new Set(prev); next.delete(runId); return next })
      }, 3000)
    } catch {
      setCancellingRuns((prev) => { const next = new Set(prev); next.delete(runId); return next })
    }
  }, [projectDir, loadRuns])

  const handleFixRunWithClaude = useCallback(async (run: CiWorkflowRun) => {
    const jobs = await api.ci.getRunJobs(projectDir, run.id)
    const failedJobs = jobs.filter((j) => j.conclusion === 'failure')
    const failedJobSummaries = failedJobs.map((j) => ({
      id: j.id,
      name: j.name,
      failedSteps: j.steps.filter((s) => s.conclusion === 'failure').map((s) => s.name)
    }))
    api.ci.fixWithClaude(projectDir, {
      runId: run.id,
      runName: run.name,
      runNumber: run.runNumber,
      headBranch: run.headBranch,
      failedJobs: failedJobSummaries,
      primaryFailedJobId: failedJobSummaries[0]?.id
    })
  }, [projectDir])

  const handleRefresh = useCallback(() => {
    setPage(1)
    setRuns([])
    setHasMore(true)
    loadRuns(1, true)
  }, [loadRuns])

  // Refresh runs when tab becomes active (10s cooldown)
  useEffect(() => {
    if (active && status === 'ready' && Date.now() - lastCiRefreshRef.current > 10000) {
      handleRefresh()
    }
  }, [active])

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
  const availableBranches = useMemo(() => {
    const set = new Set(runs.map((r) => r.headBranch))
    if (currentBranch) set.add(currentBranch)
    return [...set].sort()
  }, [runs, currentBranch])
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

  // Navigate to a specific run (shared logic for DOM events + pending prop)
  const navigateToRun = useCallback((runId: number) => {
    setExpandedRun(runId)
    setRunJobs([])
    setLoadingJobs(true)
    api.ci.getRunJobs(projectDir, runId)
      .then((jobs) => setRunJobs(jobs))
      .catch(() => {})
      .finally(() => setLoadingJobs(false))
  }, [projectDir])

  // Listen for navigate-to-run DOM events (from within this window)
  useEffect(() => {
    const handler = (e: Event) => {
      const runId = (e as CustomEvent).detail as number
      if (runId) navigateToRun(runId)
    }
    window.addEventListener('ci-navigate-run', handler)
    return () => window.removeEventListener('ci-navigate-run', handler)
  }, [navigateToRun])

  // Process pending navigation from dock notifications — waits until runs are loaded
  useEffect(() => {
    if (!pendingRunId || status !== 'ready' || loadingRuns) return
    navigateToRun(pendingRunId)
    onNavigated?.()
  }, [pendingRunId, status, loadingRuns, navigateToRun, onNavigated])

  // Track whether RunDetailPanel has a log viewer open
  useEffect(() => {
    const handler = (e: Event) => {
      setCiLogOpenLocal((e as CustomEvent).detail as boolean)
    }
    window.addEventListener('ci-log-view', handler)
    return () => window.removeEventListener('ci-log-view', handler)
  }, [])

  // Listen for ci-open-job-log events (from search result clicks)
  useEffect(() => {
    const handler = (e: Event) => {
      const { runId, jobId } = (e as CustomEvent).detail as { runId: number; jobId: number }
      setAutoOpenJob({ runId, jobId })
      if (expandedRun !== runId) {
        navigateToRun(runId)
      }
    }
    window.addEventListener('ci-open-job-log', handler)
    return () => window.removeEventListener('ci-open-job-log', handler)
  }, [expandedRun, navigateToRun])

  // Apply filters — exclude runs already shown in the active section
  const activeRunIds = useMemo(() => new Set(filteredActiveRuns.map((r) => r.id)), [filteredActiveRuns])

  const filteredRuns = useMemo(() => {
    return runs.filter((run) => {
      // Skip runs already in the active section
      if (activeRunIds.has(run.id)) return false
      // Prune stale queued unless user opted in
      if (!filters.showStaleQueued && isStaleQueued(run)) return false
      // Status filter
      if (filters.status.size > 0 && !filters.status.has(getEffectiveStatus(run))) return false
      // Branch filter
      if (filters.branches.size > 0 && !filters.branches.has(run.headBranch)) return false
      // Event filter
      if (filters.event && run.event !== filters.event) return false
      return true
    })
  }, [runs, filters, activeRunIds])

  const toggleStatusFilter = useCallback((s: ConclusionFilter) => {
    setFilters((prev) => {
      const next = new Set(prev.status)
      if (next.has(s)) next.delete(s)
      else next.add(s)
      return { ...prev, status: next }
    })
  }, [])

  const toggleBranchFilter = useCallback((branch: string) => {
    setFilters((prev) => {
      const next = new Set(prev.branches)
      if (next.has(branch)) next.delete(branch)
      else next.add(branch)
      return { ...prev, branches: next }
    })
  }, [])

  const hasActiveFilters = filters.status.size > 0 || filters.branches.size > 0 || filters.event !== null

  // Cross-log search: search job logs when on CI tab without a specific log open
  useEffect(() => {
    if (!searchQuery?.trim() || ciLogOpenLocal || status !== 'ready') {
      window.dispatchEvent(new CustomEvent('ci-search-results', { detail: { results: [], progress: null } }))
      return
    }

    const scope: 'run' | 'all' = expandedRun !== null ? 'run' : 'all'

    // When a run is selected but jobs are still loading, wait
    if (expandedRun !== null && loadingJobs) {
      window.dispatchEvent(new CustomEvent('ci-search-results', {
        detail: { results: [], progress: { searched: 0, total: 0, done: false, scope } }
      }))
      return
    }

    const query = searchQuery.trim().toLowerCase()

    // Signal that a new search is starting (null progress = pending, not "0/0")
    window.dispatchEvent(new CustomEvent('ci-search-results', {
      detail: { results: [], progress: null }
    }))

    searchAbortRef.current?.abort()
    const abort = new AbortController()
    searchAbortRef.current = abort

    const timer = setTimeout(async () => {
      if (abort.signal.aborted) return

      // Determine scope: expanded run's jobs or all visible runs
      let jobsToSearch: Array<{ job: CiJob; run: CiWorkflowRun }> = []

      if (expandedRun !== null) {
        const run = [...filteredActiveRuns, ...filteredRuns].find(r => r.id === expandedRun)
        if (run && runJobs.length > 0) {
          jobsToSearch = runJobs.map(job => ({ job, run }))
        }
      } else {
        const visibleRuns = [...filteredActiveRuns, ...filteredRuns].slice(0, 10)
        for (const run of visibleRuns) {
          if (abort.signal.aborted) return
          try {
            const jobs = await api.ci.getRunJobs(projectDir, run.id)
            for (const job of jobs) {
              jobsToSearch.push({ job, run })
            }
          } catch { /* skip */ }
        }
      }

      if (abort.signal.aborted) return

      const total = jobsToSearch.length
      let searched = 0
      const results: CiLogSearchMatch[] = []

      // Emit initial progress with real total
      window.dispatchEvent(new CustomEvent('ci-search-results', {
        detail: { results: [], progress: { searched: 0, total, done: false, scope } }
      }))

      for (const { job, run } of jobsToSearch) {
        if (abort.signal.aborted) return

        // Fetch log (cached)
        let log = logCacheRef.current.get(job.id)
        if (log === undefined) {
          try {
            log = await api.ci.getJobLog(projectDir, job.id) || ''
          } catch {
            log = ''
          }
          logCacheRef.current.set(job.id, log)
        }

        // Search log — collect match count and first match preview per job
        if (log) {
          let matchCount = 0
          let firstPreview = ''
          const lines = log.split('\n')
          for (const line of lines) {
            const cleanLine = line
              .replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+/, '')
              .replace(/^##\[\w+\]/, '')
            if (cleanLine.toLowerCase().includes(query)) {
              matchCount++
              if (!firstPreview) firstPreview = cleanLine.trim().slice(0, 200)
            }
          }
          if (matchCount > 0) {
            results.push({
              id: `${run.id}-${job.id}`,
              runId: run.id,
              runName: run.name,
              runNumber: run.runNumber,
              jobId: job.id,
              jobName: job.name,
              matchCount,
              firstMatchPreview: firstPreview
            })
          }
        }

        searched++

        if (!abort.signal.aborted) {
          window.dispatchEvent(new CustomEvent('ci-search-results', {
            detail: { results: [...results], progress: { searched, total, done: searched === total, scope } }
          }))
        }
      }

      // Final emit
      if (!abort.signal.aborted) {
        window.dispatchEvent(new CustomEvent('ci-search-results', {
          detail: { results, progress: { searched, total, done: true, scope } }
        }))
      }
    }, 500)

    return () => {
      clearTimeout(timer)
      abort.abort()
    }
  }, [searchQuery, ciLogOpenLocal, expandedRun, runJobs, loadingJobs, filteredActiveRuns, filteredRuns, projectDir, status])

  if (status === 'loading') {
    return <div className="ci-panel-center"><div className="ci-spinner" /> Checking CI availability...</div>
  }

  if (status === 'setup') {
    return (
      <CiSetupWizard
        setup={setup}
        projectDir={projectDir}
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
        onActionTriggered={(actionId) => {
          setSetup(prev => ({ ...prev, actionTriggered: new Set(prev.actionTriggered).add(actionId) }))
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
        <div className="ci-empty-hint">This repository has no CI workflows configured.</div>
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
          {workflows.length > 1 ? (
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
          ) : (
            <span className="ci-workflow-label">{workflows[0]?.name || 'Pipelines'}</span>
          )}
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
              {availableBranches.length > 0 && (
                <BranchFilterDropdown
                  branches={availableBranches}
                  selected={filters.branches}
                  currentBranch={currentBranch}
                  onToggle={toggleBranchFilter}
                />
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
                <button className="ci-filter-clear" onClick={() => setFilters((p) => ({ ...p, status: new Set(), branches: new Set(), event: null }))}>
                  Clear
                </button>
              )}
            </div>
          )}
          {!filtersExpanded && hasActiveFilters && (
            <span className="ci-filter-summary">
              {filters.status.size > 0 && [...filters.status].map((s) => s === 'in_progress' ? 'running' : s).join(', ')}
              {filters.branches.size > 0 && `${filters.status.size > 0 ? ' · ' : ''}${[...filters.branches].join(', ')}`}
              {filters.event && `${filters.status.size > 0 || filters.branches.size > 0 ? ' · ' : ''}${filters.event}`}
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
                  <span className="ci-run-name">
                    {run.name}
                    {runProgress.has(run.id) && <span className="ci-run-pct">{runProgress.get(run.id)}%</span>}
                  </span>
                  <span className="ci-run-meta">#{run.runNumber} on <span className="ci-run-branch">{run.headBranch}</span></span>
                </div>
                <button
                  className={`ci-cancel-btn${cancellingRuns.has(run.id) ? ' ci-cancel-btn-active' : ''}`}
                  onClick={(e) => { e.stopPropagation(); handleCancel(run.id) }}
                  disabled={cancellingRuns.has(run.id)}
                  title={cancellingRuns.has(run.id) ? 'Cancelling...' : 'Cancel run'}
                >
                  {cancellingRuns.has(run.id) ? (
                    <span className="ci-cancel-spinner" />
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" /><line x1="8" y1="8" x2="16" y2="16" /><line x1="16" y1="8" x2="8" y2="16" />
                    </svg>
                  )}
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
              <StatusDot color={getStatusColor(run)} animated={run.status === 'in_progress'} />
              <div className="ci-run-info">
                <span className="ci-run-name">
                  {run.name}
                  {runProgress.has(run.id) && <span className="ci-run-pct">{runProgress.get(run.id)}%</span>}
                </span>
                <span className="ci-run-meta">
                  #{run.runNumber} · <span className="ci-run-branch">{run.headBranch}</span> · {run.event} · {formatTime(run.createdAt)}
                </span>
              </div>
              {run.conclusion === 'failure' && (
                <button className="ci-run-fix-btn" onClick={(e) => { e.stopPropagation(); handleFixRunWithClaude(run) }} title="Fix with Claude">
                  <ClaudeFixIcon />
                </button>
              )}
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
              key={selectedRun.id}
              run={selectedRun}
              jobs={runJobs}
              jobGroups={jobGroups}
              loadingJobs={loadingJobs}
              expandedGroups={expandedGroups}
              provider={(ciProviderKey as GitProvider) || provider}
              projectDir={projectDir}
              searchQuery={searchQuery}
              progress={runProgress.get(selectedRun.id)}
              onToggleGroup={toggleGroup}
              onClose={() => { setExpandedRun(null); setAutoOpenJob(null) }}
              onCancel={handleCancel}
              cancelling={cancellingRuns.has(selectedRun.id)}
              onOpenUrl={(url) => api.app.openExternal(url)}
              autoOpenJobId={autoOpenJob?.runId === selectedRun.id ? autoOpenJob.jobId : undefined}
              onAutoOpenHandled={() => setAutoOpenJob(null)}
            />
          </div>
        </>
      )}
    </div>
  )
}

function RunDetailPanel({ run, jobs, jobGroups, loadingJobs, expandedGroups, provider, projectDir, searchQuery, progress, onToggleGroup, onClose, onCancel, cancelling, onOpenUrl, autoOpenJobId, onAutoOpenHandled }: {
  run: CiWorkflowRun
  jobs: CiJob[]
  jobGroups: CiJobGroup[]
  loadingJobs: boolean
  expandedGroups: Set<string>
  provider: GitProvider
  projectDir: string
  searchQuery?: string
  progress?: number
  onToggleGroup: (key: string) => void
  onClose: () => void
  onCancel: (runId: number) => void
  cancelling?: boolean
  onOpenUrl: (url: string) => void
  autoOpenJobId?: number
  onAutoOpenHandled?: () => void
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
    window.dispatchEvent(new CustomEvent('ci-log-view', { detail: true }))
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
    window.dispatchEvent(new CustomEvent('ci-log-view', { detail: false }))
  }, [])

  // Auto-open a job log when navigated from search results
  useEffect(() => {
    if (autoOpenJobId && !loadingJobs && jobs.length > 0) {
      viewJobLog(autoOpenJobId)
      onAutoOpenHandled?.()
    }
  }, [autoOpenJobId, loadingJobs, jobs])

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
        {logLoading ? (
          <div className="ci-log-viewer"><div className="ci-jobs-loading"><div className="ci-spinner" /> Loading logs...</div></div>
        ) : (
          <CiLogViewer log={displayLog} searchQuery={searchQuery} />
        )}
      </div>
    )
  }

  return (
    <div className="ci-detail">
      <div className="ci-detail-header">
        <span className="ci-detail-title">{run.name}</span>
        <div className="ci-detail-header-actions">
          {(effectiveStatus === 'in_progress' || effectiveStatus === 'queued') && (
            <button
              className={`ci-detail-icon-btn ci-detail-icon-cancel${cancelling ? ' ci-cancel-btn-active' : ''}`}
              onClick={() => onCancel(run.id)}
              disabled={cancelling}
              title={cancelling ? 'Cancelling...' : 'Cancel run'}
            >
              {cancelling ? (
                <span className="ci-cancel-spinner" />
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" /><line x1="8" y1="8" x2="16" y2="16" /><line x1="16" y1="8" x2="8" y2="16" />
                </svg>
              )}
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
          {progress !== undefined && effectiveStatus === 'in_progress' && <span className="ci-detail-pct">{progress}%</span>}
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
                onFixWithClaude={(jobId) => {
                  const job = jobs.find((j) => j.id === jobId)
                  if (!job) return
                  const failedSteps = job.steps.filter((s) => s.conclusion === 'failure').map((s) => s.name)
                  const data = {
                    runId: run.id,
                    runName: run.name,
                    runNumber: run.runNumber,
                    headBranch: run.headBranch,
                    failedJobs: [{ id: job.id, name: job.name, failedSteps }],
                    primaryFailedJobId: job.id
                  }
                  api.ci.fixWithClaude(projectDir, data)
                }}
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

function ClaudeFixIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  )
}

function DetailJobGroup({ group, expanded, onToggle, onViewLog, onFixWithClaude }: {
  group: CiJobGroup; expanded: boolean; onToggle: () => void
  onViewLog: (jobId: number, stepName?: string) => void
  onFixWithClaude: (jobId: number) => void
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
          {job.conclusion === 'failure' && (
            <button className="ci-detail-fix-btn" onClick={(e) => { e.stopPropagation(); onFixWithClaude(job.id) }} title="Fix with Claude">
              <ClaudeFixIcon />
            </button>
          )}
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

function BranchFilterDropdown({ branches, selected, currentBranch, onToggle }: {
  branches: string[]
  selected: Set<string>
  currentBranch?: string
  onToggle: (branch: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Focus input when opening
  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim()
    if (!q) return branches
    return branches.filter((b) => b.toLowerCase().includes(q))
  }, [branches, search])

  const label = selected.size === 0
    ? 'Branches'
    : selected.size === 1
      ? [...selected][0]
      : `${selected.size} branches`

  return (
    <div className="ci-branch-dropdown" ref={containerRef}>
      <button
        className={`ci-branch-dropdown-trigger${selected.size > 0 ? ' ci-branch-dropdown-active' : ''}`}
        onClick={() => { setOpen((p) => !p); setSearch('') }}
      >
        <BranchIcon />
        <span className="ci-branch-dropdown-label">{label}</span>
        <span className={`ci-branch-dropdown-caret${open ? ' ci-branch-dropdown-caret-open' : ''}`}>{'\u25BE'}</span>
      </button>
      {open && (
        <div className="ci-branch-dropdown-menu">
          <input
            ref={inputRef}
            className="ci-branch-dropdown-search"
            type="text"
            placeholder="Filter branches..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setOpen(false)
            }}
          />
          <div className="ci-branch-dropdown-list">
            {filtered.length === 0 && (
              <div className="ci-branch-dropdown-empty">No branches match</div>
            )}
            {filtered.map((b) => (
              <button
                key={b}
                className={`ci-branch-dropdown-item${selected.has(b) ? ' ci-branch-dropdown-item-on' : ''}${b === currentBranch ? ' ci-branch-dropdown-item-current' : ''}`}
                onClick={() => onToggle(b)}
              >
                <span className="ci-branch-dropdown-check">{selected.has(b) ? '\u2713' : ''}</span>
                {b === currentBranch && <span className="ci-filter-current-dot" />}
                <span className="ci-branch-dropdown-name">{b}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function BranchIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  )
}

function CiSetupWizard({ setup, projectDir, onRecheck, onActionTriggered }: {
  setup: SetupState
  projectDir: string
  onRecheck: () => void
  onActionTriggered: (actionId: string) => void
}) {
  const api = getDockApi()
  const { setupStatus } = setup
  const [credValues, setCredValues] = useState<Record<string, string>>({})
  const [credSaving, setCredSaving] = useState(false)
  const [credError, setCredError] = useState<string | null>(null)

  if (!setupStatus) {
    return <div className="ci-panel-center"><div className="ci-spinner" /> Checking CI setup...</div>
  }

  const stepIcon = (status: 'ok' | 'missing' | 'checking') => {
    if (status === 'ok') return <span className="ci-setup-icon ci-setup-done">&#10003;</span>
    if (status === 'checking') return <span className="ci-setup-icon"><div className="ci-spinner" /></span>
    return <span className="ci-setup-icon ci-setup-pending">&#9675;</span>
  }

  // Find the first step that is not 'ok' — that's the active blocker
  const activeStepIndex = setupStatus.steps.findIndex((s) => s.status !== 'ok')

  const recheckBtn = (
    <button className="ci-setup-recheck-icon" onClick={onRecheck} disabled={setup.checking} title="Recheck">
      {setup.checking ? <div className="ci-spinner" /> : <SetupRefreshIcon />}
    </button>
  )

  const handleCredentialSubmit = async (step: typeof setupStatus.steps[0]) => {
    if (!step.actionId || !step.credentialFields) return
    const allFilled = step.credentialFields.every((f) => credValues[f.id]?.trim())
    if (!allFilled) return
    setCredSaving(true)
    setCredError(null)
    try {
      const result = await api.ci.runSetupAction(projectDir, step.actionId, credValues)
      if (result.success) {
        setCredValues({})
        onRecheck()
      } else {
        setCredError(result.error || 'Failed to save credentials')
      }
    } catch {
      setCredError('Failed to save credentials')
    } finally {
      setCredSaving(false)
    }
  }

  return (
    <div className="ci-panel-center ci-setup-wizard">
      <div className="ci-empty-icon">CI</div>
      <div className="ci-empty-title">{setupStatus.providerName} Setup Required</div>
      <div className="ci-setup-steps">
        {setupStatus.steps.map((step, i) => {
          const isActive = i === activeStepIndex
          const hasCredFields = step.credentialFields && step.credentialFields.length > 0
          return (
            <div key={step.id} className={`ci-setup-step${isActive ? ' ci-setup-step-active' : ''}`}>
              {stepIcon(step.status)}
              <div className="ci-setup-step-content">
                <div className="ci-setup-step-label">{step.label}</div>
                {isActive && (
                  <div className="ci-setup-step-action">
                    {step.helpText && <span className="ci-setup-step-hint">{step.helpText}</span>}
                    {hasCredFields && (
                      <div className="ci-setup-cred-form">
                        {step.credentialFields!.map((field) => (
                          <input
                            key={field.id}
                            type={field.type}
                            placeholder={field.placeholder || field.label}
                            value={credValues[field.id] || ''}
                            onChange={(e) => setCredValues((v) => ({ ...v, [field.id]: e.target.value }))}
                            onKeyDown={(e) => { if (e.key === 'Enter') handleCredentialSubmit(step) }}
                            className="ci-setup-cred-input"
                            disabled={credSaving}
                          />
                        ))}
                        {credError && <span className="ci-setup-cred-error">{credError}</span>}
                      </div>
                    )}
                    <div className="ci-setup-step-buttons">
                      {step.helpUrl && !hasCredFields && !step.actionId && (
                        <button className="ci-setup-btn" onClick={() => api.app.openExternal(step.helpUrl!)}>
                          {step.actionLabel || 'Download'}
                        </button>
                      )}
                      {hasCredFields && (
                        <>
                          <button
                            className="ci-setup-btn ci-setup-btn-primary"
                            disabled={credSaving || !step.credentialFields!.every((f) => credValues[f.id]?.trim())}
                            onClick={() => handleCredentialSubmit(step)}
                          >
                            {credSaving ? 'Saving...' : 'Save credentials'}
                          </button>
                          {step.helpUrl && (
                            <button className="ci-setup-btn" onClick={() => api.app.openExternal(step.helpUrl!)}>
                              {step.actionLabel || 'Help'}
                            </button>
                          )}
                        </>
                      )}
                      {step.actionId && !hasCredFields && (
                        <button
                          className="ci-setup-btn"
                          onClick={async () => {
                            onActionTriggered(step.actionId!)
                            const result = await api.ci.runSetupAction(projectDir, step.actionId!)
                            if (result.success) {
                              onRecheck()
                            } else if (result.error) {
                              setCredError(result.error)
                            }
                          }}
                        >
                          {setup.actionTriggered.has(step.actionId) ? `${step.actionLabel} again` : step.actionLabel}
                        </button>
                      )}
                      {recheckBtn}
                    </div>
                    {step.actionId && !hasCredFields && setup.actionTriggered.has(step.actionId) && (
                      credError
                        ? <span className="ci-setup-cred-error">{credError}</span>
                        : <span className="ci-setup-step-hint ci-setup-step-hint-sub">{step.actionHint || 'Complete the login in the terminal window that opened, then recheck.'}</span>
                    )}
                  </div>
                )}
              </div>
            </div>
          )
        })}
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

// --- Structured log viewer ---

type LogLineType = 'error' | 'warning' | 'notice' | 'group' | 'command' | 'debug' | 'normal'

interface ParsedLogLine {
  type: LogLineType
  timestamp: string | null
  text: string
  raw: string
}

const TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+/
const ANNOTATION_RE = /^##\[(error|warning|notice|debug|group|endgroup|command)\]/

function parseLogLine(line: string): ParsedLogLine {
  let text = line
  let timestamp: string | null = null

  // Extract leading timestamp
  const tsMatch = text.match(TIMESTAMP_RE)
  if (tsMatch) {
    timestamp = tsMatch[1]
    text = text.slice(tsMatch[0].length)
  }

  // Check for GitHub Actions annotations
  const annoMatch = text.match(ANNOTATION_RE)
  if (annoMatch) {
    const kind = annoMatch[1]
    const content = text.slice(annoMatch[0].length)
    if (kind === 'endgroup') return { type: 'normal', timestamp, text: '', raw: line }
    if (kind === 'group') return { type: 'group', timestamp, text: content, raw: line }
    if (kind === 'command') return { type: 'command', timestamp, text: content, raw: line }
    return { type: kind as LogLineType, timestamp, text: content, raw: line }
  }

  // Heuristic classification for lines without annotations
  const lower = text.toLowerCase()
  if (/\berror\b/i.test(lower) && !/\b0 errors?\b/i.test(lower)) {
    return { type: 'error', timestamp, text, raw: line }
  }
  if (/\bwarn(ing)?\b/i.test(lower) && !/\b0 warnings?\b/i.test(lower)) {
    return { type: 'warning', timestamp, text, raw: line }
  }

  return { type: 'normal', timestamp, text, raw: line }
}

type LogFilter = 'all' | 'errors' | 'warnings' | 'errors+warnings'

function CiLogViewer({ log, searchQuery }: { log: string; searchQuery?: string }) {
  const viewerRef = useRef<HTMLDivElement>(null)
  const [currentMatch, setCurrentMatch] = useState(0)
  const matchRefs = useRef<(HTMLSpanElement | null)[]>([])
  const [filter, setFilter] = useState<LogFilter>('all')

  const lines = useMemo(() => log.split('\n').map(parseLogLine), [log])

  const counts = useMemo(() => {
    let errors = 0, warnings = 0
    for (const l of lines) {
      if (l.type === 'error') errors++
      else if (l.type === 'warning') warnings++
    }
    return { errors, warnings }
  }, [lines])

  const filteredLines = useMemo(() => {
    if (filter === 'all') return lines
    return lines.filter((l) => {
      if (filter === 'errors') return l.type === 'error'
      if (filter === 'warnings') return l.type === 'warning'
      return l.type === 'error' || l.type === 'warning'
    })
  }, [lines, filter])

  // Build search match index
  const query = searchQuery?.trim().toLowerCase() || ''
  const matchCount = useMemo(() => {
    if (!query) return 0
    let count = 0
    for (const line of filteredLines) {
      let idx = 0
      const lower = line.text.toLowerCase()
      while (idx < lower.length) {
        const found = lower.indexOf(query, idx)
        if (found === -1) break
        count++
        idx = found + query.length
      }
    }
    return count
  }, [filteredLines, query])

  // Emit match count to parent
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('ci-log-search-matches', { detail: { count: matchCount, current: currentMatch } }))
  }, [matchCount, currentMatch])

  // Reset current match when query changes
  useEffect(() => {
    setCurrentMatch(0)
  }, [query])

  // Scroll current match into view
  useEffect(() => {
    if (matchCount > 0 && matchRefs.current[currentMatch]) {
      matchRefs.current[currentMatch]?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  }, [currentMatch, matchCount])

  // Listen for next/prev match events
  useEffect(() => {
    const handler = (e: Event) => {
      const dir = (e as CustomEvent).detail as 'next' | 'prev'
      if (matchCount === 0) return
      setCurrentMatch((c) => dir === 'next' ? (c + 1) % matchCount : (c - 1 + matchCount) % matchCount)
    }
    window.addEventListener('ci-log-search-nav', handler)
    return () => window.removeEventListener('ci-log-search-nav', handler)
  }, [matchCount])

  // Render line text with search highlights
  let globalMatchIdx = 0
  matchRefs.current = []

  function renderText(text: string): React.ReactNode {
    if (!query) return text
    const parts: React.ReactNode[] = []
    let idx = 0
    const lower = text.toLowerCase()
    while (idx < text.length) {
      const found = lower.indexOf(query, idx)
      if (found === -1) {
        parts.push(text.slice(idx))
        break
      }
      if (found > idx) parts.push(text.slice(idx, found))
      const matchIdx = globalMatchIdx++
      const isCurrent = matchIdx === currentMatch
      parts.push(
        <span
          key={matchIdx}
          ref={(el) => { matchRefs.current[matchIdx] = el }}
          className={`ci-log-search-match${isCurrent ? ' ci-log-search-match-current' : ''}`}
        >
          {text.slice(found, found + query.length)}
        </span>
      )
      idx = found + query.length
    }
    return parts
  }

  const hasIssues = counts.errors > 0 || counts.warnings > 0

  return (
    <div className="ci-log-viewer" ref={viewerRef}>
      {hasIssues && (
        <div className="ci-log-filter-bar">
          <button
            className={`ci-log-filter-btn${filter === 'all' ? ' ci-log-filter-active' : ''}`}
            onClick={() => setFilter('all')}
          >All</button>
          {counts.errors > 0 && (
            <button
              className={`ci-log-filter-btn ci-log-filter-errors${filter === 'errors' ? ' ci-log-filter-active' : ''}`}
              onClick={() => setFilter(filter === 'errors' ? 'all' : 'errors')}
            >
              <span className="ci-log-level-badge ci-log-level-error">ERR</span>
              {counts.errors}
            </button>
          )}
          {counts.warnings > 0 && (
            <button
              className={`ci-log-filter-btn ci-log-filter-warnings${filter === 'warnings' ? ' ci-log-filter-active' : ''}`}
              onClick={() => setFilter(filter === 'warnings' ? 'all' : 'warnings')}
            >
              <span className="ci-log-level-badge ci-log-level-warning">WRN</span>
              {counts.warnings}
            </button>
          )}
          {counts.errors > 0 && counts.warnings > 0 && (
            <button
              className={`ci-log-filter-btn ci-log-filter-both${filter === 'errors+warnings' ? ' ci-log-filter-active' : ''}`}
              onClick={() => setFilter(filter === 'errors+warnings' ? 'all' : 'errors+warnings')}
            >
              Errors + Warnings
            </button>
          )}
        </div>
      )}
      <div className="ci-log-structured">
        {filteredLines.map((line, i) => {
          if (line.type === 'normal' && !line.text && !line.timestamp) {
            return <div key={i} className="ci-log-line ci-log-line-blank">{'\n'}</div>
          }
          return (
            <div key={i} className={`ci-log-line ci-log-line-${line.type}`}>
              <span className="ci-log-lineno">{i + 1}</span>
              {line.type === 'group' && <span className="ci-log-group-marker">{'\u25BC'}</span>}
              {line.type === 'error' && <span className="ci-log-level-badge ci-log-level-error">ERR</span>}
              {line.type === 'warning' && <span className="ci-log-level-badge ci-log-level-warning">WRN</span>}
              {line.type === 'notice' && <span className="ci-log-level-badge ci-log-level-notice">NTC</span>}
              <span className="ci-log-text">{renderText(line.text)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
