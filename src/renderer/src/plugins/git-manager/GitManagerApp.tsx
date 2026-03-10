import './git-manager.css'
import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { getDockApi } from '../../lib/ipc-bridge'
import { useSettingsStore } from '../../stores/settings-store'
import { applyThemeToDocument } from '../../lib/theme'
import type {
  GitCommitInfo,
  GitBranchInfo,
  GitFileStatusEntry,
  GitStatusResult,
  GitCommitDetail,
  GitFileDiff,
  GitStashEntry,
  GitSubmoduleInfo,
  GitMergeState,
  GitConflictFileContent,
  GitConflictChunk
} from '../../../../shared/git-manager-types'

const params = new URLSearchParams(window.location.search)
const projectDir = decodeURIComponent(params.get('projectDir') || '')

interface NavEntry {
  dir: string
  label: string
}

const GitManagerApp: React.FC = () => {
  const loadSettings = useSettingsStore((s) => s.load)
  const [commits, setCommits] = useState<GitCommitInfo[]>([])
  const [branches, setBranches] = useState<GitBranchInfo[]>([])
  const [status, setStatus] = useState<GitStatusResult | null>(null)
  const [submodules, setSubmodules] = useState<GitSubmoduleInfo[]>([])
  const [stashes, setStashes] = useState<GitStashEntry[]>([])
  const [selectedCommit, setSelectedCommit] = useState<GitCommitDetail | null>(null)
  const [mergeState, setMergeState] = useState<GitMergeState | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<'log' | 'changes' | 'conflicts'>('log')
  const [error, setError] = useState<string | null>(null)
  const [sidebarModal, setSidebarModal] = useState<'addSubmodule' | 'addSubmodulePath' | 'addRemote' | null>(null)
  const [addSubmoduleBasePath, setAddSubmoduleBasePath] = useState('')
  const [selectedSubmodule, setSelectedSubmodule] = useState<string | null>(null)
  const [confirmModal, setConfirmModal] = useState<{
    title: string; message: React.ReactNode; confirmLabel: string; danger?: boolean; onConfirm: () => void
  } | null>(null)
  // Navigation: activeDir is the repo we're currently viewing, navStack tracks parent repos
  const [activeDir, setActiveDir] = useState(projectDir)
  const [navStack, setNavStack] = useState<NavEntry[]>([])
  const sidebarRef = useRef<HTMLDivElement>(null)
  const detailRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    loadSettings().then(() => {
      applyThemeToDocument(useSettingsStore.getState().settings)
    })
  }, [loadSettings])

  // Zoom: Ctrl+MWB and Ctrl++/- with persistence
  useEffect(() => {
    const ZOOM_KEY = 'gm-zoom'
    const MIN_ZOOM = 0.5
    const MAX_ZOOM = 2.0
    const STEP = 0.1

    const saved = localStorage.getItem(ZOOM_KEY)
    let zoom = saved ? parseFloat(saved) : 1
    if (isNaN(zoom) || zoom < MIN_ZOOM || zoom > MAX_ZOOM) zoom = 1
    document.documentElement.style.zoom = String(zoom)

    const applyZoom = (z: number) => {
      zoom = Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z)) * 100) / 100
      document.documentElement.style.zoom = String(zoom)
      localStorage.setItem(ZOOM_KEY, String(zoom))
    }

    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      applyZoom(zoom + (e.deltaY < 0 ? STEP : -STEP))
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.ctrlKey) return
      if (e.key === '=' || e.key === '+') { e.preventDefault(); applyZoom(zoom + STEP) }
      else if (e.key === '-') { e.preventDefault(); applyZoom(zoom - STEP) }
      else if (e.key === '0') { e.preventDefault(); applyZoom(1) }
    }

    window.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('wheel', onWheel)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  const refresh = useCallback(async () => {
    if (!activeDir) return
    const api = getDockApi()
    setLoading(true)
    setError(null)
    try {
      const [logData, branchData, statusData, submoduleData, stashData, mergeData] = await Promise.all([
        api.gitManager.getLog(activeDir, { maxCount: 200 }),
        api.gitManager.getBranches(activeDir),
        api.gitManager.getStatus(activeDir),
        api.gitManager.getSubmodules(activeDir),
        api.gitManager.stashList(activeDir),
        api.gitManager.getMergeState(activeDir)
      ])
      setCommits(logData)
      setBranches(branchData)
      setStatus(statusData)
      setSubmodules(submoduleData)
      setStashes(stashData)
      setMergeState(mergeData)
      // Auto-switch to conflicts tab if merge is in progress with conflicts
      if (mergeData.inProgress && mergeData.conflicts.length > 0) {
        setActiveTab((prev) => prev === 'conflicts' ? 'conflicts' : prev)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load git data')
    }
    setLoading(false)
  }, [activeDir])

  useEffect(() => {
    refresh()
  }, [refresh])

  const handleSelectCommit = useCallback(async (hash: string) => {
    const api = getDockApi()
    try {
      const detail = await api.gitManager.getCommitDetail(activeDir, hash)
      setSelectedCommit(detail)
    } catch {
      setSelectedCommit(null)
    }
  }, [activeDir])

  const [pullDialogOpen, setPullDialogOpen] = useState(false)
  const [remotes, setRemotes] = useState<{ name: string; fetchUrl: string; pushUrl: string }[]>([])
  const [pushing, setPushing] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  const handlePush = useCallback(async () => {
    if (pushing) return
    setPushing(true)
    try {
      const api = getDockApi()
      const result = await api.gitManager.push(activeDir)
      if (!result.success) {
        setError(result.error || 'Push failed')
      }
      refresh()
    } finally {
      setPushing(false)
    }
  }, [activeDir, refresh, pushing])

  const handleRefresh = useCallback(async () => {
    if (refreshing) return
    setRefreshing(true)
    try {
      await refresh()
    } finally {
      setRefreshing(false)
    }
  }, [refresh, refreshing])

  const handleCheckoutBranch = useCallback(async (name: string) => {
    const api = getDockApi()
    setError(null)
    const result = await api.gitManager.checkoutBranch(activeDir, name)
    if (!result.success) {
      setError(result.error || 'Checkout failed')
    }
    refresh()
  }, [activeDir, refresh])

  const navigateToSubmodule = useCallback((sub: GitSubmoduleInfo) => {
    setNavStack((prev) => [...prev, { dir: activeDir, label: activeDir.split(/[/\\]/).pop() || activeDir }])
    setActiveDir(activeDir + '/' + sub.path)
    setSelectedCommit(null)
  }, [activeDir])

  const navigateBack = useCallback(() => {
    setNavStack((prev) => {
      const next = [...prev]
      const entry = next.pop()
      if (entry) {
        setActiveDir(entry.dir)
        setSelectedCommit(null)
      }
      return next
    })
  }, [])

  const api = getDockApi()
  const currentBranch = branches.find((b) => b.current)
  const localBranches = branches.filter((b) => !b.remote)
  const remoteBranches = branches.filter((b) => b.remote)

  return (
    <div className="gm-app">
      {/* Titlebar */}
      <div className="gm-titlebar">
        <div className="gm-titlebar-left">
          <GitIcon />
          {navStack.length > 0 && (
            <button className="gm-back-btn" onClick={navigateBack} title="Back to parent repo">
              <BackIcon />
            </button>
          )}
          {navStack.length > 0 ? (
            <span className="gm-titlebar-breadcrumb">
              <button className="gm-breadcrumb-root" onClick={() => { setActiveDir(projectDir); setNavStack([]); setSelectedCommit(null) }}>
                {projectDir.split(/[/\\]/).pop()}
              </button>
              {navStack.slice(1).map((entry, i) => (
                <React.Fragment key={i}>
                  <span className="gm-breadcrumb-sep">/</span>
                  <span className="gm-breadcrumb-part">{entry.label}</span>
                </React.Fragment>
              ))}
              <span className="gm-breadcrumb-sep">/</span>
              <span className="gm-breadcrumb-current">{activeDir.split(/[/\\]/).pop()}</span>
            </span>
          ) : (
            <span className="gm-titlebar-project">{projectDir.split(/[/\\]/).pop()}</span>
          )}
          <BranchDropdown
            localBranches={localBranches}
            remoteBranches={remoteBranches}
            currentBranch={currentBranch?.name}
            onCheckout={handleCheckoutBranch}
          />
        </div>
        <div className="gm-titlebar-center" />
        <div className="gm-titlebar-right">
          <PullSplitButton
            activeDir={activeDir}
            onError={setError}
            onRefresh={refresh}
            onOpenDialog={() => {
              getDockApi().gitManager.getRemotes(activeDir).then(setRemotes)
              setPullDialogOpen(true)
            }}
          />
          <button className="gm-toolbar-btn" onClick={handlePush} title="Push" disabled={pushing}>
            {pushing ? <span className="gm-toolbar-spinner" /> : <PushIcon />} Push
          </button>
          <button className="gm-toolbar-btn" onClick={handleRefresh} title="Refresh" disabled={refreshing}>
            {refreshing ? <span className="gm-toolbar-spinner" /> : <RefreshIcon />}
          </button>
          <button className="gm-toolbar-btn" onClick={() => api.gitManager.openBash(activeDir)} title="Open Git Bash">
            <BashIcon />
          </button>
          <button className="gm-toolbar-btn" onClick={() => api.app.openInExplorer(activeDir)} title="Open in Explorer">
            <OpenFolderIcon />
          </button>
          <SettingsDropdown projectDir={activeDir} />
          <div className="toolbar-separator" />
          <button className="win-btn win-minimize" onClick={() => api.win.minimize()}>&#x2015;</button>
          <button className="win-btn win-maximize" onClick={() => api.win.maximize()}>&#9744;</button>
          <button className="win-btn win-close" onClick={() => api.win.close()}>&#10005;</button>
        </div>
      </div>

      {error && (
        <div className="gm-error-bar">
          <span>{error}</span>
          <button onClick={() => setError(null)}>&#10005;</button>
        </div>
      )}

      {mergeState?.inProgress && (
        <div className="gm-merge-bar">
          <div className="gm-merge-bar-left">
            <WarningIcon />
            <span>
              {mergeState.type === 'merge' ? 'Merge' :
               mergeState.type === 'rebase' ? 'Rebase' :
               mergeState.type === 'cherry-pick' ? 'Cherry-pick' : 'Revert'} in progress
              {mergeState.conflicts.length > 0 && ` — ${mergeState.conflicts.length} conflict${mergeState.conflicts.length > 1 ? 's' : ''}`}
            </span>
          </div>
          {mergeState.conflicts.length > 0 && (
            <button className="gm-merge-bar-btn" onClick={() => setActiveTab('conflicts')}>
              Resolve Conflicts
            </button>
          )}
        </div>
      )}

      <div className="gm-body">
        {/* Branch sidebar */}
        <div className="gm-sidebar" ref={sidebarRef}>
          <CollapsibleSection title="Branches" count={localBranches.length}>
            <LocalBranchTree branches={localBranches} onCheckout={handleCheckoutBranch} />
          </CollapsibleSection>
          <CollapsibleSection title="Remotes" count={remoteBranches.length} defaultCollapsed onAdd={() => setSidebarModal('addRemote')} addTitle="Add remote">
            <RemoteBranchTree
              branches={remoteBranches}
              onRemoveRemote={(remoteName, branchNames) => {
                setConfirmModal({
                  title: `Remove remote "${remoteName}"`,
                  message: (
                    <div>
                      <p>This will remove the remote <strong>{remoteName}</strong> and all its tracking branches:</p>
                      <ul style={{ margin: '8px 0', paddingLeft: 20, fontSize: 11, color: 'var(--text-secondary)' }}>
                        {branchNames.map((n) => <li key={n}>{n}</li>)}
                      </ul>
                    </div>
                  ),
                  confirmLabel: 'Remove',
                  danger: true,
                  onConfirm: async () => {
                    const r = await getDockApi().gitManager.removeRemote(activeDir, remoteName)
                    if (!r.success) setError(r.error || 'Remove remote failed')
                    refresh()
                  }
                })
              }}
            />
          </CollapsibleSection>
          <CollapsibleSection title="Submodules" count={submodules.length} onAdd={() => { setAddSubmoduleBasePath(''); setSidebarModal('addSubmodule') }} addTitle="Add submodule">
            <SubmoduleTree
              submodules={submodules}
              selectedPath={selectedSubmodule}
              onSelect={setSelectedSubmodule}
              onNavigate={navigateToSubmodule}
              onAddInFolder={(basePath) => { setAddSubmoduleBasePath(basePath); setSidebarModal('addSubmodulePath') }}
              onRemove={(subPath) => {
                setConfirmModal({
                  title: 'Remove submodule',
                  message: (<p>Are you sure you want to remove the submodule <strong>{subPath}</strong>?</p>),
                  confirmLabel: 'Remove',
                  danger: true,
                  onConfirm: async () => {
                    const r = await getDockApi().gitManager.removeSubmodule(activeDir, subPath)
                    if (!r.success) setError(r.error || 'Remove submodule failed')
                    refresh()
                  }
                })
              }}
            />
          </CollapsibleSection>
          <CollapsibleSection title="Stashes" count={stashes.length} defaultCollapsed>
            {stashes.map((s) => (
              <StashSidebarEntry
                key={s.index}
                stash={s}
                projectDir={activeDir}
                onError={setError}
                onRefresh={refresh}
                onConfirm={setConfirmModal}
              />
            ))}
            {stashes.length === 0 && (
              <div className="gm-sidebar-empty">No stashes</div>
            )}
          </CollapsibleSection>
        </div>
        <ResizeHandle side="left" targetRef={sidebarRef} min={120} max={400} storageKey="gm-sidebar-width" />

        {/* Main content */}
        <div className="gm-main">
          {/* Tab bar */}
          <div className="gm-tabs">
            <button
              className={`gm-tab${activeTab === 'log' ? ' gm-tab-active' : ''}`}
              onClick={() => setActiveTab('log')}
            >
              Commit Log
            </button>
            <button
              className={`gm-tab${activeTab === 'changes' ? ' gm-tab-active' : ''}`}
              onClick={() => setActiveTab('changes')}
            >
              Working Changes
              {status && (status.staged.length + status.unstaged.length + status.untracked.length) > 0 && (
                <span className="gm-tab-badge">
                  {status.staged.length + status.unstaged.length + status.untracked.length}
                </span>
              )}
            </button>
            {mergeState?.inProgress && (
              <button
                className={`gm-tab${activeTab === 'conflicts' ? ' gm-tab-active' : ''}`}
                onClick={() => setActiveTab('conflicts')}
              >
                <WarningIcon />
                Merge Conflicts
                {mergeState.conflicts.length > 0 && (
                  <span className="gm-tab-badge gm-tab-badge-warn">{mergeState.conflicts.length}</span>
                )}
              </button>
            )}
          </div>

          {loading ? (
            <div className="gm-loading">Loading...</div>
          ) : activeTab === 'log' ? (
            <CommitLog
              commits={commits}
              branches={branches}
              stashes={stashes}
              selectedHash={selectedCommit?.hash}
              currentBranch={currentBranch?.name}
              projectDir={activeDir}
              onSelect={handleSelectCommit}
              onAction={refresh}
              onError={setError}
            />
          ) : activeTab === 'changes' ? (
            <WorkingChanges
              status={status}
              projectDir={activeDir}
              onRefresh={refresh}
            />
          ) : activeTab === 'conflicts' && mergeState ? (
            <MergeConflictsPanel
              mergeState={mergeState}
              projectDir={activeDir}
              onRefresh={refresh}
              onError={setError}
            />
          ) : null}
        </div>

        {/* Detail panel */}
        {selectedCommit && activeTab === 'log' && (
          <>
            <ResizeHandle side="right" targetRef={detailRef} min={250} max={1400} storageKey="gm-detail-width" />
            <div className="gm-detail" ref={detailRef}>
              <CommitDetailPanel
                detail={selectedCommit}
                onClose={() => setSelectedCommit(null)}
              />
            </div>
          </>
        )}
      </div>

      {/* Sidebar modals */}
      {(sidebarModal === 'addSubmodule' || sidebarModal === 'addSubmodulePath') && (
        <AddSubmoduleModal
          basePath={addSubmoduleBasePath}
          projectDir={activeDir}
          onClose={() => setSidebarModal(null)}
          onDone={refresh}
          onError={setError}
        />
      )}
      {sidebarModal === 'addRemote' && (
        <AddRemoteModal
          projectDir={activeDir}
          onClose={() => setSidebarModal(null)}
          onDone={refresh}
          onError={setError}
        />
      )}
      {confirmModal && (
        <ConfirmModal
          title={confirmModal.title}
          message={confirmModal.message}
          confirmLabel={confirmModal.confirmLabel}
          danger={confirmModal.danger}
          onConfirm={confirmModal.onConfirm}
          onClose={() => setConfirmModal(null)}
        />
      )}
      {pullDialogOpen && (
        <PullDialog
          projectDir={activeDir}
          remotes={remotes}
          remoteBranches={remoteBranches}
          onClose={() => setPullDialogOpen(false)}
          onError={setError}
          onRefresh={refresh}
        />
      )}
    </div>
  )
}

// --- Sub-components ---

// --- Graph layout engine ---

const GRAPH_COLORS = [
  '#7aa2f7', '#9ece6a', '#e0af68', '#f7768e', '#bb9af7',
  '#7dcfff', '#73daca', '#ff9e64', '#c0caf5', '#a9b1d6'
]
const GRAPH_GREY = '#565f89'
const LANE_W = 14
const DOT_R = 4

interface GraphRowData {
  col: number
  color: string
  segments: { fromCol: number; toCol: number; color: string; half: 'full' | 'top' | 'bottom' }[]
}

function computeGraph(commits: GitCommitInfo[]): { rows: GraphRowData[]; maxCols: number } {
  // Build the current branch set: HEAD commit + its first-parent chain
  const currentSet = new Set<string>()
  const hashMap = new Map<string, GitCommitInfo>()
  for (const c of commits) hashMap.set(c.hash, c)
  // Find HEAD: first commit with a "HEAD" ref, or fall back to the very first commit in the log
  let headCommit = commits.find((c) => c.refs.some((r) => r === 'HEAD' || r.startsWith('HEAD -> ')))
  if (!headCommit && commits.length > 0) headCommit = commits[0]
  if (headCommit) {
    let cur: GitCommitInfo | undefined = headCommit
    while (cur) {
      currentSet.add(cur.hash)
      cur = cur.parents[0] ? hashMap.get(cur.parents[0]) : undefined
    }
  }

  const lanes: (string | null)[] = []
  const colorOf = new Map<string, string>()
  let ci = 0
  const getColor = (h: string) => {
    if (!colorOf.has(h)) {
      colorOf.set(h, currentSet.has(h) ? GRAPH_COLORS[ci++ % GRAPH_COLORS.length] : GRAPH_GREY)
    }
    return colorOf.get(h)!
  }
  const hashSet = new Set(commits.map((c) => c.hash))
  const rows: GraphRowData[] = []
  let maxCols = 0

  for (const commit of commits) {
    // Find lane for this commit
    let col = lanes.indexOf(commit.hash)
    const wasExpected = col !== -1
    if (col === -1) {
      col = lanes.indexOf(null)
      if (col === -1) { col = lanes.length; lanes.push(null) }
    }
    while (lanes.length <= col) lanes.push(null)
    const color = getColor(commit.hash)

    // Snapshot top edge
    const top = [...lanes]

    // Clear this commit's slot
    lanes[col] = null

    // Assign parents
    const parents = commit.parents.filter((p) => hashSet.has(p))
    if (parents.length >= 1) {
      const p0Idx = lanes.indexOf(parents[0])
      if (p0Idx === -1) {
        lanes[col] = parents[0]
        colorOf.set(parents[0], color) // first parent inherits color
      }
    }
    for (let i = 1; i < parents.length; i++) {
      if (lanes.indexOf(parents[i]) === -1) {
        const slot = lanes.indexOf(null)
        if (slot !== -1) lanes[slot] = parents[i]
        else lanes.push(parents[i])
        getColor(parents[i])
      }
    }

    // Snapshot bottom edge
    const bot = [...lanes]

    // Compute segments: pass-through lanes + commit connections
    const segments: GraphRowData['segments'] = []

    // Pass-through: lanes that existed before and still exist after (not this commit)
    for (let i = 0; i < top.length; i++) {
      const h = top[i]
      if (!h || h === commit.hash) continue
      const j = bot.indexOf(h)
      if (j !== -1) segments.push({ fromCol: i, toCol: j, color: getColor(h), half: 'full' })
    }

    // Incoming to commit (top half): only if expected from a previous row
    if (wasExpected) {
      segments.push({ fromCol: col, toCol: col, color, half: 'top' })
    }

    // Outgoing from commit to parents (bottom half)
    for (const p of parents) {
      const j = bot.indexOf(p)
      if (j !== -1) {
        segments.push({ fromCol: col, toCol: j, color: j === col ? color : getColor(p), half: 'bottom' })
      }
    }

    // Trim trailing nulls
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop()
    maxCols = Math.max(maxCols, top.filter(Boolean).length, lanes.length, col + 1)

    rows.push({ col, color, segments })
  }

  return { rows, maxCols }
}

// --- Commit log with graph ---

type LogEntry = { type: 'commit'; commit: GitCommitInfo; index: number } | { type: 'stash'; stash: GitStashEntry }

function buildLogEntries(commits: GitCommitInfo[], stashes: GitStashEntry[]): LogEntry[] {
  const entries: LogEntry[] = commits.map((c, i) => ({ type: 'commit' as const, commit: c, index: i }))
  // Insert stash entries after their parent commit in the timeline
  for (const stash of stashes) {
    if (!stash.parentHash || !stash.date) {
      // No parent info — insert at the top
      entries.unshift({ type: 'stash', stash })
      continue
    }
    const parentIdx = entries.findIndex((e) => e.type === 'commit' && e.commit.hash === stash.parentHash)
    if (parentIdx !== -1) {
      entries.splice(parentIdx, 0, { type: 'stash', stash })
    } else {
      // Parent not in visible log — insert at top sorted by date
      const stashTime = new Date(stash.date).getTime()
      let inserted = false
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]
        const entryDate = entry.type === 'commit' ? entry.commit.date : entry.stash.date
        if (entryDate && new Date(entryDate).getTime() <= stashTime) {
          entries.splice(i, 0, { type: 'stash', stash })
          inserted = true
          break
        }
      }
      if (!inserted) entries.push({ type: 'stash', stash })
    }
  }
  return entries
}

const CommitLog: React.FC<{
  commits: GitCommitInfo[]
  branches: GitBranchInfo[]
  stashes: GitStashEntry[]
  selectedHash?: string
  currentBranch?: string
  projectDir: string
  onSelect: (hash: string) => void
  onAction: () => void
  onError: (msg: string) => void
}> = ({ commits, branches, stashes, selectedHash, currentBranch, projectDir, onSelect, onAction, onError }) => {
  const [showGraph, setShowGraph] = useState(() => localStorage.getItem('gm-show-graph') !== 'false')
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; commit: GitCommitInfo } | null>(null)
  const [stashCtxMenu, setStashCtxMenu] = useState<{ x: number; y: number; stash: GitStashEntry } | null>(null)
  const [modal, setModal] = useState<{ type: 'reset' | 'createBranch' | 'createTag'; commit: GitCommitInfo } | null>(null)

  const toggleGraph = useCallback(() => {
    setShowGraph((prev) => {
      const next = !prev
      localStorage.setItem('gm-show-graph', String(next))
      return next
    })
  }, [])

  const { rows, maxCols } = useMemo(() =>
    showGraph ? computeGraph(commits) : { rows: [], maxCols: 0 }
  , [commits, showGraph])

  const graphW = Math.max(24, maxCols * LANE_W + 8)

  const logEntries = useMemo(() => buildLogEntries(commits, stashes), [commits, stashes])

  // Build a hash→commit-index map for graph row lookup
  const commitIndexMap = useMemo(() => {
    const m = new Map<string, number>()
    commits.forEach((c, i) => m.set(c.hash, i))
    return m
  }, [commits])

  const handleContextMenu = useCallback((e: React.MouseEvent, commit: GitCommitInfo) => {
    e.preventDefault()
    const zoom = parseFloat(document.documentElement.style.zoom) || 1
    setCtxMenu({ x: e.clientX / zoom, y: e.clientY / zoom, commit })
  }, [])

  const isHead = useCallback((c: GitCommitInfo) => {
    return c.refs.some((r) => r.startsWith('HEAD'))
  }, [])

  return (
    <div className="gm-commit-list">
      <div className="gm-commit-list-header">
        <span className="gm-col-graph" style={{ width: showGraph ? graphW : 24 }}>
          <button className="gm-graph-toggle" onClick={toggleGraph} title={showGraph ? 'Hide graph' : 'Show graph'}>
            <GraphToggleIcon />
          </button>
        </span>
        <span className="gm-col-message">Message</span>
        <span className="gm-col-author">Author</span>
        <span className="gm-col-date">Date</span>
        <span className="gm-col-hash">Hash</span>
      </div>
      <div className="gm-commit-list-body">
        {logEntries.map((entry) => {
          if (entry.type === 'stash') {
            const s = entry.stash
            // Find parent commit's graph row for pass-through lines
            const parentIdx = s.parentHash ? commitIndexMap.get(s.parentHash) : undefined
            const parentRow = parentIdx !== undefined ? rows[parentIdx] : undefined
            return (
              <div key={`stash-${s.index}`} className="gm-commit-row gm-stash-row" onContextMenu={(e) => {
                e.preventDefault()
                const zoom = parseFloat(document.documentElement.style.zoom) || 1
                setStashCtxMenu({ x: e.clientX / zoom, y: e.clientY / zoom, stash: s })
              }}>
                <span className="gm-col-graph gm-col-graph-lines" style={{ width: showGraph ? graphW : 24 }}>
                  {showGraph && parentRow ? (
                    <svg width={graphW} height="100%" viewBox={`0 0 ${graphW} 100`} preserveAspectRatio="none" className="gm-graph-svg">
                      {/* Vertical pass-through line at parent column */}
                      <line
                        x1={parentRow.col * LANE_W + LANE_W / 2 + 4} y1={-1}
                        x2={parentRow.col * LANE_W + LANE_W / 2 + 4} y2={101}
                        stroke="#565f89" strokeWidth={2} vectorEffect="non-scaling-stroke"
                      />
                      {/* Any other active pass-through lanes */}
                      {parentRow.segments.filter((seg) => seg.half === 'top' || seg.half === 'full').map((seg, si) => {
                        const x = seg.fromCol * LANE_W + LANE_W / 2 + 4
                        if (seg.fromCol === parentRow.col) return null
                        return <line key={si} x1={x} y1={-1} x2={x} y2={101} stroke="#565f89" strokeWidth={2} vectorEffect="non-scaling-stroke" />
                      })}
                    </svg>
                  ) : null}
                  <span
                    className="gm-stash-dot"
                    style={showGraph && parentRow ? { left: parentRow.col * LANE_W + LANE_W / 2 + 4 } : undefined}
                  />
                </span>
                <span className="gm-col-message">
                  <span className="gm-stash-badge">stash@{'{' + s.index + '}'}</span>
                  <span className="gm-commit-subject">{s.message}</span>
                </span>
                <span className="gm-col-author" />
                <span className="gm-col-date">{s.date ? formatDate(s.date) : ''}</span>
                <span className="gm-col-hash">{s.hash.slice(0, 7)}</span>
              </div>
            )
          }
          const c = entry.commit
          const row = rows[entry.index]
          const head = isHead(c)
          return (
            <div
              key={c.hash}
              className={`gm-commit-row${selectedHash === c.hash ? ' gm-commit-row-selected' : ''}`}
              onClick={() => onSelect(c.hash)}
              onContextMenu={(e) => handleContextMenu(e, c)}
            >
              <span className="gm-col-graph gm-col-graph-lines" style={{ width: showGraph ? graphW : 24 }}>
                {showGraph && row ? (
                  <svg width={graphW} height="100%" viewBox={`0 0 ${graphW} 100`} preserveAspectRatio="none" className="gm-graph-svg">
                    {row.segments.map((s, si) => {
                      const x1 = s.fromCol * LANE_W + LANE_W / 2 + 4
                      const x2 = s.toCol * LANE_W + LANE_W / 2 + 4
                      const y1 = s.half === 'bottom' ? 50 : -1
                      const y2 = s.half === 'top' ? 50 : 101
                      if (s.fromCol === s.toCol) {
                        return <line key={si} x1={x1} y1={y1} x2={x2} y2={y2} stroke={s.color} strokeWidth={2} vectorEffect="non-scaling-stroke" />
                      }
                      const my = (y1 + y2) / 2
                      return <path key={si} d={`M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`} fill="none" stroke={s.color} strokeWidth={2} vectorEffect="non-scaling-stroke" />
                    })}
                  </svg>
                ) : null}
                {showGraph && row ? (
                  <span
                    className={`gm-graph-dot-node${head ? ' gm-graph-dot-head' : ''}`}
                    style={{
                      left: row.col * LANE_W + LANE_W / 2 + 4,
                      backgroundColor: row.color
                    }}
                  />
                ) : (
                  <span
                    className={`gm-graph-dot${head ? ' gm-graph-dot-head' : ''}`}
                    style={{ backgroundColor: c.parents.length > 1 ? '#bb9af7' : 'var(--accent-color)' }}
                  />
                )}
              </span>
              <span className="gm-col-message">
                {c.refs.length > 0 && c.refs.map((r) => (
                  <span key={r} className={`gm-ref-badge${r.includes('/') ? ' gm-ref-remote' : ''}`}>
                    {r.replace(/^HEAD -> /, '')}
                  </span>
                ))}
                <span className="gm-commit-subject">{c.subject}</span>
              </span>
              <span className="gm-col-author"><AuthorAvatar name={c.author} />{c.author}</span>
              <span className="gm-col-date">{formatDate(c.date)}</span>
              <span className="gm-col-hash">{c.shortHash}</span>
            </div>
          )
        })}
      </div>
      {ctxMenu && (
        <CommitContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          commit={ctxMenu.commit}
          currentBranch={currentBranch}
          branches={branches}
          projectDir={projectDir}
          onClose={() => setCtxMenu(null)}
          onAction={onAction}
          onError={onError}
          onReset={(c) => { setCtxMenu(null); setModal({ type: 'reset', commit: c }) }}
          onCreateBranch={(c) => { setCtxMenu(null); setModal({ type: 'createBranch', commit: c }) }}
          onCreateTag={(c) => { setCtxMenu(null); setModal({ type: 'createTag', commit: c }) }}
        />
      )}
      {stashCtxMenu && (
        <StashContextMenu
          x={stashCtxMenu.x}
          y={stashCtxMenu.y}
          stash={stashCtxMenu.stash}
          projectDir={projectDir}
          onClose={() => setStashCtxMenu(null)}
          onAction={onAction}
          onError={onError}
        />
      )}
      {modal?.type === 'reset' && (
        <ResetModal
          commit={modal.commit}
          currentBranch={currentBranch}
          projectDir={projectDir}
          onClose={() => setModal(null)}
          onAction={onAction}
          onError={onError}
        />
      )}
      {modal?.type === 'createBranch' && (
        <CreateBranchModal
          commit={modal.commit}
          projectDir={projectDir}
          onClose={() => setModal(null)}
          onAction={onAction}
          onError={onError}
        />
      )}
      {modal?.type === 'createTag' && (
        <CreateTagModal
          commit={modal.commit}
          projectDir={projectDir}
          onClose={() => setModal(null)}
          onAction={onAction}
          onError={onError}
        />
      )}
    </div>
  )
}

const GraphToggleIcon: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="6" cy="6" r="2.5" />
    <circle cx="18" cy="12" r="2.5" />
    <circle cx="6" cy="18" r="2.5" />
    <line x1="6" y1="8.5" x2="6" y2="15.5" />
    <path d="M8.5 6h4a4 4 0 014 4v2" />
  </svg>
)

const CommitDetailPanel: React.FC<{
  detail: GitCommitDetail
  onClose: () => void
}> = ({ detail, onClose }) => {
  const [selectedLines, setSelectedLines] = useState<Set<string>>(new Set())
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; fileIdx: number } | null>(null)
  const [dragStart, setDragStart] = useState<string | null>(null)
  const lastClickedRef = useRef<string | null>(null)
  const isDragging = useRef(false)

  // Clear selection on new commit
  useEffect(() => { setSelectedLines(new Set()); setCtxMenu(null) }, [detail.hash])

  // Build flat key list per file for range selection
  const allLineKeysByFile = useMemo(() => {
    const map = new Map<number, string[]>()
    for (let fi = 0; fi < detail.files.length; fi++) {
      const keys: string[] = []
      for (let hi = 0; hi < detail.files[fi].hunks.length; hi++) {
        for (let li = 0; li < detail.files[fi].hunks[hi].lines.length; li++) {
          keys.push(`${fi}:${hi}:${li}`)
        }
      }
      map.set(fi, keys)
    }
    return map
  }, [detail.files])

  const getLineRange = useCallback((from: string, to: string): string[] => {
    const fi = parseInt(from.split(':')[0])
    const fi2 = parseInt(to.split(':')[0])
    if (fi !== fi2) return [to] // different files, just select the target
    const keys = allLineKeysByFile.get(fi)
    if (!keys) return [to]
    const fromIdx = keys.indexOf(from)
    const toIdx = keys.indexOf(to)
    if (fromIdx === -1 || toIdx === -1) return [to]
    const s = Math.min(fromIdx, toIdx)
    const e = Math.max(fromIdx, toIdx)
    return keys.slice(s, e + 1)
  }, [allLineKeysByFile])

  // Drag handlers
  useEffect(() => {
    if (!dragStart) return
    const onMove = (e: MouseEvent) => {
      isDragging.current = true
      const el = document.elementFromPoint(e.clientX, e.clientY)
      const lineEl = el?.closest('[data-linekey]')
      const key = lineEl?.getAttribute('data-linekey')
      if (key) {
        const range = getLineRange(dragStart, key)
        setSelectedLines(new Set(range))
      }
    }
    const onUp = () => {
      setDragStart(null)
      isDragging.current = false
      document.body.style.userSelect = ''
    }
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.userSelect = ''
    }
  }, [dragStart, getLineRange])

  const handleLineMouseDown = useCallback((key: string, e: React.MouseEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    if (e.shiftKey && lastClickedRef.current) {
      const range = getLineRange(lastClickedRef.current, key)
      setSelectedLines(new Set(range))
    } else if (e.ctrlKey) {
      setSelectedLines((prev) => {
        const next = new Set(prev)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
      })
    } else {
      setSelectedLines(new Set([key]))
      setDragStart(key)
    }
    lastClickedRef.current = key
  }, [getLineRange])

  const handleContextMenu = useCallback((fileIdx: number, e: React.MouseEvent) => {
    e.preventDefault()
    const el = (e.target as HTMLElement).closest('[data-linekey]')
    const key = el?.getAttribute('data-linekey') || null
    if (key && !selectedLines.has(key)) {
      setSelectedLines(new Set([key]))
      lastClickedRef.current = key
    }
    const zoom = parseFloat(document.documentElement.style.zoom) || 1
    setCtxMenu({ x: e.clientX / zoom, y: e.clientY / zoom, fileIdx })
  }, [selectedLines])

  const getSelectedText = useCallback((mode: 'content' | 'patch' | 'new' | 'old') => {
    const lines: string[] = []
    const sortedKeys = [...selectedLines].sort((a, b) => {
      const ap = a.split(':').map(Number)
      const bp = b.split(':').map(Number)
      return ap[0] !== bp[0] ? ap[0] - bp[0] : ap[1] !== bp[1] ? ap[1] - bp[1] : ap[2] - bp[2]
    })
    for (const key of sortedKeys) {
      const [fi, hi, li] = key.split(':').map(Number)
      const line = detail.files[fi]?.hunks[hi]?.lines[li]
      if (!line) continue
      if (mode === 'content') {
        lines.push(line.content)
      } else if (mode === 'patch') {
        const prefix = line.type === 'add' ? '+' : line.type === 'delete' ? '-' : ' '
        lines.push(prefix + line.content)
      } else if (mode === 'new') {
        if (line.type !== 'delete') lines.push(line.content)
      } else if (mode === 'old') {
        if (line.type !== 'add') lines.push(line.content)
      }
    }
    return lines.join('\n')
  }, [detail.files, selectedLines])

  const doCopy = (mode: 'content' | 'patch' | 'new' | 'old') => {
    navigator.clipboard.writeText(getSelectedText(mode))
    setCtxMenu(null)
  }

  return (
    <div className="gm-commit-detail">
      <div className="gm-detail-header">
        <span className="gm-detail-hash">{detail.shortHash}</span>
        <button className="gm-detail-close" onClick={onClose}>&#10005;</button>
      </div>
      <div className="gm-detail-meta">
        <div className="gm-detail-author-row">
          <AuthorAvatar name={detail.author} large />
          <div className="gm-detail-info">
            <span>{detail.author} &lt;{detail.authorEmail}&gt;</span>
            <span>{new Date(detail.date).toLocaleString()}</span>
          </div>
        </div>
        <div className="gm-detail-subject">{detail.subject}</div>
        {detail.body && <div className="gm-detail-body">{detail.body}</div>}
      </div>
      <div className="gm-detail-files">
        <div className="gm-detail-files-header">{detail.files.length} file(s) changed</div>
        {detail.files.map((f, fi) => (
          <div key={f.path} className="gm-diff-file">
            <div className="gm-diff-file-header">
              <FileStatusBadge status={f.status} />
              <span>{f.oldPath ? `${f.oldPath} -> ${f.path}` : f.path}</span>
            </div>
            {f.isBinary ? (
              <div className="gm-diff-binary">Binary file</div>
            ) : (
              f.hunks.map((h, hi) => (
                <div key={hi} className="gm-diff-hunk">
                  <div className="gm-diff-hunk-header">{h.header}</div>
                  {h.lines.map((l, li) => {
                    const key = `${fi}:${hi}:${li}`
                    const isSelected = selectedLines.has(key)
                    return (
                      <div
                        key={li}
                        data-linekey={key}
                        className={`gm-diff-line gm-diff-line-${l.type}${isSelected ? ' gm-diff-line-selected' : ''}`}
                        onMouseDown={(e) => handleLineMouseDown(key, e)}
                        onContextMenu={(e) => handleContextMenu(fi, e)}
                      >
                        <span className="gm-diff-line-no">
                          {l.oldLineNo ?? ' '} {l.newLineNo ?? ' '}
                        </span>
                        <span className="gm-diff-line-prefix">
                          {l.type === 'add' ? '+' : l.type === 'delete' ? '-' : ' '}
                        </span>
                        <span className="gm-diff-line-content">{l.content}</span>
                      </div>
                    )
                  })}
                </div>
              ))
            )}
          </div>
        ))}
      </div>

      {ctxMenu && (
        <CommitDiffContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          selectedCount={selectedLines.size}
          onCopy={() => doCopy('content')}
          onCopyPatch={() => doCopy('patch')}
          onCopyNew={() => doCopy('new')}
          onCopyOld={() => doCopy('old')}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  )
}

const CommitDiffContextMenu: React.FC<{
  x: number; y: number
  selectedCount: number
  onCopy: () => void
  onCopyPatch: () => void
  onCopyNew: () => void
  onCopyOld: () => void
  onClose: () => void
}> = ({ x, y, selectedCount, onCopy, onCopyPatch, onCopyNew, onCopyOld, onClose }) => {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  useEffect(() => {
    if (!ref.current) return
    const el = ref.current
    const zoom = parseFloat(document.documentElement.style.zoom) || 1
    const vw = window.innerWidth / zoom
    const vh = window.innerHeight / zoom
    const cx = parseFloat(el.style.left)
    const cy = parseFloat(el.style.top)
    if (cx + el.offsetWidth > vw) el.style.left = `${vw - el.offsetWidth - 4}px`
    if (cy + el.offsetHeight > vh) el.style.top = `${vh - el.offsetHeight - 4}px`
  }, [])

  const label = selectedCount === 1 ? 'line' : `${selectedCount} lines`

  return (
    <div className="gm-ctx-menu" ref={ref} style={{ left: x, top: y }}>
      <div className="gm-ctx-item" onClick={onCopy}>
        <span>Copy {label}</span>
        <span className="gm-ctx-shortcut">Ctrl+C</span>
      </div>
      <div className="gm-ctx-item" onClick={onCopyPatch}>Copy patch</div>
      <div className="gm-ctx-item" onClick={onCopyNew}>Copy new version</div>
      <div className="gm-ctx-item" onClick={onCopyOld}>Copy old version</div>
    </div>
  )
}

const WorkingChanges: React.FC<{
  status: GitStatusResult | null
  projectDir: string
  onRefresh: () => void
}> = ({ status: parentStatus, projectDir, onRefresh }) => {
  const [localStatus, setLocalStatus] = useState<GitStatusResult | null>(null)
  const status = localStatus || parentStatus
  const [commitMsg, setCommitMsg] = useState(() => {
    try { return localStorage.getItem(`gm-commit-msg:${projectDir}`) || '' } catch { return '' }
  })
  const [busy, setBusy] = useState(false)
  const [stagingPaths, setStagingPaths] = useState<Set<string>>(new Set())
  const [generating, setGenerating] = useState(false)
  const [genError, setGenError] = useState<string | null>(null)
  const [autoGen, setAutoGen] = useState(false)
  const [fileCtx, setFileCtx] = useState<{ x: number; y: number; file: GitFileStatusEntry; section: 'staged' | 'unstaged' } | null>(null)
  const [selectedFile, setSelectedFile] = useState<{ path: string; staged: boolean } | null>(null)
  const [fileDiffs, setFileDiffs] = useState<GitFileDiff[]>([])
  const [diffLoading, setDiffLoading] = useState(false)
  const fileListRef = useRef<HTMLDivElement>(null)

  // Sync localStatus when parentStatus changes (from full refresh)
  useEffect(() => { setLocalStatus(null) }, [parentStatus])

  // Quick re-fetch just the status (not the full app data)
  const refreshStatus = useCallback(async () => {
    try {
      const s = await getDockApi().gitManager.getStatus(projectDir)
      setLocalStatus(s)
    } catch { /* ignore */ }
  }, [projectDir])

  // Persist commit message to localStorage
  useEffect(() => {
    const key = `gm-commit-msg:${projectDir}`
    if (commitMsg) localStorage.setItem(key, commitMsg)
    else localStorage.removeItem(key)
  }, [commitMsg, projectDir])

  // Load auto-generate setting on mount (default: true per plugin schema)
  useEffect(() => {
    getDockApi().plugins.getSetting(projectDir, 'git-manager', 'autoGenerateCommitMsg')
      .then((val) => { setAutoGen(typeof val === 'boolean' ? val : true) })
  }, [projectDir])

  // Load diff when a file is selected
  useEffect(() => {
    if (!selectedFile) { setFileDiffs([]); return }
    let cancelled = false
    setDiffLoading(true)
    getDockApi().gitManager.getDiff(projectDir, selectedFile.path, selectedFile.staged)
      .then((diffs) => { if (!cancelled) setFileDiffs(diffs) })
      .catch(() => { if (!cancelled) setFileDiffs([]) })
      .finally(() => { if (!cancelled) setDiffLoading(false) })
    return () => { cancelled = true }
  }, [selectedFile, projectDir])

  // Clear selection when the file disappears from the status
  useEffect(() => {
    if (!selectedFile || !status) return
    const inStaged = status.staged.some((f) => f.path === selectedFile.path)
    const inUnstaged = [...status.unstaged, ...status.untracked].some((f) => f.path === selectedFile.path)
    if (!inStaged && !inUnstaged) setSelectedFile(null)
  }, [status, selectedFile])

  if (!status) return <div className="gm-loading">No status data</div>

  const api = getDockApi()
  const allUnstaged = [...status.unstaged, ...status.untracked]

  const triggerAutoGenerate = async () => {
    setGenerating(true)
    setGenError(null)
    try {
      const result = await api.gitManager.generateCommitMsg(projectDir)
      if (result.success && result.message) {
        setCommitMsg(result.message)
      } else {
        setGenError(result.error || 'Failed to generate')
      }
    } catch (err) {
      setGenError(err instanceof Error ? err.message : 'Failed to generate')
    }
    setGenerating(false)
  }

  const handleStageAll = async () => {
    setBusy(true)
    const paths = allUnstaged.map((f) => f.path)
    setStagingPaths(new Set(paths))
    await api.gitManager.stage(projectDir, paths)
    await refreshStatus()
    setStagingPaths(new Set())
    setBusy(false)
    if (autoGen) triggerAutoGenerate()
  }

  const handleUnstageAll = async () => {
    setBusy(true)
    const paths = status.staged.map((f) => f.path)
    setStagingPaths(new Set(paths))
    await api.gitManager.unstage(projectDir, paths)
    await refreshStatus()
    setStagingPaths(new Set())
    setBusy(false)
  }

  const handleCommit = async () => {
    if (!commitMsg.trim()) return
    setBusy(true)
    const result = await api.gitManager.commit(projectDir, commitMsg)
    if (result.success) {
      setCommitMsg('')
    }
    onRefresh()
    setBusy(false)
  }

  const handleStageFile = async (filePath: string) => {
    setStagingPaths((prev) => new Set(prev).add(filePath))
    await api.gitManager.stage(projectDir, [filePath])
    await refreshStatus()
    setStagingPaths((prev) => { const n = new Set(prev); n.delete(filePath); return n })
    if (autoGen) triggerAutoGenerate()
  }

  const handleUnstageFile = async (filePath: string) => {
    setStagingPaths((prev) => new Set(prev).add(filePath))
    await api.gitManager.unstage(projectDir, [filePath])
    await refreshStatus()
    setStagingPaths((prev) => { const n = new Set(prev); n.delete(filePath); return n })
  }

  const handleGenerateMsg = async () => {
    if (status.staged.length === 0) return
    await triggerAutoGenerate()
  }

  const handleFileContext = (e: React.MouseEvent, file: GitFileStatusEntry, section: 'staged' | 'unstaged') => {
    e.preventDefault()
    const zoom = parseFloat(document.documentElement.style.zoom) || 1
    setFileCtx({ x: e.clientX / zoom, y: e.clientY / zoom, file, section })
  }

  const handleSelectFile = (path: string, staged: boolean) => {
    if (selectedFile?.path === path && selectedFile?.staged === staged) {
      setSelectedFile(null)
    } else {
      setSelectedFile({ path, staged })
    }
  }

  return (
    <div className="gm-changes">
      <div className="gm-changes-file-list" ref={fileListRef}>
        {/* Unstaged / untracked */}
        <div className="gm-changes-section">
          <div className="gm-changes-section-header">
            <span>Unstaged ({allUnstaged.length})</span>
            {allUnstaged.length > 0 && (
              <button className="gm-small-btn" onClick={handleStageAll} disabled={busy}>
                Stage All
              </button>
            )}
          </div>
          {allUnstaged.map((f) => (
            <div
              key={f.path}
              className={`gm-file-entry gm-file-unstaged${f.isSubmodule ? ' gm-file-submodule' : ''}${selectedFile?.path === f.path && !selectedFile?.staged ? ' gm-file-selected' : ''}`}
              onClick={() => handleSelectFile(f.path, false)}
              onDoubleClick={() => handleStageFile(f.path)}
              onContextMenu={(e) => handleFileContext(e, f, 'unstaged')}
            >
              {f.isSubmodule && <SubmoduleIcon />}
              <FileStatusBadge status={f.workTreeStatus === '?' ? 'untracked' : f.workTreeStatus} />
              <span className="gm-file-path">{f.path}</span>
              {f.isSubmodule && <span className="gm-file-submodule-label">submodule</span>}
              <button
                className="gm-file-action"
                onClick={(e) => { e.stopPropagation(); handleStageFile(f.path) }}
                title="Stage"
                disabled={stagingPaths.has(f.path)}
              >{stagingPaths.has(f.path) ? <span className="gm-file-action-spinner" /> : '+'}</button>
            </div>
          ))}
        </div>

        {/* Staged files */}
        <div className="gm-changes-section">
          <div className="gm-changes-section-header">
            <span>Staged ({status.staged.length})</span>
            {status.staged.length > 0 && (
              <button className="gm-small-btn" onClick={handleUnstageAll} disabled={busy}>
                Unstage All
              </button>
            )}
          </div>
          {status.staged.map((f) => (
            <div
              key={f.path}
              className={`gm-file-entry gm-file-staged${f.isSubmodule ? ' gm-file-submodule' : ''}${selectedFile?.path === f.path && selectedFile?.staged ? ' gm-file-selected' : ''}`}
              onClick={() => handleSelectFile(f.path, true)}
              onDoubleClick={() => handleUnstageFile(f.path)}
              onContextMenu={(e) => handleFileContext(e, f, 'staged')}
            >
              {f.isSubmodule && <SubmoduleIcon />}
              <FileStatusBadge status={f.indexStatus} />
              <span className="gm-file-path">{f.path}</span>
              {f.isSubmodule && <span className="gm-file-submodule-label">submodule</span>}
              <button
                className="gm-file-action"
                onClick={(e) => { e.stopPropagation(); handleUnstageFile(f.path) }}
                title="Unstage"
                disabled={stagingPaths.has(f.path)}
              >{stagingPaths.has(f.path) ? <span className="gm-file-action-spinner" /> : '-'}</button>
            </div>
          ))}
        </div>

        {/* Commit box */}
        <div className="gm-commit-box">
          <div className="gm-commit-input-wrap">
            <textarea
              className="gm-commit-input"
              placeholder="Commit message..."
              value={commitMsg}
              onChange={(e) => setCommitMsg(e.target.value)}
              rows={3}
            />
            <button
              className="gm-generate-btn"
              onClick={handleGenerateMsg}
              disabled={generating || status.staged.length === 0}
              title="Generate commit message with AI"
            >
              {generating ? <span className="gm-generate-spinner" /> : <SparkleIcon />}
            </button>
          </div>
          {genError && (
            <div className="gm-gen-error">
              {genError}
              <button onClick={() => setGenError(null)}>&#10005;</button>
            </div>
          )}
          <button
            className="gm-commit-btn"
            onClick={handleCommit}
            disabled={busy || !commitMsg.trim() || status.staged.length === 0}
          >
            Commit ({status.staged.length} staged)
          </button>
        </div>
      </div>

      {/* Diff viewer panel */}
      {selectedFile && (
        <>
          <ResizeHandle side="left" targetRef={fileListRef} min={200} max={600} storageKey="gm-wc-filelist-width" />
          <WorkingDiffViewer
            diffs={fileDiffs}
            loading={diffLoading}
            filePath={selectedFile.path}
            staged={selectedFile.staged}
            projectDir={projectDir}
            onClose={() => setSelectedFile(null)}
            onRefresh={onRefresh}
          />
        </>
      )}

      {fileCtx && (
        <FileContextMenu
          x={fileCtx.x}
          y={fileCtx.y}
          file={fileCtx.file}
          section={fileCtx.section}
          projectDir={projectDir}
          onClose={() => setFileCtx(null)}
          onRefresh={onRefresh}
        />
      )}
    </div>
  )
}

// --- File context menu ---

const FileContextMenu: React.FC<{
  x: number; y: number
  file: GitFileStatusEntry
  section: 'staged' | 'unstaged'
  projectDir: string
  onClose: () => void
  onRefresh: () => void
}> = ({ x, y, file, section, projectDir, onClose, onRefresh }) => {
  const ref = useRef<HTMLDivElement>(null)
  const [copySubmenu, setCopySubmenu] = useState(false)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  useEffect(() => {
    if (!ref.current) return
    const el = ref.current
    const zoom = parseFloat(document.documentElement.style.zoom) || 1
    const vw = window.innerWidth / zoom
    const vh = window.innerHeight / zoom
    const cx = parseFloat(el.style.left)
    const cy = parseFloat(el.style.top)
    if (cx + el.offsetWidth > vw) el.style.left = `${vw - el.offsetWidth - 4}px`
    if (cy + el.offsetHeight > vh) el.style.top = `${vh - el.offsetHeight - 4}px`
  }, [])

  const api = getDockApi()
  const isUntracked = file.workTreeStatus === '?' || file.workTreeStatus === 'untracked'
  const fileName = file.path.split('/').pop() || file.path

  const doStage = async () => { onClose(); await api.gitManager.stage(projectDir, [file.path]); onRefresh() }
  const doUnstage = async () => { onClose(); await api.gitManager.unstage(projectDir, [file.path]); onRefresh() }

  const doDiscard = async () => {
    onClose()
    if (isUntracked) {
      await api.gitManager.deleteFiles(projectDir, [file.path])
    } else {
      await api.gitManager.discard(projectDir, [file.path])
    }
    onRefresh()
  }

  const doDelete = async () => {
    onClose()
    await api.gitManager.deleteFiles(projectDir, [file.path])
    onRefresh()
  }

  const doShowInFolder = () => { onClose(); api.gitManager.showInFolder(projectDir, file.path) }
  const doOpenFile = () => { onClose(); api.app.openInExplorer(projectDir + '/' + file.path) }
  const doCopyPath = (text: string) => { navigator.clipboard.writeText(text); onClose() }

  return (
    <div className="gm-ctx-menu" ref={ref} style={{ left: x, top: y }}>
      {section === 'unstaged' ? (
        <div className="gm-ctx-item" onClick={doStage}>Stage</div>
      ) : (
        <div className="gm-ctx-item" onClick={doUnstage}>Unstage</div>
      )}
      {section === 'unstaged' && (
        <div className="gm-ctx-item gm-ctx-danger" onClick={doDiscard}>
          {isUntracked ? 'Delete file' : 'Discard changes'}
        </div>
      )}
      {section === 'staged' && !isUntracked && (
        <div className="gm-ctx-item gm-ctx-danger" onClick={async () => {
          onClose()
          await api.gitManager.unstage(projectDir, [file.path])
          await api.gitManager.discard(projectDir, [file.path])
          onRefresh()
        }}>Unstage and discard changes</div>
      )}
      <div className="gm-ctx-separator" />
      <div className="gm-ctx-item" onClick={doOpenFile}>Open file</div>
      <div className="gm-ctx-item" onClick={doShowInFolder}>Show in folder</div>
      <div className="gm-ctx-separator" />
      <div
        className="gm-ctx-item gm-ctx-submenu-trigger"
        onMouseEnter={() => setCopySubmenu(true)}
        onMouseLeave={() => setCopySubmenu(false)}
      >
        <span>Copy path(s)</span>
        <span className="gm-ctx-arrow">&#9656;</span>
        {copySubmenu && (
          <div className="gm-ctx-submenu">
            <div className="gm-ctx-item" onClick={() => doCopyPath(file.path)}>
              Relative: {file.path}
            </div>
            <div className="gm-ctx-item" onClick={() => doCopyPath(projectDir + '/' + file.path)}>
              Full path
            </div>
            <div className="gm-ctx-item" onClick={() => doCopyPath(fileName)}>
              Filename: {fileName}
            </div>
          </div>
        )}
      </div>
      {section === 'unstaged' && isUntracked && (
        <>
          <div className="gm-ctx-separator" />
          <div className="gm-ctx-item gm-ctx-danger" onClick={doDelete}>Delete file</div>
        </>
      )}
    </div>
  )
}

// --- Working diff viewer with line selection ---

function buildPartialPatch(
  diff: GitFileDiff,
  selectedKeys: Set<string>
): string | null {
  const parts: string[] = []

  if (diff.status === 'added') {
    parts.push('--- /dev/null')
  } else {
    parts.push(`--- a/${diff.oldPath || diff.path}`)
  }
  if (diff.status === 'deleted') {
    parts.push('+++ /dev/null')
  } else {
    parts.push(`+++ b/${diff.path}`)
  }

  let hasAnyChanges = false
  let cumulativeOffset = 0

  for (let hi = 0; hi < diff.hunks.length; hi++) {
    const hunk = diff.hunks[hi]
    const hunkLines: string[] = []
    let oldCount = 0
    let newCount = 0
    let hunkHasChanges = false

    for (let li = 0; li < hunk.lines.length; li++) {
      const line = hunk.lines[li]
      const key = `${hi}:${li}`
      const selected = selectedKeys.has(key)

      if (line.type === 'context') {
        hunkLines.push(` ${line.content}`)
        oldCount++
        newCount++
      } else if (line.type === 'add') {
        if (selected) {
          hunkLines.push(`+${line.content}`)
          newCount++
          hunkHasChanges = true
        }
      } else if (line.type === 'delete') {
        if (selected) {
          hunkLines.push(`-${line.content}`)
          oldCount++
          hunkHasChanges = true
        } else {
          hunkLines.push(` ${line.content}`)
          oldCount++
          newCount++
        }
      }
    }

    if (hunkHasChanges) {
      const newStart = hunk.oldStart + cumulativeOffset
      parts.push(`@@ -${hunk.oldStart},${oldCount} +${newStart},${newCount} @@`)
      parts.push(...hunkLines)
      cumulativeOffset += (newCount - oldCount)
      hasAnyChanges = true
    }
  }

  if (!hasAnyChanges) return null
  return parts.join('\n') + '\n'
}

const WorkingDiffViewer: React.FC<{
  diffs: GitFileDiff[]
  loading: boolean
  filePath: string
  staged: boolean
  projectDir: string
  onClose: () => void
  onRefresh: () => void
}> = ({ diffs, loading, filePath, staged, projectDir, onClose, onRefresh }) => {
  const [selectedLines, setSelectedLines] = useState<Set<string>>(new Set())
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null)
  const [dragStart, setDragStart] = useState<string | null>(null)
  const lastClickedRef = useRef<string | null>(null)
  const isDragging = useRef(false)
  const contentRef = useRef<HTMLDivElement>(null)

  // Clear selection when file changes
  useEffect(() => { setSelectedLines(new Set()); setCtxMenu(null) }, [filePath, staged])

  // Build flat key list for range selection
  const allLineKeys = useMemo(() => {
    const keys: string[] = []
    if (diffs.length === 0) return keys
    for (let hi = 0; hi < diffs[0].hunks.length; hi++) {
      for (let li = 0; li < diffs[0].hunks[hi].lines.length; li++) {
        keys.push(`${hi}:${li}`)
      }
    }
    return keys
  }, [diffs])

  const getLineRange = useCallback((from: string, to: string): string[] => {
    const fi = allLineKeys.indexOf(from)
    const ti = allLineKeys.indexOf(to)
    if (fi === -1 || ti === -1) return [to]
    const s = Math.min(fi, ti)
    const e = Math.max(fi, ti)
    return allLineKeys.slice(s, e + 1)
  }, [allLineKeys])

  const getKeyFromEvent = useCallback((e: MouseEvent | React.MouseEvent): string | null => {
    const el = (e.target as HTMLElement).closest('[data-linekey]')
    return el?.getAttribute('data-linekey') || null
  }, [])

  // Drag handlers — runs when dragStart changes to a non-null key
  useEffect(() => {
    if (!dragStart) return
    const onMove = (e: MouseEvent) => {
      isDragging.current = true
      const el = document.elementFromPoint(e.clientX, e.clientY)
      const lineEl = el?.closest('[data-linekey]')
      const key = lineEl?.getAttribute('data-linekey')
      if (key) {
        const range = getLineRange(dragStart, key)
        setSelectedLines(new Set(range))
      }
    }
    const onUp = () => {
      setDragStart(null)
      isDragging.current = false
      document.body.style.userSelect = ''
    }
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.userSelect = ''
    }
  }, [dragStart, getLineRange])

  const handleLineMouseDown = useCallback((key: string, e: React.MouseEvent) => {
    if (e.button !== 0) return
    e.preventDefault()

    if (e.shiftKey && lastClickedRef.current) {
      const range = getLineRange(lastClickedRef.current, key)
      setSelectedLines(new Set(range))
    } else if (e.ctrlKey) {
      setSelectedLines((prev) => {
        const next = new Set(prev)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
      })
    } else {
      setSelectedLines(new Set([key]))
      setDragStart(key)
    }
    lastClickedRef.current = key
  }, [getLineRange])

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const key = getKeyFromEvent(e)
    if (key && !selectedLines.has(key)) {
      setSelectedLines(new Set([key]))
      lastClickedRef.current = key
    }
    const zoom = parseFloat(document.documentElement.style.zoom) || 1
    setCtxMenu({ x: e.clientX / zoom, y: e.clientY / zoom })
  }, [selectedLines, getKeyFromEvent])

  // Count selected add/delete lines
  const selectedChanges = useMemo(() => {
    if (diffs.length === 0) return 0
    let count = 0
    for (const key of selectedLines) {
      const [hi, li] = key.split(':').map(Number)
      const line = diffs[0]?.hunks[hi]?.lines[li]
      if (line && line.type !== 'context') count++
    }
    return count
  }, [selectedLines, diffs])

  const api = getDockApi()
  const diff = diffs[0]

  const handleStageLines = async () => {
    if (!diff || selectedChanges === 0) return
    const patch = buildPartialPatch(diff, selectedLines)
    if (!patch) return
    setCtxMenu(null)
    const result = await api.gitManager.applyPatch(projectDir, patch, true, false)
    if (!result.success) { console.error('Stage lines failed:', result.error) }
    setSelectedLines(new Set())
    onRefresh()
  }

  const handleUnstageLines = async () => {
    if (!diff || selectedChanges === 0) return
    const patch = buildPartialPatch(diff, selectedLines)
    if (!patch) return
    setCtxMenu(null)
    const result = await api.gitManager.applyPatch(projectDir, patch, true, true)
    if (!result.success) { console.error('Unstage lines failed:', result.error) }
    setSelectedLines(new Set())
    onRefresh()
  }

  const handleDiscardLines = async () => {
    if (!diff || selectedChanges === 0) return
    const patch = buildPartialPatch(diff, selectedLines)
    if (!patch) return
    setCtxMenu(null)
    const result = await api.gitManager.applyPatch(projectDir, patch, false, true)
    if (!result.success) { console.error('Discard lines failed:', result.error) }
    setSelectedLines(new Set())
    onRefresh()
  }

  const getSelectedText = useCallback((mode: 'content' | 'patch' | 'new' | 'old') => {
    if (!diff) return ''
    const lines: string[] = []
    const sortedKeys = [...selectedLines].sort((a, b) => {
      const [ah, al] = a.split(':').map(Number)
      const [bh, bl] = b.split(':').map(Number)
      return ah !== bh ? ah - bh : al - bl
    })
    for (const key of sortedKeys) {
      const [hi, li] = key.split(':').map(Number)
      const line = diff.hunks[hi]?.lines[li]
      if (!line) continue
      if (mode === 'content') {
        lines.push(line.content)
      } else if (mode === 'patch') {
        const prefix = line.type === 'add' ? '+' : line.type === 'delete' ? '-' : ' '
        lines.push(prefix + line.content)
      } else if (mode === 'new') {
        if (line.type !== 'delete') lines.push(line.content)
      } else if (mode === 'old') {
        if (line.type !== 'add') lines.push(line.content)
      }
    }
    return lines.join('\n')
  }, [diff, selectedLines])

  const doCopy = (mode: 'content' | 'patch' | 'new' | 'old') => {
    navigator.clipboard.writeText(getSelectedText(mode))
    setCtxMenu(null)
  }

  return (
    <div className="gm-changes-diff">
      <div className="gm-changes-diff-header">
        <span className="gm-changes-diff-title">
          {staged ? 'Staged' : 'Unstaged'}: {filePath}
        </span>
        <button className="gm-detail-close" onClick={onClose}>&#10005;</button>
      </div>
      <div className="gm-changes-diff-content" ref={contentRef}>
        {loading ? (
          <div className="gm-loading">Loading diff...</div>
        ) : diffs.length === 0 ? (
          <div className="gm-diff-empty">No diff available</div>
        ) : (
          diffs.map((f) => (
            <div key={f.path} className="gm-diff-file">
              {f.isBinary ? (
                <div className="gm-diff-binary">Binary file</div>
              ) : (
                f.hunks.map((h, hi) => (
                  <div key={hi} className="gm-diff-hunk">
                    <div className="gm-diff-hunk-header">{h.header}</div>
                    {h.lines.map((l, li) => {
                      const key = `${hi}:${li}`
                      const isSelected = selectedLines.has(key)
                      return (
                        <div
                          key={li}
                          data-linekey={key}
                          className={`gm-diff-line gm-diff-line-${l.type}${isSelected ? ' gm-diff-line-selected' : ''}`}
                          onMouseDown={(e) => handleLineMouseDown(key, e)}
                          onContextMenu={handleContextMenu}
                        >
                          <span className="gm-diff-line-no">
                            {l.oldLineNo ?? ' '} {l.newLineNo ?? ' '}
                          </span>
                          <span className="gm-diff-line-prefix">
                            {l.type === 'add' ? '+' : l.type === 'delete' ? '-' : ' '}
                          </span>
                          <span className="gm-diff-line-content">{l.content}</span>
                        </div>
                      )
                    })}
                  </div>
                ))
              )}
            </div>
          ))
        )}
      </div>

      {ctxMenu && (
        <DiffLineContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          staged={staged}
          hasChanges={selectedChanges > 0}
          selectedCount={selectedLines.size}
          onStage={handleStageLines}
          onUnstage={handleUnstageLines}
          onDiscard={handleDiscardLines}
          onCopy={() => doCopy('content')}
          onCopyPatch={() => doCopy('patch')}
          onCopyNew={() => doCopy('new')}
          onCopyOld={() => doCopy('old')}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  )
}

const DiffLineContextMenu: React.FC<{
  x: number; y: number
  staged: boolean
  hasChanges: boolean
  selectedCount: number
  onStage: () => void
  onUnstage: () => void
  onDiscard: () => void
  onCopy: () => void
  onCopyPatch: () => void
  onCopyNew: () => void
  onCopyOld: () => void
  onClose: () => void
}> = ({ x, y, staged, hasChanges, selectedCount, onStage, onUnstage, onDiscard, onCopy, onCopyPatch, onCopyNew, onCopyOld, onClose }) => {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  useEffect(() => {
    if (!ref.current) return
    const el = ref.current
    const zoom = parseFloat(document.documentElement.style.zoom) || 1
    const vw = window.innerWidth / zoom
    const vh = window.innerHeight / zoom
    const cx = parseFloat(el.style.left)
    const cy = parseFloat(el.style.top)
    if (cx + el.offsetWidth > vw) el.style.left = `${vw - el.offsetWidth - 4}px`
    if (cy + el.offsetHeight > vh) el.style.top = `${vh - el.offsetHeight - 4}px`
  }, [])

  const label = selectedCount === 1 ? 'line' : 'lines'

  return (
    <div className="gm-ctx-menu" ref={ref} style={{ left: x, top: y }}>
      {!staged && hasChanges && (
        <div className="gm-ctx-item" onClick={onStage}>
          <span>Stage selected {label}</span>
          <span className="gm-ctx-shortcut">S</span>
        </div>
      )}
      {staged && hasChanges && (
        <div className="gm-ctx-item" onClick={onUnstage}>
          <span>Unstage selected {label}</span>
          <span className="gm-ctx-shortcut">U</span>
        </div>
      )}
      {hasChanges && (
        <div className="gm-ctx-item gm-ctx-danger" onClick={onDiscard}>
          <span>Reset selected {label}</span>
          <span className="gm-ctx-shortcut">R</span>
        </div>
      )}
      {hasChanges && <div className="gm-ctx-separator" />}
      <div className="gm-ctx-item" onClick={onCopy}>
        <span>Copy</span>
        <span className="gm-ctx-shortcut">Ctrl+C</span>
      </div>
      <div className="gm-ctx-item" onClick={onCopyPatch}>Copy patch</div>
      <div className="gm-ctx-item" onClick={onCopyNew}>Copy new version</div>
      <div className="gm-ctx-item" onClick={onCopyOld}>Copy old version</div>
    </div>
  )
}

const FileStatusBadge: React.FC<{ status: string }> = ({ status }) => {
  const colors: Record<string, string> = {
    modified: '#e0af68',
    added: '#9ece6a',
    deleted: '#f7768e',
    renamed: '#7aa2f7',
    copied: '#7dcfff',
    untracked: '#565f89',
    unmerged: '#f7768e'
  }
  const label = status.charAt(0).toUpperCase()
  return (
    <span className="gm-status-badge" style={{ color: colors[status] || 'var(--text-secondary)' }}>
      {label}
    </span>
  )
}

// --- Author avatar ---

const AVATAR_COLORS = [
  '#c0392b', '#e67e22', '#f1c40f', '#27ae60', '#2980b9',
  '#8e44ad', '#e74c3c', '#d35400', '#16a085', '#2c3e50',
  '#e91e63', '#9c27b0', '#673ab7', '#3f51b5', '#009688',
  '#ff5722', '#795548', '#607d8b', '#f44336', '#4caf50'
]

function getAuthorInitials(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
  if (parts.length === 1 && parts[0].length >= 2) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0]?.[0] || '?').toUpperCase()
}

function getAuthorColor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]
}

const AuthorAvatar: React.FC<{ name: string; large?: boolean }> = ({ name, large }) => (
  <span
    className={`gm-avatar${large ? ' gm-avatar-lg' : ''}`}
    style={{ backgroundColor: getAuthorColor(name) }}
    title={name}
  >
    {getAuthorInitials(name)}
  </span>
)

// --- Resize handle ---

const ResizeHandle: React.FC<{
  side: 'left' | 'right'
  targetRef: React.RefObject<HTMLDivElement | null>
  min?: number
  max?: number
  storageKey?: string
}> = ({ side, targetRef, min = 120, max = 600, storageKey }) => {
  // Restore saved width on mount
  useEffect(() => {
    if (!storageKey || !targetRef.current) return
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
      const delta = (side === 'left' ? ev.clientX - startX : startX - ev.clientX) / zoom
      const newW = Math.min(max, Math.max(min, startW + delta))
      el.style.width = `${newW}px`
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      if (storageKey && el) {
        const z = parseFloat(document.documentElement.style.zoom) || 1
        localStorage.setItem(storageKey, String(Math.round(el.getBoundingClientRect().width / z)))
      }
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [targetRef, side, min, max, storageKey])

  return <div className={`gm-resize-handle gm-resize-${side}`} onMouseDown={handleMouseDown} />
}

// --- Collapsible sidebar section ---

const CollapsibleSection: React.FC<{
  title: string
  count?: number
  defaultCollapsed?: boolean
  onAdd?: () => void
  addTitle?: string
  children: React.ReactNode
}> = ({ title, count, defaultCollapsed = false, onAdd, addTitle, children }) => {
  const [collapsed, setCollapsed] = useState(defaultCollapsed)

  return (
    <div className="gm-sidebar-section">
      <div className="gm-sidebar-header-wrap">
        <button className="gm-sidebar-header gm-sidebar-header-toggle" onClick={() => setCollapsed(!collapsed)}>
          <SectionChevron collapsed={collapsed} />
          <span>{title}</span>
        </button>
        {onAdd && (
          <button
            className="gm-sidebar-add-btn"
            onClick={(e) => { e.stopPropagation(); onAdd() }}
            title={addTitle || 'Add'}
          >+</button>
        )}
        {count !== undefined && <span className="gm-sidebar-header-count">{count}</span>}
      </div>
      {!collapsed && children}
    </div>
  )
}

const SectionChevron: React.FC<{ collapsed: boolean }> = ({ collapsed }) => (
  <svg
    className="gm-section-chevron"
    width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
    style={{ transform: collapsed ? 'rotate(-90deg)' : 'none' }}
  >
    <polyline points="6 9 12 15 18 9" />
  </svg>
)

// --- Remote branch tree (grouped by remote name) ---

const RemoteBranchTree: React.FC<{
  branches: GitBranchInfo[]
  onRemoveRemote?: (remoteName: string, branchNames: string[]) => void
}> = ({ branches, onRemoveRemote }) => {
  // Group by remote name (e.g. origin/main -> origin group)
  const groups = useMemo(() => {
    const map = new Map<string, GitBranchInfo[]>()
    for (const b of branches) {
      const slashIdx = b.name.indexOf('/')
      const remote = slashIdx > 0 ? b.name.slice(0, slashIdx) : 'other'
      if (!map.has(remote)) map.set(remote, [])
      map.get(remote)!.push(b)
    }
    return map
  }, [branches])

  return (
    <>
      {[...groups.entries()].map(([remote, items]) => (
        <RemoteBranchGroup key={remote} remote={remote} branches={items} onRemoveRemote={onRemoveRemote} />
      ))}
    </>
  )
}

const RemoteBranchGroup: React.FC<{
  remote: string
  branches: GitBranchInfo[]
  onRemoveRemote?: (remoteName: string, branchNames: string[]) => void
}> = ({ remote, branches, onRemoveRemote }) => {
  const [collapsed, setCollapsed] = useState(false)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null)
  const ctxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!ctxMenu) return
    const handler = (e: MouseEvent) => {
      if (ctxRef.current && !ctxRef.current.contains(e.target as Node)) setCtxMenu(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [ctxMenu])

  const handleCtx = (e: React.MouseEvent) => {
    e.preventDefault()
    if (!onRemoveRemote) return
    const zoom = parseFloat(document.documentElement.style.zoom) || 1
    setCtxMenu({ x: e.clientX / zoom, y: e.clientY / zoom })
  }

  return (
    <>
      <div
        className="gm-sidebar-item gm-sidebar-item-remote gm-sidebar-remote-group"
        onClick={() => setCollapsed((p) => !p)}
        onContextMenu={handleCtx}
      >
        <span className={`gm-collapse-arrow${collapsed ? '' : ' gm-collapse-arrow-open'}`}>&#9656;</span>
        <span className="gm-branch-name">{remote}</span>
        <span className="gm-sidebar-header-count">{branches.length}</span>
      </div>
      {!collapsed && branches.map((b) => (
        <div
          key={b.name}
          className="gm-sidebar-item gm-sidebar-item-remote gm-sidebar-remote-leaf"
          onContextMenu={handleCtx}
        >
          <span className="gm-branch-name">{b.name.slice(remote.length + 1)}</span>
        </div>
      ))}
      {ctxMenu && onRemoveRemote && (
        <div className="gm-ctx-menu" ref={ctxRef} style={{ left: ctxMenu.x, top: ctxMenu.y }}>
          <div
            className="gm-ctx-item gm-ctx-danger"
            onClick={() => {
              onRemoveRemote(remote, branches.map((b) => b.name))
              setCtxMenu(null)
            }}
          >
            Remove remote "{remote}"
          </div>
        </div>
      )}
    </>
  )
}

// --- Local branch tree (path-based hierarchy) ---

interface BranchTreeNode {
  name: string // segment name (e.g. "feature")
  fullPath: string // full branch name (e.g. "feature/my-branch")
  branch?: GitBranchInfo // present if this is a leaf
  children: Map<string, BranchTreeNode>
}

function buildBranchTree(branches: GitBranchInfo[]): BranchTreeNode {
  const root: BranchTreeNode = { name: '', fullPath: '', children: new Map() }
  for (const b of branches) {
    const parts = b.name.split('/')
    let node = root
    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i]
      if (!node.children.has(seg)) {
        node.children.set(seg, {
          name: seg,
          fullPath: parts.slice(0, i + 1).join('/'),
          children: new Map()
        })
      }
      node = node.children.get(seg)!
    }
    node.branch = b
  }
  return root
}

const LocalBranchTree: React.FC<{
  branches: GitBranchInfo[]
  onCheckout: (name: string) => void
}> = ({ branches, onCheckout }) => {
  const tree = useMemo(() => buildBranchTree(branches), [branches])

  return (
    <>
      {[...tree.children.values()].map((node) => (
        <LocalBranchNode key={node.fullPath} node={node} depth={0} onCheckout={onCheckout} />
      ))}
    </>
  )
}

const LocalBranchNode: React.FC<{
  node: BranchTreeNode
  depth: number
  onCheckout: (name: string) => void
}> = ({ node, depth, onCheckout }) => {
  const [collapsed, setCollapsed] = useState(false)
  const isLeaf = node.branch !== undefined && node.children.size === 0
  const isGroup = node.children.size > 0

  if (isLeaf) {
    const b = node.branch!
    return (
      <div
        className={`gm-sidebar-item${b.current ? ' gm-sidebar-item-active' : ''}`}
        style={{ paddingLeft: 22 + depth * 14 }}
        title={b.tracking ? `Tracking: ${b.tracking}` : undefined}
        onDoubleClick={() => { if (!b.current) onCheckout(b.name) }}
      >
        <span className="gm-branch-name">{node.name}</span>
        {(b.ahead > 0 || b.behind > 0) && (
          <span className="gm-branch-badges">
            {b.ahead > 0 && <span className="gm-badge gm-badge-ahead">+{b.ahead}</span>}
            {b.behind > 0 && <span className="gm-badge gm-badge-behind">-{b.behind}</span>}
          </span>
        )}
      </div>
    )
  }

  // Group node (may also be a branch itself, e.g. "feature" is both a group and a branch)
  const childCount = countLeaves(node)
  return (
    <>
      <div
        className="gm-sidebar-item gm-branch-group"
        style={{ paddingLeft: 22 + depth * 14 }}
        onClick={() => setCollapsed((p) => !p)}
      >
        <span className="gm-branch-group-header">
          <span className={`gm-collapse-arrow${collapsed ? '' : ' gm-collapse-arrow-open'}`}>&#9656;</span>
          <span className="gm-branch-name">{node.name}</span>
        </span>
        <span className="gm-sidebar-header-count">{childCount}</span>
      </div>
      {node.branch && !isGroup ? null : null}
      {/* If this node is also a branch (rare: branch named same as folder prefix) */}
      {node.branch && isGroup && !collapsed && (
        <div
          className={`gm-sidebar-item${node.branch.current ? ' gm-sidebar-item-active' : ''}`}
          style={{ paddingLeft: 24 + (depth + 1) * 16 }}
          title={node.branch.tracking ? `Tracking: ${node.branch.tracking}` : undefined}
          onDoubleClick={() => { if (!node.branch!.current) onCheckout(node.branch!.name) }}
        >
          <span className="gm-branch-name">{node.name}</span>
        </div>
      )}
      {!collapsed && [...node.children.values()].map((child) => (
        <LocalBranchNode key={child.fullPath} node={child} depth={depth + 1} onCheckout={onCheckout} />
      ))}
    </>
  )
}

function countLeaves(node: BranchTreeNode): number {
  if (node.children.size === 0) return node.branch ? 1 : 0
  let count = node.branch ? 1 : 0
  for (const child of node.children.values()) count += countLeaves(child)
  return count
}

// --- Pull split button ---

type PullAction = 'pull-merge' | 'pull-rebase' | 'fetch' | 'fetch-all' | 'fetch-prune-all'

const PULL_ACTION_LABELS: Record<PullAction, string> = {
  'pull-merge': 'Pull \u00b7 Merge',
  'pull-rebase': 'Pull \u00b7 Rebase',
  'fetch': 'Fetch',
  'fetch-all': 'Fetch all',
  'fetch-prune-all': 'Fetch and prune all'
}

const PULL_DEFAULT_KEY = 'gm-default-pull-action'

const PullSplitButton: React.FC<{
  activeDir: string
  onError: (msg: string) => void
  onRefresh: () => void
  onOpenDialog: () => void
}> = ({ activeDir, onError, onRefresh, onOpenDialog }) => {
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [defaultSub, setDefaultSub] = useState(false)
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const [defaultAction, setDefaultAction] = useState<PullAction>(() => {
    return (localStorage.getItem(PULL_DEFAULT_KEY) as PullAction) || 'pull-rebase'
  })

  useEffect(() => {
    if (!dropdownOpen) { setDefaultSub(false); return }
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setDropdownOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [dropdownOpen])

  const runAction = useCallback(async (action: PullAction) => {
    if (busy) return
    setBusy(true)
    try {
      const api = getDockApi()
      let result: { success: boolean; output?: string; error?: string }
      switch (action) {
        case 'pull-merge': result = await api.gitManager.pull(activeDir, 'merge'); break
        case 'pull-rebase': result = await api.gitManager.pull(activeDir, 'rebase'); break
        case 'fetch': result = await api.gitManager.fetchSimple(activeDir); break
        case 'fetch-all': result = await api.gitManager.fetchAll(activeDir); break
        case 'fetch-prune-all': result = await api.gitManager.fetchPruneAll(activeDir); break
      }
      if (!result.success) onError(result.error || 'Operation failed')
      onRefresh()
    } finally {
      setBusy(false)
    }
  }, [activeDir, onError, onRefresh, busy])

  const setDefault = (action: PullAction) => {
    setDefaultAction(action)
    localStorage.setItem(PULL_DEFAULT_KEY, action)
    setDefaultSub(false)
  }

  const label = PULL_ACTION_LABELS[defaultAction] || 'Pull'
  const icon = defaultAction.startsWith('fetch') ? <FetchIcon /> : <PullIcon />

  return (
    <div className="gm-pull-split" ref={ref} style={{ position: 'relative' }}>
      <button className="gm-toolbar-btn" onClick={() => runAction(defaultAction)} title={label} disabled={busy}>
        {busy ? <span className="gm-toolbar-spinner" /> : icon} {label}
      </button>
      <button className="gm-pull-split-arrow" onClick={() => setDropdownOpen((p) => !p)} title="Pull options" disabled={busy}>
        &#9662;
      </button>
      {dropdownOpen && (
        <div className="gm-pull-dropdown">
          <div className="gm-pull-dropdown-item" onClick={() => { setDropdownOpen(false); onOpenDialog() }}>
            Open pull dialog...
            <span className="gm-pull-dropdown-shortcut">Ctrl+Down</span>
          </div>
          <div className="gm-pull-dropdown-separator" />
          <div className="gm-pull-dropdown-item" onClick={() => { runAction('pull-merge'); setDropdownOpen(false) }}>
            <PullIcon /> Pull &middot; Merge
          </div>
          <div className="gm-pull-dropdown-item" onClick={() => { runAction('pull-rebase'); setDropdownOpen(false) }}>
            <PullIcon /> Pull &middot; Rebase
          </div>
          <div className="gm-pull-dropdown-separator" />
          <div className="gm-pull-dropdown-item" onClick={() => { runAction('fetch'); setDropdownOpen(false) }}>
            <FetchIcon /> Fetch
          </div>
          <div className="gm-pull-dropdown-item" onClick={() => { runAction('fetch-all'); setDropdownOpen(false) }}>
            <FetchIcon /> Fetch all
          </div>
          <div className="gm-pull-dropdown-item" onClick={() => { runAction('fetch-prune-all'); setDropdownOpen(false) }}>
            <FetchIcon /> Fetch and prune all
          </div>
          <div className="gm-pull-dropdown-separator" />
          <div
            className="gm-pull-dropdown-sub"
            onMouseEnter={() => setDefaultSub(true)}
            onMouseLeave={() => setDefaultSub(false)}
          >
            <div className="gm-pull-dropdown-sub-label">
              Set default Pull button action
              <span className="gm-ctx-arrow">&#9656;</span>
            </div>
            {defaultSub && (
              <div className="gm-pull-dropdown-sub-menu">
                {(Object.entries(PULL_ACTION_LABELS) as [PullAction, string][]).map(([key, lbl]) => (
                  <div
                    key={key}
                    className={`gm-pull-dropdown-item${key === defaultAction ? ' gm-pull-dropdown-item-active' : ''}`}
                    onClick={() => { setDefault(key); setDropdownOpen(false) }}
                  >
                    <span className="gm-pull-dropdown-check">{key === defaultAction ? '✓' : ''}</span>
                    {lbl}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// --- Pull dialog ---

const PullDialog: React.FC<{
  projectDir: string
  remotes: { name: string; fetchUrl: string; pushUrl: string }[]
  remoteBranches: GitBranchInfo[]
  onClose: () => void
  onError: (msg: string) => void
  onRefresh: () => void
}> = ({ projectDir, remotes, remoteBranches, onClose, onError, onRefresh }) => {
  const [remote, setRemote] = useState(remotes[0]?.name || 'origin')
  const [branch, setBranch] = useState('')
  const [rebase, setRebase] = useState(true)
  const [autostash, setAutostash] = useState(true)
  const [tags, setTags] = useState(false)
  const [prune, setPrune] = useState(false)
  const [pulling, setPulling] = useState(false)

  // Filter remote branches by selected remote
  const remoteBranchesForRemote = useMemo(() => {
    return remoteBranches
      .filter((b) => b.name.startsWith(remote + '/'))
      .map((b) => b.name.slice(remote.length + 1))
  }, [remoteBranches, remote])

  useEffect(() => {
    if (remoteBranchesForRemote.length > 0 && !remoteBranchesForRemote.includes(branch)) {
      // Default to main/master/first available
      const preferred = remoteBranchesForRemote.find((n) => n === 'main') ||
        remoteBranchesForRemote.find((n) => n === 'master') ||
        remoteBranchesForRemote[0]
      setBranch(preferred || '')
    }
  }, [remoteBranchesForRemote, branch])

  const handlePull = async () => {
    setPulling(true)
    try {
      const api = getDockApi()
      const result = await api.gitManager.pullAdvanced(projectDir, remote, branch, rebase, autostash, tags, prune)
      if (!result.success) {
        onError(result.error || 'Pull failed')
      }
      onRefresh()
      onClose()
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Pull failed')
    } finally {
      setPulling(false)
    }
  }

  return (
    <div className="gm-modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="gm-modal">
        <div className="gm-modal-header">
          <span>Pull</span>
          <button className="gm-modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="gm-modal-body">
          <div className="gm-pull-dialog-row">
            <label>Remote:</label>
            <select value={remote} onChange={(e) => setRemote(e.target.value)}>
              {remotes.map((r) => (
                <option key={r.name} value={r.name}>{r.name}</option>
              ))}
            </select>
          </div>
          <div className="gm-pull-dialog-row">
            <label>Branch:</label>
            <select value={branch} onChange={(e) => setBranch(e.target.value)}>
              {remoteBranchesForRemote.map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
          </div>
          <div className="gm-pull-dialog-checks">
            <label className="gm-pull-dialog-check">
              <input type="checkbox" checked={rebase} onChange={(e) => setRebase(e.target.checked)} />
              Rebase (instead of merge)
            </label>
            <label className="gm-pull-dialog-check">
              <input type="checkbox" checked={autostash} onChange={(e) => setAutostash(e.target.checked)} />
              Auto-stash before pull
            </label>
            <label className="gm-pull-dialog-check">
              <input type="checkbox" checked={tags} onChange={(e) => setTags(e.target.checked)} />
              Fetch tags
            </label>
            <label className="gm-pull-dialog-check">
              <input type="checkbox" checked={prune} onChange={(e) => setPrune(e.target.checked)} />
              Prune remote tracking branches
            </label>
          </div>
        </div>
        <div className="gm-modal-footer">
          <button className="gm-modal-btn" onClick={onClose}>Cancel</button>
          <button
            className="gm-modal-btn gm-modal-btn-primary"
            disabled={!branch || pulling}
            onClick={handlePull}
          >
            {pulling ? 'Pulling...' : 'Pull'}
          </button>
        </div>
      </div>
    </div>
  )
}

// --- Branch dropdown ---

const PAGE_SIZE = 30

const BranchDropdown: React.FC<{
  localBranches: GitBranchInfo[]
  remoteBranches: GitBranchInfo[]
  currentBranch?: string
  onCheckout: (name: string) => void
}> = ({ localBranches, remoteBranches, currentBranch, onCheckout }) => {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const ref = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Close on outside click (including drag-region areas in titlebar)
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    // Drag regions swallow mousedown, so also close on window blur
    const blurHandler = () => setOpen(false)
    document.addEventListener('mousedown', handler)
    window.addEventListener('blur', blurHandler)
    return () => {
      document.removeEventListener('mousedown', handler)
      window.removeEventListener('blur', blurHandler)
    }
  }, [open])

  // Focus search on open, reset on close
  useEffect(() => {
    if (open) {
      setFilter('')
      setVisibleCount(PAGE_SIZE)
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [open])

  // Filter branches
  const lowerFilter = filter.toLowerCase()
  const filteredLocal = filter
    ? localBranches.filter((b) => b.name.toLowerCase().includes(lowerFilter))
    : localBranches
  const filteredRemote = filter
    ? remoteBranches.filter((b) => b.name.toLowerCase().includes(lowerFilter))
    : remoteBranches

  const allFiltered = [
    ...filteredLocal.map((b) => ({ ...b, section: 'local' as const })),
    ...filteredRemote.map((b) => ({ ...b, section: 'remote' as const }))
  ]
  const visible = allFiltered.slice(0, visibleCount)
  const hasMore = visibleCount < allFiltered.length

  // Infinite scroll
  const handleScroll = useCallback(() => {
    const el = listRef.current
    if (!el || !hasMore) return
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 20) {
      setVisibleCount((prev) => prev + PAGE_SIZE)
    }
  }, [hasMore])

  const handleSelect = (name: string, isRemote: boolean) => {
    setOpen(false)
    // For remote branches, strip the remote prefix (e.g. "origin/feature" -> "feature")
    const checkoutName = isRemote ? name.replace(/^[^/]+\//, '') : name
    if (checkoutName !== currentBranch) {
      onCheckout(checkoutName)
    }
  }

  // Find where remote section starts in the visible list
  const firstRemoteIdx = visible.findIndex((b) => b.section === 'remote')

  return (
    <div className="gm-branch-dropdown" ref={ref}>
      <button
        className="gm-branch-dropdown-trigger"
        onClick={() => setOpen(!open)}
        title="Switch branch"
      >
        <BranchIcon />
        <span>{currentBranch || 'HEAD'}</span>
        <ChevronIcon open={open} />
      </button>
      {open && (
        <div className="gm-branch-dropdown-menu">
          <div className="gm-branch-dropdown-search">
            <input
              ref={inputRef}
              type="text"
              placeholder="Filter branches..."
              value={filter}
              onChange={(e) => { setFilter(e.target.value); setVisibleCount(PAGE_SIZE) }}
              className="gm-branch-dropdown-filter"
            />
          </div>
          <div className="gm-branch-dropdown-list" ref={listRef} onScroll={handleScroll}>
            {visible.map((b, i) => (
              <React.Fragment key={`${b.section}-${b.name}`}>
                {b.section === 'local' && i === 0 && filteredLocal.length > 0 && (
                  <div className="gm-branch-dropdown-section-label">Local</div>
                )}
                {i === firstRemoteIdx && firstRemoteIdx >= 0 && (
                  <div className="gm-branch-dropdown-section-label">Remote</div>
                )}
                <button
                  className={`gm-branch-dropdown-item${b.name === currentBranch && b.section === 'local' ? ' gm-branch-dropdown-item-active' : ''}${b.section === 'remote' ? ' gm-branch-dropdown-item-remote' : ''}`}
                  onClick={() => handleSelect(b.name, b.section === 'remote')}
                >
                  <span className="gm-branch-dropdown-name">{b.name}</span>
                  {(b.ahead > 0 || b.behind > 0) && (
                    <span className="gm-branch-badges">
                      {b.ahead > 0 && <span className="gm-badge gm-badge-ahead">+{b.ahead}</span>}
                      {b.behind > 0 && <span className="gm-badge gm-badge-behind">-{b.behind}</span>}
                    </span>
                  )}
                  {b.name === currentBranch && b.section === 'local' && (
                    <span className="gm-branch-dropdown-check">&#10003;</span>
                  )}
                </button>
              </React.Fragment>
            ))}
            {allFiltered.length === 0 && (
              <div className="gm-branch-dropdown-empty">No matching branches</div>
            )}
            {hasMore && (
              <div className="gm-branch-dropdown-empty">Scroll for more...</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

const BranchIcon: React.FC = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <line x1="6" y1="3" x2="6" y2="15" />
    <circle cx="18" cy="6" r="3" />
    <circle cx="6" cy="18" r="3" />
    <path d="M18 9a9 9 0 01-9 9" />
  </svg>
)

const ChevronIcon: React.FC<{ open: boolean }> = ({ open }) => (
  <svg
    width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
    style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}
  >
    <polyline points="6 9 12 15 18 9" />
  </svg>
)

// --- Context menu ---

const CommitContextMenu: React.FC<{
  x: number; y: number
  commit: GitCommitInfo
  currentBranch?: string
  branches: GitBranchInfo[]
  projectDir: string
  onClose: () => void
  onAction: () => void
  onError: (msg: string) => void
  onReset: (c: GitCommitInfo) => void
  onCreateBranch: (c: GitCommitInfo) => void
  onCreateTag: (c: GitCommitInfo) => void
}> = ({ x, y, commit, currentBranch, branches, projectDir, onClose, onAction, onError, onReset, onCreateBranch, onCreateTag }) => {
  const ref = useRef<HTMLDivElement>(null)
  const subRef = useRef<HTMLDivElement>(null)
  const [copySubmenu, setCopySubmenu] = useState(false)
  const [checkoutSubmenu, setCheckoutSubmenu] = useState(false)
  const [mergeSubmenu, setMergeSubmenu] = useState(false)
  const [subFlip, setSubFlip] = useState(false)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  // Adjust position so menu doesn't overflow viewport
  useEffect(() => {
    if (!ref.current) return
    const el = ref.current
    const zoom = parseFloat(document.documentElement.style.zoom) || 1
    const vw = window.innerWidth / zoom
    const vh = window.innerHeight / zoom
    const ew = el.offsetWidth
    const eh = el.offsetHeight
    const cx = parseFloat(el.style.left)
    const cy = parseFloat(el.style.top)
    if (cx + ew > vw) el.style.left = `${vw - ew - 4}px`
    if (cy + eh > vh) el.style.top = `${vh - eh - 4}px`
    // Check if submenu would overflow right edge
    setSubFlip(cx + ew + 240 > vw)
  }, [])

  // Also recheck submenu overflow when it opens
  useEffect(() => {
    if (!copySubmenu || !subRef.current || !ref.current) return
    const zoom = parseFloat(document.documentElement.style.zoom) || 1
    const vw = window.innerWidth / zoom
    const sr = subRef.current.getBoundingClientRect()
    if (sr.right / zoom > vw) setSubFlip(true)
  }, [copySubmenu])

  const copy = (text: string) => {
    navigator.clipboard.writeText(text)
    onClose()
  }

  const api = getDockApi()

  const doCheckout = async () => {
    onClose()
    const r = await api.gitManager.checkoutBranch(projectDir, commit.hash)
    if (!r.success) onError(r.error || 'Checkout failed')
    onAction()
  }

  const doRevert = async () => {
    onClose()
    const r = await api.gitManager.revert(projectDir, commit.hash)
    if (!r.success) onError(r.error || 'Revert failed')
    onAction()
  }

  const doCherryPick = async () => {
    onClose()
    const r = await api.gitManager.cherryPick(projectDir, commit.hash)
    if (!r.success) onError(r.error || 'Cherry pick failed')
    onAction()
  }

  // Branches that point at this commit
  const commitBranches = commit.refs
    .filter((r) => !r.startsWith('tag:'))
    .map((r) => r.replace(/^HEAD -> /, ''))
    .filter(Boolean)

  return (
    <div className="gm-ctx-menu" ref={ref} style={{ left: x, top: y }}>
      <div
        className="gm-ctx-item gm-ctx-submenu-trigger"
        onMouseEnter={() => setCopySubmenu(true)}
        onMouseLeave={() => setCopySubmenu(false)}
      >
        <span>Copy to clipboard</span>
        <span className="gm-ctx-arrow">&#9656;</span>
        {copySubmenu && (
          <div className={`gm-ctx-submenu${subFlip ? ' gm-ctx-submenu-left' : ''}`} ref={subRef}>
            {commitBranches.length > 0 && (
              <div className="gm-ctx-item" onClick={() => copy(commitBranches.join(', '))}>
                Branches: {commitBranches.join(', ')}
              </div>
            )}
            <div className="gm-ctx-item" onClick={() => copy(commit.hash)}>
              Commit hash: {commit.shortHash}
            </div>
            <div className="gm-ctx-item" onClick={() => copy(commit.subject)}>
              Message: {commit.subject.slice(0, 40)}{commit.subject.length > 40 ? '...' : ''}
            </div>
            <div className="gm-ctx-item" onClick={() => copy(`${commit.author} <${commit.authorEmail}>`)}>
              Author: {commit.author}
            </div>
            <div className="gm-ctx-item" onClick={() => copy(new Date(commit.date).toLocaleString())}>
              Date: {new Date(commit.date).toLocaleString()}
            </div>
          </div>
        )}
      </div>
      <div className="gm-ctx-separator" />
      <div className="gm-ctx-item" onClick={() => { onClose(); onReset(commit) }}>
        Reset current branch to here...
      </div>
      <div className="gm-ctx-separator" />
      <div className="gm-ctx-item" onClick={() => { onClose(); onCreateBranch(commit) }}>
        Create new branch here...
      </div>
      <div className="gm-ctx-item" onClick={() => { onClose(); onCreateTag(commit) }}>
        Create new tag here...
      </div>
      {(() => {
        // Branches at this commit that aren't the current branch (local + remote refs)
        const checkoutableBranches = commitBranches.filter((bName) => bName !== currentBranch)
        const mergeableBranches = commitBranches.filter((bName) => bName !== currentBranch)
        const showCheckout = checkoutableBranches.length > 0
        const showMerge = mergeableBranches.length > 0 || commitBranches.length === 0
        return (showCheckout || showMerge) ? (
          <>
            <div className="gm-ctx-separator" />
            {showCheckout && (
              <div
                className="gm-ctx-item gm-ctx-submenu-trigger"
                onMouseEnter={() => setCheckoutSubmenu(true)}
                onMouseLeave={() => setCheckoutSubmenu(false)}
              >
                <span>Checkout branch...</span>
                <span className="gm-ctx-arrow">&#9656;</span>
                {checkoutSubmenu && (
                  <div className={`gm-ctx-submenu${subFlip ? ' gm-ctx-submenu-left' : ''}`}>
                    {checkoutableBranches.map((bName) => (
                      <div key={bName} className="gm-ctx-item" onClick={async () => {
                        onClose()
                        const r = await api.gitManager.checkoutBranch(projectDir, bName)
                        if (!r.success) onError(r.error || 'Checkout failed')
                        onAction()
                      }}>
                        {bName}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {showMerge && (
              <div
                className="gm-ctx-item gm-ctx-submenu-trigger"
                onMouseEnter={() => setMergeSubmenu(true)}
                onMouseLeave={() => setMergeSubmenu(false)}
              >
                <span>Merge into current...</span>
                <span className="gm-ctx-arrow">&#9656;</span>
                {mergeSubmenu && (
                  <div className={`gm-ctx-submenu${subFlip ? ' gm-ctx-submenu-left' : ''}`}>
                    {mergeableBranches.length > 0 ? mergeableBranches.map((bName) => (
                      <div key={bName} className="gm-ctx-item" onClick={async () => {
                        onClose()
                        const r = await api.gitManager.mergeBranch(projectDir, bName)
                        if (!r.success) onError(r.error || 'Merge failed')
                        onAction()
                      }}>
                        Merge {bName} into {currentBranch || 'HEAD'}
                      </div>
                    )) : (
                      <div className="gm-ctx-item" onClick={async () => {
                        onClose()
                        const r = await api.gitManager.mergeBranch(projectDir, commit.hash)
                        if (!r.success) onError(r.error || 'Merge failed')
                        onAction()
                      }}>
                        Merge {commit.shortHash} into {currentBranch || 'HEAD'}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </>
        ) : null
      })()}
      <div className="gm-ctx-separator" />
      <div className="gm-ctx-item" onClick={doCheckout}>
        Checkout this commit (detached)...
      </div>
      <div className="gm-ctx-item" onClick={doRevert}>
        Revert this commit...
      </div>
      <div className="gm-ctx-item" onClick={doCherryPick}>
        Cherry pick this commit...
      </div>
    </div>
  )
}

// --- Stash context menu ---

const StashContextMenu: React.FC<{
  x: number; y: number
  stash: GitStashEntry
  projectDir: string
  onClose: () => void
  onAction: () => void
  onError: (msg: string) => void
}> = ({ x, y, stash, projectDir, onClose, onAction, onError }) => {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  useEffect(() => {
    if (!ref.current) return
    const el = ref.current
    const zoom = parseFloat(document.documentElement.style.zoom) || 1
    const vw = window.innerWidth / zoom
    const vh = window.innerHeight / zoom
    if (parseFloat(el.style.left) + el.offsetWidth > vw) el.style.left = `${vw - el.offsetWidth - 4}px`
    if (parseFloat(el.style.top) + el.offsetHeight > vh) el.style.top = `${vh - el.offsetHeight - 4}px`
  }, [])

  const api = getDockApi()

  const doApply = async () => {
    onClose()
    const r = await api.gitManager.stashApply(projectDir, stash.index)
    if (!r.success) onError(r.error || 'Stash apply failed')
    onAction()
  }

  const doPop = async () => {
    onClose()
    const r = await api.gitManager.stashPop(projectDir, stash.index)
    if (!r.success) onError(r.error || 'Stash pop failed')
    onAction()
  }

  const doDrop = async () => {
    onClose()
    const r = await api.gitManager.stashDrop(projectDir, stash.index)
    if (!r.success) onError(r.error || 'Stash drop failed')
    onAction()
  }

  const doCopy = (text: string) => {
    navigator.clipboard.writeText(text)
    onClose()
  }

  return (
    <div className="gm-ctx-menu" ref={ref} style={{ left: x, top: y }}>
      <div className="gm-ctx-item" onClick={doApply}>
        Apply stash
      </div>
      <div className="gm-ctx-item" onClick={doPop}>
        Pop stash
      </div>
      <div className="gm-ctx-separator" />
      <div className="gm-ctx-item gm-ctx-danger" onClick={doDrop}>
        Drop stash
      </div>
      <div className="gm-ctx-separator" />
      <div className="gm-ctx-item" onClick={() => doCopy(stash.hash)}>
        Copy hash: {stash.hash.slice(0, 7)}
      </div>
      <div className="gm-ctx-item" onClick={() => doCopy(stash.message)}>
        Copy message
      </div>
    </div>
  )
}

// --- Reset modal ---

const RESET_MODES: { value: string; label: string; desc: string; color: string }[] = [
  { value: 'soft', label: 'Soft', desc: 'leave working directory and index untouched', color: '#9ece6a' },
  { value: 'mixed', label: 'Mixed', desc: 'leave working directory untouched, reset index', color: '#e0af68' },
  { value: 'keep', label: 'Keep', desc: 'update working directory to the commit (abort if there are local changes), reset index', color: '#ff9e64' },
  { value: 'merge', label: 'Merge', desc: 'update working directory to the commit and keep local changes (abort if there are conflicts), reset index', color: '#f7768e88' },
  { value: 'hard', label: 'Hard', desc: 'reset working directory and index (discard ALL local changes, even uncommitted changes)', color: '#f7768e' }
]

const ResetModal: React.FC<{
  commit: GitCommitInfo
  currentBranch?: string
  projectDir: string
  onClose: () => void
  onAction: () => void
  onError: (msg: string) => void
}> = ({ commit, currentBranch, projectDir, onClose, onAction, onError }) => {
  const [mode, setMode] = useState('soft')
  const [busy, setBusy] = useState(false)

  const handleOk = async () => {
    setBusy(true)
    const r = await getDockApi().gitManager.reset(projectDir, commit.hash, mode)
    setBusy(false)
    if (!r.success) { onError(r.error || 'Reset failed'); onClose(); return }
    onAction()
    onClose()
  }

  return (
    <div className="gm-modal-overlay" onClick={onClose}>
      <div className="gm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="gm-modal-header">
          <span>Reset current branch</span>
          <button className="gm-modal-close" onClick={onClose}>&#10005;</button>
        </div>
        <div className="gm-modal-body">
          <div className="gm-reset-info">
            <div className="gm-reset-label">Reset branch '{currentBranch}' to revision:</div>
            <div className="gm-reset-hash">{commit.shortHash}</div>
            <div className="gm-reset-detail-box">
              <div className="gm-reset-subject">{commit.subject}</div>
              <div className="gm-reset-meta">Author: {commit.author}</div>
              <div className="gm-reset-meta">Commit date: {new Date(commit.date).toLocaleString()}</div>
              <div className="gm-reset-meta">Branch(es): {commit.refs.filter(r => !r.startsWith('tag:')).map(r => r.replace(/^HEAD -> /, '')).join(', ') || 'n/a'}</div>
            </div>
          </div>
          <div className="gm-reset-type-label">Reset type</div>
          <div className="gm-reset-options">
            {RESET_MODES.map((m) => (
              <label
                key={m.value}
                className={`gm-reset-option${mode === m.value ? ' gm-reset-option-selected' : ''}`}
                style={{ borderLeftColor: m.color, backgroundColor: mode === m.value ? `${m.color}22` : undefined }}
              >
                <input type="radio" name="resetMode" value={m.value} checked={mode === m.value} onChange={() => setMode(m.value)} />
                <div>
                  <div className="gm-reset-option-label">{m.label}: {m.desc}</div>
                </div>
              </label>
            ))}
          </div>
        </div>
        <div className="gm-modal-footer">
          <button className="gm-modal-btn gm-modal-btn-primary" onClick={handleOk} disabled={busy}>OK</button>
          <button className="gm-modal-btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

// --- Create branch modal ---

const CreateBranchModal: React.FC<{
  commit: GitCommitInfo
  projectDir: string
  onClose: () => void
  onAction: () => void
  onError: (msg: string) => void
}> = ({ commit, projectDir, onClose, onAction, onError }) => {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { setTimeout(() => inputRef.current?.focus(), 50) }, [])

  const handleCreate = async () => {
    if (!name.trim()) return
    setBusy(true)
    const r = await getDockApi().gitManager.createBranch(projectDir, name.trim(), commit.hash)
    setBusy(false)
    if (!r.success) { onError(r.error || 'Create branch failed'); onClose(); return }
    onAction()
    onClose()
  }

  return (
    <div className="gm-modal-overlay" onClick={onClose}>
      <div className="gm-modal gm-modal-sm" onClick={(e) => e.stopPropagation()}>
        <div className="gm-modal-header">
          <span>Create new branch</span>
          <button className="gm-modal-close" onClick={onClose}>&#10005;</button>
        </div>
        <div className="gm-modal-body">
          <label className="gm-modal-field">
            <span>Branch name</span>
            <input
              ref={inputRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              placeholder="feature/my-branch"
              className="gm-modal-input"
            />
          </label>
          <label className="gm-modal-field">
            <span>Create at revision</span>
            <input type="text" value={commit.shortHash} readOnly className="gm-modal-input gm-modal-input-ro" />
          </label>
        </div>
        <div className="gm-modal-footer">
          <button className="gm-modal-btn gm-modal-btn-primary" onClick={handleCreate} disabled={busy || !name.trim()}>Create branch</button>
          <button className="gm-modal-btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

// --- Create tag modal ---

const CreateTagModal: React.FC<{
  commit: GitCommitInfo
  projectDir: string
  onClose: () => void
  onAction: () => void
  onError: (msg: string) => void
}> = ({ commit, projectDir, onClose, onAction, onError }) => {
  const [tagName, setTagName] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { setTimeout(() => inputRef.current?.focus(), 50) }, [])

  const handleCreate = async () => {
    if (!tagName.trim()) return
    setBusy(true)
    const r = await getDockApi().gitManager.createTag(projectDir, tagName.trim(), commit.hash, message.trim() || undefined)
    setBusy(false)
    if (!r.success) { onError(r.error || 'Create tag failed'); onClose(); return }
    onAction()
    onClose()
  }

  return (
    <div className="gm-modal-overlay" onClick={onClose}>
      <div className="gm-modal gm-modal-sm" onClick={(e) => e.stopPropagation()}>
        <div className="gm-modal-header">
          <span>Create tag</span>
          <button className="gm-modal-close" onClick={onClose}>&#10005;</button>
        </div>
        <div className="gm-modal-body">
          <label className="gm-modal-field">
            <span>Tag name</span>
            <input
              ref={inputRef}
              type="text"
              value={tagName}
              onChange={(e) => setTagName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              placeholder="v1.0.0"
              className="gm-modal-input"
            />
          </label>
          <label className="gm-modal-field">
            <span>Create tag at revision</span>
            <input type="text" value={commit.shortHash} readOnly className="gm-modal-input gm-modal-input-ro" />
          </label>
          <label className="gm-modal-field">
            <span>Message (optional, makes annotated tag)</span>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Lightweight tag if left empty"
              className="gm-modal-textarea"
              rows={3}
            />
          </label>
        </div>
        <div className="gm-modal-footer">
          <button className="gm-modal-btn gm-modal-btn-primary" onClick={handleCreate} disabled={busy || !tagName.trim()}>Create tag</button>
          <button className="gm-modal-btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

// --- Merge Conflicts Panel ---

const MergeConflictsPanel: React.FC<{
  mergeState: GitMergeState
  projectDir: string
  onRefresh: () => void
  onError: (msg: string) => void
}> = ({ mergeState, projectDir, onRefresh, onError }) => {
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [conflictContent, setConflictContent] = useState<GitConflictFileContent | null>(null)
  const [loadingContent, setLoadingContent] = useState(false)
  const [busy, setBusy] = useState(false)

  // Load conflict content when file is selected
  useEffect(() => {
    if (!selectedFile) { setConflictContent(null); return }
    let cancelled = false
    setLoadingContent(true)
    getDockApi().gitManager.getConflictContent(projectDir, selectedFile)
      .then((content) => { if (!cancelled) setConflictContent(content) })
      .catch(() => { if (!cancelled) setConflictContent(null) })
      .finally(() => { if (!cancelled) setLoadingContent(false) })
    return () => { cancelled = true }
  }, [selectedFile, projectDir])

  const handleResolveChunk = useCallback(async (chunkIndex: number, resolution: 'ours' | 'theirs' | 'both') => {
    if (!selectedFile) return
    setBusy(true)
    const r = await getDockApi().gitManager.resolveConflict(projectDir, selectedFile, resolution, chunkIndex)
    if (!r.success) onError(r.error || 'Resolve failed')
    // Reload the file content
    try {
      const content = await getDockApi().gitManager.getConflictContent(projectDir, selectedFile)
      setConflictContent(content)
    } catch { /* file may have no more conflicts */ }
    setBusy(false)
  }, [selectedFile, projectDir, onError])

  const handleResolveAll = useCallback(async (resolution: 'ours' | 'theirs' | 'both') => {
    if (!selectedFile) return
    setBusy(true)
    const r = await getDockApi().gitManager.resolveConflict(projectDir, selectedFile, resolution)
    if (!r.success) onError(r.error || 'Resolve failed')
    try {
      const content = await getDockApi().gitManager.getConflictContent(projectDir, selectedFile)
      setConflictContent(content)
    } catch { /* ignore */ }
    setBusy(false)
  }, [selectedFile, projectDir, onError])

  const handleMarkResolved = useCallback(async () => {
    if (!selectedFile) return
    setBusy(true)
    const r = await getDockApi().gitManager.stage(projectDir, [selectedFile])
    if (!r.success) onError(r.error || 'Stage failed')
    onRefresh()
    setBusy(false)
  }, [selectedFile, projectDir, onRefresh, onError])

  const handleAbort = useCallback(async () => {
    setBusy(true)
    const r = await getDockApi().gitManager.abortMerge(projectDir)
    if (!r.success) onError(r.error || 'Abort failed')
    onRefresh()
    setBusy(false)
  }, [projectDir, onRefresh, onError])

  const handleContinue = useCallback(async () => {
    setBusy(true)
    const r = await getDockApi().gitManager.continueMerge(projectDir)
    if (!r.success) onError(r.error || 'Continue failed')
    onRefresh()
    setBusy(false)
  }, [projectDir, onRefresh, onError])

  const conflictChunks = conflictContent?.chunks.filter((c) => c.type === 'conflict') || []
  const hasConflicts = conflictChunks.length > 0

  return (
    <div className="gm-conflicts">
      {/* File list */}
      <div className="gm-conflicts-sidebar">
        <div className="gm-conflicts-sidebar-header">
          <span>Conflicted Files</span>
          <span className="gm-conflicts-count">{mergeState.conflicts.length}</span>
        </div>
        <div className="gm-conflicts-file-list">
          {mergeState.conflicts.map((c) => (
            <div
              key={c.path}
              className={`gm-conflicts-file${selectedFile === c.path ? ' gm-conflicts-file-active' : ''}`}
              onClick={() => setSelectedFile(c.path)}
            >
              <ConflictFileIcon />
              <span className="gm-file-path">{c.path}</span>
            </div>
          ))}
          {mergeState.conflicts.length === 0 && (
            <div className="gm-conflicts-empty">All conflicts resolved</div>
          )}
        </div>
        <div className="gm-conflicts-actions">
          <button className="gm-conflicts-action-btn gm-conflicts-abort" onClick={handleAbort} disabled={busy}>
            Abort {mergeState.type === 'merge' ? 'Merge' : mergeState.type === 'rebase' ? 'Rebase' : mergeState.type === 'cherry-pick' ? 'Cherry-pick' : 'Revert'}
          </button>
          <button
            className="gm-conflicts-action-btn gm-conflicts-continue"
            onClick={handleContinue}
            disabled={busy || mergeState.conflicts.length > 0}
            title={mergeState.conflicts.length > 0 ? 'Resolve all conflicts first' : 'Continue merge'}
          >
            Continue {mergeState.type === 'merge' ? 'Merge' : mergeState.type === 'rebase' ? 'Rebase' : mergeState.type === 'cherry-pick' ? 'Cherry-pick' : 'Revert'}
          </button>
        </div>
      </div>

      {/* Conflict detail */}
      <div className="gm-conflicts-detail">
        {!selectedFile ? (
          <div className="gm-conflicts-placeholder">
            <ConflictPlaceholderIcon />
            <p>Select a conflicted file to begin resolving</p>
          </div>
        ) : loadingContent ? (
          <div className="gm-loading">Loading conflict...</div>
        ) : conflictContent ? (
          <div className="gm-conflicts-content">
            <div className="gm-conflicts-content-header">
              <span className="gm-conflicts-content-path">{selectedFile}</span>
              <div className="gm-conflicts-content-actions">
                {hasConflicts && (
                  <>
                    <button className="gm-small-btn" onClick={() => handleResolveAll('ours')} disabled={busy}>Accept All Ours</button>
                    <button className="gm-small-btn" onClick={() => handleResolveAll('theirs')} disabled={busy}>Accept All Theirs</button>
                  </>
                )}
                <button
                  className="gm-small-btn gm-conflicts-mark-btn"
                  onClick={handleMarkResolved}
                  disabled={busy || hasConflicts}
                  title={hasConflicts ? 'Resolve all conflict chunks first' : 'Mark file as resolved'}
                >
                  Mark as Resolved
                </button>
              </div>
            </div>
            <div className="gm-conflicts-chunks">
              {conflictContent.chunks.map((chunk, ci) => (
                <ConflictChunkView
                  key={ci}
                  chunk={chunk}
                  chunkIndex={ci}
                  onResolve={handleResolveChunk}
                  disabled={busy}
                />
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

const ConflictChunkView: React.FC<{
  chunk: GitConflictChunk
  chunkIndex: number
  onResolve: (index: number, resolution: 'ours' | 'theirs' | 'both') => void
  disabled: boolean
}> = ({ chunk, chunkIndex, onResolve, disabled }) => {
  if (chunk.type === 'common') {
    const lines = chunk.commonLines || []
    // Show abbreviated common sections (first 3 + last 3 if long)
    const abbreviated = lines.length > 8
    const showLines = abbreviated ? [...lines.slice(0, 3), null, ...lines.slice(-3)] : lines
    return (
      <div className="gm-conflict-common">
        {showLines.map((line, i) =>
          line === null ? (
            <div key={`ellipsis-${i}`} className="gm-conflict-ellipsis">⋯ {lines.length - 6} lines hidden</div>
          ) : (
            <div key={i} className="gm-conflict-line gm-conflict-line-context">{line}</div>
          )
        )}
      </div>
    )
  }

  return (
    <div className="gm-conflict-block">
      <div className="gm-conflict-section gm-conflict-ours">
        <div className="gm-conflict-section-header">
          <span className="gm-conflict-section-label">Current Changes (Ours)</span>
          <button className="gm-conflict-accept-btn gm-conflict-accept-ours" onClick={() => onResolve(chunkIndex, 'ours')} disabled={disabled}>
            Accept Ours
          </button>
        </div>
        <div className="gm-conflict-section-lines">
          {(chunk.oursLines || []).map((line, i) => (
            <div key={i} className="gm-conflict-line gm-conflict-line-ours">{line || '\u00A0'}</div>
          ))}
          {(!chunk.oursLines || chunk.oursLines.length === 0) && (
            <div className="gm-conflict-line gm-conflict-line-empty">(empty)</div>
          )}
        </div>
      </div>
      <div className="gm-conflict-divider">
        <button className="gm-conflict-accept-btn gm-conflict-accept-both" onClick={() => onResolve(chunkIndex, 'both')} disabled={disabled}>
          Accept Both
        </button>
      </div>
      <div className="gm-conflict-section gm-conflict-theirs">
        <div className="gm-conflict-section-header">
          <span className="gm-conflict-section-label">Incoming Changes (Theirs)</span>
          <button className="gm-conflict-accept-btn gm-conflict-accept-theirs" onClick={() => onResolve(chunkIndex, 'theirs')} disabled={disabled}>
            Accept Theirs
          </button>
        </div>
        <div className="gm-conflict-section-lines">
          {(chunk.theirsLines || []).map((line, i) => (
            <div key={i} className="gm-conflict-line gm-conflict-line-theirs">{line || '\u00A0'}</div>
          ))}
          {(!chunk.theirsLines || chunk.theirsLines.length === 0) && (
            <div className="gm-conflict-line gm-conflict-line-empty">(empty)</div>
          )}
        </div>
      </div>
    </div>
  )
}

// --- Confirmation modal ---

const ConfirmModal: React.FC<{
  title: string
  message: React.ReactNode
  confirmLabel?: string
  danger?: boolean
  onConfirm: () => void
  onClose: () => void
}> = ({ title, message, confirmLabel = 'Confirm', danger = false, onConfirm, onClose }) => (
  <div className="gm-modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
    <div className="gm-modal gm-modal-sm">
      <div className="gm-modal-header">
        <span>{title}</span>
        <button className="gm-modal-close" onClick={onClose}>&times;</button>
      </div>
      <div className="gm-modal-body" style={{ fontSize: 12, lineHeight: 1.5 }}>
        {message}
      </div>
      <div className="gm-modal-footer">
        <button className="gm-modal-btn" onClick={onClose}>Cancel</button>
        <button
          className={`gm-modal-btn${danger ? ' gm-modal-btn-danger' : ' gm-modal-btn-primary'}`}
          onClick={() => { onConfirm(); onClose() }}
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  </div>
)

// --- Add Submodule / Add Remote modals ---

const AddSubmoduleModal: React.FC<{
  basePath: string
  projectDir: string
  onClose: () => void
  onDone: () => void
  onError: (msg: string) => void
}> = ({ basePath, projectDir, onClose, onDone, onError }) => {
  const [url, setUrl] = useState('')
  const [localPath, setLocalPath] = useState(basePath ? basePath + '/' : '')
  const [branch, setBranch] = useState('')
  const [force, setForce] = useState(false)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const handleAdd = async () => {
    if (!url.trim() || busy) return
    setBusy(true)
    const r = await getDockApi().gitManager.addSubmodule(
      projectDir,
      url.trim(),
      localPath.trim() || undefined,
      branch.trim() || undefined,
      force
    )
    setBusy(false)
    if (r.success) { onDone(); onClose() }
    else onError(r.error || 'Add submodule failed')
  }

  return (
    <div className="gm-modal-overlay" onClick={onClose}>
      <div className="gm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="gm-modal-header">
          <span>Add submodule</span>
          <button className="gm-modal-close" onClick={onClose}>&#10005;</button>
        </div>
        <div className="gm-modal-body">
          <label className="gm-modal-field">
            <span>Path to submodule (URL or local path)</span>
            <input
              ref={inputRef}
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://github.com/user/repo.git"
              className="gm-modal-input"
            />
          </label>
          <label className="gm-modal-field">
            <span>Local path (leave empty for auto)</span>
            <input
              type="text"
              value={localPath}
              onChange={(e) => setLocalPath(e.target.value)}
              placeholder="path/to/submodule"
              className="gm-modal-input"
            />
          </label>
          <label className="gm-modal-field">
            <span>Branch (optional)</span>
            <input
              type="text"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="main"
              className="gm-modal-input"
            />
          </label>
          <label className="gm-modal-field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} style={{ accentColor: 'var(--accent-color)' }} />
            <span>Force</span>
          </label>
        </div>
        <div className="gm-modal-footer">
          <button className="gm-modal-btn gm-modal-btn-primary" onClick={handleAdd} disabled={busy || !url.trim()}>
            {busy ? 'Adding...' : 'Add submodule'}
          </button>
          <button className="gm-modal-btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

const AddRemoteModal: React.FC<{
  projectDir: string
  onClose: () => void
  onDone: () => void
  onError: (msg: string) => void
}> = ({ projectDir, onClose, onDone, onError }) => {
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const handleAdd = async () => {
    if (!name.trim() || !url.trim() || busy) return
    setBusy(true)
    const r = await getDockApi().gitManager.addRemote(projectDir, name.trim(), url.trim())
    setBusy(false)
    if (r.success) { onDone(); onClose() }
    else onError(r.error || 'Add remote failed')
  }

  return (
    <div className="gm-modal-overlay" onClick={onClose}>
      <div className="gm-modal gm-modal-sm" onClick={(e) => e.stopPropagation()}>
        <div className="gm-modal-header">
          <span>Add remote</span>
          <button className="gm-modal-close" onClick={onClose}>&#10005;</button>
        </div>
        <div className="gm-modal-body">
          <label className="gm-modal-field">
            <span>Name</span>
            <input
              ref={inputRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="origin"
              className="gm-modal-input"
            />
          </label>
          <label className="gm-modal-field">
            <span>URL</span>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
              placeholder="https://github.com/user/repo.git"
              className="gm-modal-input"
            />
          </label>
        </div>
        <div className="gm-modal-footer">
          <button className="gm-modal-btn gm-modal-btn-primary" onClick={handleAdd} disabled={busy || !name.trim() || !url.trim()}>
            {busy ? 'Adding...' : 'Add remote'}
          </button>
          <button className="gm-modal-btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

// --- Settings dropdown ---

const PLUGIN_SETTINGS: { key: string; label: string; type: 'boolean' }[] = [
  { key: 'autoGenerateCommitMsg', label: 'Auto-generate commit messages', type: 'boolean' }
]

const SettingsDropdown: React.FC<{ projectDir: string }> = ({ projectDir }) => {
  const [open, setOpen] = useState(false)
  const [values, setValues] = useState<Record<string, unknown>>({})
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const api = getDockApi()
    Promise.all(
      PLUGIN_SETTINGS.map(async (s) => {
        const val = await api.plugins.getSetting(projectDir, 'git-manager', s.key)
        return [s.key, val] as const
      })
    ).then((entries) => setValues(Object.fromEntries(entries)))
  }, [open, projectDir])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const blurHandler = () => setOpen(false)
    document.addEventListener('mousedown', handler)
    window.addEventListener('blur', blurHandler)
    return () => {
      document.removeEventListener('mousedown', handler)
      window.removeEventListener('blur', blurHandler)
    }
  }, [open])

  const toggle = async (key: string) => {
    const cur = !!values[key]
    const next = !cur
    setValues((prev) => ({ ...prev, [key]: next }))
    await getDockApi().plugins.setSetting(projectDir, 'git-manager', key, next)
  }

  return (
    <div className="gm-settings-dropdown" ref={ref}>
      <button className="gm-toolbar-btn" onClick={() => setOpen(!open)} title="Settings">
        <SettingsIcon />
      </button>
      {open && (
        <div className="gm-settings-menu">
          <div className="gm-settings-title">Git Manager Settings</div>
          {PLUGIN_SETTINGS.map((s) => (
            <label key={s.key} className="gm-settings-item">
              <input
                type="checkbox"
                checked={!!values[s.key]}
                onChange={() => toggle(s.key)}
              />
              <span>{s.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

const SettingsIcon: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
  </svg>
)

// --- Submodule tree ---

interface SubmoduleTreeNode {
  name: string
  children: SubmoduleTreeNode[]
  submodule?: GitSubmoduleInfo
}

function buildSubmoduleTree(submodules: GitSubmoduleInfo[]): SubmoduleTreeNode[] {
  const root: SubmoduleTreeNode = { name: '', children: [] }

  for (const sub of submodules) {
    const parts = sub.path.split('/')
    let current = root
    // Navigate/create directory nodes for all but the last part
    for (let i = 0; i < parts.length - 1; i++) {
      let child = current.children.find((c) => c.name === parts[i] && !c.submodule)
      if (!child) {
        child = { name: parts[i], children: [] }
        current.children.push(child)
      }
      current = child
    }
    // Add the submodule as a leaf
    current.children.push({ name: sub.name, children: [], submodule: sub })
  }

  return root.children
}

const SubmoduleTree: React.FC<{
  submodules: GitSubmoduleInfo[]
  selectedPath?: string | null
  onSelect?: (path: string) => void
  onNavigate: (sub: GitSubmoduleInfo) => void
  onAddInFolder?: (basePath: string) => void
  onRemove?: (subPath: string) => void
}> = ({ submodules, selectedPath, onSelect, onNavigate, onAddInFolder, onRemove }) => {
  const tree = useMemo(() => buildSubmoduleTree(submodules), [submodules])
  return <>{tree.map((node) => <SubmoduleTreeNodeView key={node.name} node={node} selectedPath={selectedPath} onSelect={onSelect} onNavigate={onNavigate} onAddInFolder={onAddInFolder} onRemove={onRemove} depth={0} parentPath="" />)}</>
}

const SubmoduleTreeNodeView: React.FC<{
  node: SubmoduleTreeNode
  selectedPath?: string | null
  onSelect?: (path: string) => void
  onNavigate: (sub: GitSubmoduleInfo) => void
  onAddInFolder?: (basePath: string) => void
  onRemove?: (subPath: string) => void
  depth: number
  parentPath: string
}> = ({ node, selectedPath, onSelect, onNavigate, onAddInFolder, onRemove, depth, parentPath }) => {
  const [collapsed, setCollapsed] = useState(false)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null)

  if (node.submodule) {
    const sub = node.submodule
    const hasStageableCommit = sub.status === 'modified'
    const tooltip = [
      `${sub.path} (${sub.hash})`,
      hasStageableCommit ? 'New commits (can be staged)' : null,
      sub.hasDirtyWorkTree ? 'Has uncommitted changes' : null,
      'Double-click to open submodule'
    ].filter(Boolean).join('\n')
    return (
      <>
        <div
          className={`gm-sidebar-item gm-sidebar-item-submodule${selectedPath === sub.path ? ' gm-sidebar-item-active' : ''}`}
          onClick={() => onSelect?.(sub.path)}
          onDoubleClick={() => onNavigate(sub)}
          onContextMenu={(e) => {
            e.preventDefault()
            if (!onRemove) return
            const zoom = parseFloat(document.documentElement.style.zoom) || 1
            setCtxMenu({ x: e.clientX / zoom, y: e.clientY / zoom })
          }}
          title={tooltip}
          style={{ paddingLeft: 22 + depth * 14 }}
        >
          <SubmoduleIcon />
          <span className="gm-branch-name">
            {node.name}
            {sub.branch && <span style={{ color: 'var(--text-secondary)', fontWeight: 400 }}> ({sub.branch})</span>}
          </span>
          <span className="gm-submodule-indicators">
            {sub.changeCount != null && sub.changeCount > 0 && (
              <span className="gm-badge gm-badge-submodule-changes" title={`${sub.changeCount} working change${sub.changeCount > 1 ? 's' : ''}`}>
                {sub.changeCount}
              </span>
            )}
            {sub.hasDirtyWorkTree && (
              <span className="gm-submodule-dirty" title="Has uncommitted changes">
                <SubmoduleDirtyIcon />
              </span>
            )}
            {hasStageableCommit && (
              <span className="gm-submodule-commits" title="New commits (can be staged)">
                <SubmoduleCommitIcon />
              </span>
            )}
            {sub.status === 'uninitialized' && (
              <span className="gm-badge gm-badge-uninit">-</span>
            )}
          </span>
        </div>
        {ctxMenu && onRemove && (
          <SubmoduleContextMenu
            x={ctxMenu.x}
            y={ctxMenu.y}
            subPath={sub.path}
            onRemove={onRemove}
            onClose={() => setCtxMenu(null)}
          />
        )}
      </>
    )
  }

  // Directory node
  const folderPath = parentPath ? `${parentPath}/${node.name}` : node.name
  return (
    <>
      <div
        className="gm-sidebar-item gm-submodule-folder"
        onClick={() => setCollapsed((p) => !p)}
        style={{ paddingLeft: 22 + depth * 14 }}
      >
        <FolderIcon />
        <span className="gm-branch-name">{node.name}</span>
        {onAddInFolder && (
          <button
            className="gm-sidebar-folder-add-btn"
            onClick={(e) => { e.stopPropagation(); onAddInFolder(folderPath) }}
            title={`Add submodule in ${folderPath}/`}
          >+</button>
        )}
      </div>
      {!collapsed && node.children.map((child) => (
        <SubmoduleTreeNodeView key={child.name} node={child} selectedPath={selectedPath} onSelect={onSelect} onNavigate={onNavigate} onAddInFolder={onAddInFolder} onRemove={onRemove} depth={depth + 1} parentPath={folderPath} />
      ))}
    </>
  )
}

// --- Stash sidebar entry with right-click context menu ---

const StashSidebarEntry: React.FC<{
  stash: GitStashEntry
  projectDir: string
  onError: (msg: string) => void
  onRefresh: () => void
  onConfirm: (modal: { title: string; message: React.ReactNode; confirmLabel: string; danger?: boolean; onConfirm: () => void }) => void
}> = ({ stash, projectDir, onError, onRefresh, onConfirm }) => {
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null)
  const ctxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!ctxMenu) return
    const handler = (e: MouseEvent) => {
      if (ctxRef.current && !ctxRef.current.contains(e.target as Node)) setCtxMenu(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [ctxMenu])

  const handleCtx = (e: React.MouseEvent) => {
    e.preventDefault()
    const zoom = parseFloat(document.documentElement.style.zoom) || 1
    setCtxMenu({ x: e.clientX / zoom, y: e.clientY / zoom })
  }

  const api = getDockApi()
  const label = stash.message || `stash@{${stash.index}}`

  const doApply = async () => {
    setCtxMenu(null)
    const r = await api.gitManager.stashApply(projectDir, stash.index)
    if (!r.success) onError(r.error || 'Stash apply failed')
    onRefresh()
  }

  const doPop = async () => {
    setCtxMenu(null)
    const r = await api.gitManager.stashPop(projectDir, stash.index)
    if (!r.success) onError(r.error || 'Stash pop failed')
    onRefresh()
  }

  const doDrop = () => {
    setCtxMenu(null)
    onConfirm({
      title: 'Drop stash',
      message: (<p>Are you sure you want to drop <strong>stash@&#123;{stash.index}&#125;</strong>?<br /><span style={{ color: 'var(--text-secondary)', fontSize: 11 }}>{label}</span></p>),
      confirmLabel: 'Drop',
      danger: true,
      onConfirm: async () => {
        const r = await api.gitManager.stashDrop(projectDir, stash.index)
        if (!r.success) onError(r.error || 'Stash drop failed')
        onRefresh()
      }
    })
  }

  return (
    <>
      <div
        className="gm-sidebar-item gm-sidebar-item-stash"
        title={`stash@{${stash.index}}: ${stash.message}`}
        onContextMenu={handleCtx}
      >
        <StashSidebarIcon />
        <span className="gm-branch-name">{label}</span>
        <span className="gm-sidebar-stash-index">@{stash.index}</span>
      </div>
      {ctxMenu && (
        <div className="gm-ctx-menu" ref={ctxRef} style={{ left: ctxMenu.x, top: ctxMenu.y }}>
          <div className="gm-ctx-item" onClick={doApply}>Apply stash</div>
          <div className="gm-ctx-item" onClick={doPop}>Pop stash</div>
          <div className="gm-ctx-separator" />
          <div className="gm-ctx-item gm-ctx-danger" onClick={doDrop}>Drop stash</div>
        </div>
      )}
    </>
  )
}

const SubmoduleContextMenu: React.FC<{
  x: number; y: number
  subPath: string
  onRemove: (subPath: string) => void
  onClose: () => void
}> = ({ x, y, subPath, onRemove, onClose }) => {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  return (
    <div className="gm-ctx-menu" ref={ref} style={{ left: x, top: y }}>
      <div
        className="gm-ctx-item gm-ctx-danger"
        onClick={() => { onRemove(subPath); onClose() }}
      >
        Remove submodule
      </div>
    </div>
  )
}

// --- SVG Icons ---

const BackIcon: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="15 18 9 12 15 6" />
  </svg>
)

const SubmoduleIcon: React.FC = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
    <circle cx="12" cy="14" r="2" strokeWidth="1.5" />
  </svg>
)

const SubmoduleDirtyIcon: React.FC = () => (
  <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
    <circle cx="8" cy="8" r="5" fill="#e0af68" />
  </svg>
)

const SubmoduleCommitIcon: React.FC = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#9ece6a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="17 1 21 5 17 9" />
    <path d="M3 11V9a4 4 0 014-4h14" />
  </svg>
)

const StashSidebarIcon: React.FC = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#bb9af7" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
    <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" />
  </svg>
)

const BashIcon: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="4 17 10 11 4 5" />
    <line x1="12" y1="19" x2="20" y2="19" />
  </svg>
)

const OpenFolderIcon: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
    <line x1="12" y1="11" x2="12" y2="17" />
    <polyline points="9 14 12 11 15 14" />
  </svg>
)

const FolderIcon: React.FC = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.5 }}>
    <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
  </svg>
)

const SparkleIcon: React.FC = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3l1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5L12 3z" />
    <path d="M19 15l.5 2 2 .5-2 .5-.5 2-.5-2-2-.5 2-.5.5-2z" />
  </svg>
)

const GitIcon: React.FC = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="18" r="3" />
    <circle cx="12" cy="6" r="3" />
    <path d="M12 9v6" />
  </svg>
)

const FetchIcon: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </svg>
)

const PullIcon: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="8 17 12 21 16 17" />
    <line x1="12" y1="12" x2="12" y2="21" />
    <path d="M20.88 18.09A5 5 0 0018 9h-1.26A8 8 0 103 16.29" />
  </svg>
)

const PushIcon: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="16 16 12 12 8 16" />
    <line x1="12" y1="12" x2="12" y2="21" />
    <path d="M20.39 18.39A5 5 0 0018 9h-1.26A8 8 0 103 16.3" />
    <polyline points="16 16 12 12 8 16" />
  </svg>
)

const RefreshIcon: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="23 4 23 10 17 10" />
    <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
  </svg>
)

const WarningIcon: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#e0af68" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
    <line x1="12" y1="9" x2="12" y2="13" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  </svg>
)

const ConflictFileIcon: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#e0af68" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="12" y1="12" x2="12" y2="16" />
    <line x1="12" y1="18" x2="12.01" y2="18" />
  </svg>
)

const ConflictPlaceholderIcon: React.FC = () => (
  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" opacity="0.3">
    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="9" y1="13" x2="15" y2="13" />
  </svg>
)

function formatDate(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const diff = now.getTime() - d.getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return d.toLocaleDateString()
}

export default GitManagerApp
