import React, { useState, useEffect, useCallback, useRef } from 'react'
import { getDockApi } from '../../../../renderer/src/lib/ipc-bridge'
import type { PullRequest, PrState, PrCreateRequest } from '../../../../shared/pr-types'
import type { CiSetupStatus } from '../../../../shared/ci-types'
import type { GitBranchInfo } from '../../../../shared/git-manager-types'

interface PrPanelProps {
  projectDir: string
  provider: string
  currentBranch?: string
  active?: boolean
}

type PanelStatus = 'loading' | 'setup' | 'ready' | 'error'

// Cache availability per session to avoid re-checking on tab switches
const prAvailabilityCache = new Map<string, { available: boolean; providerKey?: string }>()

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

function StatusDot({ state }: { state: PrState }) {
  const color = state === 'open' ? 'var(--accent-color)' : state === 'merged' ? '#9ece6a' : 'var(--text-secondary)'
  return <span className="gm-pr-status-dot" style={{ background: color }} />
}

export default function PrPanel({ projectDir, provider, currentBranch, active }: PrPanelProps) {
  const [status, setStatus] = useState<PanelStatus>('loading')
  const [errorMsg, setErrorMsg] = useState('')
  const [setup, setSetup] = useState<CiSetupStatus | null>(null)
  const [prs, setPrs] = useState<PullRequest[]>([])
  const [filter, setFilter] = useState<PrState | 'all'>('open')
  const [loading, setLoading] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const api = getDockApi()

  // Check availability on mount
  useEffect(() => {
    let cancelled = false
    async function init() {
      const cached = prAvailabilityCache.get(projectDir)
      if (cached) {
        if (!cached.available) {
          const s = await api.pr.getSetupStatus(projectDir)
          setSetup(s)
          setStatus(s.ready ? 'ready' : 'setup')
          return
        }
        setStatus('ready')
        return
      }

      try {
        const result = await api.pr.checkAvailable(projectDir)
        if (cancelled) return
        if (!result) {
          prAvailabilityCache.set(projectDir, { available: false })
          const s = await api.pr.getSetupStatus(projectDir)
          if (cancelled) return
          setSetup(s)
          setStatus(s.ready ? 'ready' : 'setup')
          return
        }
        prAvailabilityCache.set(projectDir, { available: true, providerKey: result })
        setStatus('ready')
      } catch (err) {
        if (cancelled) return
        setStatus('error')
        setErrorMsg(err instanceof Error ? err.message : 'Failed to check PR availability')
      }
    }
    init()
    return () => { cancelled = true }
  }, [projectDir])

  // Load PRs when ready and filter changes
  const loadPrs = useCallback(async () => {
    if (status !== 'ready') return
    setLoading(true)
    try {
      const state = filter === 'all' ? undefined : filter
      const result = await api.pr.list(projectDir, state)
      setPrs(result)
    } catch { /* ignore */ }
    setLoading(false)
  }, [status, filter, projectDir])

  useEffect(() => {
    loadPrs()
  }, [loadPrs])

  // Poll when active
  useEffect(() => {
    if (!active || status !== 'ready') return
    const poll = () => {
      timerRef.current = setTimeout(async () => {
        await loadPrs()
        poll()
      }, 60_000)
    }
    poll()
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [active, status, loadPrs])

  if (status === 'loading') {
    return <div className="gm-pr-panel"><div className="gm-loading">Loading...</div></div>
  }

  if (status === 'error') {
    return <div className="gm-pr-panel"><div className="gm-loading">{errorMsg || 'Error'}</div></div>
  }

  if (status === 'setup' && setup) {
    return (
      <div className="gm-pr-panel">
        <div className="gm-pr-setup">
          <div className="gm-pr-setup-title">Setup Required</div>
          <div className="gm-pr-setup-provider">{setup.providerName}</div>
          {setup.steps.map((step) => (
            <div key={step.id} className={`gm-pr-setup-step gm-pr-setup-step-${step.status}`}>
              <span className="gm-pr-setup-icon">{step.status === 'ok' ? '\u2713' : '\u25CB'}</span>
              <span>{step.label}</span>
              {step.status === 'missing' && step.helpText && <div className="gm-pr-setup-help">{step.helpText}</div>}
            </div>
          ))}
          <button className="gm-small-btn" onClick={async () => {
            prAvailabilityCache.delete(projectDir)
            const s = await api.pr.getSetupStatus(projectDir)
            setSetup(s)
            if (s.ready) setStatus('ready')
          }}>
            Recheck
          </button>
        </div>
      </div>
    )
  }

  const prLabel = provider === 'gitlab' ? 'Merge Request' : 'Pull Request'

  return (
    <div className="gm-pr-panel">
      {/* Header */}
      <div className="gm-pr-header">
        <div className="gm-pr-filters">
          {(['open', 'closed', 'merged', 'all'] as const).map((f) => (
            <button
              key={f}
              className={`gm-pr-filter${filter === f ? ' gm-pr-filter-active' : ''}`}
              onClick={() => setFilter(f)}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
        <div className="gm-pr-header-right">
          <button className="gm-small-btn" onClick={loadPrs} disabled={loading}>
            {loading ? '\u21BB' : '\u21BB'} Refresh
          </button>
          <button className="gm-small-btn gm-pr-create-btn" onClick={() => setCreateOpen(true)}>
            + New {prLabel}
          </button>
        </div>
      </div>

      {/* PR List */}
      <div className="gm-pr-list">
        {prs.length === 0 && !loading && (
          <div className="gm-pr-empty">
            No {filter === 'all' ? '' : filter + ' '}{prLabel.toLowerCase()}s found.
          </div>
        )}
        {prs.map((pr) => (
          <div key={pr.id} className="gm-pr-item" onClick={() => api.app.openExternal(pr.url)}>
            <StatusDot state={pr.state} />
            <div className="gm-pr-item-content">
              <div className="gm-pr-title">
                {pr.isDraft && <span className="gm-pr-draft">Draft</span>}
                <span>{pr.title}</span>
                <span className="gm-pr-number">#{pr.id}</span>
              </div>
              <div className="gm-pr-meta">
                <span className="gm-pr-branches">
                  <span className="gm-pr-branch">{pr.sourceBranch}</span>
                  <span className="gm-pr-arrow">{'\u2192'}</span>
                  <span className="gm-pr-branch">{pr.targetBranch}</span>
                </span>
                <span className="gm-pr-sep">{'\u00B7'}</span>
                <span>{pr.author}</span>
                <span className="gm-pr-sep">{'\u00B7'}</span>
                <span>{formatTime(pr.updatedAt || pr.createdAt)}</span>
                {pr.labels.length > 0 && (
                  <>
                    <span className="gm-pr-sep">{'\u00B7'}</span>
                    {pr.labels.slice(0, 3).map((l) => (
                      <span key={l} className="gm-pr-label">{l}</span>
                    ))}
                  </>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Create PR Dialog */}
      {createOpen && (
        <CreatePrDialog
          projectDir={projectDir}
          currentBranch={currentBranch || ''}
          prLabel={prLabel}
          provider={provider}
          onClose={() => setCreateOpen(false)}
          onCreated={() => { setCreateOpen(false); loadPrs() }}
        />
      )}
    </div>
  )
}

// --- Create PR Dialog ---

interface CreatePrDialogProps {
  projectDir: string
  currentBranch: string
  prLabel: string
  provider: string
  onClose: () => void
  onCreated: () => void
}

function CreatePrDialog({ projectDir, currentBranch, prLabel, provider, onClose, onCreated }: CreatePrDialogProps) {
  const [title, setTitle] = useState(() => {
    // Auto-generate title from branch name
    return currentBranch
      .replace(/^(feature|fix|chore|docs|refactor|test|style)\//i, '')
      .replace(/[-_]/g, ' ')
      .replace(/^\w/, (c) => c.toUpperCase())
  })
  const [body, setBody] = useState('')
  const [targetBranch, setTargetBranch] = useState('')
  const [isDraft, setIsDraft] = useState(false)
  const [branches, setBranches] = useState<GitBranchInfo[]>([])
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null)

  const api = getDockApi()

  useEffect(() => {
    // Load branches and default branch
    Promise.all([
      api.gitManager.getBranches(projectDir),
      api.pr.getDefaultBranch(projectDir)
    ]).then(([branchList, defaultBranch]) => {
      setBranches(branchList.filter((b) => b.remote && b.name !== currentBranch))
      setTargetBranch(defaultBranch)
    })
  }, [projectDir, currentBranch])

  const handleCreate = async () => {
    if (!title.trim() || !targetBranch) return
    setCreating(true)
    setError('')
    setFallbackUrl(null)

    const request: PrCreateRequest = {
      title: title.trim(),
      body: body.trim(),
      sourceBranch: currentBranch,
      targetBranch,
      isDraft: provider !== 'bitbucket' ? isDraft : undefined
    }

    try {
      const result = await api.pr.create(projectDir, request)
      if (result.success) {
        if (result.url) api.app.openExternal(result.url)
        onCreated()
      } else {
        setError(result.error || 'Failed to create')
        if (result.url) setFallbackUrl(result.url)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed')
      // Try to get fallback URL
      const url = await api.pr.getNewUrl(projectDir, currentBranch, targetBranch)
      if (url) setFallbackUrl(url)
    }
    setCreating(false)
  }

  // Unique remote branch names (strip remote prefix)
  const remoteBranches = [...new Set(
    branches
      .filter((b) => b.remote)
      .map((b) => b.name.replace(/^[^/]+\//, ''))
      .filter((n) => n !== currentBranch)
  )]

  return (
    <div className="modal-overlay">
      <div className="gm-pr-create-dialog">
        <div className="gm-pr-create-header">
          <h3>New {prLabel}</h3>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="gm-pr-create-body">
          <div className="gm-pr-create-branches">
            <div className="gm-pr-create-branch">
              <label>Source</label>
              <span className="gm-pr-branch-name">{currentBranch}</span>
            </div>
            <span className="gm-pr-arrow-lg">{'\u2192'}</span>
            <div className="gm-pr-create-branch">
              <label>Target</label>
              <select value={targetBranch} onChange={(e) => setTargetBranch(e.target.value)}>
                {remoteBranches.map((b) => (
                  <option key={b} value={b}>{b}</option>
                ))}
              </select>
            </div>
          </div>
          <label className="gm-pr-create-field">
            Title
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) handleCreate() }}
            />
          </label>
          <label className="gm-pr-create-field">
            Description
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={4}
              placeholder="Optional description..."
            />
          </label>
          {provider !== 'bitbucket' && (
            <label className="gm-pr-create-draft">
              <input type="checkbox" checked={isDraft} onChange={(e) => setIsDraft(e.target.checked)} />
              Create as draft
            </label>
          )}
          {error && (
            <div className="gm-pr-create-error">
              {error}
              {fallbackUrl && (
                <button className="gm-pr-create-fallback" onClick={() => api.app.openExternal(fallbackUrl)}>
                  Open in browser instead
                </button>
              )}
            </div>
          )}
        </div>
        <div className="gm-pr-create-footer">
          <button className="gm-small-btn" onClick={onClose}>Cancel</button>
          <button className="gm-small-btn gm-pr-create-submit" onClick={handleCreate} disabled={creating || !title.trim() || !targetBranch}>
            {creating ? 'Creating...' : `Create ${prLabel}`}
          </button>
        </div>
      </div>
    </div>
  )
}
