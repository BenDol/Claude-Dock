import './git-manager.css'
import React, { useEffect, useLayoutEffect, useState, useCallback, useRef, useMemo } from 'react'
import { getDockApi } from '@dock-renderer/lib/ipc-bridge'
import { useSettingsStore } from '@dock-renderer/stores/settings-store'
import { applyThemeToDocument } from '@dock-renderer/lib/theme'
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
  GitConflictChunk,
  GitSearchResult,
  GitSearchResponse
} from '../../../../shared/git-manager-types'
import { remoteUrlToCommitUrl, detectProvider, type GitProvider } from '../../../../shared/remote-url'
import { highlightDiffHunks, highlightCode } from './diff-highlight'
import { ProviderIcon, providerLabel } from './ProviderIcons'
import CiPanel from './CiPanel'
import type { CiLogSearchMatch, CiSearchProgress } from './CiPanel'
const PrPanel = React.lazy(() => import('./PrPanel'))
import type { DockNotification, NotificationAction } from '../../../../shared/ci-types'
import type { WriteTestsTask, ReferenceThisTask } from '../../../../shared/claude-task-types'

const params = new URLSearchParams(window.location.search)
const projectDir = decodeURIComponent(params.get('projectDir') || '')
const standaloneCommitHash = params.get('commitHash') || ''

interface NavEntry {
  dir: string
  label: string
}

/** Send a write-tests task to the dock window */
function sendWriteTestsTask(files: string[], commitHash?: string, commitSubject?: string, selectedDiff?: string): void {
  const api = getDockApi()
  const task: WriteTestsTask = {
    type: 'write-tests',
    files,
    commitHash,
    commitSubject,
    selectedDiff
  }
  api.claudeTask.send(projectDir, task)
}

/** Send a reference-this task to the dock window */
function sendReferenceThisTask(files: string[], commitHash?: string, commitSubject?: string, selectedDiff?: string): void {
  const api = getDockApi()
  const task: ReferenceThisTask = {
    type: 'reference-this',
    files,
    commitHash,
    commitSubject,
    selectedDiff
  }
  api.claudeTask.send(projectDir, task)
}

/** Compute the character width needed for line numbers in a diff file */
function lineNoDigits(hunks: GitFileDiff['hunks']): number {
  let max = 0
  for (const h of hunks) for (const l of h.lines) {
    if (l.oldLineNo && l.oldLineNo > max) max = l.oldLineNo
    if (l.newLineNo && l.newLineNo > max) max = l.newLineNo
  }
  return Math.max(String(max).length, 3)
}

/** Ref callback: repositions a context submenu if it overflows the viewport */
function adjustSubmenuRef(el: HTMLDivElement | null): void {
  if (!el) return
  const zoom = parseFloat(document.documentElement.style.zoom) || 1
  const vw = window.innerWidth
  const vh = window.innerHeight
  let r = el.getBoundingClientRect()
  // Flip horizontally if overflowing right
  if (r.right > vw) {
    el.classList.add('gm-ctx-submenu-left')
    r = el.getBoundingClientRect()
  }
  // Flip back if flipping caused left overflow
  if (r.left < 0) {
    el.classList.remove('gm-ctx-submenu-left')
    r = el.getBoundingClientRect()
  }
  // Adjust vertically if overflowing bottom
  if (r.bottom > vh) {
    const over = (r.bottom - vh + 4) / zoom
    const currentTop = parseFloat(el.style.top) || -4
    el.style.top = `${currentTop - over}px`
  }
}

// --- Action error with resolutions ---

interface ActionErrorResolution {
  label: string
  description?: string
  danger?: boolean
  keepOpen?: boolean
  action: () => Promise<void>
}

interface ActionError {
  title: string
  message: string
  resolutions: ActionErrorResolution[]
}

function parseGitError(action: string, errorMsg: string, context: {
  projectDir: string
  refresh: () => void
  branchName?: string
  retry?: () => Promise<void>
}): ActionError {
  const api = getDockApi()
  const msg = errorMsg || `${action} failed`
  const resolutions: ActionErrorResolution[] = []

  const stashThenRetry = async (flags?: string) => {
    const sr = await api.gitManager.stashSave(context.projectDir, `Auto-stash before ${action.toLowerCase()}`, flags)
    if (!sr.success) throw new Error('Stash failed: ' + (sr.error || 'Unknown error'))
    if (context.retry) await context.retry()
  }

  // Dirty working tree — checkout, rebase, merge, pull
  if (/local changes.*would be overwritten|uncommitted changes|unstaged changes|please.*(stash|commit)|cannot.*checkout.*with.*uncommitted|your local changes/i.test(msg)) {
    resolutions.push({
      label: 'Stash & retry',
      description: 'Save your changes to the stash, then retry the operation',
      action: () => stashThenRetry()
    })
    resolutions.push({
      label: 'Stash (keep index) & retry',
      description: 'Stash only unstaged changes, keep staged files, then retry',
      action: () => stashThenRetry('--keep-index')
    })
    resolutions.push({
      label: 'Stash (include untracked) & retry',
      description: 'Stash all changes including untracked files, then retry',
      action: () => stashThenRetry('--include-untracked')
    })
  }

  // Push rejected — non-fast-forward
  if (/non-fast-forward|rejected.*fetch first|failed to push|updates were rejected/i.test(msg)) {
    resolutions.push({
      label: 'Pull with the default pull action (rebase)',
      description: 'Pull with rebase and autostash, then push again',
      action: async () => {
        const pr = await api.gitManager.pull(context.projectDir, 'rebase')
        if (!pr.success) throw new Error(pr.error || 'Pull rebase failed')
        const ps = await api.gitManager.push(context.projectDir)
        if (!ps.success) throw new Error(ps.error || 'Push failed after pull')
      }
    })
    resolutions.push({
      label: 'Pull with rebase',
      description: 'Rebase local commits on top of remote changes, then push',
      action: async () => {
        const pr = await api.gitManager.pull(context.projectDir, 'rebase')
        if (!pr.success) throw new Error(pr.error || 'Pull rebase failed')
        const ps = await api.gitManager.push(context.projectDir)
        if (!ps.success) throw new Error(ps.error || 'Push failed after rebase')
      }
    })
    resolutions.push({
      label: 'Pull with merge',
      description: 'Merge remote changes into local branch, then push',
      action: async () => {
        const pr = await api.gitManager.pull(context.projectDir, 'merge')
        if (!pr.success) throw new Error(pr.error || 'Pull merge failed')
        const ps = await api.gitManager.push(context.projectDir)
        if (!ps.success) throw new Error(ps.error || 'Push failed after merge')
      }
    })
    resolutions.push({
      label: 'Force push with lease',
      description: 'Force push safely — fails if remote has new commits from others',
      danger: true,
      action: async () => {
        const ps = await api.gitManager.pushForceWithLease(context.projectDir)
        if (!ps.success) throw new Error(ps.error || 'Force push failed')
      }
    })
  }

  // Merge conflicts
  if (/conflict|merge.*failed|automatic merge failed|could not apply/i.test(msg) && !/non-fast-forward/i.test(msg)) {
    resolutions.push({
      label: 'Open conflict resolver',
      description: 'Switch to the conflicts tab to resolve manually',
      action: async () => { /* handled by caller setting tab */ }
    })
  }

  // Branch already exists
  if (/already exists|branch.*already/i.test(msg)) {
    // No automatic resolution — user needs to choose a different name
  }

  // Cannot delete current branch
  if (/cannot delete.*checked out|cannot delete branch.*currently on/i.test(msg)) {
    resolutions.push({
      label: 'Switch to another branch first',
      description: 'Checkout a different branch before deleting',
      action: async () => { /* informational — user picks branch */ }
    })
  }

  // Lock file exists — stale .git/index.lock from crashed process
  if (/index\.lock.*file exists|unable to create.*index\.lock|another git process/i.test(msg)) {
    resolutions.push({
      label: 'Remove lock file & retry',
      description: 'Delete the stale .git/index.lock file, then retry the operation',
      action: async () => {
        const lr = await api.gitManager.removeLockFile(context.projectDir)
        if (!lr.success) throw new Error(lr.error || 'Failed to remove lock file')
        if (context.retry) await context.retry()
      }
    })
    resolutions.push({
      label: 'Remove lock file only',
      description: 'Delete the stale .git/index.lock file without retrying',
      action: async () => {
        const lr = await api.gitManager.removeLockFile(context.projectDir)
        if (!lr.success) throw new Error(lr.error || 'Failed to remove lock file')
      }
    })
  }

  // Unmerged paths / dirty index from active merge — need to resolve or abort
  if (/unmerged|fix conflicts and run|fix them up|could not write index/i.test(msg)) {
    resolutions.push({
      label: 'Abort merge',
      description: 'Cancel the current merge/rebase/cherry-pick and retry',
      action: async () => {
        await api.gitManager.abortMerge(context.projectDir)
        if (context.retry) await context.retry()
      }
    })
    resolutions.push({
      label: 'Abort merge only',
      description: 'Cancel the current merge/rebase/cherry-pick without retrying',
      action: async () => {
        await api.gitManager.abortMerge(context.projectDir)
      }
    })
    return {
      title: 'Merge in progress',
      message: 'There is an active merge with unresolved conflicts. Resolve the conflicts or abort the merge before performing other git operations.',
      resolutions
    }
  }

  // Author identity unknown
  if (/author identity unknown|please tell me who you are|unable to auto-detect email/i.test(msg)) {
    return {
      title: 'Git identity not configured',
      message: 'Git needs your name and email address to create commits. Please configure your identity.',
      resolutions
    }
  }

  // Authentication / credential errors
  if (/authentication failed|invalid username or password|could not read username|permission denied.*publickey|requested url returned error: 40[13]|could not read from remote repository|correct access rights|support for password authentication was removed|terminal prompts disabled|host key verification failed/i.test(msg)) {
    resolutions.push({
      label: 'Open Git Bash to authenticate',
      description: 'Opens a terminal where Git will prompt you to sign in',
      keepOpen: true,
      action: async () => {
        await api.gitManager.openBash(context.projectDir)
      }
    })
    if (context.retry) {
      resolutions.push({
        label: 'Retry',
        description: 'Retry the operation after authenticating',
        action: context.retry
      })
    }
    // Determine friendly message based on error type
    let detail = 'Git could not authenticate with the remote repository.'
    if (/permission denied.*publickey|host key verification/i.test(msg)) {
      detail = 'SSH authentication failed. You may need to set up or add your SSH key.'
    } else if (/support for password authentication was removed/i.test(msg)) {
      detail = 'Password authentication is no longer supported by this remote. Use a personal access token or SSH key instead.'
    } else if (/could not read username|terminal prompts disabled/i.test(msg)) {
      detail = 'Git could not prompt for credentials. Open Git Bash to authenticate interactively.'
    }
    return {
      title: 'Authentication required',
      message: detail,
      resolutions
    }
  }

  // Better title/message for push rejection
  if (action.toLowerCase() === 'push' && /non-fast-forward|rejected.*fetch first|failed to push|updates were rejected/i.test(msg)) {
    resolutions.push({
      label: 'Pull & Rebase',
      description: 'Pull the latest changes with rebase, then try pushing again',
      action: async () => {
        await api.gitManager.pull(context.projectDir)
        context.refresh()
      }
    })
    return {
      title: 'Branch is behind remote',
      message: 'The push was rejected because your branch is behind its remote counterpart. Pull the latest changes before pushing again.',
      resolutions
    }
  }

  // Large file / Git LFS errors
  if (/exceeds.*file size limit|large files detected|git.lfs|GH001/i.test(msg)) {
    // Extract file names and sizes from the error
    const fileMatches = [...msg.matchAll(/File\s+(\S+)\s+is\s+([\d.]+\s*[KMGT]?B)/gi)]
    const fileList = fileMatches.map((m) => `${m[1]} (${m[2]})`).join(', ')

    if (fileMatches.length > 0) {
      resolutions.push({
        label: 'Migrate to Git LFS & Push',
        description: 'Install Git LFS, track these file types, amend the commit, then push',
        action: async () => {
          const files = fileMatches.map((m) => m[1])
          const lfsResult = await api.gitManager.migrateToLfs(context.projectDir, files)
          if (!lfsResult.success) throw new Error(lfsResult.error || 'LFS migration failed')
          const pushResult = await api.gitManager.push(context.projectDir)
          if (!pushResult.success) throw new Error(pushResult.error || 'Push failed after LFS migration')
          context.refresh()
        }
      })
    }
    resolutions.push({
      label: 'Add to .gitignore',
      description: 'Stop tracking these large files and remove them from the commit',
      action: async () => {
        for (const m of fileMatches) {
          await api.gitManager.addToGitignore(context.projectDir, m[1], true)
        }
        context.refresh()
      }
    })
    resolutions.push({
      label: 'Open Git Bash',
      description: 'Set up Git LFS manually',
      keepOpen: true,
      action: async () => {
        await api.gitManager.openBash(context.projectDir)
      }
    })
    return {
      title: 'Files exceed size limit',
      message: fileList
        ? `The following files exceed the remote\'s file size limit: ${fileList}.\n\nYou can either add them to .gitignore, or set up Git LFS to track large files.`
        : 'One or more files exceed the remote\'s file size limit. Add them to .gitignore or set up Git LFS.',
      resolutions
    }
  }

  return { title: `${action} failed`, message: msg, resolutions }
}


// ── Extracted hooks for search state ────────────────────────────────────────

type TabType = 'log' | 'changes' | 'conflicts' | 'ci'

function useSearchState(activeDir: string, activeTab: TabType) {
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<GitSearchResult[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchTruncated, setSearchTruncated] = useState(false)
  const [searchFocusIdx, setSearchFocusIdx] = useState(-1)
  const [scrollToFileAndLine, setScrollToFileAndLine] = useState<{ filePath: string; lineNumber?: number } | null>(null)
  const [wcNavigateTo, setWcNavigateTo] = useState<{ path: string; staged: boolean; lineNumber?: number } | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const triggerSearch = useCallback((q: string) => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current)
    if (!q.trim()) {
      setSearchResults([])
      setSearchLoading(false)
      setSearchTruncated(false)
      return
    }
    setSearchLoading(true)
    searchDebounceRef.current = setTimeout(async () => {
      try {
        const mode = activeTab === 'changes' ? 'working' as const : 'log' as const
        const response = await getDockApi().gitManager.search(activeDir, { query: q.trim(), mode })
        setSearchResults(response.results)
        setSearchTruncated(response.truncated)
        setSearchFocusIdx(-1)
      } catch {
        setSearchResults([])
        setSearchTruncated(false)
      } finally {
        setSearchLoading(false)
      }
    }, 300)
  }, [activeDir, activeTab])

  const handleSearchClose = useCallback(() => setSearchOpen(false), [])
  const handleScrollToFileLineHandled = useCallback(() => setScrollToFileAndLine(null), [])
  const handleWcNavigateHandled = useCallback(() => setWcNavigateTo(null), [])

  // Ctrl+F keyboard shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault()
        searchInputRef.current?.focus()
        setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  return {
    searchQuery, setSearchQuery, searchResults, setSearchResults,
    searchLoading, setSearchLoading, searchOpen, setSearchOpen, searchTruncated,
    searchFocusIdx, setSearchFocusIdx,
    scrollToFileAndLine, setScrollToFileAndLine,
    wcNavigateTo, setWcNavigateTo,
    searchInputRef, searchDebounceRef,
    triggerSearch, handleSearchClose, handleScrollToFileLineHandled, handleWcNavigateHandled
  }
}

function useCiSearchState(activeTab: string) {
  const [ciLogOpen, setCiLogOpen] = useState(false)
  const [ciLogMatchInfo, setCiLogMatchInfo] = useState<{ count: number; current: number }>({ count: 0, current: 0 })
  const ciLogSearchMode = activeTab === 'ci' && ciLogOpen
  const ciSearchMode = activeTab === 'ci' && !ciLogOpen
  const [ciSearchResults, setCiSearchResults] = useState<CiLogSearchMatch[]>([])
  const [ciSearchProgress, setCiSearchProgress] = useState<CiSearchProgress | null>(null)

  // CI log view tracking
  useEffect(() => {
    const logViewHandler = (e: Event) => {
      const isOpen = (e as CustomEvent).detail as boolean
      setCiLogOpen(isOpen)
      if (!isOpen) { setCiLogMatchInfo({ count: 0, current: 0 }) }
    }
    const matchHandler = (e: Event) => {
      const info = (e as CustomEvent).detail as { count: number; current: number }
      setCiLogMatchInfo(info)
    }
    window.addEventListener('ci-log-view', logViewHandler)
    window.addEventListener('ci-log-search-matches', matchHandler)
    return () => {
      window.removeEventListener('ci-log-view', logViewHandler)
      window.removeEventListener('ci-log-search-matches', matchHandler)
    }
  }, [])

  // CI cross-log search results tracking
  useEffect(() => {
    const handler = (e: Event) => {
      const { results, progress } = (e as CustomEvent).detail as { results: CiLogSearchMatch[]; progress: CiSearchProgress | null }
      setCiSearchResults(results)
      setCiSearchProgress(progress)
    }
    window.addEventListener('ci-search-results', handler)
    return () => window.removeEventListener('ci-search-results', handler)
  }, [])

  return {
    ciLogOpen, ciLogMatchInfo, ciLogSearchMode, ciSearchMode,
    ciSearchResults, setCiSearchResults, ciSearchProgress, setCiSearchProgress
  }
}

const GitManagerApp: React.FC = () => {
  const loadSettings = useSettingsStore((s) => s.load)
  const [commits, setCommits] = useState<GitCommitInfo[]>([])
  const [totalCommitCount, setTotalCommitCount] = useState(0)
  const [branches, setBranches] = useState<GitBranchInfo[]>([])
  const [status, setStatus] = useState<GitStatusResult | null>(null)
  const [submodules, setSubmodules] = useState<GitSubmoduleInfo[]>([])
  const [submodulesLoading, setSubmodulesLoading] = useState(false)
  const [stashes, setStashes] = useState<GitStashEntry[]>([])
  const [tags, setTags] = useState<{ name: string; hash: string; date: string }[]>([])
  const [selectedCommit, setSelectedCommit] = useState<GitCommitDetail | null>(null)
  const [mergeState, setMergeState] = useState<GitMergeState | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<'log' | 'changes' | 'conflicts' | 'ci' | 'pr'>('log')
  const [enableCiTab, setEnableCiTab] = useState(false)
  const [enablePrTab, setEnablePrTab] = useState(false)
  const [ciStatus, setCiStatus] = useState<'success' | 'failure' | 'in_progress' | 'none'>('none')
  const [wcBusy, setWcBusy] = useState(false)
  const wcBusyRef = useRef(false)
  const [syntaxHL, setSyntaxHL] = useState(true)
  const [escToHide, setEscToHide] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<ActionError | null>(null)
  const actionBusyRef = useRef(false)
  const [identitySetup, setIdentitySetup] = useState<{ retry?: () => Promise<void> } | null>(null)
  const [notGitRepo, setNotGitRepo] = useState(false)
  const [sidebarModal, setSidebarModal] = useState<'addSubmodule' | 'addSubmodulePath' | 'addRemote' | null>(null)
  const [sidebarBranchCtx, setSidebarBranchCtx] = useState<{ x: number; y: number; branchName: string; isRemote: boolean } | null>(null)
  const [addSubmoduleBasePath, setAddSubmoduleBasePath] = useState('')
  const [switchBranchSubPath, setSwitchBranchSubPath] = useState<string | null>(null)
  const [selectedSubmodule, setSelectedSubmodule] = useState<string | null>(null)
  const [tagSidebarCtx, setTagSidebarCtx] = useState<{ x: number; y: number; tag: { name: string; hash: string; date: string } } | null>(null)
  const [scrollToHash, setScrollToHash] = useState<string | null>(null)
  const [confirmModal, setConfirmModal] = useState<{
    title: string; message: React.ReactNode; confirmLabel: string; danger?: boolean; onConfirm: () => void
  } | null>(null)
  // Navigation: activeDir is the repo we're currently viewing, navStack tracks parent repos
  const [activeDir, setActiveDir] = useState(projectDir)
  const [navStack, setNavStack] = useState<NavEntry[]>([])
  const sidebarRef = useRef<HTMLDivElement>(null)
  const detailRef = useRef<HTMLDivElement>(null)
  const [sidebarFocusIdx, setSidebarFocusIdx] = useState(-1)

  // Search state (extracted hook)
  const {
    searchQuery, setSearchQuery, searchResults, setSearchResults,
    searchLoading, setSearchLoading, searchOpen, setSearchOpen, searchTruncated,
    searchFocusIdx, setSearchFocusIdx,
    scrollToFileAndLine, setScrollToFileAndLine,
    wcNavigateTo, setWcNavigateTo,
    searchInputRef, searchDebounceRef,
    triggerSearch, handleSearchClose, handleScrollToFileLineHandled, handleWcNavigateHandled
  } = useSearchState(activeDir, activeTab)

  // CI search state (extracted hook)
  const {
    ciLogOpen, ciLogMatchInfo, ciLogSearchMode, ciSearchMode,
    ciSearchResults, setCiSearchResults, ciSearchProgress, setCiSearchProgress
  } = useCiSearchState(activeTab)

  useEffect(() => {
    loadSettings().then(() => {
      applyThemeToDocument(useSettingsStore.getState().settings)
    })
  }, [loadSettings])

  // Load plugin settings
  useEffect(() => {
    const api = getDockApi()
    api.plugins.getSetting(projectDir, 'git-manager', 'enableCiTab')
      .then((v) => setEnableCiTab(v === true))
      .catch(() => {})
    api.plugins.getSetting(projectDir, 'git-manager', 'enablePrTab')
      .then((v) => setEnablePrTab(v === true))
      .catch(() => {})
    api.plugins.getSetting(projectDir, 'git-manager', 'syntaxHighlighting')
      .then((v) => setSyntaxHL(typeof v === 'boolean' ? v : true))
      .catch(() => {})
    api.plugins.getSetting(projectDir, 'git-manager', 'escToHide')
      .then((v) => setEscToHide(typeof v === 'boolean' ? v : true))
      .catch(() => {})
  }, [projectDir])

  // React to setting changes from the settings dropdown
  useEffect(() => {
    const handler = (e: Event) => {
      const { key, value } = (e as CustomEvent).detail
      if (key === 'enableCiTab') {
        const enabled = !!value
        setEnableCiTab(enabled)
        if (!enabled) setActiveTab((t) => t === 'ci' ? 'history' : t)
      } else if (key === 'enablePrTab') {
        const enabled = !!value
        setEnablePrTab(enabled)
        if (!enabled) setActiveTab((t) => t === 'pr' ? 'log' : t)
      } else if (key === 'syntaxHighlighting') {
        setSyntaxHL(!!value)
      } else if (key === 'escToHide') {
        setEscToHide(!!value)
      }
    }
    window.addEventListener('gm-setting-changed', handler)
    return () => window.removeEventListener('gm-setting-changed', handler)
  }, [])

  // Esc to hide: close/hide the window when Escape is pressed and no modal is open
  const escToHideRef = useRef(escToHide)
  escToHideRef.current = escToHide
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !escToHideRef.current) return
      // Don't hide if a modal, search, or dropdown is consuming Escape
      if (document.querySelector('.modal-overlay, .gm-dropdown-backdrop, .gm-search-dropdown')) return
      getDockApi().win.close()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Listen for CI status changes from CiPanel
  useEffect(() => {
    const handler = (e: Event) => {
      setCiStatus((e as CustomEvent).detail)
    }
    window.addEventListener('ci-status-change', handler)
    return () => window.removeEventListener('ci-status-change', handler)
  }, [])

  // Pending CI run navigation — queued until CiPanel is fully loaded
  const [pendingCiRunId, setPendingCiRunId] = useState<number | null>(null)

  // Navigate to CI tab when a notification is clicked (DOM event from within this window)
  useEffect(() => {
    const handler = (e: Event) => {
      const runId = (e as CustomEvent).detail as number | undefined
      setActiveTab('ci')
      if (runId) setPendingCiRunId(runId)
    }
    window.addEventListener('ci-navigate-run', handler)
    return () => window.removeEventListener('ci-navigate-run', handler)
  }, [])

  // Navigate to CI tab via IPC from dock window
  useEffect(() => {
    const api = getDockApi()
    return api.ci.onNavigateToRun((runId) => {
      setActiveTab('ci')
      setPendingCiRunId(runId)
    })
  }, [])

  // Set window title based on active directory
  useEffect(() => {
    const name = activeDir.split(/[/\\]/).pop() || activeDir
    document.title = `${name} - Git`
  }, [activeDir])

  // F12 (DEV only): replay last notification from the panel or create a sample one
  useEffect(() => {
    if (typeof __DEV__ !== 'undefined' && !__DEV__) return
    const api = getDockApi()
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'F12') return
      e.preventDefault()
      // Try to get the last notification from the notification panel's localStorage
      let lastNotif: import('../../../../shared/ci-types').DockNotification | null = null
      try {
        const key = `gm-notifications:${projectDir.replace(/[\\/]/g, '/').toLowerCase()}`
        const stored = localStorage.getItem(key)
        if (stored) {
          const list = JSON.parse(stored)
          if (Array.isArray(list) && list.length > 0) lastNotif = list[0]
        }
      } catch { /* ignore */ }
      const replay = lastNotif
        ? { ...lastNotif, id: `replay-${Date.now()}`, projectDir: undefined }
        : {
            id: `debug-${Date.now()}`,
            title: 'Sample Notification',
            message: 'This is a test notification triggered by F12.',
            type: 'info' as const,
            source: 'git-manager'
          }
      api.notifications.emit(replay as import('../../../../shared/ci-types').DockNotification)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

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

  // Sidebar arrow key navigation
  const sidebarNavSelector = '.gm-sidebar-item, .gm-sidebar-header-toggle'
  const handleSidebarKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown' && e.key !== 'Enter' && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    const sidebar = sidebarRef.current
    if (!sidebar) return

    const items = sidebar.querySelectorAll<HTMLElement>(sidebarNavSelector)
    const count = items.length
    if (count === 0) return

    if (e.key === 'Enter') {
      e.preventDefault()
      if (sidebarFocusIdx >= 0 && sidebarFocusIdx < count) {
        items[sidebarFocusIdx].click()
      }
      return
    }

    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      if (sidebarFocusIdx < 0 || sidebarFocusIdx >= count) return
      const item = items[sidebarFocusIdx]
      const isCollapsible = item.hasAttribute('data-collapsible')

      if (e.key === 'ArrowRight') {
        if (isCollapsible && item.getAttribute('data-collapsed') === 'true') {
          // Expand collapsed section
          item.click()
        } else if (isCollapsible && item.getAttribute('data-collapsed') === 'false') {
          // Already expanded — move to first child
          const newIdx = Math.min(count - 1, sidebarFocusIdx + 1)
          setSidebarFocusIdx(newIdx)
        }
      } else {
        if (isCollapsible && item.getAttribute('data-collapsed') === 'false') {
          // Collapse expanded section
          item.click()
        } else {
          // Move to parent collapsible header
          for (let i = sidebarFocusIdx - 1; i >= 0; i--) {
            const candidate = items[i]
            if (candidate.hasAttribute('data-collapsible') && candidate.getAttribute('data-collapsed') === 'false') {
              setSidebarFocusIdx(i)
              break
            }
          }
        }
      }
      return
    }

    e.preventDefault()
    const newIdx = e.key === 'ArrowDown'
      ? Math.min(count - 1, sidebarFocusIdx + 1)
      : Math.max(0, sidebarFocusIdx - 1)

    setSidebarFocusIdx(newIdx)
  }, [sidebarFocusIdx])

  // Sync sidebar kb-focus class to DOM
  useEffect(() => {
    const sidebar = sidebarRef.current
    if (!sidebar) return
    sidebar.querySelectorAll('.gm-sidebar-item-kb-focus').forEach(el =>
      el.classList.remove('gm-sidebar-item-kb-focus')
    )
    if (sidebarFocusIdx >= 0) {
      const items = sidebar.querySelectorAll(sidebarNavSelector)
      const item = items[sidebarFocusIdx]
      if (item) {
        item.classList.add('gm-sidebar-item-kb-focus')
        item.scrollIntoView({ block: 'nearest' })
      }
    }
  }, [sidebarFocusIdx])

  const refreshGenRef = useRef(0)
  const initialLoadRef = useRef(true)
  const submoduleGenRef = useRef(0)
  const lastRefreshRef = useRef(0)
  const lastFetchRef = useRef(0)
  const refresh = useCallback(async () => {
    if (!activeDir) return
    // Skip refresh while commit/push is in progress to avoid unmounting WorkingChanges
    if (wcBusyRef.current) return
    const gen = ++refreshGenRef.current
    const api = getDockApi()
    setLoading(true)
    try {
      const isRepo = await api.gitManager.isRepo(activeDir)
      if (gen !== refreshGenRef.current) return // stale
      if (!isRepo) {
        setNotGitRepo(true)
        setLoading(false)
        return
      }
      setNotGitRepo(false)
      const [logData, branchData, statusData, stashData, mergeData, commitCount, tagData] = await Promise.all([
        api.gitManager.getLog(activeDir, { maxCount: 200 }),
        api.gitManager.getBranches(activeDir),
        api.gitManager.getStatus(activeDir),
        api.gitManager.stashList(activeDir),
        api.gitManager.getMergeState(activeDir),
        api.gitManager.getCommitCount(activeDir),
        api.gitManager.getTags(activeDir)
      ])
      if (gen !== refreshGenRef.current) return // stale
      setCommits(logData)
      setTotalCommitCount(commitCount)
      setBranches(branchData)
      setStatus(statusData)
      setStashes(stashData)
      setTags(tagData)
      setMergeState(mergeData)
      // Submodules are slow — load them without blocking the UI
      const subGen = ++submoduleGenRef.current
      setSubmodulesLoading(true)
      api.gitManager.getSubmodules(activeDir).then((data) => {
        if (subGen === submoduleGenRef.current) {
          setSubmodules(data)
          setSubmodulesLoading(false)
        }
      }).catch(() => {
        if (subGen === submoduleGenRef.current) setSubmodulesLoading(false)
      })
      // Auto-switch to conflicts tab if merge is in progress with conflicts
      if (mergeData.inProgress && mergeData.conflicts.length > 0) {
        setActiveTab((prev) => prev === 'conflicts' ? 'conflicts' : prev)
      }
      // On initial load, switch to changes tab if there are staged/unstaged changes
      if (initialLoadRef.current) {
        initialLoadRef.current = false
        if (statusData.staged.length + statusData.unstaged.length + statusData.untracked.length > 0) {
          setActiveTab('changes')
        }
      }
      lastRefreshRef.current = Date.now()
    } catch (err) {
      if (gen !== refreshGenRef.current) return // stale
      setError(err instanceof Error ? err.message : 'Failed to load git data')
    }
    setLoading(false)
  }, [activeDir])

  // Targeted refresh functions — only fetch data that could have changed
  const refreshAfterCommit = useCallback(async () => {
    if (!activeDir) return
    const gen = ++refreshGenRef.current
    const api = getDockApi()
    try {
      const [logData, statusData, commitCount] = await Promise.all([
        api.gitManager.getLog(activeDir, { maxCount: 200 }),
        api.gitManager.getStatus(activeDir),
        api.gitManager.getCommitCount(activeDir)
      ])
      if (gen !== refreshGenRef.current) return
      setCommits(logData)
      setStatus(statusData)
      setTotalCommitCount(commitCount)
      lastRefreshRef.current = Date.now()
    } catch { /* next full refresh will catch up */ }
  }, [activeDir])

  const refreshAfterCheckout = useCallback(async () => {
    if (!activeDir) return
    const gen = ++refreshGenRef.current
    const api = getDockApi()
    try {
      const [logData, branchData, statusData, mergeData, commitCount] = await Promise.all([
        api.gitManager.getLog(activeDir, { maxCount: 200 }),
        api.gitManager.getBranches(activeDir),
        api.gitManager.getStatus(activeDir),
        api.gitManager.getMergeState(activeDir),
        api.gitManager.getCommitCount(activeDir)
      ])
      if (gen !== refreshGenRef.current) return
      setCommits(logData)
      setBranches(branchData)
      setStatus(statusData)
      setMergeState(mergeData)
      setTotalCommitCount(commitCount)
      if (mergeData.inProgress && mergeData.conflicts.length > 0) {
        setActiveTab((prev) => prev === 'conflicts' ? 'conflicts' : prev)
      }
      lastRefreshRef.current = Date.now()
    } catch { /* next full refresh will catch up */ }
  }, [activeDir])

  const refreshAfterPush = useCallback(async () => {
    if (!activeDir) return
    const gen = ++refreshGenRef.current
    const api = getDockApi()
    try {
      const [branchData, statusData] = await Promise.all([
        api.gitManager.getBranches(activeDir),
        api.gitManager.getStatus(activeDir)
      ])
      if (gen !== refreshGenRef.current) return
      setBranches(branchData)
      setStatus(statusData)
      lastRefreshRef.current = Date.now()
    } catch { /* next full refresh will catch up */ }
  }, [activeDir])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Dismiss all context menus when titlebar is clicked (drag regions swallow mousedown)
  useEffect(() => {
    const handler = () => {
      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: -1, clientY: -1 }))
    }
    window.addEventListener('gm-dismiss-menus', handler)
    return () => window.removeEventListener('gm-dismiss-menus', handler)
  }, [])

  // Auto Fetch All: fetch on load + recurring timer based on plugin settings
  useEffect(() => {
    if (!activeDir) return
    const api = getDockApi()
    let timer: ReturnType<typeof setInterval> | null = null

    const doAutoFetch = async () => {
      try {
        // Skip auto-fetch when a resolution action is running to avoid index.lock races
        if (actionBusyRef.current) return
        const enabled = await api.gitManager.getSetting(activeDir, 'autoFetchAll')
        if (!enabled) return
        await api.gitManager.fetchAll(activeDir)
        refresh()
      } catch { /* ignore fetch errors silently */ }
    }

    const setupTimer = async () => {
      try {
        const enabled = await api.gitManager.getSetting(activeDir, 'autoFetchAll')
        if (!enabled) return
        // Fetch on load
        doAutoFetch()
        const minutes = (await api.gitManager.getSetting(activeDir, 'autoRecheckMinutes') as number) ?? 15
        if (minutes > 0) {
          timer = setInterval(doAutoFetch, minutes * 60 * 1000)
        }
      } catch { /* ignore */ }
    }

    setupTimer()
    return () => { if (timer) clearInterval(timer) }
  }, [activeDir, refresh])

  // Refresh when the toolbar button re-opens an already-open window
  // Also reset to the main repo if we were navigated into a submodule
  useEffect(() => {
    return getDockApi().gitManager.onReopen(() => {
      if (activeDir !== projectDir) {
        setActiveDir(projectDir)
        setNavStack([])
      }
      refresh()
    })
  }, [refresh, activeDir, projectDir])

  const selectCommitTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const selectCommitGen = useRef(0)

  const handleSelectCommit = useCallback((hash: string) => {
    // Debounce rapid selections (arrow keys) — only fetch the last one
    if (selectCommitTimer.current) clearTimeout(selectCommitTimer.current)
    const gen = ++selectCommitGen.current
    selectCommitTimer.current = setTimeout(async () => {
      const api = getDockApi()
      try {
        const detail = await api.gitManager.getCommitDetail(activeDir, hash)
        if (gen === selectCommitGen.current) setSelectedCommit(detail)
      } catch {
        if (gen === selectCommitGen.current) setSelectedCommit(null)
      }
    }, 50)
  }, [activeDir])

  const navigateToCommit = useCallback((hash: string) => {
    setActiveTab('log')
    handleSelectCommit(hash)
    setScrollToHash(hash)
  }, [handleSelectCommit])

  const navigateToBranch = useCallback(async (branchName: string) => {
    const api = getDockApi()
    try {
      const log = await api.gitManager.getLog(activeDir, { maxCount: 1, branch: branchName })
      if (log.length > 0) navigateToCommit(log[0].hash)
    } catch { /* ignore */ }
  }, [activeDir, navigateToCommit])

  const showActionError = useCallback((action: string, errorMsg: string, opts?: { branchName?: string; retry?: () => Promise<void> }) => {
    const parsed = parseGitError(action, errorMsg, {
      projectDir: activeDir,
      refresh: () => {},
      branchName: opts?.branchName,
      retry: opts?.retry
    })
    if (parsed.resolutions.length > 0) {
      setActionError(parsed)
    } else {
      setActionError({ title: `${action} failed`, message: errorMsg, resolutions: [] })
    }
  }, [activeDir])

  // Smart error handler for child components — parses git errors and offers resolutions
  const handleSmartError = useCallback((msg: string, retry?: () => Promise<void>) => {
    // Identity error — show setup dialog instead of generic error
    if (/author identity unknown|please tell me who you are|unable to auto-detect email/i.test(msg)) {
      setIdentitySetup({ retry })
      return
    }
    // Try to extract an action name from the error prefix
    const actionMatch = msg.match(/^([\w\s]+) failed[:\s]*/i)
    const action = actionMatch ? actionMatch[1].trim() : 'Git operation'
    const errorMsg = actionMatch ? msg.slice(actionMatch[0].length) || msg : msg
    showActionError(action, errorMsg, { retry })
  }, [showActionError])

  // Search result click handler (cross-cutting: needs navigateToCommit + setActiveTab)
  const handleSearchResult = useCallback((result: GitSearchResult) => {
    setSearchOpen(false)
    setSearchQuery('')
    setSearchResults([])
    if (result.source.type === 'commit') {
      navigateToCommit(result.source.hash)
      if (result.filePath) {
        setScrollToFileAndLine({ filePath: result.filePath, lineNumber: result.lineNumber })
      }
    } else {
      setActiveTab('changes')
      setWcNavigateTo({
        path: result.filePath,
        staged: result.source.section === 'staged',
        lineNumber: result.lineNumber
      })
    }
  }, [navigateToCommit])

  const handleCiSearchResult = useCallback((result: CiLogSearchMatch) => {
    window.dispatchEvent(new CustomEvent('ci-open-job-log', {
      detail: { runId: result.runId, jobId: result.jobId }
    }))
    setSearchOpen(false)
  }, [])

  const [pullDialogOpen, setPullDialogOpen] = useState(false)
  const [remotes, setRemotes] = useState<{ name: string; fetchUrl: string; pushUrl: string }[]>([])
  const repoProvider = useMemo<GitProvider>(() => {
    const origin = remotes.find((r) => r.name === 'origin') || remotes[0]
    return origin ? detectProvider(origin.fetchUrl) : 'generic'
  }, [remotes])
  const [pushing, setPushing] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  const handlePush = useCallback(async () => {
    if (pushing) return
    setPushing(true)
    try {
      const api = getDockApi()
      const result = await api.gitManager.push(activeDir)
      if (!result.success) {
        showActionError('Push', result.error || 'Push failed', {
          retry: async () => {
            const r2 = await api.gitManager.push(activeDir)
            if (!r2.success) throw new Error(r2.error || 'Push still failed')
            refresh()
          }
        })
        return
      }
      refresh()
    } finally {
      setPushing(false)
    }
  }, [activeDir, refresh, pushing, showActionError])

  const handleRefresh = useCallback(async () => {
    if (refreshing) return
    setRefreshing(true)
    try {
      await refresh()
    } finally {
      setRefreshing(false)
    }
  }, [refresh, refreshing])

  const doCheckout = useCallback(async (checkoutName: string) => {
    const api = getDockApi()
    setError(null)
    actionBusyRef.current = true
    try {
      const result = await api.gitManager.checkoutBranch(activeDir, checkoutName)
      if (result.success) { setError(null); refreshAfterCheckout(); return }

      const errMsg = result.error || 'Checkout failed'
      // Dirty working tree — auto-stash and retry inline
      if (/local changes|uncommitted|unstaged|please.*(stash|commit)|your local changes/i.test(errMsg)) {
        const sr = await api.gitManager.stashSave(activeDir, `Auto-stash before checkout ${checkoutName}`)
        if (!sr.success) {
          const sr2 = await api.gitManager.stashSave(activeDir, `Auto-stash before checkout ${checkoutName}`, '--include-untracked')
          if (!sr2.success) {
            setError('Stash failed: ' + (sr2.error || sr.error || 'Unknown error'))
            return
          }
        }
        const r2 = await api.gitManager.checkoutBranch(activeDir, checkoutName)
        if (!r2.success) {
          setError('Checkout failed after stash: ' + (r2.error || 'Unknown error'))
          return
        }
        setError(null)
        refreshAfterCheckout()
      } else {
        showActionError('Checkout branch', errMsg, {
          branchName: checkoutName,
          retry: async () => {
            const r = await api.gitManager.checkoutBranch(activeDir, checkoutName)
            if (!r.success) throw new Error(r.error || 'Checkout still failed')
          }
        })
      }
    } catch (e) {
      setError('Checkout error: ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      actionBusyRef.current = false
    }
  }, [activeDir, refreshAfterCheckout, showActionError])

  const handleCheckoutBranch = useCallback(async (name: string) => {
    const api = getDockApi()
    const isRemote = branches.some((b) => b.remote && b.name === name)
    const checkoutName = isRemote ? name.replace(/^[^/]+\//, '') : name

    // Check if any Claude terminals are actively working before switching branches
    try {
      const active = await api.gitManager.getActiveTerminals(activeDir)
      if (active.length > 0) {
        const termNames = active.map((t) => t.title || `Terminal ${t.id.slice(0, 6)}`).join(', ')
        setConfirmModal({
          title: 'Claude is working',
          message: (
            <>
              <p>{active.length === 1 ? 'A Claude terminal is' : `${active.length} Claude terminals are`} actively working in this project:</p>
              <p style={{ fontWeight: 600, margin: '8px 0' }}>{termNames}</p>
              <p>Switching branches now may disrupt ongoing work. Are you sure you want to checkout <strong>{checkoutName}</strong>?</p>
            </>
          ),
          confirmLabel: 'Switch anyway',
          danger: true,
          onConfirm: () => { setConfirmModal(null); doCheckout(checkoutName) }
        })
        return
      }
    } catch {
      // If the check fails, proceed without warning
    }

    doCheckout(checkoutName)
  }, [activeDir, branches, doCheckout])

  // Clear all repo-specific state so stale data from the previous repo is never shown
  const resetRepoState = useCallback(() => {
    setCommits([])
    setBranches([])
    setStatus(null)
    setSubmodules([])
    setSubmodulesLoading(false)
    setStashes([])
    setTags([])
    setSelectedCommit(null)
    setMergeState(null)
    setError(null)
    setActionError(null)
    setNotGitRepo(false)
    setSearchQuery('')
    setSearchResults([])
    setSearchOpen(false)
    setLoading(true)
    // Allow auto-switch to changes tab for the new repo
    initialLoadRef.current = true
  }, [])

  const navigateToSubmodule = useCallback((sub: GitSubmoduleInfo) => {
    // Uninitialized submodules have no .git reference, so git commands would
    // silently fall back to the parent repo — showing wrong commits/branches.
    if (sub.status === 'uninitialized') {
      const doInit = async (thenOpen: boolean) => {
        const api = getDockApi()

        // Check if the submodule URL is accessible before attempting anything
        const access = await api.gitManager.checkSubmoduleAccess(activeDir, sub.path)
        if (!access.accessible) {
          throw new Error(
            access.url
              ? `Cannot access submodule repository:\n${access.url}\n\n${access.error}\n\nEnsure the repository exists and the current user has access.`
              : access.error || 'Submodule URL not found in .gitmodules'
          )
        }

        // URL is accessible — proceed with init
        await api.gitManager.syncSubmodules(activeDir, [sub.path])
        const r = await api.gitManager.updateSubmodules(activeDir, [sub.path], true)
        if (!r.success) throw new Error(r.error || 'Submodule init failed')

        // Verify the submodule is actually its own git root (not just inside the parent repo).
        // isRepo() uses --is-inside-work-tree which returns true even for uninitialized submodule
        // dirs that are inside the parent repo. We need to check the submodules list instead.
        const subs = await api.gitManager.getSubmodules(activeDir)
        const updatedSub = subs.find((s) => s.path === sub.path)
        if (!updatedSub || updatedSub.status === 'uninitialized') {
          // Init ran but the submodule is still uninitialized.
          // Use __replaceDialog to swap the current dialog with the appropriate one.
          throw {
            __replaceDialog: true,
            replacement: {
              title: 'Submodule initialization failed',
              message: `"${sub.path}" could not be initialized.\n\n` +
                `git submodule update --init completed without errors but the submodule was not cloned. ` +
                `This usually means the submodule URL is incorrect, inaccessible, or requires authentication.\n\n` +
                `You can try force re-cloning (removes the directory if it exists and re-clones), ` +
                `or open a terminal to debug manually.`,
              resolutions: [{
                label: 'Force Re-clone',
                description: `Deinit, remove directory (if exists), and clone fresh`,
                danger: true,
                action: async () => {
                  const fr = await api.gitManager.forceReinitSubmodule(activeDir, sub.path)
                  if (!fr.success) throw new Error(fr.error || 'Force reinit failed')
                  await refresh()
                  if (thenOpen) {
                    setNavStack((prev) => [...prev, { dir: activeDir, label: activeDir.split(/[/\\]/).pop() || activeDir }])
                    wcBusyRef.current = false
                    resetRepoState()
                    setActiveDir(activeDir + '/' + sub.path)
                  }
                }
              }, {
                label: 'Open Git Bash',
                description: 'Debug manually in a terminal',
                keepOpen: true,
                action: async () => {
                  api.gitManager.openBash(activeDir)
                }
              }]
            }
          }
        }

        await refresh()

        if (thenOpen) {
          setNavStack((prev) => [...prev, { dir: activeDir, label: activeDir.split(/[/\\]/).pop() || activeDir }])
          wcBusyRef.current = false
          resetRepoState()
          setActiveDir(activeDir + '/' + sub.path)
        }
      }

      setActionError({
        title: 'Submodule not initialized',
        message: `Cannot open submodule "${sub.name}" — it is not initialized.`,
        resolutions: [{
          label: 'Initialize & Open',
          description: `Sync, init, and open the submodule`,
          action: () => doInit(true)
        }, {
          label: 'Initialize only',
          description: `Run git submodule sync + update --init without opening`,
          action: () => doInit(false)
        }]
      })
      return
    }
    setNavStack((prev) => [...prev, { dir: activeDir, label: activeDir.split(/[/\\]/).pop() || activeDir }])
    wcBusyRef.current = false
    resetRepoState()
    setActiveDir(activeDir + '/' + sub.path)
  }, [activeDir, resetRepoState])

  const navigateBack = useCallback(() => {
    setNavStack((prev) => {
      const next = [...prev]
      const entry = next.pop()
      if (entry) {
        resetRepoState()
        setActiveDir(entry.dir)
      }
      return next
    })
  }, [resetRepoState])

  // Stable callback refs for memoized child components
  const handleScrollToHashHandled = useCallback(() => setScrollToHash(null), [])
  const handleCommitted = useCallback((hash: string) => {
    wcBusyRef.current = false
    setWcBusy(false)
    refreshAfterCommit().then(() => navigateToCommit(hash))
  }, [refreshAfterCommit, navigateToCommit])
  const handleBusyChange = useCallback((busy: boolean) => { wcBusyRef.current = busy; setWcBusy(busy) }, [])
  const handleCloseDetail = useCallback(() => setSelectedCommit(null), [])
  const handleOpenPullDialog = useCallback(() => {
    getDockApi().gitManager.getRemotes(activeDir).then(setRemotes)
    setPullDialogOpen(true)
  }, [activeDir])
  const mergeConflictState = useMemo(() => {
    if (mergeState?.inProgress) return mergeState
    return { inProgress: false as const, type: 'none' as const, conflicts: status?.conflicts ?? [] }
  }, [mergeState, status])

  const api = getDockApi()
  const currentBranch = branches.find((b) => b.current)
  const localBranches = branches.filter((b) => !b.remote)
  const remoteBranches = branches.filter((b) => b.remote)

  return (
    <div className="gm-app">
      {/* Titlebar */}
      <div className="gm-titlebar" onMouseDown={() => window.dispatchEvent(new CustomEvent('gm-dismiss-menus'))} onPointerDown={() => window.dispatchEvent(new CustomEvent('gm-dismiss-menus'))}>
        <div className="gm-titlebar-left">
          <GitIcon />
          {navStack.length > 0 && (
            <button className="gm-back-btn" onClick={navigateBack} title="Back to parent repo">
              <BackIcon />
            </button>
          )}
          {navStack.length > 0 ? (
            <span className="gm-titlebar-breadcrumb">
              <button className="gm-breadcrumb-root" onClick={() => { resetRepoState(); setActiveDir(projectDir); setNavStack([]) }}>
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
          <button className="gm-toolbar-btn" onClick={handleRefresh} title="Refresh" disabled={refreshing}>
            {refreshing ? <span className="gm-toolbar-spinner" /> : <RefreshIcon />}
          </button>
          <PullSplitButton
            activeDir={activeDir}
            behindCount={currentBranch?.behind ?? 0}
            onError={handleSmartError}
            onRefresh={refresh}
            onOpenDialog={handleOpenPullDialog}
          />
          {currentBranch && (currentBranch.ahead || currentBranch.behind || (!currentBranch.remote && !currentBranch.tracking)) ? (
            <button className="gm-toolbar-btn" onClick={handlePush} title={!currentBranch.tracking ? 'Publish branch to origin' : `Push${currentBranch.ahead ? ` (${currentBranch.ahead} ahead)` : ''}${currentBranch.behind ? ` (${currentBranch.behind} behind)` : ''}`} disabled={pushing}>
              {pushing ? <span className="gm-toolbar-spinner" /> : <PushIcon />} {!currentBranch.tracking ? 'Publish' : 'Push'}{currentBranch.ahead ? <span className="gm-toolbar-count gm-toolbar-count-ahead">{currentBranch.ahead}</span> : null}{currentBranch.behind ? <span className="gm-toolbar-count gm-toolbar-count-behind">{currentBranch.behind}</span> : null}
            </button>
          ) : (
            <button className="gm-toolbar-btn" onClick={() => { setActiveTab('changes'); if (Date.now() - lastRefreshRef.current > 2000) refresh() }} title="Working Changes">
              <ChangesIcon /> Changes{status && (status.staged.length + status.unstaged.length + status.untracked.length) > 0 ? <span className="gm-toolbar-count gm-toolbar-count-changes">{status.staged.length + status.unstaged.length + status.untracked.length}</span> : null}
            </button>
          )}
          <button className="gm-toolbar-btn" onClick={() => api.gitManager.openBash(activeDir)} title="Open Git Bash">
            <BashIcon />
          </button>
          <button className="gm-toolbar-btn" onClick={() => api.app.openInExplorer(activeDir)} title="Open in Explorer">
            <OpenFolderIcon />
          </button>
          <SettingsDropdown projectDir={activeDir} />
          <NotificationPanel projectDir={activeDir} provider={repoProvider} />
          <div className="toolbar-separator" />
          <div className="gm-win-controls">
            <button className="win-btn win-minimize" onClick={() => api.win.minimize()}>&#x2015;</button>
            <button className="win-btn win-maximize" onClick={() => api.win.maximize()}>&#9744;</button>
            <button className="win-btn win-close" onClick={() => api.win.close()}>&#10005;</button>
          </div>
        </div>
        {pushing && <div className="gm-push-progress"><div className="gm-push-progress-bar" /></div>}
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

      {!mergeState?.inProgress && status && status.conflicts.length > 0 && (
        <div className="gm-merge-bar">
          <div className="gm-merge-bar-left">
            <WarningIcon />
            <span>
              {status.conflicts.length} unresolved conflict{status.conflicts.length > 1 ? 's' : ''}
            </span>
          </div>
          <button className="gm-merge-bar-btn" onClick={() => setActiveTab('conflicts')}>
            Resolve...
          </button>
        </div>
      )}

      <div className="gm-body">
        {/* Branch sidebar */}
        <div className="gm-sidebar" ref={sidebarRef} tabIndex={0} onKeyDown={handleSidebarKeyDown} onMouseDown={() => setSidebarFocusIdx(-1)}>
          <CollapsibleSection title="Branches" count={localBranches.length}>
            <LocalBranchTree
              branches={localBranches}
              onCheckout={handleCheckoutBranch}
              onNavigate={navigateToBranch}
              onBranchContextMenu={(e, branch) => {
                const zoom = parseFloat(document.documentElement.style.zoom) || 1
                setSidebarBranchCtx({ x: e.clientX / zoom, y: e.clientY / zoom, branchName: branch.name, isRemote: false })
              }}
            />
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
          <CollapsibleSection title="Submodules" count={submodules.length} loading={submodulesLoading} onAdd={() => { setAddSubmoduleBasePath(''); setSidebarModal('addSubmodule') }} addTitle="Add submodule">
            <SubmoduleTree
              submodules={submodules}
              selectedPath={selectedSubmodule}
              projectDir={activeDir}
              onSelect={setSelectedSubmodule}
              onNavigate={navigateToSubmodule}
              onAddInFolder={(basePath) => { setAddSubmoduleBasePath(basePath); setSidebarModal('addSubmodulePath') }}
              onSwitchBranch={(subPath) => setSwitchBranchSubPath(subPath)}
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
              onRefresh={refresh}
            />
          </CollapsibleSection>
          <CollapsibleSection title="Tags" count={tags.length} defaultCollapsed>
            <VirtualSidebarList itemCount={tags.length}>
              {(startIdx, endIdx) => tags.slice(startIdx, endIdx).map((t) => (
                <div
                  key={t.name}
                  className="gm-sidebar-item gm-sidebar-item-tag"
                  onClick={() => navigateToCommit(t.hash)}
                  onDoubleClick={() => {
                    setActiveTab('log')
                    handleSelectCommit(t.hash)
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    const zoom = parseFloat(document.documentElement.style.zoom) || 1
                    setTagSidebarCtx({ x: e.clientX / zoom, y: e.clientY / zoom, tag: t })
                  }}
                  title={`${t.name} — ${t.hash}`}
                >
                  <TagSidebarIcon />
                  <span className="gm-sidebar-item-label">{t.name}</span>
                </div>
              ))}
            </VirtualSidebarList>
            {tags.length === 0 && (
              <div className="gm-sidebar-empty">No tags</div>
            )}
          </CollapsibleSection>
          <CollapsibleSection title="Stashes" count={stashes.length} defaultCollapsed>
            <VirtualSidebarList itemCount={stashes.length}>
              {(startIdx, endIdx) => stashes.slice(startIdx, endIdx).map((s) => (
                <StashSidebarEntry
                  key={s.index}
                  stash={s}
                  projectDir={activeDir}
                  onError={handleSmartError}
                  onRefresh={refresh}
                  onConfirm={setConfirmModal}
                />
              ))}
            </VirtualSidebarList>
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
              onClick={() => {
                setActiveTab('log')
                if (activeDir && Date.now() - lastFetchRef.current > 30000) {
                  lastFetchRef.current = Date.now()
                  const api = getDockApi()
                  api.gitManager.fetchAll(activeDir).then(() => refresh()).catch(() => {})
                }
              }}
            >
              Commit Log
            </button>
            <button
              className={`gm-tab${activeTab === 'changes' ? ' gm-tab-active' : ''}`}
              onClick={() => {
                setActiveTab('changes')
                if (Date.now() - lastRefreshRef.current > 2000) refresh()
              }}
            >
              Working Changes
              {wcBusy && activeTab !== 'changes' && <span className="gm-tab-spinner" />}
              {status && (status.staged.length + status.unstaged.length + status.untracked.length) > 0 && (
                <span className="gm-tab-badge">
                  {status.staged.length + status.unstaged.length + status.untracked.length}
                </span>
              )}
            </button>
            {(mergeState?.inProgress || (status && status.conflicts.length > 0)) && (
              <button
                className={`gm-tab${activeTab === 'conflicts' ? ' gm-tab-active' : ''}`}
                onClick={() => setActiveTab('conflicts')}
              >
                <WarningIcon />
                {mergeState?.inProgress ? 'Merge Conflicts' : 'Conflicts'}
                {((mergeState?.inProgress ? mergeState.conflicts.length : status?.conflicts.length) ?? 0) > 0 && (
                  <span className="gm-tab-badge gm-tab-badge-warn">{mergeState?.inProgress ? mergeState.conflicts.length : status!.conflicts.length}</span>
                )}
              </button>
            )}
            {enableCiTab && (
              <button
                className={`gm-tab${activeTab === 'ci' ? ' gm-tab-active' : ''}`}
                onClick={() => setActiveTab('ci')}
              >
                CI
                {ciStatus !== 'none' && (
                  <span className={`gm-ci-tab-dot gm-ci-tab-dot-${ciStatus}`} />
                )}
              </button>
            )}
            {enablePrTab && (
              <button
                className={`gm-tab${activeTab === 'pr' ? ' gm-tab-active' : ''}`}
                onClick={() => setActiveTab('pr')}
              >
                {repoProvider === 'gitlab' ? 'Merge Requests' : 'Pull Requests'}
              </button>
            )}
            <span className="gm-tabs-spacer" />
            <div className="gm-search-bar">
              <SearchIcon />
              <input
                ref={searchInputRef}
                className="gm-search-input"
                placeholder={ciLogSearchMode ? 'Find in log...' : ciSearchMode ? (ciSearchProgress?.scope === 'run' ? 'Search run job logs...' : 'Search all job logs...') : activeTab === 'changes' ? 'Search working changes...' : 'Search commit history...'}
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value)
                  if (ciSearchMode) {
                    setSearchOpen(true)
                    setSearchFocusIdx(-1)
                  } else if (!ciLogSearchMode) {
                    setSearchOpen(true)
                    triggerSearch(e.target.value)
                  }
                }}
                onFocus={() => {
                  if (searchQuery && ciSearchMode) setSearchOpen(true)
                  else if (searchQuery && !ciLogSearchMode) setSearchOpen(true)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setSearchOpen(false)
                    setSearchFocusIdx(-1)
                    searchInputRef.current?.blur()
                  } else if (ciLogSearchMode) {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      window.dispatchEvent(new CustomEvent('ci-log-search-nav', { detail: e.shiftKey ? 'prev' : 'next' }))
                    }
                  } else if (ciSearchMode) {
                    if (e.key === 'ArrowDown') {
                      e.preventDefault()
                      if (ciSearchResults.length > 0) {
                        setSearchOpen(true)
                        setSearchFocusIdx((i) => i < ciSearchResults.length - 1 ? i + 1 : 0)
                      }
                    } else if (e.key === 'ArrowUp') {
                      e.preventDefault()
                      if (ciSearchResults.length > 0) {
                        setSearchOpen(true)
                        setSearchFocusIdx((i) => i > 0 ? i - 1 : ciSearchResults.length - 1)
                      }
                    } else if (e.key === 'Enter') {
                      e.preventDefault()
                      if (searchFocusIdx >= 0 && ciSearchResults[searchFocusIdx]) {
                        handleCiSearchResult(ciSearchResults[searchFocusIdx])
                      } else if (ciSearchResults.length > 0) {
                        handleCiSearchResult(ciSearchResults[0])
                      }
                    }
                  } else if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    if (searchResults.length > 0) {
                      setSearchOpen(true)
                      setSearchFocusIdx((i) => i < searchResults.length - 1 ? i + 1 : 0)
                    }
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault()
                    if (searchResults.length > 0) {
                      setSearchOpen(true)
                      setSearchFocusIdx((i) => i > 0 ? i - 1 : searchResults.length - 1)
                    }
                  } else if (e.key === 'Enter') {
                    e.preventDefault()
                    if (searchFocusIdx >= 0 && searchResults[searchFocusIdx]) {
                      handleSearchResult(searchResults[searchFocusIdx])
                    } else if (searchResults.length > 0) {
                      handleSearchResult(searchResults[0])
                    }
                  }
                }}
              />
              {ciLogSearchMode && searchQuery && ciLogMatchInfo.count > 0 && (
                <span className="gm-search-match-info">
                  {ciLogMatchInfo.current + 1}/{ciLogMatchInfo.count}
                </span>
              )}
              {ciLogSearchMode && searchQuery && (
                <>
                  <button className="gm-search-nav-btn" onClick={() => window.dispatchEvent(new CustomEvent('ci-log-search-nav', { detail: 'prev' }))} title="Previous match (Shift+Enter)">{'\u25B2'}</button>
                  <button className="gm-search-nav-btn" onClick={() => window.dispatchEvent(new CustomEvent('ci-log-search-nav', { detail: 'next' }))} title="Next match (Enter)">{'\u25BC'}</button>
                </>
              )}
              {searchQuery && (
                <button
                  className="gm-search-clear"
                  onClick={() => { setSearchQuery(''); setSearchResults([]); setSearchOpen(false); setSearchTruncated(false); setCiSearchResults([]); setCiSearchProgress(null) }}
                >
                  &times;
                </button>
              )}
              {searchOpen && searchQuery.trim() && ciSearchMode && (
                <CiSearchDropdown
                  results={ciSearchResults}
                  progress={ciSearchProgress}
                  query={searchQuery}
                  focusIdx={searchFocusIdx}
                  onSelect={handleCiSearchResult}
                  onClose={handleSearchClose}
                />
              )}
              {searchOpen && searchQuery.trim() && !ciLogSearchMode && !ciSearchMode && (
                <SearchDropdown
                  results={searchResults}
                  loading={searchLoading}
                  truncated={searchTruncated}
                  focusIdx={searchFocusIdx}
                  onSelect={handleSearchResult}
                  onClose={handleSearchClose}
                />
              )}
            </div>
          </div>

          {notGitRepo ? (
            <div className="gm-not-repo">
              <div className="gm-not-repo-icon"><GitIcon /></div>
              <div className="gm-not-repo-title">Not a Git Repository</div>
              <div className="gm-not-repo-desc">The directory <strong>{activeDir.split(/[/\\]/).pop()}</strong> is not a git repository.</div>
              <div className="gm-not-repo-hint">Run <code>git init</code> to initialize a repository here.</div>
            </div>
          ) : loading ? (
            <div className="gm-loading">Loading...</div>
          ) : activeTab === 'log' ? (
            <CommitLog
              commits={commits}
              branches={branches}
              stashes={stashes}
              selectedHash={selectedCommit?.hash}
              currentBranch={currentBranch?.name}
              projectDir={activeDir}
              totalCommitCount={totalCommitCount}
              scrollToHash={scrollToHash}
              onScrollToHandled={handleScrollToHashHandled}
              onSelect={handleSelectCommit}
              onAction={refresh}
              onError={handleSmartError}
              onCheckout={handleCheckoutBranch}
            />
          ) : activeTab === 'conflicts' && (mergeState?.inProgress || (status && status.conflicts.length > 0)) ? (
            <MergeConflictsPanel
              mergeState={mergeConflictState}
              projectDir={activeDir}
              onRefresh={refresh}
              onError={handleSmartError}
            />
          ) : activeTab === 'ci' ? null : activeTab === 'changes' ? null : null}
          {/* Working changes stays mounted so commit/push/generation survives tab switches */}
          {!notGitRepo && !loading && status && (
            <div style={{ display: activeTab === 'changes' ? 'contents' : 'none' }}>
              <WorkingChanges
                status={status}
                stashes={stashes}
                projectDir={activeDir}
                syntaxHL={syntaxHL}
                active={activeTab === 'changes'}
                navigateTo={wcNavigateTo}
                onNavigateHandled={handleWcNavigateHandled}
                onRefresh={refresh}
                onError={handleSmartError}
                onConfirm={setConfirmModal}
                onCommitted={handleCommitted}
                onStatusRefreshed={setStatus}
                onBusyChange={handleBusyChange}
              />
            </div>
          )}
          {/* CI panel stays mounted to preserve state across tab switches */}
          {enableCiTab && (
            <div style={{ display: activeTab === 'ci' ? 'contents' : 'none' }}>
              <CiPanel key={activeDir} projectDir={activeDir} provider={repoProvider} searchQuery={activeTab === 'ci' ? searchQuery : undefined} currentBranch={currentBranch?.name} active={activeTab === 'ci'} pendingRunId={pendingCiRunId} onNavigated={() => setPendingCiRunId(null)} />
            </div>
          )}
          {enablePrTab && (
            <div style={{ display: activeTab === 'pr' ? 'contents' : 'none' }}>
              <React.Suspense fallback={<div className="gm-loading">Loading...</div>}>
                <PrPanel key={activeDir} projectDir={activeDir} provider={repoProvider} currentBranch={currentBranch?.name} active={activeTab === 'pr'} />
              </React.Suspense>
            </div>
          )}
        </div>

        {/* Detail panel */}
        {selectedCommit && activeTab === 'log' && (
          <>
            <ResizeHandle side="right" targetRef={detailRef} min={250} max={1400} storageKey="gm-detail-width" />
            <div className="gm-detail" ref={detailRef}>
              <CommitDetailPanel
                detail={selectedCommit}
                projectDir={activeDir}
                syntaxHL={syntaxHL}
                scrollToFileAndLine={scrollToFileAndLine}
                onScrollToHandled={handleScrollToFileLineHandled}
                onClose={handleCloseDetail}
                onError={handleSmartError}
                onRefresh={refresh}
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
          onError={handleSmartError}
        />
      )}
      {sidebarModal === 'addRemote' && (
        <AddRemoteModal
          projectDir={activeDir}
          onClose={() => setSidebarModal(null)}
          onDone={refresh}
          onError={handleSmartError}
        />
      )}
      {switchBranchSubPath && (
        <SwitchSubmoduleBranchModal
          subPath={switchBranchSubPath}
          projectDir={activeDir}
          onClose={() => setSwitchBranchSubPath(null)}
          onDone={refresh}
          onError={handleSmartError}
        />
      )}
      {sidebarBranchCtx && (
        <BranchRefContextMenu
          x={sidebarBranchCtx.x}
          y={sidebarBranchCtx.y}
          branchName={sidebarBranchCtx.branchName}
          isRemote={sidebarBranchCtx.isRemote}
          projectDir={activeDir}
          onClose={() => setSidebarBranchCtx(null)}
          onAction={refresh}
          onError={(msg) => setError(msg)}
          onCheckout={handleCheckoutBranch}
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
      {actionError && (
        <ErrorDialog
          error={actionError}
          busyRef={actionBusyRef}
          onClose={() => setActionError(null)}
          onResolved={() => { setActionError(null); refresh() }}
          onError={(msg) => { setActionError(null); handleSmartError(msg) }}
          onReplaceError={(newError) => setActionError(newError)}
        />
      )}
      {identitySetup && (
        <IdentitySetupModal
          projectDir={activeDir}
          onClose={() => setIdentitySetup(null)}
          onSaved={async () => {
            setIdentitySetup(null)
            if (identitySetup.retry) {
              try { await identitySetup.retry() } catch (err) {
                handleSmartError(err instanceof Error ? err.message : 'Retry failed')
              }
            }
            refresh()
          }}
        />
      )}
      {tagSidebarCtx && (
        <TagContextMenu
          x={tagSidebarCtx.x}
          y={tagSidebarCtx.y}
          tagName={tagSidebarCtx.tag.name}
          commitHash={tagSidebarCtx.tag.hash}
          projectDir={activeDir}
          onClose={() => setTagSidebarCtx(null)}
          onAction={refresh}
          onError={handleSmartError}
          onCheckout={handleCheckoutBranch}
        />
      )}
      {pullDialogOpen && (
        <PullDialog
          projectDir={activeDir}
          remotes={remotes}
          remoteBranches={remoteBranches}
          onClose={() => setPullDialogOpen(false)}
          onError={handleSmartError}
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
const LANE_W = 14
const DOT_R = 4

const GRAPH_GREY = '#3b4261'

interface GraphRowData {
  col: number
  color: string
  onCurrentBranch: boolean
  segments: { fromCol: number; toCol: number; color: string; half: 'full' | 'top' | 'bottom'; onCurrentBranch: boolean }[]
}

function computeGraph(commits: GitCommitInfo[]): { rows: GraphRowData[]; maxCols: number; currentBranchHashes: Set<string> } {
  // Build two sets:
  // 1. firstParentSet: first-parent chain from HEAD (for line/pass-through coloring)
  // 2. currentSet: all commits reachable from HEAD via any parent (for dot/text coloring)
  const firstParentSet = new Set<string>()
  const currentSet = new Set<string>()
  const hashMap = new Map<string, GitCommitInfo>()
  for (const c of commits) hashMap.set(c.hash, c)
  // Find HEAD: first commit with a "HEAD" ref, or fall back to the very first commit in the log
  let headCommit = commits.find((c) => c.refs.some((r) => r === 'HEAD' || r.startsWith('HEAD -> ')))
  if (!headCommit && commits.length > 0) headCommit = commits[0]
  if (headCommit) {
    // First-parent chain (for continuous line coloring)
    let cur: GitCommitInfo | undefined = headCommit
    while (cur) {
      firstParentSet.add(cur.hash)
      cur = cur.parents[0] ? hashMap.get(cur.parents[0]) : undefined
    }
    // All-parent BFS (for dot/text coloring)
    const queue: string[] = [headCommit.hash]
    while (queue.length > 0) {
      const h = queue.shift()!
      if (currentSet.has(h)) continue
      currentSet.add(h)
      const c = hashMap.get(h)
      if (c) {
        for (const p of c.parents) {
          if (hashMap.has(p) && !currentSet.has(p)) queue.push(p)
        }
      }
    }
  }

  const lanes: (string | null)[] = []
  const laneOwned: boolean[] = [] // tracks if lane was last assigned by a reachable commit
  const colorOf = new Map<string, string>()
  let ci = 0
  const getColor = (h: string) => {
    if (!colorOf.has(h)) {
      colorOf.set(h, GRAPH_COLORS[ci++ % GRAPH_COLORS.length])
    }
    return colorOf.get(h)!
  }
  const hashSet = new Set(commits.map((c) => c.hash))
  const rows: GraphRowData[] = []
  let maxCols = 0

  for (const commit of commits) {
    const commitReachable = currentSet.has(commit.hash)

    // Find lane for this commit
    let col = lanes.indexOf(commit.hash)
    const wasExpected = col !== -1
    if (col === -1) {
      col = lanes.indexOf(null)
      if (col === -1) { col = lanes.length; lanes.push(null); laneOwned.push(false) }
    }
    while (lanes.length <= col) { lanes.push(null); laneOwned.push(false) }
    const color = getColor(commit.hash)

    // Snapshot top edge (lanes + ownership)
    const top = [...lanes]
    const topOwned = [...laneOwned]

    // Clear this commit's slot
    lanes[col] = null
    laneOwned[col] = false

    // Assign parents
    const parents = commit.parents.filter((p) => hashSet.has(p))
    if (parents.length >= 1) {
      const p0Idx = lanes.indexOf(parents[0])
      if (p0Idx === -1) {
        lanes[col] = parents[0]
        laneOwned[col] = commitReachable
        colorOf.set(parents[0], color) // first parent inherits color
      }
    }
    for (let i = 1; i < parents.length; i++) {
      if (lanes.indexOf(parents[i]) === -1) {
        const slot = lanes.indexOf(null)
        if (slot !== -1) { lanes[slot] = parents[i]; laneOwned[slot] = commitReachable }
        else { lanes.push(parents[i]); laneOwned.push(commitReachable) }
        getColor(parents[i])
      }
    }

    // Snapshot bottom edge
    const bot = [...lanes]

    // Compute segments: pass-through lanes + commit connections
    const segments: GraphRowData['segments'] = []

    // Pass-through: colored only if the lane was set up by a reachable commit
    for (let i = 0; i < top.length; i++) {
      const h = top[i]
      if (!h || h === commit.hash) continue
      const j = bot.indexOf(h)
      if (j !== -1) segments.push({ fromCol: i, toCol: j, color: getColor(h), half: 'full', onCurrentBranch: topOwned[i] && currentSet.has(h) })
    }

    // Incoming to commit (top half): colored if commit is reachable from HEAD
    if (wasExpected) {
      segments.push({ fromCol: col, toCol: col, color, half: 'top', onCurrentBranch: currentSet.has(commit.hash) })
    }

    // Outgoing from commit to parents (bottom half): colored if both commit and parent are reachable
    for (const p of parents) {
      const j = bot.indexOf(p)
      if (j !== -1) {
        segments.push({ fromCol: col, toCol: j, color: j === col ? color : getColor(p), half: 'bottom', onCurrentBranch: currentSet.has(commit.hash) && currentSet.has(p) })
      }
    }

    // Trim trailing nulls
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) { lanes.pop(); laneOwned.pop() }
    maxCols = Math.max(maxCols, top.filter(Boolean).length, lanes.length, col + 1)

    rows.push({ col, color, onCurrentBranch: currentSet.has(commit.hash), segments })
  }

  return { rows, maxCols, currentBranchHashes: currentSet }
}

// --- Commit log with virtual scroll ---

const COMMIT_ROW_HEIGHT = 28
const COMMIT_PAGE_SIZE = 200

const CommitLog: React.FC<{
  commits: GitCommitInfo[]
  branches: GitBranchInfo[]
  stashes: GitStashEntry[]
  selectedHash?: string
  currentBranch?: string
  projectDir: string
  totalCommitCount: number
  scrollToHash?: string | null
  onScrollToHandled?: () => void
  onSelect: (hash: string) => void
  onAction: () => void
  onError: (msg: string, retry?: () => Promise<void>) => void
  onCheckout: (name: string) => void
}> = React.memo(({ commits, branches, stashes, selectedHash, currentBranch, projectDir, totalCommitCount, scrollToHash, onScrollToHandled, onSelect, onAction, onError, onCheckout }) => {
  const [showGraph, setShowGraph] = useState(() => localStorage.getItem('gm-show-graph') !== 'false')
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; commit: GitCommitInfo } | null>(null)
  const [stashCtxMenu, setStashCtxMenu] = useState<{ x: number; y: number; stash: GitStashEntry } | null>(null)
  const [tagCtxMenu, setTagCtxMenu] = useState<{ x: number; y: number; tagName: string; commitHash: string } | null>(null)
  const [branchCtxMenu, setBranchCtxMenu] = useState<{ x: number; y: number; branchName: string; isRemote: boolean; commitHash: string } | null>(null)
  const [modal, setModal] = useState<{ type: 'reset' | 'createBranch' | 'createTag'; commit: GitCommitInfo } | null>(null)

  // Virtual scroll state
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)
  const pageCacheRef = useRef(new Map<number, GitCommitInfo[]>())
  const loadingPagesRef = useRef(new Set<number>())
  const [cacheVersion, setCacheVersion] = useState(0)
  const prevProjectDirRef = useRef(projectDir)

  // Seed page cache with initial commits (page 0) from parent
  useEffect(() => {
    // On projectDir change, clear cache
    if (prevProjectDirRef.current !== projectDir) {
      pageCacheRef.current.clear()
      loadingPagesRef.current.clear()
      prevProjectDirRef.current = projectDir
    }
    if (commits.length > 0) {
      pageCacheRef.current.set(0, commits)
      setCacheVersion((v) => v + 1)
    }
  }, [commits, projectDir])

  const toggleGraph = useCallback(() => {
    setShowGraph((prev) => {
      const next = !prev
      localStorage.setItem('gm-show-graph', String(next))
      return next
    })
  }, [])

  // Collect all loaded commits in order for graph computation
  const allLoadedCommits = useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _v = cacheVersion // depend on cache version
    const result: GitCommitInfo[] = []
    const pageKeys = [...pageCacheRef.current.keys()].sort((a, b) => a - b)
    for (const pk of pageKeys) {
      const page = pageCacheRef.current.get(pk)
      if (page) result.push(...page)
    }
    return result
  }, [cacheVersion])

  // Global index map: commitHash → global index across all loaded pages
  const globalIndexMap = useMemo(() => {
    const m = new Map<string, number>()
    const pageKeys = [...pageCacheRef.current.keys()].sort((a, b) => a - b)
    for (const pk of pageKeys) {
      const page = pageCacheRef.current.get(pk)
      if (page) {
        const baseIdx = pk * COMMIT_PAGE_SIZE
        page.forEach((c, i) => m.set(c.hash, baseIdx + i))
      }
    }
    return m
  }, [allLoadedCommits])

  const { rows: graphRows, maxCols, currentBranchHashes } = useMemo(() =>
    showGraph ? computeGraph(allLoadedCommits) : { rows: [], maxCols: 0, currentBranchHashes: new Set<string>() }
  , [allLoadedCommits, showGraph])

  // Map global commit index → graph row index
  const graphRowMap = useMemo(() => {
    const m = new Map<number, number>()
    const pageKeys = [...pageCacheRef.current.keys()].sort((a, b) => a - b)
    let graphIdx = 0
    for (const pk of pageKeys) {
      const page = pageCacheRef.current.get(pk)
      if (page) {
        for (let i = 0; i < page.length; i++) {
          m.set(pk * COMMIT_PAGE_SIZE + i, graphIdx++)
        }
      }
    }
    return m
  }, [allLoadedCommits])

  const branchHashes = useMemo(() => {
    if (showGraph) return currentBranchHashes
    const hashMap = new Map<string, GitCommitInfo>()
    for (const c of allLoadedCommits) hashMap.set(c.hash, c)
    const set = new Set<string>()
    let head = allLoadedCommits.find((c) => c.refs.some((r) => r === 'HEAD' || r.startsWith('HEAD -> ')))
    if (!head && allLoadedCommits.length > 0) head = allLoadedCommits[0]
    if (head) {
      const queue: string[] = [head.hash]
      while (queue.length > 0) {
        const h = queue.shift()!
        if (set.has(h)) continue
        set.add(h)
        const c = hashMap.get(h)
        if (c) {
          for (const p of c.parents) {
            if (hashMap.has(p) && !set.has(p)) queue.push(p)
          }
        }
      }
    }
    return set
  }, [allLoadedCommits, showGraph, currentBranchHashes])

  const graphW = Math.max(24, maxCols * LANE_W + 8)

  // Build stash-to-parent map for interleaving
  const stashByParent = useMemo(() => {
    const m = new Map<string, GitStashEntry[]>()
    for (const s of stashes) {
      if (s.parentHash) {
        const arr = m.get(s.parentHash) || []
        arr.push(s)
        m.set(s.parentHash, arr)
      }
    }
    return m
  }, [stashes])

  // Orphan stashes (no parent in visible commits)
  const orphanStashes = useMemo(() => {
    return stashes.filter((s) => !s.parentHash)
  }, [stashes])

  // Compute effective total: if a page returned fewer than COMMIT_PAGE_SIZE, we know the real end
  const effectiveTotal = useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _v = cacheVersion
    const pageKeys = [...pageCacheRef.current.keys()].sort((a, b) => a - b)
    for (const pk of pageKeys) {
      const page = pageCacheRef.current.get(pk)
      if (page && page.length < COMMIT_PAGE_SIZE) {
        return pk * COMMIT_PAGE_SIZE + page.length
      }
    }
    return totalCommitCount
  }, [cacheVersion, totalCommitCount])

  // Virtual scroll calculations
  const totalHeight = effectiveTotal * COMMIT_ROW_HEIGHT
  const OVERSCAN = 10
  const firstVisible = Math.floor(scrollTop / COMMIT_ROW_HEIGHT)
  const visibleCount = Math.ceil(viewportHeight / COMMIT_ROW_HEIGHT)
  const startIdx = Math.max(0, firstVisible - OVERSCAN)
  const endIdx = Math.min(effectiveTotal - 1, firstVisible + visibleCount + OVERSCAN)

  // Determine which pages are needed
  const startPage = Math.floor(startIdx / COMMIT_PAGE_SIZE)
  const endPage = Math.floor(endIdx / COMMIT_PAGE_SIZE)

  // Load missing pages on demand
  useEffect(() => {
    const api = getDockApi()
    for (let p = startPage; p <= endPage; p++) {
      if (!pageCacheRef.current.has(p) && !loadingPagesRef.current.has(p)) {
        loadingPagesRef.current.add(p)
        api.gitManager.getLog(projectDir, { maxCount: COMMIT_PAGE_SIZE, skip: p * COMMIT_PAGE_SIZE })
          .then((data) => {
            pageCacheRef.current.set(p, data)
            loadingPagesRef.current.delete(p)
            setCacheVersion((v) => v + 1)
          })
          .catch(() => {
            pageCacheRef.current.set(p, [])
            loadingPagesRef.current.delete(p)
            setCacheVersion((v) => v + 1)
          })
      }
    }
  }, [startPage, endPage, projectDir])

  // Highlight animation state
  const [highlightHash, setHighlightHash] = useState<string | null>(null)

  // Scroll to a specific commit hash
  useEffect(() => {
    if (!scrollToHash || !scrollContainerRef.current) return
    const doScroll = async () => {
      // First check loaded pages
      let targetIdx = -1
      const pageKeys = [...pageCacheRef.current.keys()].sort((a, b) => a - b)
      for (const pk of pageKeys) {
        const page = pageCacheRef.current.get(pk)
        if (page) {
          const localIdx = page.findIndex((c) => c.hash === scrollToHash || c.hash.startsWith(scrollToHash))
          if (localIdx !== -1) {
            targetIdx = pk * COMMIT_PAGE_SIZE + localIdx
            break
          }
        }
      }
      // If not found in loaded pages, look up via IPC
      if (targetIdx === -1) {
        const api = getDockApi()
        targetIdx = await api.gitManager.getCommitIndex(projectDir, scrollToHash)
      }
      if (targetIdx >= 0 && scrollContainerRef.current) {
        const targetTop = targetIdx * COMMIT_ROW_HEIGHT
        const center = targetTop - scrollContainerRef.current.clientHeight / 2 + COMMIT_ROW_HEIGHT / 2
        scrollContainerRef.current.scrollTop = Math.max(0, center)
        setScrollTop(Math.max(0, center))
        setHighlightHash(scrollToHash)
        setTimeout(() => setHighlightHash(null), 1200)
      }
      onScrollToHandled?.()
    }
    doScroll()
  }, [scrollToHash, projectDir, onScrollToHandled])

  // Viewport height tracking
  useEffect(() => {
    const el = scrollContainerRef.current
    if (!el) return
    const obs = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setViewportHeight(entry.contentRect.height)
      }
    })
    obs.observe(el)
    setViewportHeight(el.clientHeight)
    return () => obs.disconnect()
  }, [])

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current
    if (el) setScrollTop(el.scrollTop)
  }, [])

  // Local visual selection that updates immediately (before debounced detail fetch)
  const [activeHash, setActiveHash] = useState<string | null>(null)
  // Sync activeHash when parent's selectedHash catches up (e.g. from click)
  useEffect(() => {
    setActiveHash(null)
  }, [selectedHash])

  // Track selected index in a ref so rapid key-repeat events see the latest value
  const selectedIdxRef = useRef(-1)
  useEffect(() => {
    const hash = activeHash || selectedHash
    selectedIdxRef.current = hash ? globalIndexMap.get(hash) ?? -1 : -1
  }, [selectedHash, activeHash, globalIndexMap])

  // Arrow key navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
    e.preventDefault()

    const currentIdx = selectedIdxRef.current
    if (currentIdx === -1 && e.key === 'ArrowUp') return

    const newIdx = e.key === 'ArrowDown'
      ? Math.min(effectiveTotal - 1, currentIdx + 1)
      : Math.max(0, currentIdx - 1)

    if (newIdx === currentIdx) return

    const page = Math.floor(newIdx / COMMIT_PAGE_SIZE)
    const pageOffset = newIdx % COMMIT_PAGE_SIZE
    const pageData = pageCacheRef.current.get(page)
    const commit = pageData?.[pageOffset]

    if (commit) {
      selectedIdxRef.current = newIdx
      setActiveHash(commit.hash)
      onSelect(commit.hash)
    }

    // Scroll into view
    if (scrollContainerRef.current) {
      const targetTop = newIdx * COMMIT_ROW_HEIGHT
      const targetBottom = targetTop + COMMIT_ROW_HEIGHT
      const st = scrollContainerRef.current.scrollTop
      const sb = st + scrollContainerRef.current.clientHeight

      if (targetTop < st) {
        scrollContainerRef.current.scrollTop = targetTop
      } else if (targetBottom > sb) {
        scrollContainerRef.current.scrollTop = targetBottom - scrollContainerRef.current.clientHeight
      }
      setScrollTop(scrollContainerRef.current.scrollTop)
    }
  }, [effectiveTotal, onSelect])

  const handleContextMenu = useCallback((e: React.MouseEvent, commit: GitCommitInfo) => {
    e.preventDefault()
    const zoom = parseFloat(document.documentElement.style.zoom) || 1
    setCtxMenu({ x: e.clientX / zoom, y: e.clientY / zoom, commit })
  }, [])

  const isHead = useCallback((c: GitCommitInfo) => {
    return c.refs.some((r) => r.startsWith('HEAD'))
  }, [])

  const listRef = useRef<HTMLDivElement>(null)
  const [compactLevel, setCompactLevel] = useState(0)

  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const obs = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentRect.width
        if (w < 500) setCompactLevel(2)
        else if (w < 700) setCompactLevel(1)
        else setCompactLevel(0)
      }
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  // Build visible entries: commits + interleaved stashes
  const visibleEntries = useMemo(() => {
    const entries: ({ type: 'commit'; commit: GitCommitInfo; globalIdx: number } | { type: 'stash'; stash: GitStashEntry; globalIdx: number } | { type: 'placeholder'; globalIdx: number })[] = []

    // Orphan stashes at the top (only if viewing near the top)
    if (startIdx === 0) {
      for (const s of orphanStashes) {
        entries.push({ type: 'stash', stash: s, globalIdx: -1 })
      }
    }

    for (let i = startIdx; i <= endIdx && i < effectiveTotal; i++) {
      const page = Math.floor(i / COMMIT_PAGE_SIZE)
      const pageOffset = i % COMMIT_PAGE_SIZE
      const pageData = pageCacheRef.current.get(page)
      const commit = pageData?.[pageOffset]

      if (commit) {
        // Insert stashes before their parent commit
        const stashesHere = stashByParent.get(commit.hash)
        if (stashesHere) {
          for (const s of stashesHere) {
            entries.push({ type: 'stash', stash: s, globalIdx: i })
          }
        }
        entries.push({ type: 'commit', commit, globalIdx: i })
      } else {
        entries.push({ type: 'placeholder', globalIdx: i })
      }
    }
    return entries
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startIdx, endIdx, totalCommitCount, cacheVersion, stashByParent, orphanStashes])

  const renderStashRow = (s: GitStashEntry, parentGlobalIdx: number) => {
    const graphRowIdx = parentGlobalIdx >= 0 ? graphRowMap.get(parentGlobalIdx) : undefined
    const parentRow = graphRowIdx !== undefined ? graphRows[graphRowIdx] : undefined
    return (
      <div key={`stash-${s.index}`} className="gm-commit-row gm-stash-row" style={{ height: COMMIT_ROW_HEIGHT }} onContextMenu={(e) => {
        e.preventDefault()
        const zoom = parseFloat(document.documentElement.style.zoom) || 1
        setStashCtxMenu({ x: e.clientX / zoom, y: e.clientY / zoom, stash: s })
      }}>
        <span className="gm-col-graph gm-col-graph-lines" style={{ width: showGraph ? graphW : 24 }}>
          {showGraph && parentRow ? (
            <svg width={graphW} height="100%" viewBox={`0 0 ${graphW} 100`} preserveAspectRatio="none" className="gm-graph-svg">
              <line
                x1={parentRow.col * LANE_W + LANE_W / 2 + 4} y1={-1}
                x2={parentRow.col * LANE_W + LANE_W / 2 + 4} y2={101}
                stroke="#565f89" strokeWidth={2} vectorEffect="non-scaling-stroke"
              />
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

  const renderCommitRow = (c: GitCommitInfo, globalIdx: number) => {
    const graphRowIdx = graphRowMap.get(globalIdx)
    const row = graphRowIdx !== undefined ? graphRows[graphRowIdx] : undefined
    const head = isHead(c)
    const branchTip = !head && c.refs.length > 0
    const onCurrentBranch = branchHashes.has(c.hash)
    return (
      <div
        key={c.hash}
        className={`gm-commit-row${(activeHash || selectedHash) === c.hash ? ' gm-commit-row-selected' : ''}${head ? ' gm-commit-row-head' : ''}${!onCurrentBranch ? ' gm-commit-row-dimmed' : ''}${highlightHash === c.hash ? ' gm-commit-row-highlight' : ''}`}
        style={{ height: COMMIT_ROW_HEIGHT }}
        onClick={() => onSelect(c.hash)}
        onDoubleClick={() => getDockApi().gitManager.openCommit(projectDir, c.hash)}
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
                const strokeColor = s.onCurrentBranch ? s.color : GRAPH_GREY
                if (s.fromCol === s.toCol) {
                  return <line key={si} x1={x1} y1={y1} x2={x2} y2={y2} stroke={strokeColor} strokeWidth={2} vectorEffect="non-scaling-stroke" />
                }
                const my = (y1 + y2) / 2
                return <path key={si} d={`M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`} fill="none" stroke={strokeColor} strokeWidth={2} vectorEffect="non-scaling-stroke" />
              })}
            </svg>
          ) : null}
          {showGraph && row ? (
            <span
              className={`gm-graph-dot-node${head ? ' gm-graph-dot-head' : branchTip ? ' gm-graph-dot-tip' : ''}`}
              style={{
                left: row.col * LANE_W + LANE_W / 2 + 4,
                backgroundColor: row.onCurrentBranch ? row.color : GRAPH_GREY
              }}
            />
          ) : (
            <span
              className={`gm-graph-dot${head ? ' gm-graph-dot-head' : branchTip ? ' gm-graph-dot-tip' : ''}`}
              style={{ backgroundColor: c.parents.length > 1 ? '#bb9af7' : 'var(--accent-color)' }}
            />
          )}
        </span>
        <span className="gm-col-message">
          {c.refs.length > 0 && c.refs.filter((r) => r !== 'HEAD' && !r.endsWith('/HEAD')).map((r) => {
            const isTag = r.startsWith('tag: ')
            const isRemote = r.includes('/')
            const label = r.replace(/^HEAD -> /, '').replace(/^tag: /, '')
            return (
              <span
                key={r}
                className={`gm-ref-badge${isTag ? ' gm-ref-tag' : isRemote ? ' gm-ref-remote' : ''}`}
                onContextMenu={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  const zoom = parseFloat(document.documentElement.style.zoom) || 1
                  if (isTag) {
                    setTagCtxMenu({ x: e.clientX / zoom, y: e.clientY / zoom, tagName: label, commitHash: c.hash })
                  } else {
                    setBranchCtxMenu({ x: e.clientX / zoom, y: e.clientY / zoom, branchName: label, isRemote, commitHash: c.hash })
                  }
                }}
              >
                {isTag && <TagIcon />}{label}
              </span>
            )
          })}
          <span className="gm-commit-subject">{c.subject}</span>
        </span>
        <span className="gm-col-author"><AuthorAvatar name={c.author} />{c.author}</span>
        <span className="gm-col-date">{formatDate(c.date)}</span>
        <span className="gm-col-hash">{c.shortHash}</span>
      </div>
    )
  }

  return (
    <div className={`gm-commit-list${compactLevel >= 1 ? ' gm-hide-hash' : ''}${compactLevel >= 2 ? ' gm-hide-date' : ''}`} ref={listRef}>
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
      <div className="gm-commit-list-body" ref={scrollContainerRef} onScroll={handleScroll} onKeyDown={handleKeyDown} tabIndex={0}>
        <div style={{ height: totalHeight, position: 'relative' }}>
          <div style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${startIdx * COMMIT_ROW_HEIGHT}px)` }}>
            {visibleEntries.map((entry) => {
              if (entry.type === 'stash') return renderStashRow(entry.stash, entry.globalIdx)
              if (entry.type === 'placeholder') {
                return (
                  <div key={`ph-${entry.globalIdx}`} className="gm-commit-row gm-commit-row-placeholder" style={{ height: COMMIT_ROW_HEIGHT }}>
                    <span className="gm-col-graph" style={{ width: showGraph ? graphW : 24 }} />
                    <span className="gm-col-message"><span className="gm-placeholder-bar" /></span>
                    <span className="gm-col-author"><span className="gm-placeholder-bar gm-placeholder-short" /></span>
                    <span className="gm-col-date"><span className="gm-placeholder-bar gm-placeholder-short" /></span>
                    <span className="gm-col-hash"><span className="gm-placeholder-bar gm-placeholder-short" /></span>
                  </div>
                )
              }
              return renderCommitRow(entry.commit, entry.globalIdx)
            })}
          </div>
        </div>
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
          onCheckout={onCheckout}
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
      {tagCtxMenu && (
        <TagContextMenu
          x={tagCtxMenu.x}
          y={tagCtxMenu.y}
          tagName={tagCtxMenu.tagName}
          commitHash={tagCtxMenu.commitHash}
          projectDir={projectDir}
          onClose={() => setTagCtxMenu(null)}
          onAction={onAction}
          onError={onError}
          onCheckout={onCheckout}
        />
      )}
      {branchCtxMenu && (
        <BranchRefContextMenu
          x={branchCtxMenu.x}
          y={branchCtxMenu.y}
          branchName={branchCtxMenu.branchName}
          isRemote={branchCtxMenu.isRemote}
          projectDir={projectDir}
          onClose={() => setBranchCtxMenu(null)}
          onAction={onAction}
          onError={onError}
          onCheckout={onCheckout}
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
})

const GraphToggleIcon: React.FC = React.memo(() => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="6" cy="6" r="2.5" />
    <circle cx="18" cy="12" r="2.5" />
    <circle cx="6" cy="18" r="2.5" />
    <line x1="6" y1="8.5" x2="6" y2="15.5" />
    <path d="M8.5 6h4a4 4 0 014 4v2" />
  </svg>
))

// ── Binary file viewer system ──────────────────────────────────────────────────
// Extensible registry: add new viewer types by appending to FILE_VIEWERS.

/** Props shared by all binary file viewer components */
interface FileViewerProps {
  file: GitFileDiff
  projectDir: string
  oldSrc: string | null
  newSrc: string | null
}

/** Hook that fetches old/new blob data URLs for a binary file diff */
function useFileBlobs(
  file: GitFileDiff,
  projectDir: string,
  commitHash?: string,
  staged?: boolean
): { oldSrc: string | null; newSrc: string | null; loading: boolean } {
  const [oldSrc, setOldSrc] = useState<string | null>(null)
  const [newSrc, setNewSrc] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const api = getDockApi()
  const filePath = file.path
  const oldPath = file.oldPath || file.path

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setOldSrc(null)
    setNewSrc(null)

    const load = async (): Promise<void> => {
      const isAdded = file.status === 'added'
      const isDeleted = file.status === 'deleted'

      let oldData: string | null = null
      let newData: string | null = null

      if (commitHash) {
        if (!isAdded) oldData = await api.gitManager.getFileBlob(projectDir, oldPath, `${commitHash}~1`)
        if (!isDeleted) newData = await api.gitManager.getFileBlob(projectDir, filePath, commitHash)
      } else if (staged) {
        if (!isAdded) oldData = await api.gitManager.getFileBlob(projectDir, oldPath, 'HEAD')
        if (!isDeleted) newData = await api.gitManager.getFileBlob(projectDir, filePath, ':0:' + filePath)
      } else {
        if (!isAdded) oldData = await api.gitManager.getFileBlob(projectDir, oldPath, 'HEAD')
        if (!isDeleted) newData = await api.gitManager.getFileBlob(projectDir, filePath)
      }

      if (cancelled) return
      setOldSrc(oldData)
      setNewSrc(newData)
      setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [filePath, oldPath, commitHash, staged, projectDir, file.status])

  return { oldSrc, newSrc, loading }
}

/** Image viewer — renders before/after image previews */
const ImageFileViewer: React.FC<FileViewerProps> = ({ file, oldSrc, newSrc }) => {
  const onlyNew = !oldSrc && newSrc
  const onlyOld = oldSrc && !newSrc
  return (
    <div className="gm-image-diff">
      {onlyNew ? (
        <div className="gm-image-diff-single gm-image-diff-added">
          <img src={newSrc!} alt={file.path} />
        </div>
      ) : onlyOld ? (
        <div className="gm-image-diff-single gm-image-diff-deleted">
          <img src={oldSrc!} alt={file.oldPath || file.path} />
        </div>
      ) : (
        <div className="gm-image-diff-side-by-side">
          <div className="gm-image-diff-panel gm-image-diff-deleted">
            <div className="gm-image-diff-label">Before</div>
            <img src={oldSrc!} alt={`${file.oldPath || file.path} (before)`} />
          </div>
          <div className="gm-image-diff-panel gm-image-diff-added">
            <div className="gm-image-diff-label">After</div>
            <img src={newSrc!} alt={`${file.path} (after)`} />
          </div>
        </div>
      )}
    </div>
  )
}

/** PDF viewer — renders before/after embedded PDF previews */
const PdfFileViewer: React.FC<FileViewerProps> = ({ file, oldSrc, newSrc }) => {
  const onlyNew = !oldSrc && newSrc
  const onlyOld = oldSrc && !newSrc
  return (
    <div className="gm-pdf-diff">
      {onlyNew ? (
        <div className="gm-pdf-diff-single">
          <embed src={newSrc!} type="application/pdf" className="gm-pdf-embed" />
        </div>
      ) : onlyOld ? (
        <div className="gm-pdf-diff-single">
          <embed src={oldSrc!} type="application/pdf" className="gm-pdf-embed" />
        </div>
      ) : (
        <div className="gm-pdf-diff-side-by-side">
          <div className="gm-pdf-diff-panel gm-image-diff-deleted">
            <div className="gm-image-diff-label">Before</div>
            <embed src={oldSrc!} type="application/pdf" className="gm-pdf-embed" />
          </div>
          <div className="gm-pdf-diff-panel gm-image-diff-added">
            <div className="gm-image-diff-label">After</div>
            <embed src={newSrc!} type="application/pdf" className="gm-pdf-embed" />
          </div>
        </div>
      )}
    </div>
  )
}

/** Registry entry mapping file extensions to a viewer component */
interface FileViewerEntry {
  extensions: Set<string>
  component: React.FC<FileViewerProps>
  label: string // shown while loading
}

const FILE_VIEWERS: FileViewerEntry[] = [
  {
    extensions: new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico', 'avif', 'tif', 'tiff']),
    component: ImageFileViewer,
    label: 'image'
  },
  {
    extensions: new Set(['pdf']),
    component: PdfFileViewer,
    label: 'PDF'
  }
]

function getFileViewer(filePath: string): FileViewerEntry | null {
  const ext = filePath.split('.').pop()?.toLowerCase() || ''
  for (const entry of FILE_VIEWERS) {
    if (entry.extensions.has(ext)) return entry
  }
  return null
}

/** Dispatcher — picks the right viewer for a binary file, or falls back to "Binary file" text */
const BinaryFileViewer: React.FC<{
  file: GitFileDiff
  projectDir: string
  commitHash?: string
  staged?: boolean
}> = ({ file, projectDir, commitHash, staged }) => {
  const entry = getFileViewer(file.path)
  const { oldSrc, newSrc, loading } = useFileBlobs(file, projectDir, commitHash, staged)

  if (!entry) return <div className="gm-diff-binary">Binary file</div>
  if (loading) return <div className="gm-diff-binary">Loading {entry.label}...</div>
  if (!oldSrc && !newSrc) return <div className="gm-diff-binary">Binary file ({entry.label} not available)</div>

  const Viewer = entry.component
  return <Viewer file={file} projectDir={projectDir} oldSrc={oldSrc} newSrc={newSrc} />
}

/** Renders a single file diff lazily — only mounts content when scrolled into view */
const LazyDiffFile: React.FC<{
  file: GitFileDiff
  fileIdx: number
  syntaxHL: boolean
  selectedLines: Set<string>
  projectDir: string
  scrollTo: boolean
  onScrolled: () => void
  onLineMouseDown: (key: string, e: React.MouseEvent) => void
  onContextMenu: (fileIdx: number, e: React.MouseEvent) => void
  commitHash?: string
  commitSubject?: string
  onResetFile?: (filePath: string) => void
  hidden?: boolean
}> = ({ file: f, fileIdx: fi, syntaxHL, selectedLines, projectDir, scrollTo, onScrolled, onLineMouseDown, onContextMenu, commitHash, commitSubject, onResetFile, hidden }) => {
  const api = getDockApi()
  const [visible, setVisible] = useState(fi < 5) // render first 5 eagerly
  const sentinelRef = useRef<HTMLDivElement>(null)

  // Force-reveal and scroll when requested from the file list
  useEffect(() => {
    if (!scrollTo) return
    setVisible(true)

    // Wait for React to commit the expanded content, then scroll.
    // Use instant scroll to avoid being thrown off by intermediate lazy files
    // expanding during a smooth scroll (which shifts the target element).
    // After the initial jump, do a second correction to account for any
    // layout shifts from IntersectionObserver-triggered expansions.
    let cancelled = false
    const doScroll = (): void => {
      if (cancelled || !sentinelRef.current) return
      sentinelRef.current.scrollIntoView({ behavior: 'instant', block: 'start' })
      // Second pass: after intermediate files may have expanded from the scroll,
      // re-verify position. This catches layout shifts from lazy loading.
      requestAnimationFrame(() => {
        if (cancelled || !sentinelRef.current) return
        sentinelRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
        onScrolled()
      })
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (cancelled) return
        setTimeout(doScroll, 50)
      })
    })
    return () => { cancelled = true }
  }, [scrollTo, onScrolled])

  useEffect(() => {
    if (visible || !sentinelRef.current) return
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setVisible(true); observer.disconnect() } },
      { rootMargin: '200px' }
    )
    observer.observe(sentinelRef.current)
    return () => observer.disconnect()
  }, [visible])

  const highlighted = useMemo(() => {
    if (!visible || !syntaxHL) return null
    return highlightDiffHunks(f.path, f.hunks)
  }, [visible, syntaxHL, f.path, f.hunks])

  const lineCount = f.hunks.reduce((n, h) => n + h.lines.length, 0)
  let adds = 0, dels = 0
  for (const h of f.hunks) for (const l of h.lines) {
    if (l.type === 'add') adds++
    else if (l.type === 'delete') dels++
  }

  if (hidden) {
    return <div className="gm-diff-file" ref={sentinelRef} style={{ display: 'none' }} />
  }

  return (
    <div className="gm-diff-file" ref={sentinelRef}>
      <div className="gm-diff-file-header">
        <FileStatusBadge status={f.status} />
        <EllipsisPath className="gm-diff-file-path" text={f.oldPath ? `${f.oldPath} -> ${f.path}` : f.path} />
        <button
          className="gm-file-hover-btn"
          onClick={() => api.app.openInExplorer(projectDir + '/' + f.path)}
          title="Open file"
        ><OpenFileIcon /></button>
        <button
          className="gm-file-hover-btn"
          onClick={() => api.gitManager.showInFolder(projectDir, f.path)}
          title="Show in folder"
        ><ShowInFolderIcon /></button>
        {onResetFile && (
          <button
            className="gm-file-hover-btn"
            onClick={() => onResetFile(f.path)}
            title="Reset this file's change"
          ><ResetChangeIcon /></button>
        )}
        <ClaudeActionWheel files={[f.path]} commitHash={commitHash} commitSubject={commitSubject} />
        <span className="gm-diff-file-stats">
          {adds > 0 && <span className="gm-diff-stat-add">+{adds}</span>}
          {dels > 0 && <span className="gm-diff-stat-del">-{dels}</span>}
        </span>
      </div>
      {!visible ? (
        <div className="gm-diff-lazy-placeholder" style={{ height: lineCount * 20 + 8 }} />
      ) : f.isBinary ? (
        <BinaryFileViewer file={f} projectDir={projectDir} commitHash={commitHash} />
      ) : (
        <LargeDiffGate lineCount={lineCount}>
          <div className="gm-diff-file-body" style={{ '--line-no-ch': lineNoDigits(f.hunks) } as React.CSSProperties}>
            {f.hunks.map((h, hi) => (
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
                      onMouseDown={(e) => onLineMouseDown(key, e)}
                      onContextMenu={(e) => onContextMenu(fi, e)}
                    >
                      <span className="gm-diff-line-no">
                        <span>{l.oldLineNo ?? ' '}</span>
                        <span>{l.newLineNo ?? ' '}</span>
                      </span>
                      <span className="gm-diff-line-prefix">
                        {l.type === 'add' ? '+' : l.type === 'delete' ? '-' : ' '}
                      </span>
                      {highlighted?.[hi]?.[li]
                        ? <span className="gm-diff-line-content gm-highlighted"
                            dangerouslySetInnerHTML={{ __html: highlighted[hi][li] }} />
                        : <span className="gm-diff-line-content">{l.content}</span>}
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        </LargeDiffGate>
      )}
    </div>
  )
}

// --- Search Dropdown ---

function highlightMatch(text: string, query: string): React.ReactNode {
  if (!query || !text) return text
  const idx = text.toLowerCase().indexOf(query.toLowerCase())
  if (idx === -1) return text
  return (
    <>
      {text.slice(0, idx)}
      <mark>{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  )
}

const SEARCH_ROW_HEIGHT = 44

const SearchDropdown: React.FC<{
  results: GitSearchResult[]
  loading: boolean
  truncated: boolean
  focusIdx: number
  onSelect: (result: GitSearchResult) => void
  onClose: () => void
}> = React.memo(({ results, loading, truncated, focusIdx, onSelect, onClose }) => {
  const dropdownRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        // Check if click is on the search input
        const searchBar = dropdownRef.current.closest('.gm-search-bar')
        if (searchBar && searchBar.contains(e.target as Node)) return
        onClose()
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  // Scroll focused item into view
  useEffect(() => {
    if (focusIdx < 0 || !scrollRef.current) return
    const top = focusIdx * SEARCH_ROW_HEIGHT
    const el = scrollRef.current
    if (top < el.scrollTop) el.scrollTop = top
    else if (top + SEARCH_ROW_HEIGHT > el.scrollTop + el.clientHeight) {
      el.scrollTop = top + SEARCH_ROW_HEIGHT - el.clientHeight
    }
  }, [focusIdx])

  if (loading && results.length === 0) {
    return (
      <div className="gm-search-dropdown" ref={dropdownRef}>
        <div className="gm-search-dropdown-loading">Searching...</div>
      </div>
    )
  }

  if (!loading && results.length === 0) {
    return (
      <div className="gm-search-dropdown" ref={dropdownRef}>
        <div className="gm-search-dropdown-empty">No results found</div>
      </div>
    )
  }

  return (
    <div className="gm-search-dropdown" ref={dropdownRef}>
      <div className="gm-search-dropdown-scroll" ref={scrollRef}>
        {results.map((r, i) => {
          const isCommit = r.source.type === 'commit'
          const badge = isCommit
            ? { cls: 'gm-search-badge-commit', label: r.source.shortHash }
            : { cls: `gm-search-badge-${r.source.section}`, label: r.source.section }

          const displayPath = r.filePath
            ? r.filePath + (r.lineNumber ? `:${r.lineNumber}` : '')
            : (isCommit ? r.source.subject : '')

          const line2 = r.matchType === 'subject' && isCommit
            ? r.source.subject
            : r.lineContent || (isCommit ? r.source.subject : '')

          // Get query from the search input (passed via closure)
          const searchInput = dropdownRef.current?.closest('.gm-search-bar')?.querySelector('input')
          const query = searchInput?.value || ''

          return (
            <div
              key={r.id}
              className={`gm-search-result${i === focusIdx ? ' gm-search-result-focused' : ''}`}
              style={{ height: SEARCH_ROW_HEIGHT }}
              onClick={() => onSelect(r)}
            >
              <div className="gm-search-result-line1">
                <span className="gm-search-result-path">
                  {highlightMatch(displayPath, query)}
                </span>
                <span className={`gm-search-badge ${badge.cls}`}>{badge.label}</span>
              </div>
              <div className="gm-search-result-line2">
                {highlightMatch(line2, query)}
              </div>
            </div>
          )
        })}
      </div>
      {truncated && <div className="gm-search-truncated">Results truncated — refine your search</div>}
      {loading && results.length > 0 && <div className="gm-search-dropdown-loading">Searching...</div>}
    </div>
  )
})

const CiSearchDropdown: React.FC<{
  results: CiLogSearchMatch[]
  progress: CiSearchProgress | null
  query: string
  focusIdx: number
  onSelect: (result: CiLogSearchMatch) => void
  onClose: () => void
}> = ({ results, progress, query, focusIdx, onSelect, onClose }) => {
  const dropdownRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        const searchBar = dropdownRef.current.closest('.gm-search-bar')
        if (searchBar && searchBar.contains(e.target as Node)) return
        onClose()
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  useEffect(() => {
    if (focusIdx < 0 || !scrollRef.current) return
    const top = focusIdx * SEARCH_ROW_HEIGHT
    const el = scrollRef.current
    if (top < el.scrollTop) el.scrollTop = top
    else if (top + SEARCH_ROW_HEIGHT > el.scrollTop + el.clientHeight) {
      el.scrollTop = top + SEARCH_ROW_HEIGHT - el.clientHeight
    }
  }, [focusIdx])

  const searching = progress && !progress.done

  // Still loading (no progress yet, or 0/0 while fetching job lists)
  if (!progress && results.length === 0) {
    return null
  }

  if (searching && results.length === 0) {
    const label = progress.total > 0
      ? `Searching ${progress.searched}/${progress.total} job logs...`
      : 'Fetching job list...'
    return (
      <div className="gm-search-dropdown" ref={dropdownRef}>
        <div className="gm-search-dropdown-loading">
          <span className="ci-spinner" style={{ width: 12, height: 12, marginRight: 8, display: 'inline-block', verticalAlign: 'middle' }} />
          {label}
        </div>
      </div>
    )
  }

  if (progress?.done && results.length === 0) {
    return (
      <div className="gm-search-dropdown" ref={dropdownRef}>
        <div className="gm-search-dropdown-empty">No matches in {progress.total} job {progress.total === 1 ? 'log' : 'logs'}</div>
      </div>
    )
  }

  return (
    <div className="gm-search-dropdown" ref={dropdownRef}>
      <div className="gm-search-dropdown-scroll" ref={scrollRef}>
        {results.map((r, i) => (
          <div
            key={r.id}
            className={`gm-search-result${i === focusIdx ? ' gm-search-result-focused' : ''}`}
            style={{ height: SEARCH_ROW_HEIGHT }}
            onClick={() => onSelect(r)}
          >
            <div className="gm-search-result-line1">
              <span className="gm-search-result-path">
                {r.jobName}
              </span>
              <span className="gm-search-badge gm-search-badge-ci">#{r.runNumber}</span>
              <span className="gm-ci-match-count">{r.matchCount} {r.matchCount === 1 ? 'match' : 'matches'}</span>
            </div>
            <div className="gm-search-result-line2">
              {highlightMatch(r.firstMatchPreview, query)}
            </div>
          </div>
        ))}
      </div>
      {searching && (
        <div className="gm-search-dropdown-loading">
          <span className="ci-spinner" style={{ width: 12, height: 12, marginRight: 8, display: 'inline-block', verticalAlign: 'middle' }} />
          Searching {progress!.searched}/{progress!.total} job logs...
        </div>
      )}
    </div>
  )
}

const SearchIcon: React.FC = React.memo(() => (
  <svg className="gm-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="8" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
))

const CommitDetailPanel: React.FC<{
  detail: GitCommitDetail
  projectDir: string
  syntaxHL: boolean
  scrollToFileAndLine?: { filePath: string; lineNumber?: number } | null
  onScrollToHandled?: () => void
  onClose: () => void
  onError?: (msg: string) => void
  onRefresh?: () => void
  hideClose?: boolean
}> = React.memo(({ detail, projectDir, syntaxHL, scrollToFileAndLine, onScrollToHandled, onClose, onError, onRefresh, hideClose }) => {
  const api = getDockApi()
  const [selectedLines, setSelectedLines] = useState<Set<string>>(new Set())
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; fileIdx: number } | null>(null)
  const [dragStart, setDragStart] = useState<string | null>(null)
  const lastClickedRef = useRef<string | null>(null)
  const isDragging = useRef(false)
  const [commitUrl, setCommitUrl] = useState<string | null>(null)
  const [provider, setProvider] = useState<GitProvider>('generic')
  const [fileListExpanded, setFileListExpanded] = useState(false)
  const [scrollToFileIdx, setScrollToFileIdx] = useState<number | null>(null)
  const clearScrollTo = useCallback(() => setScrollToFileIdx(null), [])
  const [focusedFileIdx, setFocusedFileIdx] = useState<number | null>(null)
  const [hoveredFileIdx, setHoveredFileIdx] = useState<number | null>(null)
  const activeFilterIdx = focusedFileIdx ?? hoveredFileIdx

  const handleResetFile = useCallback(async (filePath: string) => {
    if (!window.confirm(`Reset "${filePath}" to its state before this commit?`)) return
    const result = await api.gitManager.restoreFileFromCommit(projectDir, detail.hash, filePath)
    if (result.success) {
      onRefresh?.()
    } else {
      onError?.(`Reset failed: ${result.error || 'Unknown error'}`)
    }
  }, [api, projectDir, detail.hash, onError, onRefresh])

  const handleResetLines = useCallback(async () => {
    if (selectedLines.size === 0) return
    const changeCount = [...selectedLines].filter(k => {
      const [fi, hi, li] = k.split(':').map(Number)
      const t = detail.files[fi]?.hunks[hi]?.lines[li]?.type
      return t === 'add' || t === 'delete'
    }).length
    if (changeCount === 0) return
    if (!window.confirm(`Reset ${changeCount === 1 ? '1 selected line' : `${changeCount} selected lines`} to state before this commit?`)) return

    // Group selected lines by file index
    const byFile = new Map<number, Set<string>>()
    for (const key of selectedLines) {
      const [fi, hi, li] = key.split(':').map(Number)
      if (!byFile.has(fi)) byFile.set(fi, new Set())
      byFile.get(fi)!.add(`${hi}:${li}`)
    }

    let anyFailed = false
    for (const [fi, lineKeys] of byFile) {
      const file = detail.files[fi]
      if (!file) continue
      const patch = buildPartialPatch(file, lineKeys)
      if (!patch) continue
      const result = await api.gitManager.applyPatch(projectDir, patch, false, true, true)
      if (!result.success) {
        anyFailed = true
        onError?.(`Reset lines failed for ${file.path}: ${result.error || 'Unknown error'}`)
      }
    }
    setSelectedLines(new Set())
    if (!anyFailed) onRefresh?.()
  }, [api, projectDir, detail.files, selectedLines, onError, onRefresh])

  // Clear selection on new commit
  useEffect(() => { setSelectedLines(new Set()); setCtxMenu(null); setFocusedFileIdx(null) }, [detail.hash])

  // Scroll to file and line from search navigation
  useEffect(() => {
    if (!scrollToFileAndLine) return
    const fileIdx = detail.files.findIndex((f) => f.path === scrollToFileAndLine.filePath)
    if (fileIdx >= 0) {
      setScrollToFileIdx(fileIdx)
      // After a short delay, try to scroll to the specific line within the file
      if (scrollToFileAndLine.lineNumber) {
        const targetLine = scrollToFileAndLine.lineNumber
        setTimeout(() => {
          // Find the diff line with the matching new line number
          const file = detail.files[fileIdx]
          for (let hi = 0; hi < file.hunks.length; hi++) {
            for (let li = 0; li < file.hunks[hi].lines.length; li++) {
              const l = file.hunks[hi].lines[li]
              if (l.newLineNo === targetLine || l.oldLineNo === targetLine) {
                const key = `${fileIdx}:${hi}:${li}`
                const lineEl = document.querySelector(`[data-linekey="${key}"]`)
                if (lineEl) {
                  lineEl.scrollIntoView({ block: 'center', behavior: 'smooth' })
                  lineEl.classList.add('gm-search-highlight-flash')
                }
                return
              }
            }
          }
        }, 400)
      }
    }
    onScrollToHandled?.()
  }, [scrollToFileAndLine, detail.files, onScrollToHandled])

  // Resolve commit web URL from remote origin
  useEffect(() => {
    let cancelled = false
    api.gitManager.getRemotes(projectDir).then((remotes) => {
      if (cancelled) return
      const origin = remotes.find((r) => r.name === 'origin') || remotes[0]
      if (origin) {
        setCommitUrl(remoteUrlToCommitUrl(origin.fetchUrl, detail.hash))
        setProvider(detectProvider(origin.fetchUrl))
      } else {
        setCommitUrl(null)
        setProvider('generic')
      }
    }).catch(() => { if (!cancelled) { setCommitUrl(null); setProvider('generic') } })
    return () => { cancelled = true }
  }, [projectDir, detail.hash, api])

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
      document.documentElement.classList.remove('gm-line-dragging')
    }
    document.documentElement.classList.add('gm-line-dragging')
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.documentElement.classList.remove('gm-line-dragging')
    }
  }, [dragStart, getLineRange])

  // Track text selection via direct DOM manipulation (no React re-renders)
  // Also clear all selections when clicking outside diff lines
  useEffect(() => {
    const clearTextHighlights = () => {
      document.querySelectorAll('.gm-diff-line-text-selected').forEach(el => el.classList.remove('gm-diff-line-text-selected'))
    }
    const onSelectionChange = () => {
      const sel = document.getSelection()
      if (!sel || sel.isCollapsed || !sel.rangeCount) { clearTextHighlights(); return }
      const range = sel.getRangeAt(0)
      const container = range.commonAncestorContainer instanceof Element
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement
      if (!container?.closest('.gm-diff-hunk')) { clearTextHighlights(); return }
      clearTextHighlights()
      document.querySelectorAll('[data-linekey]').forEach(el => {
        if (sel.containsNode(el, true)) el.classList.add('gm-diff-line-text-selected')
      })
    }
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target instanceof Element ? e.target : (e.target as Node)?.parentElement
      if (!target?.closest?.('[data-linekey]') && !target?.closest?.('.gm-ctx-menu')) {
        clearTextHighlights()
        setSelectedLines(new Set())
      }
    }
    document.addEventListener('selectionchange', onSelectionChange)
    document.addEventListener('mousedown', onMouseDown)
    return () => {
      document.removeEventListener('selectionchange', onSelectionChange)
      document.removeEventListener('mousedown', onMouseDown)
      clearTextHighlights()
    }
  }, [])

  const handleLineMouseDown = useCallback((key: string, e: React.MouseEvent) => {
    if (e.button !== 0) return
    const target = e.target instanceof Element ? e.target : (e.target as Node)?.parentElement
    if (!target?.closest) return
    const isGutter = target.closest('.gm-diff-line-no') || target.closest('.gm-diff-line-prefix')
    if (!isGutter) return // content clicks use native text selection only
    e.preventDefault()
    // Clear any text-selection highlights when switching to gutter selection
    document.querySelectorAll('.gm-diff-line-text-selected').forEach(el => el.classList.remove('gm-diff-line-text-selected'))
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
    // Sync text-selection highlights into selectedLines for context menu actions
    const textSelected = document.querySelectorAll('.gm-diff-line-text-selected[data-linekey]')
    if (textSelected.length > 0) {
      const keys = new Set<string>()
      textSelected.forEach(el => { const k = el.getAttribute('data-linekey'); if (k) keys.add(k) })
      setSelectedLines(keys)
    } else {
      const el = (e.target as HTMLElement).closest('[data-linekey]')
      const key = el?.getAttribute('data-linekey') || null
      if (key && !selectedLines.has(key)) {
        setSelectedLines(new Set([key]))
        lastClickedRef.current = key
      }
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
        <span className="gm-detail-hash">
          {detail.shortHash}
          <button
            className="gm-detail-copy-hash"
            onClick={() => navigator.clipboard.writeText(detail.hash)}
            title="Copy full hash"
          >
            <CopyIcon />
          </button>
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {commitUrl && (
            <button
              className="gm-detail-web-link"
              onClick={() => api.app.openExternal(commitUrl)}
              title={`View on ${providerLabel(provider)}`}
            >
              <ProviderIcon provider={provider} />
            </button>
          )}
          {!hideClose && <button className="gm-detail-close" onClick={onClose}>&#10005;</button>}
        </span>
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
        <div
          className={`gm-detail-files-header${fileListExpanded ? ' gm-detail-files-header-expanded' : ''}`}
          onClick={() => setFileListExpanded((v) => !v)}
        >
          <span className="gm-detail-files-toggle">{fileListExpanded ? '\u25BC' : '\u25B6'}</span>
          {detail.files.length} file{detail.files.length !== 1 ? 's' : ''} changed
        </div>
        {fileListExpanded && (
          <div className="gm-detail-file-list" onMouseLeave={() => setHoveredFileIdx(null)}>
            {detail.files.map((f, fi) => {
              let adds = 0, dels = 0
              for (const h of f.hunks) for (const l of h.lines) {
                if (l.type === 'add') adds++
                else if (l.type === 'delete') dels++
              }
              const isFocused = focusedFileIdx === fi
              return (
                <div
                  key={f.path}
                  className={`gm-detail-file-list-item${isFocused ? ' gm-detail-file-list-item-focused' : ''}`}
                  onMouseEnter={() => setHoveredFileIdx(fi)}
                  onClick={(e) => {
                    if (e.ctrlKey || e.metaKey) {
                      // Ctrl+click: scroll to file without selecting
                      setScrollToFileIdx(fi)
                      setFileListExpanded(false)
                    } else {
                      // Normal click: toggle focus filter
                      setFocusedFileIdx(isFocused ? null : fi)
                    }
                  }}
                  onDoubleClick={() => { setScrollToFileIdx(fi); setFileListExpanded(false) }}
                >
                  <FileStatusBadge status={f.status} />
                  <EllipsisPath className="gm-detail-file-list-name" text={f.path} />
                  <span className="gm-diff-file-stats">
                    {adds > 0 && <span className="gm-diff-stat-add">+{adds}</span>}
                    {dels > 0 && <span className="gm-diff-stat-del">-{dels}</span>}
                  </span>
                </div>
              )
            })}
          </div>
        )}
        {detail.files.map((f, fi) => (
          <LazyDiffFile
            key={f.path}
            file={f}
            fileIdx={fi}
            syntaxHL={syntaxHL}
            selectedLines={selectedLines}
            projectDir={projectDir}
            scrollTo={scrollToFileIdx === fi}
            onScrolled={clearScrollTo}
            onLineMouseDown={handleLineMouseDown}
            onContextMenu={handleContextMenu}
            commitHash={detail.hash}
            commitSubject={detail.subject}
            onResetFile={handleResetFile}
            hidden={activeFilterIdx != null && activeFilterIdx !== fi}
          />
        ))}
      </div>

      {ctxMenu && (
        <CommitDiffContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          selectedCount={selectedLines.size}
          selectedPatch={getSelectedText('patch')}
          selectedFiles={[...new Set([...selectedLines].map(k => detail.files[Number(k.split(':')[0])]?.path).filter(Boolean))]}
          commitHash={detail.hash}
          commitSubject={detail.subject}
          onCopy={() => doCopy('content')}
          onCopyPatch={() => doCopy('patch')}
          onCopyNew={() => doCopy('new')}
          onCopyOld={() => doCopy('old')}
          onResetLines={handleResetLines}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  )
})

const CommitDiffContextMenu: React.FC<{
  x: number; y: number
  selectedCount: number
  selectedPatch: string
  selectedFiles: string[]
  commitHash: string
  commitSubject: string
  onCopy: () => void
  onCopyPatch: () => void
  onCopyNew: () => void
  onCopyOld: () => void
  onResetLines?: () => void
  onClose: () => void
}> = ({ x, y, selectedCount, selectedPatch, selectedFiles, commitHash, commitSubject, onCopy, onCopyPatch, onCopyNew, onCopyOld, onResetLines, onClose }) => {
  const ref = useRef<HTMLDivElement>(null)
  const [claudeSubmenu, setClaudeSubmenu] = useState(false)

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
      {onResetLines && (
        <>
          <div className="gm-ctx-separator" />
          <div className="gm-ctx-item" onClick={() => { onClose(); onResetLines() }}>Reset selected {label}</div>
        </>
      )}
      <div className="gm-ctx-separator" />
      <div
        className="gm-ctx-item gm-ctx-submenu-trigger"
        onMouseEnter={() => setClaudeSubmenu(true)}
        onMouseLeave={() => setClaudeSubmenu(false)}
      >
        <span className="gm-ctx-item-label"><svg className="gm-ctx-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5L12 3z" /><path d="M19 15l.5 2 2 .5-2 .5-.5 2-.5-2-2-.5 2-.5.5-2z" /></svg>Claude Actions</span>
        <span className="gm-ctx-arrow">&#9656;</span>
        {claudeSubmenu && (
          <div className="gm-ctx-submenu" ref={adjustSubmenuRef}>
            <div className="gm-ctx-item" onClick={() => { onClose(); sendWriteTestsTask(selectedFiles, commitHash, commitSubject, selectedPatch) }}><span className="gm-ctx-item-label"><svg className="gm-ctx-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 2v6.5L20 22H4L9.5 8.5V2" /><line x1="8" y1="2" x2="16" y2="2" /><line x1="6" y1="18" x2="18" y2="18" /></svg>Write Tests</span></div>
            <div className="gm-ctx-item" onClick={() => { onClose(); sendReferenceThisTask(selectedFiles, commitHash, commitSubject, selectedPatch) }}><span className="gm-ctx-item-label"><svg className="gm-ctx-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2z" /><path d="M22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z" /></svg>Reference This</span></div>
          </div>
        )}
      </div>
    </div>
  )
}

const FILE_ROW_HEIGHT = 28

const VirtualFileList: React.FC<{
  files: GitFileStatusEntry[]
  section: 'staged' | 'unstaged'
  selectedFile: { path: string; staged: boolean } | null
  selectedPaths: Set<string>
  stagingPaths: Set<string>
  projectDir: string
  onSelect: (path: string, staged: boolean) => void
  onShiftSelect: (paths: string[], activePath: string, staged: boolean) => void
  onCtrlSelect: (path: string, staged: boolean) => void
  onAction: (path: string) => void
  onBatchAction: (paths: string[]) => void
  onDoubleClick: (path: string) => void
  onContextMenu: (e: React.MouseEvent, file: GitFileStatusEntry, section: 'staged' | 'unstaged') => void
  actionLabel: string
  actionTitle: string
}> = React.memo(({ files, section, selectedFile, selectedPaths, stagingPaths, projectDir, onSelect, onShiftSelect, onCtrlSelect, onAction, onBatchAction, onDoubleClick, onContextMenu, actionLabel, actionTitle }) => {
  const api = getDockApi()
  const containerRef = useRef<HTMLDivElement>(null)
  const isStaged = section === 'staged'
  const anchorIdxRef = useRef(0)

  const getRangePaths = useCallback((fromIdx: number, toIdx: number): string[] => {
    const lo = Math.min(fromIdx, toIdx)
    const hi = Math.max(fromIdx, toIdx)
    return files.slice(lo, hi + 1).map(f => f.path)
  }, [files])

  const scrollIntoView = useCallback((idx: number) => {
    if (!containerRef.current) return
    const row = containerRef.current.querySelector(`[data-file-idx="${idx}"]`) as HTMLElement | null
    row?.scrollIntoView({ block: 'nearest' })
  }, [])

  // Arrow key navigation + S/U hotkeys for stage/unstage
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // S = stage (in unstaged list) or U = unstage (in staged list)
    const key = e.key.toLowerCase()
    if ((key === 's' || key === 'u') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const activeInThisList = selectedFile && selectedFile.staged === isStaged
      if (activeInThisList) {
        if ((key === 's' && !isStaged) || (key === 'u' && isStaged)) {
          e.preventDefault()
          if (selectedPaths.size > 1) {
            onBatchAction([...selectedPaths])
          } else {
            onAction(selectedFile!.path)
          }
          return
        }
      }
    }

    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
    e.preventDefault()

    const currentIdx = selectedFile && selectedFile.staged === isStaged
      ? files.findIndex(f => f.path === selectedFile.path)
      : -1
    if (currentIdx === -1 && e.key === 'ArrowUp') return

    const newIdx = e.key === 'ArrowDown'
      ? Math.min(files.length - 1, currentIdx + 1)
      : Math.max(0, currentIdx - 1)

    if (newIdx >= 0 && newIdx < files.length) {
      if (e.shiftKey) {
        const paths = getRangePaths(anchorIdxRef.current, newIdx)
        onShiftSelect(paths, files[newIdx].path, isStaged)
      } else if (e.ctrlKey || e.metaKey) {
        onCtrlSelect(files[newIdx].path, isStaged)
      } else {
        anchorIdxRef.current = newIdx
        onSelect(files[newIdx].path, isStaged)
      }
      scrollIntoView(newIdx)
    }
  }, [files, selectedFile, selectedPaths, isStaged, onSelect, onShiftSelect, onCtrlSelect, onAction, onBatchAction, getRangePaths, scrollIntoView])

  const handleMouseDown = useCallback((e: React.MouseEvent, f: GitFileStatusEntry) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return
    const idx = files.findIndex(x => x.path === f.path)
    if (idx === -1) return

    if (e.shiftKey) {
      e.preventDefault() // prevent text selection
      const paths = getRangePaths(anchorIdxRef.current, idx)
      onShiftSelect(paths, f.path, isStaged)
    } else if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      anchorIdxRef.current = idx
      onCtrlSelect(f.path, isStaged)
    } else {
      anchorIdxRef.current = idx
      onSelect(f.path, isStaged)
    }
  }, [files, isStaged, onSelect, onShiftSelect, onCtrlSelect, getRangePaths])

  if (files.length === 0) return null

  return (
    <div ref={containerRef} className="gm-virtual-file-list" onKeyDown={handleKeyDown} tabIndex={0}>
          {files.map((f, fi) => {
            const isActive = selectedFile?.path === f.path && selectedFile?.staged === isStaged
            const isInSelection = selectedPaths.has(f.path) && selectedFile?.staged === isStaged
            return (
              <div
                key={f.path}
                data-file-idx={fi}
                className={`gm-file-entry${isStaged ? ' gm-file-staged' : ' gm-file-unstaged'}${f.isSubmodule ? ' gm-file-submodule' : ''}${isActive ? ' gm-file-selected' : isInSelection ? ' gm-file-selected gm-file-range-selected' : ''}`}
                style={{ height: FILE_ROW_HEIGHT }}
                onMouseDown={(e) => handleMouseDown(e, f)}
                onDoubleClick={() => onDoubleClick(f.path)}
                onContextMenu={(e) => onContextMenu(e, f, section)}
              >
                {f.isSubmodule ? (
                  <span className="gm-submodule-icon-wrap">
                    <SubmoduleIcon />
                    {((f.submoduleAhead ?? 0) > 0 || (f.submoduleBehind ?? 0) > 0) && (
                      <span className="gm-submodule-icon-badge">
                        {(f.submoduleAhead ?? 0) > 0 && <span className="gm-submodule-ahead"><SubmoduleArrowUp />{f.submoduleAhead}</span>}
                        {(f.submoduleBehind ?? 0) > 0 && <span className="gm-submodule-behind"><SubmoduleArrowDown />{f.submoduleBehind}</span>}
                      </span>
                    )}
                  </span>
                ) : (
                  <FileStatusBadge status={isStaged ? f.indexStatus : (f.workTreeStatus === '?' ? 'untracked' : f.workTreeStatus)} />
                )}
                <span className="gm-file-path-wrap">
                  <EllipsisPath className="gm-file-path" text={f.path} />
                  <button
                    className="gm-file-hover-btn"
                    onClick={() => {
                      if (!(isActive || isInSelection)) { onSelect(f.path, isStaged); return }
                      api.app.openInExplorer(projectDir + '/' + f.path)
                    }}
                    title="Open file"
                  ><OpenFileIcon /></button>
                  <button
                    className="gm-file-hover-btn"
                    onClick={() => {
                      if (!(isActive || isInSelection)) { onSelect(f.path, isStaged); return }
                      api.gitManager.showInFolder(projectDir, f.path)
                    }}
                    title="Show in folder"
                  ><ShowInFolderIcon /></button>
                  {f.isSubmodule && !((f.submoduleAhead ?? 0) > 0 || (f.submoduleBehind ?? 0) > 0) && (
                    <span className="gm-file-submodule-label">submodule</span>
                  )}
                </span>
                <button
                  className="gm-file-action"
                  onClick={() => onAction(f.path)}
                  title={actionTitle}
                  disabled={stagingPaths.has(f.path)}
                >{stagingPaths.has(f.path) ? <span className="gm-file-action-spinner" /> : actionLabel}</button>
              </div>
            )
          })}
    </div>
  )
})

const StashSection: React.FC<{
  stashes: GitStashEntry[]
  projectDir: string
  onError: (msg: string, retry?: () => Promise<void>) => void
  onRefresh: () => void
  onConfirm: (modal: { title: string; message: React.ReactNode; confirmLabel: string; danger?: boolean; onConfirm: () => void }) => void
}> = React.memo(({ stashes, projectDir, onError, onRefresh, onConfirm }) => {
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('gm-stash-section-collapsed') === 'true' } catch { return false }
  })
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; stash: GitStashEntry } | null>(null)
  const ctxRef = useRef<HTMLDivElement>(null)
  const api = getDockApi()

  useEffect(() => {
    try { localStorage.setItem('gm-stash-section-collapsed', String(collapsed)) } catch { /* ignore */ }
  }, [collapsed])

  useEffect(() => {
    if (!ctxMenu) return
    const handler = (e: MouseEvent) => {
      if (ctxRef.current && !ctxRef.current.contains(e.target as Node)) setCtxMenu(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [ctxMenu])

  const handleApply = async (stash: GitStashEntry) => {
    setCtxMenu(null)
    const r = await api.gitManager.stashApply(projectDir, stash.index)
    if (!r.success) onError(`Stash apply failed: ${r.error || 'Unknown error'}`, () => handleApply(stash))
    onRefresh()
  }

  const handlePop = async (stash: GitStashEntry) => {
    setCtxMenu(null)
    const r = await api.gitManager.stashPop(projectDir, stash.index)
    if (!r.success) onError(`Stash pop failed: ${r.error || 'Unknown error'}`, () => handlePop(stash))
    onRefresh()
  }

  const handleDrop = (stash: GitStashEntry) => {
    setCtxMenu(null)
    onConfirm({
      title: 'Drop stash',
      message: (<p>Are you sure you want to drop <strong>stash@&#123;{stash.index}&#125;</strong>?<br /><span style={{ color: 'var(--text-secondary)', fontSize: 11 }}>{stash.message}</span></p>),
      confirmLabel: 'Drop',
      danger: true,
      onConfirm: async () => {
        const r = await api.gitManager.stashDrop(projectDir, stash.index)
        if (!r.success) onError(`Stash drop failed: ${r.error || 'Unknown error'}`)
        onRefresh()
      }
    })
  }

  const handleCtx = (e: React.MouseEvent, stash: GitStashEntry) => {
    e.preventDefault()
    const zoom = parseFloat(document.documentElement.style.zoom) || 1
    setCtxMenu({ x: e.clientX / zoom, y: e.clientY / zoom, stash })
  }

  return (
    <div className="gm-changes-section gm-stash-section">
      <div className="gm-changes-section-header gm-stash-section-header" onClick={() => setCollapsed(!collapsed)} style={{ cursor: 'pointer' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <SectionChevron collapsed={collapsed} />
          Stashes ({stashes.length})
        </span>
      </div>
      {!collapsed && (
        <div className="gm-stash-list">
          {stashes.map((s) => (
            <div
              key={s.index}
              className="gm-stash-entry"
              title={`stash@{${s.index}}: ${s.message}`}
              onContextMenu={(e) => handleCtx(e, s)}
            >
              <StashSidebarIcon />
              <span className="gm-stash-entry-msg">{s.message || `stash@{${s.index}}`}</span>
              <span className="gm-stash-entry-index">@{s.index}</span>
              <button
                className="gm-file-hover-btn"
                onClick={() => handleApply(s)}
                title="Apply stash (keep in stash list)"
              ><StashApplyIcon /></button>
              <button
                className="gm-file-hover-btn gm-stash-pop-btn"
                onClick={() => handlePop(s)}
                title="Pop stash (apply & remove)"
              ><StashPopIcon /></button>
              <button
                className="gm-file-hover-btn gm-stash-drop-btn"
                onClick={() => handleDrop(s)}
                title="Drop stash"
              ><StashDropIcon /></button>
            </div>
          ))}
        </div>
      )}
      {ctxMenu && (
        <div className="gm-ctx-menu" ref={ctxRef} style={{ left: ctxMenu.x, top: ctxMenu.y }}>
          <div className="gm-ctx-item" onClick={() => handleApply(ctxMenu.stash)}>Apply stash</div>
          <div className="gm-ctx-item" onClick={() => handlePop(ctxMenu.stash)}>Pop stash</div>
          <div className="gm-ctx-separator" />
          <div className="gm-ctx-item gm-ctx-danger" onClick={() => handleDrop(ctxMenu.stash)}>Drop stash</div>
        </div>
      )}
    </div>
  )
})

const StashApplyIcon: React.FC = React.memo(() => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="8 4 16 12 8 20" />
  </svg>
))

const StashPopIcon: React.FC = React.memo(() => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="17 11 12 6 7 11" />
    <line x1="12" y1="6" x2="12" y2="18" />
  </svg>
))

const StashDropIcon: React.FC = React.memo(() => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
))

const WorkingChanges: React.FC<{
  status: GitStatusResult | null
  stashes: GitStashEntry[]
  projectDir: string
  syntaxHL: boolean
  active?: boolean
  navigateTo?: { path: string; staged: boolean; lineNumber?: number } | null
  onNavigateHandled?: () => void
  onRefresh: () => void
  onError: (msg: string, retry?: () => Promise<void>) => void
  onConfirm: (modal: { title: string; message: React.ReactNode; confirmLabel: string; danger?: boolean; onConfirm: () => void }) => void
  onCommitted?: (hash: string) => void
  onStatusRefreshed?: (status: GitStatusResult) => void
  onBusyChange?: (busy: boolean) => void
}> = React.memo(({ status: parentStatus, stashes, projectDir, syntaxHL, active, navigateTo, onNavigateHandled, onRefresh, onError, onConfirm, onCommitted, onStatusRefreshed, onBusyChange }) => {
  const [localStatus, setLocalStatus] = useState<GitStatusResult | null>(null)
  const status = localStatus || parentStatus
  const [commitMsg, setCommitMsg] = useState(() => {
    try { return localStorage.getItem(`gm-commit-msg:${projectDir}`) || '' } catch { return '' }
  })
  const [busy, setBusy] = useState(false)
  const [committing, setCommitting] = useState<'commit' | 'commit-push' | null>(null)
  const [stagingPaths, setStagingPaths] = useState<Set<string>>(new Set())
  const [generating, setGenerating] = useState(false)
  const [genError, setGenError] = useState<string | null>(null)
  const [autoGen, setAutoGen] = useState(false)
  const userEditedMsgRef = useRef(false)
  const [fileCtx, setFileCtx] = useState<{ x: number; y: number; file: GitFileStatusEntry; section: 'staged' | 'unstaged' } | null>(null)
  const [gitignoreModal, setGitignoreModal] = useState<{ pattern: string; hasTracked: boolean } | null>(null)
  const [stageLoopWarning, setStageLoopWarning] = useState<string[] | null>(null)
  const stageLoopCountRef = useRef<Map<string, number>>(new Map())
  const [selectedFile, setSelectedFile] = useState<{ path: string; staged: boolean } | null>(null)
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  const [fileDiffs, setFileDiffs] = useState<GitFileDiff[]>([])
  const [diffLoading, setDiffLoading] = useState(false)
  const fileListRef = useRef<HTMLDivElement>(null)
  const scrollListRef = useRef<HTMLDivElement>(null)
  const commitBoxRef = useRef<HTMLDivElement>(null)

  // Report busy state to parent for tab indicator
  useEffect(() => {
    onBusyChange?.(!!committing || generating)
  }, [committing, generating, onBusyChange])

  // Sync localStatus when parentStatus changes (from full refresh)
  useEffect(() => { setLocalStatus(null) }, [parentStatus])

  // Quick re-fetch just the status (not the full app data).
  // Uses full mode (-uall) so individual untracked files are always listed.
  const refreshStatus = useCallback(async () => {
    try {
      const s = await getDockApi().gitManager.getStatus(projectDir)
      setLocalStatus(s)
      if (onStatusRefreshed) onStatusRefreshed(s)
    } catch { /* ignore */ }
  }, [projectDir, onStatusRefreshed])

  // Detect files that reappear as unstaged immediately after staging (external process regeneration loop)
  const checkStageLoop = useCallback((stagedPaths: string[], newStatus: GitStatusResult) => {
    const unstagedSet = new Set(newStatus.unstaged.map((f) => f.path).concat(newStatus.untracked.map((f) => f.path)))
    const reappeared: string[] = []
    for (const p of stagedPaths) {
      if (unstagedSet.has(p)) {
        const count = (stageLoopCountRef.current.get(p) || 0) + 1
        stageLoopCountRef.current.set(p, count)
        if (count >= 2) reappeared.push(p)
      } else {
        stageLoopCountRef.current.delete(p)
      }
    }
    if (reappeared.length > 0) {
      setStageLoopWarning(reappeared)
      // Reset counts so warning doesn't re-trigger on next normal poll
      for (const p of reappeared) stageLoopCountRef.current.delete(p)
    }
  }, [])

  const handleCloseDiffViewer = useCallback(() => { setSelectedFile(null); setSelectedPaths(new Set()) }, [])

  // Poll working changes status periodically — pause when unfocused, resume on focus
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null
    let seconds = 5
    let pending = false
    const api = getDockApi()

    const poll = () => {
      if (document.hasFocus()) {
        pending = false
        refreshStatus()
      } else {
        pending = true
      }
    }

    const onFocus = () => {
      if (pending) {
        pending = false
        refreshStatus()
      }
    }

    api.plugins.getSetting(projectDir, 'git-manager', 'changesRefreshSeconds').then((val) => {
      seconds = typeof val === 'number' ? val : 5
      if (seconds <= 0) return
      timer = setInterval(poll, seconds * 1000)
    })

    window.addEventListener('focus', onFocus)
    return () => {
      if (timer) clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [projectDir, refreshStatus])

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

  // Load diffs for all selected files (multi-select aware)
  useEffect(() => {
    if (!selectedFile) { setFileDiffs([]); return }
    const staged = selectedFile.staged
    const paths = selectedPaths.size > 0 ? [...selectedPaths] : [selectedFile.path]
    let cancelled = false
    setDiffLoading(true)
    Promise.all(
      paths.map((p) =>
        getDockApi().gitManager.getDiff(projectDir, p, staged)
          .then((diffs) => diffs)
          .catch(() => [] as GitFileDiff[])
      )
    ).then((results) => {
      if (!cancelled) setFileDiffs(results.flat())
    }).finally(() => {
      if (!cancelled) setDiffLoading(false)
    })
    return () => { cancelled = true }
  }, [selectedFile, selectedPaths, projectDir])

  // Clear selection when the file disappears from the status
  useEffect(() => {
    if (!selectedFile || !status) return
    const inStaged = status.staged.some((f) => f.path === selectedFile.path)
    const inUnstaged = [...status.unstaged, ...status.untracked].some((f) => f.path === selectedFile.path)
    if (!inStaged && !inUnstaged) setSelectedFile(null)
  }, [status, selectedFile])

  // Navigate to file from search
  useEffect(() => {
    if (!navigateTo) return
    setSelectedFile({ path: navigateTo.path, staged: navigateTo.staged })
    if (navigateTo.lineNumber) {
      const targetLine = navigateTo.lineNumber
      // Wait for diff to load, then scroll to the line
      setTimeout(() => {
        const diffContainer = document.querySelector('.gm-changes-diff-content')
        if (!diffContainer) return
        const lineEls = diffContainer.querySelectorAll('.gm-diff-line')
        for (const el of lineEls) {
          const lineNos = el.querySelector('.gm-diff-line-no')
          const spans = lineNos?.querySelectorAll('span')
          if (spans && spans.length >= 2) {
            const newLineText = spans[1].textContent?.trim()
            if (newLineText === String(targetLine)) {
              el.scrollIntoView({ block: 'center', behavior: 'smooth' })
              el.classList.add('gm-search-highlight-flash')
              break
            }
          }
        }
      }, 500)
    }
    onNavigateHandled?.()
  }, [navigateTo, onNavigateHandled])

  if (!status) return <div className="gm-loading">No status data</div>

  const api = getDockApi()
  const allUnstaged = [...status.unstaged, ...status.untracked]

  const pendingActionRef = useRef<'commit' | 'commit-push' | null>(null)
  const [pendingAction, setPendingAction] = useState<'commit' | 'commit-push' | null>(null)

  const autoGenRef = useRef(0)

  const triggerAutoGenerate = async () => {
    const gen = ++autoGenRef.current
    userEditedMsgRef.current = false
    setCommitMsg('')
    setGenerating(true)
    setGenError(null)
    try {
      let result = await api.gitManager.generateCommitMsg(projectDir)
      // Retry once on failure
      if (!result.success) {
        result = await api.gitManager.generateCommitMsg(projectDir)
      }
      if (gen !== autoGenRef.current || userEditedMsgRef.current) return // superseded or user started typing
      if (result.success && result.message) {
        setCommitMsg(result.message)
        // Execute queued action if any
        const queued = pendingActionRef.current
        pendingActionRef.current = null
        setPendingAction(null)
        if (queued) {
          setBusy(true)
          const commitResult = await api.gitManager.commit(projectDir, result.message)
          if (commitResult.success) {
            setCommitMsg('')
            if (queued === 'commit-push') {
              const pushResult = await api.gitManager.push(projectDir)
              if (!pushResult.success) {
                setBusy(false)
                if (onCommitted && commitResult.hash) { onCommitted(commitResult.hash) } else { onRefresh() }
                onError(`Push failed: ${pushResult.error || 'Unknown error'}`, async () => {
                  const r = await api.gitManager.push(projectDir)
                  if (!r.success) throw new Error(r.error || 'Push still failed')
                })
                return
              }
            }
            setBusy(false)
            if (onCommitted && commitResult.hash) { onCommitted(commitResult.hash) } else { onRefresh() }
          } else {
            onError(`Commit failed: ${commitResult.error || 'Unknown error'}`, async () => {
              const r = await api.gitManager.commit(projectDir, result.message!)
              if (!r.success) throw new Error(r.error || 'Commit still failed')
              setCommitMsg('')
            })
            onRefresh()
            setBusy(false)
          }
        }
      } else {
        pendingActionRef.current = null
        setPendingAction(null)
        setGenError(result.error || 'Failed to generate')
      }
    } catch (err) {
      // Retry once on exception
      try {
        const retry = await api.gitManager.generateCommitMsg(projectDir)
        if (gen !== autoGenRef.current || userEditedMsgRef.current) return
        if (retry.success && retry.message) {
          setCommitMsg(retry.message)
          setGenerating(false)
          return
        }
        setGenError(retry.error || 'Failed to generate')
      } catch {
        setGenError(err instanceof Error ? err.message : 'Failed to generate')
      }
      pendingActionRef.current = null
      setPendingAction(null)
    } finally {
      setGenerating(false)
    }
  }

  const cancelGenerate = () => {
    ++autoGenRef.current // invalidate in-flight result
    pendingActionRef.current = null
    setPendingAction(null)
    setGenerating(false)
    // Treat cancel as user intent to type manually — prevent auto-re-triggering
    userEditedMsgRef.current = true
  }

  const [batchProgress, setBatchProgress] = useState<string | null>(null)

  // Listen for discard progress events (LFS files can take a long time)
  useEffect(() => {
    return getDockApi().gitManager.onDiscardProgress(({ completed, total, path }) => {
      if (completed < total) {
        const name = path.split('/').pop() || path
        setBatchProgress(`Discarding ${completed + 1}/${total}: ${name}`)
      } else {
        setBatchProgress(null)
      }
    })
  }, [])

  const scrollToTop = () => {
    if (scrollListRef.current) scrollListRef.current.scrollTop = 0
  }

  const handleStageAll = async () => {
    setBusy(true)
    const paths = allUnstaged.map((f) => f.path)
    setStagingPaths(new Set(paths))
    const BATCH = 50
    let failed = false
    for (let i = 0; i < paths.length; i += BATCH) {
      const chunk = paths.slice(i, i + BATCH)
      setBatchProgress(`Staging ${Math.min(i + BATCH, paths.length)}/${paths.length}...`)
      const r = await api.gitManager.stage(projectDir, chunk)
      if (!r.success) { handleSmartError(`Stage failed: ${r.error || 'Unknown error'}`); failed = true; break }
      if (paths.length > BATCH) await refreshStatus()
    }
    setBatchProgress(null)
    const newStatus = await getDockApi().gitManager.getStatus(projectDir)
    setLocalStatus(newStatus)
    if (onStatusRefreshed) onStatusRefreshed(newStatus)
    if (!failed) checkStageLoop(paths, newStatus)
    setStagingPaths(new Set())
    setBusy(false)
    scrollToTop()
    if (!failed && autoGen && !userEditedMsgRef.current) triggerAutoGenerate()
  }

  const handleUnstageAll = async () => {
    setBusy(true)
    const paths = status.staged.map((f) => f.path)
    setStagingPaths(new Set(paths))
    const BATCH = 50
    for (let i = 0; i < paths.length; i += BATCH) {
      const chunk = paths.slice(i, i + BATCH)
      setBatchProgress(`Unstaging ${Math.min(i + BATCH, paths.length)}/${paths.length}...`)
      await api.gitManager.unstage(projectDir, chunk)
      if (paths.length > BATCH) await refreshStatus()
    }
    setBatchProgress(null)
    await refreshStatus()
    setStagingPaths(new Set())
    setBusy(false)
    scrollToTop()
  }

  const handleCommit = async () => {
    if (generating) { pendingActionRef.current = 'commit'; setPendingAction('commit'); return }
    if (!commitMsg.trim()) return
    setBusy(true)
    setCommitting('commit')
    const result = await api.gitManager.commit(projectDir, commitMsg)
    setBusy(false)
    setCommitting(null)
    if (result.success) {
      setCommitMsg('')
      userEditedMsgRef.current = false
      if (onCommitted && result.hash) { onCommitted(result.hash) }
      else { onRefresh() }
    } else {
      onError(`Commit failed: ${result.error || 'Unknown error'}`, async () => {
        const r = await api.gitManager.commit(projectDir, commitMsg)
        if (!r.success) throw new Error(r.error || 'Commit still failed')
        setCommitMsg('')
      })
      onRefresh()
    }
  }

  const handleCommitPush = async () => {
    if (generating) { pendingActionRef.current = 'commit-push'; setPendingAction('commit-push'); return }
    if (!commitMsg.trim()) return
    setBusy(true)
    setCommitting('commit-push')
    const result = await api.gitManager.commit(projectDir, commitMsg)
    if (result.success) {
      setCommitMsg('')
      userEditedMsgRef.current = false
      const pushResult = await api.gitManager.push(projectDir)
      setBusy(false)
      setCommitting(null)
      if (!pushResult.success) {
        // Commit succeeded but push failed — still navigate to the commit
        if (onCommitted && result.hash) { onCommitted(result.hash) } else { onRefresh() }
        onError(`Push failed: ${pushResult.error || 'Unknown error'}`, async () => {
          const r = await api.gitManager.push(projectDir)
          if (!r.success) throw new Error(r.error || 'Push still failed')
        })
        return
      }
      if (onCommitted && result.hash) { onCommitted(result.hash) }
      else { onRefresh() }
    } else {
      setBusy(false)
      setCommitting(null)
      onError(`Commit failed: ${result.error || 'Unknown error'}`, async () => {
        const r = await api.gitManager.commit(projectDir, commitMsg)
        if (!r.success) throw new Error(r.error || 'Commit still failed')
        setCommitMsg('')
      })
      onRefresh()
    }
  }

  const handleStageFile = async (filePath: string) => {
    setStagingPaths((prev) => new Set(prev).add(filePath))
    const r = await api.gitManager.stage(projectDir, [filePath])
    if (!r.success) handleSmartError(`Stage failed: ${r.error || 'Unknown error'}`)
    const newStatus = await getDockApi().gitManager.getStatus(projectDir)
    setLocalStatus(newStatus)
    if (onStatusRefreshed) onStatusRefreshed(newStatus)
    if (r.success) checkStageLoop([filePath], newStatus)
    setStagingPaths((prev) => { const n = new Set(prev); n.delete(filePath); return n })
    if (r.success && autoGen && !userEditedMsgRef.current) triggerAutoGenerate()
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
    e.stopPropagation()
    const zoom = parseFloat(document.documentElement.style.zoom) || 1
    setFileCtx({ x: e.clientX / zoom, y: e.clientY / zoom, file, section })
  }

  const handleSelectFile = (path: string, staged: boolean) => {
    if (selectedFile?.path === path && selectedFile?.staged === staged && selectedPaths.size <= 1) {
      return
    }
    setSelectedFile({ path, staged })
    setSelectedPaths(new Set([path]))
  }

  const handleShiftSelect = (paths: string[], activePath: string, staged: boolean) => {
    setSelectedFile({ path: activePath, staged })
    setSelectedPaths(new Set(paths))
  }

  const handleCtrlSelect = (path: string, staged: boolean) => {
    // If switching sections, start fresh selection
    if (selectedFile && selectedFile.staged !== staged) {
      setSelectedFile({ path, staged })
      setSelectedPaths(new Set([path]))
      return
    }
    setSelectedPaths(prev => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
        // If we removed the active file, pick another active from the set
        if (selectedFile?.path === path) {
          const remaining = [...next]
          if (remaining.length > 0) {
            setSelectedFile({ path: remaining[remaining.length - 1], staged })
          } else {
            setSelectedFile(null)
          }
        }
      } else {
        next.add(path)
        setSelectedFile({ path, staged })
      }
      return next
    })
  }

  const handleBatchStage = async (paths: string[]) => {
    setStagingPaths(new Set(paths))
    const r = await api.gitManager.stage(projectDir, paths)
    if (!r.success) handleSmartError(`Stage failed: ${r.error || 'Unknown error'}`)
    await refreshStatus()
    setStagingPaths(new Set())
    setSelectedPaths(new Set())
    setSelectedFile(null)
    if (r.success && autoGen && !userEditedMsgRef.current) triggerAutoGenerate()
  }

  const handleBatchUnstage = async (paths: string[]) => {
    setStagingPaths(new Set(paths))
    await api.gitManager.unstage(projectDir, paths)
    await refreshStatus()
    setStagingPaths(new Set())
    setSelectedPaths(new Set())
    setSelectedFile(null)
  }

  const handleStashUnstaged = async () => {
    if (busy) return
    setBusy(true)
    try {
      const r = await api.gitManager.stashSave(projectDir, undefined, '--include-untracked --keep-index')
      if (!r.success) onError(`Stash failed: ${r.error || 'Unknown error'}`)
      refreshStatus()
      onRefresh()
    } catch {
      onError('Stash failed')
    } finally {
      setBusy(false)
    }
  }

  const handleStashStaged = async () => {
    if (busy) return
    setBusy(true)
    try {
      const r = await api.gitManager.stashSave(projectDir)
      if (!r.success) onError(`Stash failed: ${r.error || 'Unknown error'}`)
      refreshStatus()
      onRefresh()
    } catch {
      onError('Stash failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="gm-changes">
      <div className="gm-changes-panel" ref={fileListRef}>
        <div className="gm-changes-file-list" ref={scrollListRef}>
          {/* Unstaged / untracked */}
          <div className="gm-changes-section">
            <div className="gm-changes-section-header">
              <span>Unstaged ({allUnstaged.length}) <button className="gm-section-refresh" onClick={refreshStatus} title="Refresh"><RefreshIcon /></button></span>
              <div className="gm-section-actions">
                {allUnstaged.length > 0 && (
                  <>
                    <button className="gm-file-hover-btn" onClick={handleStashUnstaged} disabled={busy} title="Stash unstaged & untracked changes (keep staged)">
                      <StashIcon />
                    </button>
                    <button className="gm-file-hover-btn" onClick={() => sendWriteTestsTask(allUnstaged.map(f => f.path))} title="Write tests for unstaged files">
                      <WriteTestsIcon />
                    </button>
                    {selectedPaths.size > 1 && selectedFile?.staged === false && (
                      <button className="gm-small-btn" onClick={() => handleBatchStage([...selectedPaths])} disabled={busy}>
                        Stage Selected ({selectedPaths.size})
                      </button>
                    )}
                    <button className="gm-small-btn" onClick={handleStageAll} disabled={busy}>
                      Stage All
                    </button>
                  </>
                )}
              </div>
            </div>
            {allUnstaged.length > 0 ? (
              <VirtualFileList
                files={allUnstaged}
                section="unstaged"
                selectedFile={selectedFile}
                selectedPaths={selectedPaths}
                stagingPaths={stagingPaths}
                projectDir={projectDir}
                onSelect={handleSelectFile}
                onShiftSelect={handleShiftSelect}
                onCtrlSelect={handleCtrlSelect}
                onAction={handleStageFile}
                onBatchAction={handleBatchStage}
                onDoubleClick={handleStageFile}
                onContextMenu={handleFileContext}
                actionLabel="+"
                actionTitle="Stage"
              />
            ) : (
              <div className="gm-changes-empty">No unstaged changes</div>
            )}
          </div>

          {/* Staged files */}
          <div className="gm-changes-section">
            <div className="gm-changes-section-header">
              <span>Staged ({status.staged.length}) <button className="gm-section-refresh" onClick={refreshStatus} title="Refresh"><RefreshIcon /></button></span>
              <div className="gm-section-actions">
                {status.staged.length > 0 && (
                  <>
                    <button className="gm-file-hover-btn" onClick={handleStashStaged} disabled={busy} title="Stash all changes">
                      <StashIcon />
                    </button>
                    <button className={`gm-file-hover-btn${allUnstaged.length === 0 ? ' gm-write-tests-rainbow' : ''}`} onClick={() => sendWriteTestsTask(status.staged.map(f => f.path))} title="Write tests for staged files">
                      <span className="gm-beaker-wrap">
                        <WriteTestsIcon />
                        {allUnstaged.length === 0 && <span className="gm-beaker-particles" />}
                      </span>
                    </button>
                    {selectedPaths.size > 1 && selectedFile?.staged === true && (
                      <button className="gm-small-btn" onClick={() => handleBatchUnstage([...selectedPaths])} disabled={busy}>
                        Unstage Selected ({selectedPaths.size})
                      </button>
                    )}
                    <button className="gm-small-btn" onClick={handleUnstageAll} disabled={busy}>
                      Unstage All
                    </button>
                  </>
                )}
              </div>
            </div>
            {status.staged.length > 0 ? (
              <VirtualFileList
                files={status.staged}
                section="staged"
                selectedFile={selectedFile}
                selectedPaths={selectedPaths}
                stagingPaths={stagingPaths}
                projectDir={projectDir}
                onSelect={handleSelectFile}
                onShiftSelect={handleShiftSelect}
                onCtrlSelect={handleCtrlSelect}
                onAction={handleUnstageFile}
                onBatchAction={handleBatchUnstage}
                onDoubleClick={handleUnstageFile}
                onContextMenu={handleFileContext}
                actionLabel="-"
                actionTitle="Unstage"
              />
            ) : (
              <div className="gm-changes-empty">No staged changes</div>
            )}
          </div>

          {/* Stashes */}
          {stashes.length > 0 && (
            <StashSection
              stashes={stashes}
              projectDir={projectDir}
              onError={onError}
              onRefresh={onRefresh}
              onConfirm={onConfirm}
            />
          )}
        </div>

        {/* Commit box — sticky footer */}
        <VerticalResizeHandle targetRef={commitBoxRef} min={120} max={500} storageKey="gm-commit-box-height" />
        <div className="gm-commit-box" ref={commitBoxRef}>
          {batchProgress && (
            <div className="gm-batch-progress">{batchProgress}</div>
          )}
          <div className="gm-commit-input-wrap">
            {generating && !commitMsg && (
              <div className="gm-commit-generating-overlay">
                <span className="gm-toolbar-spinner" />
                <span>Generating commit message from your staged changes...</span>
                <span className="gm-commit-generating-tip">Pro Tip: You can commit & push now, it'll queue until generation finishes.</span>
              </div>
            )}
            <textarea
              className="gm-commit-input"
              placeholder={generating ? '' : 'Commit message...'}
              value={commitMsg}
              onChange={(e) => { setCommitMsg(e.target.value); userEditedMsgRef.current = true }}
            />
            <button
              className={`gm-generate-btn${generating ? ' gm-generate-btn-active' : ''}`}
              onClick={generating ? cancelGenerate : handleGenerateMsg}
              disabled={!generating && status.staged.length === 0}
              title={generating ? 'Cancel generation' : 'Generate commit message with AI'}
            >
              <span className="gm-generate-btn-icon">{generating ? <span className="gm-generate-spinner" /> : <SparkleIcon />}</span>
              {generating && <span className="gm-generate-btn-cancel">&#10005;</span>}
            </button>
          </div>
          {genError && (
            <div className="gm-gen-error">
              {genError}
              <button onClick={() => setGenError(null)}>&#10005;</button>
            </div>
          )}
          {status.staged.length === 0 && allUnstaged.length > 0 ? (
            <div className="gm-commit-btn-group">
              <button
                className="gm-commit-btn gm-commit-btn-stash"
                onClick={handleStageAll}
                disabled={busy}
              >
                {busy ? <><span className="gm-commit-spinner" /> Staging...</> : `Stage All (${allUnstaged.length} files)`}
              </button>
            </div>
          ) : (
            <div className="gm-commit-btn-group">
              <button
                className={`gm-commit-btn gm-commit-btn-left${pendingAction === 'commit' ? ' gm-commit-btn-queued' : ''}`}
                onClick={handleCommit}
                disabled={busy || status.staged.length === 0 || (!generating && !commitMsg.trim())}
              >
                {committing === 'commit'
                  ? <><span className="gm-commit-spinner" /> Committing...</>
                  : pendingAction === 'commit'
                    ? <><span className="gm-commit-spinner" /> Commit <span className="gm-commit-queued-hint">after generate</span></>
                    : `Commit (${status.staged.length} staged)`}
              </button>
              <button
                className={`gm-commit-btn gm-commit-btn-right${pendingAction === 'commit-push' ? ' gm-commit-btn-queued' : ''}`}
                onClick={handleCommitPush}
                disabled={busy || status.staged.length === 0 || (!generating && !commitMsg.trim())}
              >
                {committing === 'commit-push'
                  ? <><span className="gm-commit-spinner" /> Committing & Pushing...</>
                  : pendingAction === 'commit-push'
                    ? <><span className="gm-commit-spinner" /> Commit & Push <span className="gm-commit-queued-hint">after generate</span></>
                    : 'Commit & Push'}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Diff viewer panel */}
      {selectedFile && (
        <>
          <ResizeHandle side="left" targetRef={fileListRef} min={200} max={1400} storageKey="gm-wc-filelist-width" />
          <WorkingDiffViewer
            diffs={fileDiffs}
            loading={diffLoading}
            filePath={selectedFile.path}
            staged={selectedFile.staged}
            projectDir={projectDir}
            syntaxHL={syntaxHL}
            multiFile={selectedPaths.size > 1}
            onClose={handleCloseDiffViewer}
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
          selectedPaths={selectedPaths}
          status={status}
          onClose={() => setFileCtx(null)}
          onRefresh={onRefresh}
          onError={onError}
          onConfirm={onConfirm}
          onGitignore={(pattern, hasTracked) => setGitignoreModal({ pattern, hasTracked })}
        />
      )}
      {gitignoreModal && (
        <GitignoreModal
          projectDir={projectDir}
          initialPattern={gitignoreModal.pattern}
          hasTrackedFiles={gitignoreModal.hasTracked}
          onClose={() => setGitignoreModal(null)}
          onDone={onRefresh}
          onError={onError}
        />
      )}
      {stageLoopWarning && (
        <div className="gm-stage-loop-warning">
          <div className="gm-stage-loop-header">
            <span className="gm-stage-loop-icon">&#9888;</span>
            <strong>External process modifying tracked files</strong>
            <button className="gm-stage-loop-close" onClick={() => setStageLoopWarning(null)}>&times;</button>
          </div>
          <div className="gm-stage-loop-body">
            The following file{stageLoopWarning.length > 1 ? 's keep' : ' keeps'} reappearing as unstaged immediately after staging.
            An external process (build tool, file watcher, compiler) is likely regenerating {stageLoopWarning.length > 1 ? 'them' : 'it'}.
          </div>
          <div className="gm-stage-loop-files">
            {stageLoopWarning.map((f) => <div key={f} className="gm-stage-loop-file">{f}</div>)}
          </div>
          <div className="gm-stage-loop-actions">
            <button
              className="gm-stage-loop-btn"
              onClick={() => {
                const patterns = stageLoopWarning.map((f) => {
                  // Suggest glob pattern for known generated files, otherwise the exact path
                  const ext = f.match(/\.[^./\\]+$/)?.[0]
                  if (ext && /^\.(tsbuildinfo|pyc|pyo|class|o|obj|dll|exe|so|dylib)$/i.test(ext)) {
                    return `*${ext}`
                  }
                  return f
                })
                const unique = [...new Set(patterns)]
                setGitignoreModal({ pattern: unique.join('\n'), hasTracked: true })
                setStageLoopWarning(null)
              }}
            >
              Add to .gitignore
            </button>
            <button className="gm-stage-loop-btn gm-stage-loop-btn-secondary" onClick={() => setStageLoopWarning(null)}>
              Dismiss
            </button>
          </div>
        </div>
      )}
    </div>
  )
})

// --- File context menu ---

const FileContextMenu: React.FC<{
  x: number; y: number
  file: GitFileStatusEntry
  section: 'staged' | 'unstaged'
  projectDir: string
  selectedPaths: Set<string>
  status: GitStatusResult
  onClose: () => void
  onRefresh: () => void
  onError: (msg: string) => void
  onConfirm: (modal: { title: string; message: React.ReactNode; confirmLabel: string; danger?: boolean; onConfirm: () => void }) => void
  onGitignore: (pattern: string, hasTracked: boolean) => void
}> = ({ x, y, file, section, projectDir, selectedPaths, status, onClose, onRefresh, onError, onConfirm, onGitignore }) => {
  const ref = useRef<HTMLDivElement>(null)
  const [copySubmenu, setCopySubmenu] = useState(false)
  const [claudeSubmenu, setClaudeSubmenu] = useState(false)

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
  const isMulti = selectedPaths.size > 1 && selectedPaths.has(file.path)
  const targetPaths = isMulti ? [...selectedPaths] : [file.path]
  const count = targetPaths.length
  const suffix = count > 1 ? ` (${count} files)` : ''
  const isUntracked = file.workTreeStatus === '?' || file.workTreeStatus === 'untracked'
  const fileName = file.path.split('/').pop() || file.path

  // Build lookup for file statuses to handle mixed selections correctly
  const allUnstaged = [...status.unstaged, ...status.untracked]
  const sectionFiles = section === 'staged' ? status.staged : allUnstaged
  const fileMap = new Map(sectionFiles.map(f => [f.path, f]))

  // Classify target paths by type
  const untrackedPaths = targetPaths.filter(p => {
    const f = fileMap.get(p)
    return f && (f.workTreeStatus === '?' || f.workTreeStatus === 'untracked')
  })
  const trackedPaths = targetPaths.filter(p => !untrackedPaths.includes(p))
  const addedStagedPaths = targetPaths.filter(p => {
    const f = fileMap.get(p)
    return f && f.indexStatus === 'added'
  })
  const nonAddedStagedPaths = targetPaths.filter(p => !addedStagedPaths.includes(p))
  const allUntracked = untrackedPaths.length === targetPaths.length
  const hasUntracked = untrackedPaths.length > 0

  const doStage = async () => { onClose(); const r = await api.gitManager.stage(projectDir, targetPaths); if (!r.success) onError(`Stage failed: ${r.error || 'Unknown error'}`); onRefresh() }
  const doUnstage = async () => { onClose(); const r = await api.gitManager.unstage(projectDir, targetPaths); if (!r.success) onError(`Unstage failed: ${r.error || 'Unknown error'}`); onRefresh() }

  const doDiscard = () => {
    onClose()
    if (hasUntracked) {
      // Show confirmation for files that will be permanently deleted
      onConfirm({
        title: 'Delete untracked files',
        message: (<>
          {trackedPaths.length > 0 && <p>{trackedPaths.length} modified file{trackedPaths.length > 1 ? 's' : ''} will have changes discarded.</p>}
          <p>{untrackedPaths.length} untracked file{untrackedPaths.length > 1 ? 's' : ''} will be <strong>permanently deleted</strong>:</p>
          <ul style={{ margin: '4px 0', paddingLeft: 20, maxHeight: 200, overflow: 'auto' }}>
            {untrackedPaths.map(p => <li key={p} style={{ fontSize: 11 }}>{p}</li>)}
          </ul>
        </>),
        confirmLabel: 'Delete',
        danger: true,
        onConfirm: async () => {
          if (trackedPaths.length > 0) {
            const r = await api.gitManager.discard(projectDir, trackedPaths)
            if (!r.success) { onError(`Discard failed: ${r.error || 'Unknown error'}`); return }
          }
          const r = await api.gitManager.deleteFiles(projectDir, untrackedPaths)
          if (!r.success) onError(`Delete failed: ${r.error || 'Unknown error'}`)
          onRefresh()
        }
      })
    } else {
      // All tracked — discard normally
      api.gitManager.discard(projectDir, trackedPaths).then(r => {
        if (!r.success) onError(`Discard failed: ${r.error || 'Unknown error'}`)
        onRefresh()
      })
    }
  }

  const doDelete = () => {
    onClose()
    onConfirm({
      title: `Delete file${count > 1 ? 's' : ''}`,
      message: (<>
        <p>{count} file{count > 1 ? 's' : ''} will be <strong>permanently deleted</strong>:</p>
        <ul style={{ margin: '4px 0', paddingLeft: 20, maxHeight: 200, overflow: 'auto' }}>
          {targetPaths.map(p => <li key={p} style={{ fontSize: 11 }}>{p}</li>)}
        </ul>
      </>),
      confirmLabel: 'Delete',
      danger: true,
      onConfirm: async () => {
        const r = await api.gitManager.deleteFiles(projectDir, targetPaths)
        if (!r.success) onError(`Delete failed: ${r.error || 'Unknown error'}`)
        onRefresh()
      }
    })
  }

  const doShowInFolder = () => { onClose(); targetPaths.forEach(p => api.gitManager.showInFolder(projectDir, p)) }
  const doOpenFile = () => { onClose(); targetPaths.forEach(p => api.app.openInExplorer(projectDir + '/' + p)) }
  const doCopyPath = (text: string) => { navigator.clipboard.writeText(text); onClose() }

  return (
    <div className="gm-ctx-menu" ref={ref} style={{ left: x, top: y }}>
      {section === 'unstaged' ? (
        <div className="gm-ctx-item" onClick={doStage}><span>Stage{suffix}</span><span className="gm-ctx-shortcut">S</span></div>
      ) : (
        <div className="gm-ctx-item" onClick={doUnstage}><span>Unstage{suffix}</span><span className="gm-ctx-shortcut">U</span></div>
      )}
      {file.isSubmodule && count === 1 && (
        <div className="gm-ctx-item" onClick={async () => {
          onClose()
          const r = await api.gitManager.registerSubmodule(projectDir, file.path)
          if (!r.success) onError(`Add as submodule failed: ${r.error || 'Unknown error'}`)
          onRefresh()
        }}>Add as submodule</div>
      )}
      {section === 'unstaged' && (
        <div className="gm-ctx-item gm-ctx-danger" onClick={doDiscard}>
          {allUntracked ? `Delete file${count > 1 ? 's' : ''}` : `Discard changes${suffix}`}
        </div>
      )}
      {section === 'staged' && (
        <div className="gm-ctx-item gm-ctx-danger" onClick={() => {
          onClose()
          if (addedStagedPaths.length > 0) {
            // Some files are newly added — after unstaging they become untracked and must be deleted
            onConfirm({
              title: 'Unstage and discard changes',
              message: (<>
                {nonAddedStagedPaths.length > 0 && <p>{nonAddedStagedPaths.length} modified file{nonAddedStagedPaths.length > 1 ? 's' : ''} will be unstaged and have changes discarded.</p>}
                <p>{addedStagedPaths.length} newly added file{addedStagedPaths.length > 1 ? 's' : ''} will be unstaged and <strong>permanently deleted</strong>:</p>
                <ul style={{ margin: '4px 0', paddingLeft: 20, maxHeight: 200, overflow: 'auto' }}>
                  {addedStagedPaths.map(p => <li key={p} style={{ fontSize: 11 }}>{p}</li>)}
                </ul>
              </>),
              confirmLabel: 'Delete',
              danger: true,
              onConfirm: async () => {
                const ur = await api.gitManager.unstage(projectDir, targetPaths)
                if (!ur.success) { onError(`Unstage failed: ${ur.error || 'Unknown error'}`); onRefresh(); return }
                if (nonAddedStagedPaths.length > 0) {
                  const dr = await api.gitManager.discard(projectDir, nonAddedStagedPaths)
                  if (!dr.success) { onError(`Discard failed: ${dr.error || 'Unknown error'}`); onRefresh(); return }
                }
                const del = await api.gitManager.deleteFiles(projectDir, addedStagedPaths)
                if (!del.success) onError(`Delete failed: ${del.error || 'Unknown error'}`)
                onRefresh()
              }
            })
          } else {
            // All files are modifications/deletions to tracked files — safe to unstage + discard
            api.gitManager.unstage(projectDir, targetPaths).then(async ur => {
              if (!ur.success) { onError(`Unstage failed: ${ur.error || 'Unknown error'}`); onRefresh(); return }
              const dr = await api.gitManager.discard(projectDir, targetPaths)
              if (!dr.success) onError(`Discard failed: ${dr.error || 'Unknown error'}`)
              onRefresh()
            })
          }
        }}>Unstage and discard changes{suffix}</div>
      )}
      <div className="gm-ctx-separator" />
      <div className="gm-ctx-item" onClick={() => {
        onClose()
        // Smart default: single file → its path, multiple files with shared extension → *.ext, else first file path
        let defaultPattern: string
        if (count === 1) {
          defaultPattern = file.path
        } else {
          const exts = new Set(targetPaths.map(p => { const i = p.lastIndexOf('.'); return i > -1 ? p.slice(i) : '' }).filter(Boolean))
          defaultPattern = exts.size === 1 ? `*${[...exts][0]}` : file.path
        }
        const hasTracked = !isUntracked
        onGitignore(defaultPattern, hasTracked)
      }}>Add to .gitignore</div>
      <div className="gm-ctx-separator" />
      <div className="gm-ctx-item" onClick={doOpenFile}>Open file{count > 1 ? 's' : ''}{suffix}</div>
      <div className="gm-ctx-item" onClick={doShowInFolder}>Show in folder{count > 1 ? 's' : ''}{suffix}</div>
      <div className="gm-ctx-separator" />
      <div
        className="gm-ctx-item gm-ctx-submenu-trigger"
        onMouseEnter={() => setClaudeSubmenu(true)}
        onMouseLeave={() => setClaudeSubmenu(false)}
      >
        <span className="gm-ctx-item-label"><svg className="gm-ctx-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5L12 3z" /><path d="M19 15l.5 2 2 .5-2 .5-.5 2-.5-2-2-.5 2-.5.5-2z" /></svg>Claude Actions</span>
        <span className="gm-ctx-arrow">&#9656;</span>
        {claudeSubmenu && (
          <div className="gm-ctx-submenu" ref={adjustSubmenuRef}>
            <div className="gm-ctx-item" onClick={() => { onClose(); sendWriteTestsTask(targetPaths) }}><span className="gm-ctx-item-label"><svg className="gm-ctx-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 2v6.5L20 22H4L9.5 8.5V2" /><line x1="8" y1="2" x2="16" y2="2" /><line x1="6" y1="18" x2="18" y2="18" /></svg>Write Tests{suffix}</span></div>
            <div className="gm-ctx-item" onClick={() => { onClose(); sendReferenceThisTask(targetPaths) }}><span className="gm-ctx-item-label"><svg className="gm-ctx-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2z" /><path d="M22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z" /></svg>Reference This{suffix}</span></div>
          </div>
        )}
      </div>
      <div className="gm-ctx-separator" />
      <div
        className="gm-ctx-item gm-ctx-submenu-trigger"
        onMouseEnter={() => setCopySubmenu(true)}
        onMouseLeave={() => setCopySubmenu(false)}
      >
        <span>Copy path{count > 1 ? 's' : ''}</span>
        <span className="gm-ctx-arrow">&#9656;</span>
        {copySubmenu && (
          <div className="gm-ctx-submenu" ref={adjustSubmenuRef}>
            <div className="gm-ctx-item" onClick={() => doCopyPath(targetPaths.join('\n'))}>
              Relative{count > 1 ? ` (${count})` : `: ${file.path}`}
            </div>
            <div className="gm-ctx-item" onClick={() => doCopyPath(targetPaths.map(p => projectDir + '/' + p).join('\n'))}>
              Full path{count > 1 ? ` (${count})` : ''}
            </div>
            {count === 1 && (
              <div className="gm-ctx-item" onClick={() => doCopyPath(fileName)}>
                Filename: {fileName}
              </div>
            )}
          </div>
        )}
      </div>
      {section === 'unstaged' && isUntracked && !allUntracked && (
        <>
          <div className="gm-ctx-separator" />
          <div className="gm-ctx-item gm-ctx-danger" onClick={doDelete}>Delete file{count > 1 ? 's' : ''}{suffix}</div>
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
      parts.push(`@@ -${hunk.oldStart},${oldCount} +${hunk.newStart},${newCount} @@`)
      parts.push(...hunkLines)
      hasAnyChanges = true
    }
  }

  if (!hasAnyChanges) return null
  return parts.join('\n') + '\n'
}

const DiffStats = React.memo(function DiffStats({ diffs }: { diffs: GitFileDiff[] }) {
  const { add, del } = useMemo(() => {
    let add = 0, del = 0
    for (const f of diffs) {
      for (const h of f.hunks) {
        for (const l of h.lines) {
          if (l.type === 'add') add++
          else if (l.type === 'delete') del++
        }
      }
    }
    return { add, del }
  }, [diffs])

  if (add === 0 && del === 0) return null

  return (
    <span className="gm-diff-stats">
      {add > 0 && <span className="gm-diff-stat-add">+{add}</span>}
      {del > 0 && <span className="gm-diff-stat-del">-{del}</span>}
    </span>
  )
})

const WorkingDiffViewer: React.FC<{
  diffs: GitFileDiff[]
  loading: boolean
  filePath: string
  staged: boolean
  projectDir: string
  syntaxHL: boolean
  multiFile?: boolean
  onClose: () => void
  onRefresh: () => void
}> = React.memo(({ diffs, loading, filePath, staged, projectDir, syntaxHL, multiFile, onClose, onRefresh }) => {
  const [selectedLines, setSelectedLines] = useState<Set<string>>(new Set())
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null)
  const [dragStart, setDragStart] = useState<string | null>(null)
  const lastClickedRef = useRef<string | null>(null)
  const isDragging = useRef(false)
  const contentRef = useRef<HTMLDivElement>(null)

  // Syntax-highlighted HTML per file/hunk/line
  const highlightedDiffs = useMemo(() => {
    if (!syntaxHL || diffs.length === 0) return null
    return diffs.map(f => highlightDiffHunks(f.path, f.hunks))
  }, [diffs, syntaxHL])

  // Clear selection when file changes
  useEffect(() => { setSelectedLines(new Set()); setCtxMenu(null) }, [filePath, staged])

  // Build flat key list for range selection (fi:hi:li for multi-file, hi:li for single)
  const allLineKeys = useMemo(() => {
    const keys: string[] = []
    if (diffs.length === 0) return keys
    for (let fi = 0; fi < diffs.length; fi++) {
      for (let hi = 0; hi < diffs[fi].hunks.length; hi++) {
        for (let li = 0; li < diffs[fi].hunks[hi].lines.length; li++) {
          keys.push(`${fi}:${hi}:${li}`)
        }
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
      document.documentElement.classList.remove('gm-line-dragging')
    }
    document.documentElement.classList.add('gm-line-dragging')
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.documentElement.classList.remove('gm-line-dragging')
    }
  }, [dragStart, getLineRange])

  // Track text selection via direct DOM manipulation (no React re-renders)
  // Also clear all selections when clicking outside diff lines
  useEffect(() => {
    const clearTextHighlights = () => {
      document.querySelectorAll('.gm-diff-line-text-selected').forEach(el => el.classList.remove('gm-diff-line-text-selected'))
    }
    const onSelectionChange = () => {
      const sel = document.getSelection()
      if (!sel || sel.isCollapsed || !sel.rangeCount) { clearTextHighlights(); return }
      const range = sel.getRangeAt(0)
      const container = range.commonAncestorContainer instanceof Element
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement
      if (!container?.closest('.gm-diff-hunk')) { clearTextHighlights(); return }
      clearTextHighlights()
      document.querySelectorAll('[data-linekey]').forEach(el => {
        if (sel.containsNode(el, true)) el.classList.add('gm-diff-line-text-selected')
      })
    }
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target instanceof Element ? e.target : (e.target as Node)?.parentElement
      if (!target?.closest?.('[data-linekey]') && !target?.closest?.('.gm-ctx-menu')) {
        clearTextHighlights()
        setSelectedLines(new Set())
      }
    }
    document.addEventListener('selectionchange', onSelectionChange)
    document.addEventListener('mousedown', onMouseDown)
    return () => {
      document.removeEventListener('selectionchange', onSelectionChange)
      document.removeEventListener('mousedown', onMouseDown)
      clearTextHighlights()
    }
  }, [])

  const handleLineMouseDown = useCallback((key: string, e: React.MouseEvent) => {
    if (e.button !== 0) return
    const target = e.target instanceof Element ? e.target : (e.target as Node)?.parentElement
    if (!target?.closest) return
    const isGutter = target.closest('.gm-diff-line-no') || target.closest('.gm-diff-line-prefix')
    if (!isGutter) return // content clicks use native text selection only
    e.preventDefault()
    document.querySelectorAll('.gm-diff-line-text-selected').forEach(el => el.classList.remove('gm-diff-line-text-selected'))
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
    // Sync text-selection highlights into selectedLines for context menu actions
    const textSelected = document.querySelectorAll('.gm-diff-line-text-selected[data-linekey]')
    if (textSelected.length > 0) {
      const keys = new Set<string>()
      textSelected.forEach(el => { const k = el.getAttribute('data-linekey'); if (k) keys.add(k) })
      setSelectedLines(keys)
    } else {
      const key = getKeyFromEvent(e)
      if (key && !selectedLines.has(key)) {
        setSelectedLines(new Set([key]))
        lastClickedRef.current = key
      }
    }
    const zoom = parseFloat(document.documentElement.style.zoom) || 1
    setCtxMenu({ x: e.clientX / zoom, y: e.clientY / zoom })
  }, [selectedLines, getKeyFromEvent])

  // Count selected add/delete lines
  const selectedChanges = useMemo(() => {
    if (diffs.length === 0) return 0
    let count = 0
    for (const key of selectedLines) {
      const [fi, hi, li] = key.split(':').map(Number)
      const line = diffs[fi]?.hunks[hi]?.lines[li]
      if (line && line.type !== 'context') count++
    }
    return count
  }, [selectedLines, diffs])

  const api = getDockApi()

  // Group selected lines by file index for per-file patch operations
  const groupLinesByFile = useCallback((): Map<number, Set<string>> => {
    const byFile = new Map<number, Set<string>>()
    for (const key of selectedLines) {
      const [fi, hi, li] = key.split(':').map(Number)
      if (!byFile.has(fi)) byFile.set(fi, new Set())
      byFile.get(fi)!.add(`${hi}:${li}`)
    }
    return byFile
  }, [selectedLines])

  const handleStageLines = async () => {
    if (selectedChanges === 0) return
    setCtxMenu(null)
    const byFile = groupLinesByFile()
    for (const [fi, lineKeys] of byFile) {
      const diff = diffs[fi]
      if (!diff) continue
      const patch = buildPartialPatch(diff, lineKeys)
      if (!patch) continue
      const result = await api.gitManager.applyPatch(projectDir, patch, true, false)
      if (!result.success) { console.error('Stage lines failed:', result.error) }
    }
    setSelectedLines(new Set())
    onRefresh()
  }

  const handleUnstageLines = async () => {
    if (selectedChanges === 0) return
    setCtxMenu(null)
    const byFile = groupLinesByFile()
    for (const [fi, lineKeys] of byFile) {
      const diff = diffs[fi]
      if (!diff) continue
      const patch = buildPartialPatch(diff, lineKeys)
      if (!patch) continue
      const result = await api.gitManager.applyPatch(projectDir, patch, true, true)
      if (!result.success) { console.error('Unstage lines failed:', result.error) }
    }
    setSelectedLines(new Set())
    onRefresh()
  }

  const handleDiscardLines = async () => {
    if (selectedChanges === 0) return
    setCtxMenu(null)
    const byFile = groupLinesByFile()
    for (const [fi, lineKeys] of byFile) {
      const diff = diffs[fi]
      if (!diff) continue
      const patch = buildPartialPatch(diff, lineKeys)
      if (!patch) continue
      const result = await api.gitManager.applyPatch(projectDir, patch, false, true)
      if (!result.success) { console.error('Discard lines failed:', result.error) }
    }
    setSelectedLines(new Set())
    onRefresh()
  }

  // Keyboard shortcuts: S=stage, U=unstage, R=discard
  const stageRef = useRef(handleStageLines)
  const unstageRef = useRef(handleUnstageLines)
  const discardRef = useRef(handleDiscardLines)
  stageRef.current = handleStageLines
  unstageRef.current = handleUnstageLines
  discardRef.current = handleDiscardLines

  useEffect(() => {
    const el = contentRef.current
    if (!el) return
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      switch (e.key.toLowerCase()) {
        case 's': stageRef.current(); break
        case 'u': unstageRef.current(); break
        case 'r': discardRef.current(); break
        default: return
      }
      e.preventDefault()
    }
    el.addEventListener('keydown', handler)
    return () => el.removeEventListener('keydown', handler)
  }, [diffs])

  const getSelectedText = useCallback((mode: 'content' | 'patch' | 'new' | 'old') => {
    if (diffs.length === 0) return ''
    const lines: string[] = []
    const sortedKeys = [...selectedLines].sort((a, b) => {
      const [af, ah, al] = a.split(':').map(Number)
      const [bf, bh, bl] = b.split(':').map(Number)
      return af !== bf ? af - bf : ah !== bh ? ah - bh : al - bl
    })
    for (const key of sortedKeys) {
      const [fi, hi, li] = key.split(':').map(Number)
      const line = diffs[fi]?.hunks[hi]?.lines[li]
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
  }, [diffs, selectedLines])

  const doCopy = (mode: 'content' | 'patch' | 'new' | 'old') => {
    navigator.clipboard.writeText(getSelectedText(mode))
    setCtxMenu(null)
  }

  return (
    <div className="gm-changes-diff">
      <div className="gm-changes-diff-header">
        <span className="gm-changes-diff-title">
          <span className="gm-changes-diff-title-text">{staged ? 'Staged' : 'Unstaged'}: {multiFile ? `${diffs.length} file${diffs.length !== 1 ? 's' : ''}` : filePath}</span>
        </span>
        {!multiFile && (
          <>
            <button
              className="gm-file-hover-btn"
              onClick={() => api.app.openInExplorer(projectDir + '/' + filePath)}
              title="Open file"
            ><OpenFileIcon /></button>
            <button
              className="gm-file-hover-btn"
              onClick={() => api.gitManager.showInFolder(projectDir, filePath)}
              title="Show in folder"
            ><ShowInFolderIcon /></button>
            <ClaudeActionWheel files={[filePath]} direction="left" />
          </>
        )}
        {!loading && diffs.length > 0 && <DiffStats diffs={diffs} />}
        <button className="gm-detail-close" onClick={onClose}>&#10005;</button>
      </div>
      <div className="gm-changes-diff-content" ref={contentRef} tabIndex={0}>
        {loading ? (
          <div className="gm-loading">Loading diff...</div>
        ) : diffs.length === 0 ? (
          <div className="gm-diff-empty">No diff available</div>
        ) : (
          diffs.map((f, fi) => (
            <div key={f.path} className="gm-diff-file" style={{ '--line-no-ch': lineNoDigits(f.hunks) } as React.CSSProperties}>
              {multiFile && (
                <div className="gm-diff-file-header">
                  <EllipsisPath className="gm-diff-file-path" text={f.path} />
                  <button
                    className="gm-file-hover-btn"
                    onClick={() => api.app.openInExplorer(projectDir + '/' + f.path)}
                    title="Open file"
                  ><OpenFileIcon /></button>
                  <button
                    className="gm-file-hover-btn"
                    onClick={() => api.gitManager.showInFolder(projectDir, f.path)}
                    title="Show in folder"
                  ><ShowInFolderIcon /></button>
                  <ClaudeActionWheel files={[f.path]} direction="left" />
                  <DiffStats diffs={[f]} />
                </div>
              )}
              {f.isBinary ? (
                <BinaryFileViewer file={f} projectDir={projectDir} staged={staged} />
              ) : (
                <LargeDiffGate lineCount={f.hunks.reduce((n, h) => n + h.lines.length, 0)}>
                  {f.hunks.map((h, hi) => (
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
                            onContextMenu={handleContextMenu}
                          >
                            <span className="gm-diff-line-no">
                              <span>{l.oldLineNo ?? ' '}</span>
                              <span>{l.newLineNo ?? ' '}</span>
                            </span>
                            <span className="gm-diff-line-prefix">
                              {l.type === 'add' ? '+' : l.type === 'delete' ? '-' : ' '}
                            </span>
                            {highlightedDiffs?.[fi]?.[hi]?.[li]
                              ? <span className="gm-diff-line-content gm-highlighted"
                                  dangerouslySetInnerHTML={{ __html: highlightedDiffs[fi][hi][li] }} />
                              : <span className="gm-diff-line-content">{l.content}</span>}
                          </div>
                        )
                      })}
                    </div>
                  ))}
                </LargeDiffGate>
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
          selectedPatch={getSelectedText('patch')}
          selectedFiles={[...new Set([...selectedLines].map(k => diffs[Number(k.split(':')[0])]?.path).filter(Boolean))]}
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
})

const DiffLineContextMenu: React.FC<{
  x: number; y: number
  staged: boolean
  hasChanges: boolean
  selectedCount: number
  selectedPatch: string
  selectedFiles: string[]
  onStage: () => void
  onUnstage: () => void
  onDiscard: () => void
  onCopy: () => void
  onCopyPatch: () => void
  onCopyNew: () => void
  onCopyOld: () => void
  onClose: () => void
}> = ({ x, y, staged, hasChanges, selectedCount, selectedPatch, selectedFiles, onStage, onUnstage, onDiscard, onCopy, onCopyPatch, onCopyNew, onCopyOld, onClose }) => {
  const ref = useRef<HTMLDivElement>(null)
  const [claudeSubmenu, setClaudeSubmenu] = useState(false)

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
      <div className="gm-ctx-separator" />
      <div
        className="gm-ctx-item gm-ctx-submenu-trigger"
        onMouseEnter={() => setClaudeSubmenu(true)}
        onMouseLeave={() => setClaudeSubmenu(false)}
      >
        <span className="gm-ctx-item-label"><svg className="gm-ctx-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5L12 3z" /><path d="M19 15l.5 2 2 .5-2 .5-.5 2-.5-2-2-.5 2-.5.5-2z" /></svg>Claude Actions</span>
        <span className="gm-ctx-arrow">&#9656;</span>
        {claudeSubmenu && (
          <div className="gm-ctx-submenu" ref={adjustSubmenuRef}>
            <div className="gm-ctx-item" onClick={() => { onClose(); sendWriteTestsTask(selectedFiles, undefined, undefined, selectedPatch) }}><span className="gm-ctx-item-label"><svg className="gm-ctx-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 2v6.5L20 22H4L9.5 8.5V2" /><line x1="8" y1="2" x2="16" y2="2" /><line x1="6" y1="18" x2="18" y2="18" /></svg>Write Tests</span></div>
            <div className="gm-ctx-item" onClick={() => { onClose(); sendReferenceThisTask(selectedFiles, undefined, undefined, selectedPatch) }}><span className="gm-ctx-item-label"><svg className="gm-ctx-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2z" /><path d="M22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z" /></svg>Reference This</span></div>
          </div>
        )}
      </div>
    </div>
  )
}

// --- Large diff gate ---

const DIFF_LINE_LIMIT = 5000

const LargeDiffGate: React.FC<{ lineCount: number; children: React.ReactNode }> = React.memo(({ lineCount, children }) => {
  const [expanded, setExpanded] = useState(false)
  if (lineCount <= DIFF_LINE_LIMIT || expanded) return <>{children}</>
  return (
    <div className="gm-diff-large-gate">
      <div className="gm-diff-large-gate-text">File changes are very large ({lineCount.toLocaleString()} lines)</div>
      <button className="gm-modal-btn gm-modal-btn-primary" onClick={() => setExpanded(true)}>Load diff</button>
    </div>
  )
})

/** Shows ellipsed text with a hover tooltip that reveals the full text after a delay */
const EllipsisPath: React.FC<{ text: string; className?: string }> = React.memo(({ text, className }) => {
  const spanRef = useRef<HTMLSpanElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const onEnter = useCallback(() => {
    const el = spanRef.current
    if (!el || el.scrollWidth <= el.clientWidth) return
    timerRef.current = setTimeout(() => {
      const rect = el.getBoundingClientRect()
      const zoom = parseFloat(document.documentElement.style.zoom) || 1
      setPos({ x: rect.left / zoom, y: rect.top / zoom })
    }, 400)
  }, [])

  const onLeave = useCallback(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
    setPos(null)
  }, [])

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])

  return (
    <span
      ref={spanRef}
      className={className}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      {text}
      {pos && <span className="gm-ellipsis-tooltip" style={{ position: 'fixed', left: pos.x, top: pos.y }}>{text}</span>}
    </span>
  )
})

const FileStatusBadge: React.FC<{ status: string }> = React.memo(({ status }) => {
  const colors: Record<string, string> = {
    modified: '#e0af68',
    added: '#9ece6a',
    deleted: '#f7768e',
    renamed: '#7aa2f7',
    copied: '#7dcfff',
    untracked: '#9ece6a',
    unmerged: '#f7768e'
  }
  const labels: Record<string, string> = {
    untracked: 'N'
  }
  const label = labels[status] || status.charAt(0).toUpperCase()
  return (
    <span className="gm-status-badge" style={{ color: colors[status] || 'var(--text-secondary)' }}>
      {label}
    </span>
  )
})

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

const AuthorAvatar: React.FC<{ name: string; large?: boolean }> = React.memo(({ name, large }) => (
  <span
    className={`gm-avatar${large ? ' gm-avatar-lg' : ''}`}
    style={{ backgroundColor: getAuthorColor(name) }}
    title={name}
  >
    {getAuthorInitials(name)}
  </span>
))

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

const VerticalResizeHandle: React.FC<{
  targetRef: React.RefObject<HTMLDivElement | null>
  min?: number
  max?: number
  storageKey?: string
}> = ({ targetRef, min = 120, max = 500, storageKey }) => {
  useEffect(() => {
    if (!storageKey || !targetRef.current) return
    const saved = localStorage.getItem(storageKey)
    if (saved) {
      const h = parseInt(saved, 10)
      if (h >= min && h <= max) targetRef.current.style.height = `${h}px`
    }
  }, [storageKey, targetRef, min, max])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const el = targetRef.current
    if (!el) return
    const zoom = parseFloat(document.documentElement.style.zoom) || 1
    const startY = e.clientY
    const startH = el.getBoundingClientRect().height / zoom

    const onMove = (ev: MouseEvent) => {
      const delta = (startY - ev.clientY) / zoom
      const newH = Math.min(max, Math.max(min, startH + delta))
      el.style.height = `${newH}px`
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      if (storageKey && el) {
        const z = parseFloat(document.documentElement.style.zoom) || 1
        localStorage.setItem(storageKey, String(Math.round(el.getBoundingClientRect().height / z)))
      }
    }
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [targetRef, min, max, storageKey])

  return <div className="gm-resize-handle-vertical" onMouseDown={handleMouseDown} />
}

// --- Virtual sidebar list (for large tag/stash lists) ---

const SIDEBAR_ROW_HEIGHT = 28

const VirtualSidebarList: React.FC<{
  itemCount: number
  rowHeight?: number
  maxHeight?: number
  children: (startIdx: number, endIdx: number) => React.ReactNode
}> = React.memo(({ itemCount, rowHeight = SIDEBAR_ROW_HEIGHT, maxHeight = 350, children }) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [containerHeight, setContainerHeight] = useState(0)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      setContainerHeight(entries[0]?.contentRect.height ?? 0)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const totalHeight = itemCount * rowHeight
  if (totalHeight <= maxHeight) {
    return <>{children(0, itemCount)}</>
  }

  const overscan = 3
  const clampedScrollTop = Math.min(scrollTop, Math.max(0, totalHeight - containerHeight))
  const startIdx = containerHeight > 0
    ? Math.max(0, Math.floor(clampedScrollTop / rowHeight) - overscan)
    : 0
  const endIdx = containerHeight > 0
    ? Math.min(itemCount, Math.ceil((clampedScrollTop + containerHeight) / rowHeight) + overscan)
    : itemCount
  const offsetY = startIdx * rowHeight

  return (
    <div
      ref={containerRef}
      style={{ maxHeight, overflow: 'auto' }}
      onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
    >
      <div style={{ height: totalHeight, position: 'relative' }}>
        <div style={{ position: 'absolute', top: offsetY, left: 0, right: 0 }}>
          {children(startIdx, endIdx)}
        </div>
      </div>
    </div>
  )
})

// --- Collapsible sidebar section ---

const CollapsibleSection: React.FC<{
  title: string
  count?: number
  loading?: boolean
  defaultCollapsed?: boolean
  onAdd?: () => void
  addTitle?: string
  children: React.ReactNode
}> = React.memo(({ title, count, loading, defaultCollapsed = false, onAdd, addTitle, children }) => {
  const [collapsed, setCollapsed] = useState(defaultCollapsed)

  return (
    <div className="gm-sidebar-section">
      <div className="gm-sidebar-header-wrap">
        <button className="gm-sidebar-header gm-sidebar-header-toggle" data-collapsible data-collapsed={collapsed} onClick={() => setCollapsed(!collapsed)}>
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
        {loading && <span className="gm-toolbar-spinner" style={{ width: 10, height: 10, marginLeft: 6, marginRight: 8 }} />}
        {count !== undefined && !loading && <span className="gm-sidebar-header-count">{count}</span>}
      </div>
      {!collapsed && children}
    </div>
  )
})

const SectionChevron: React.FC<{ collapsed: boolean }> = React.memo(({ collapsed }) => (
  <svg
    className="gm-section-chevron"
    width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
    style={{ transform: collapsed ? 'rotate(-90deg)' : 'none' }}
  >
    <polyline points="6 9 12 15 18 9" />
  </svg>
))

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
      if (slashIdx <= 0) continue // skip entries without a remote prefix
      const remote = b.name.slice(0, slashIdx)
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
        data-collapsible
        data-collapsed={collapsed}
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
  onNavigate?: (branchName: string) => void
  onBranchContextMenu?: (e: React.MouseEvent, branch: GitBranchInfo) => void
}> = ({ branches, onCheckout, onNavigate, onBranchContextMenu }) => {
  const tree = useMemo(() => buildBranchTree(branches), [branches])

  return (
    <>
      {[...tree.children.values()].map((node) => (
        <LocalBranchNode key={node.fullPath} node={node} depth={0} onCheckout={onCheckout} onNavigate={onNavigate} onContextMenu={onBranchContextMenu} />
      ))}
    </>
  )
}

const LocalBranchNode: React.FC<{
  node: BranchTreeNode
  depth: number
  onCheckout: (name: string) => void
  onNavigate?: (branchName: string) => void
  onContextMenu?: (e: React.MouseEvent, branch: GitBranchInfo) => void
}> = ({ node, depth, onCheckout, onNavigate, onContextMenu }) => {
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
        onClick={() => onNavigate?.(b.name)}
        onDoubleClick={() => { if (!b.current) onCheckout(b.name) }}
        onContextMenu={(e) => { if (onContextMenu) { e.preventDefault(); e.stopPropagation(); onContextMenu(e, b) } }}
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
        data-collapsible
        data-collapsed={collapsed}
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
          onClick={() => onNavigate?.(node.branch!.name)}
          onDoubleClick={() => { if (!node.branch!.current) onCheckout(node.branch!.name) }}
        >
          <span className="gm-branch-name">{node.name}</span>
        </div>
      )}
      {!collapsed && [...node.children.values()].map((child) => (
        <LocalBranchNode key={child.fullPath} node={child} depth={depth + 1} onCheckout={onCheckout} onNavigate={onNavigate} onContextMenu={onContextMenu} />
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
  behindCount: number
  onError: (msg: string, retry?: () => Promise<void>) => void
  onRefresh: () => void
  onOpenDialog: () => void
}> = React.memo(({ activeDir, behindCount, onError, onRefresh, onOpenDialog }) => {
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [defaultSub, setDefaultSub] = useState(false)
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const [defaultAction, setDefaultAction] = useState<PullAction>(() => {
    return (localStorage.getItem(PULL_DEFAULT_KEY) as PullAction) || 'pull-rebase'
  })

  useEffect(() => {
    if (!dropdownOpen) setDefaultSub(false)
  }, [dropdownOpen])

  const runActionOnce = useCallback(async (action: PullAction) => {
    const api = getDockApi()
    switch (action) {
      case 'pull-merge': return api.gitManager.pull(activeDir, 'merge')
      case 'pull-rebase': return api.gitManager.pull(activeDir, 'rebase')
      case 'fetch': return api.gitManager.fetchSimple(activeDir)
      case 'fetch-all': return api.gitManager.fetchAll(activeDir)
      case 'fetch-prune-all': return api.gitManager.fetchPruneAll(activeDir)
    }
  }, [activeDir])

  const runAction = useCallback(async (action: PullAction) => {
    if (busy) return
    setBusy(true)
    try {
      const result = await runActionOnce(action)
      if (!result.success) {
        const actionName = action.startsWith('fetch') ? 'Fetch' : 'Pull'
        onError(`${actionName} failed: ${result.error || 'Unknown error'}`, async () => {
          const r = await runActionOnce(action)
          if (!r.success) throw new Error(r.error || `${actionName} still failed`)
        })
      }
      onRefresh()
    } finally {
      setBusy(false)
    }
  }, [runActionOnce, onError, onRefresh, busy])

  const setDefault = (action: PullAction) => {
    setDefaultAction(action)
    localStorage.setItem(PULL_DEFAULT_KEY, action)
    setDefaultSub(false)
  }

  const label = PULL_ACTION_LABELS[defaultAction] || 'Pull'
  const icon = defaultAction.startsWith('fetch') ? <FetchIcon /> : <PullIcon />

  return (
    <div className="gm-pull-split" ref={ref} style={{ position: 'relative' }}>
      <button className="gm-toolbar-btn" onClick={() => runAction(defaultAction)} title={`${label}${behindCount ? ` (${behindCount} commit${behindCount > 1 ? 's' : ''} behind)` : ''}`} disabled={busy}>
        {busy ? <span className="gm-toolbar-spinner" /> : icon} {label}{behindCount > 0 && !defaultAction.startsWith('fetch') ? <span className="gm-toolbar-count gm-toolbar-count-behind">{behindCount}</span> : null}
      </button>
      <button className="gm-pull-split-arrow" onClick={() => setDropdownOpen((p) => !p)} title="Pull options" disabled={busy}>
        &#9662;
      </button>
      {dropdownOpen && (
        <>
        <div className="gm-dropdown-backdrop" onClick={() => setDropdownOpen(false)} />
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
        </>
      )}
    </div>
  )
})

// --- Pull dialog ---

const PullDialog: React.FC<{
  projectDir: string
  remotes: { name: string; fetchUrl: string; pushUrl: string }[]
  remoteBranches: GitBranchInfo[]
  onClose: () => void
  onError: (msg: string, retry?: () => Promise<void>) => void
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
        const retryPull = async () => {
          const r = await api.gitManager.pullAdvanced(projectDir, remote, branch, rebase, autostash, tags, prune)
          if (!r.success) throw new Error(r.error || 'Pull still failed')
        }
        onError(`Pull failed: ${result.error || 'Unknown error'}`, retryPull)
      }
      onRefresh()
      onClose()
    } catch (err) {
      onError(`Pull failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
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
}> = React.memo(({ localBranches, remoteBranches, currentBranch, onCheckout }) => {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const ref = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Close on Escape key
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open])

  const [focusIdx, setFocusIdx] = useState(-1)

  // Focus search on open, reset on close
  useEffect(() => {
    if (open) {
      setFilter('')
      setVisibleCount(PAGE_SIZE)
      setFocusIdx(-1)
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [open])

  // Reset focus when filter changes
  useEffect(() => { setFocusIdx(-1) }, [filter])

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

  // Arrow key navigation in dropdown
  const handleDropdownKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (focusIdx >= 0 && focusIdx < visible.length) {
        const b = visible[focusIdx]
        handleSelect(b.name, b.section === 'remote')
      }
      return
    }
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
    e.preventDefault()

    const newIdx = e.key === 'ArrowDown'
      ? Math.min(visible.length - 1, focusIdx + 1)
      : Math.max(0, focusIdx - 1)

    setFocusIdx(newIdx)

    // Ensure enough items are loaded for scrolling
    if (newIdx >= visibleCount - 5 && hasMore) {
      setVisibleCount((prev) => prev + PAGE_SIZE)
    }

    // Scroll focused item into view
    if (listRef.current) {
      const items = listRef.current.querySelectorAll('.gm-branch-dropdown-item')
      items[newIdx]?.scrollIntoView({ block: 'nearest' })
    }
  }, [focusIdx, visible, visibleCount, hasMore])

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
        <>
        <div className="gm-dropdown-backdrop" onMouseDown={() => setOpen(false)} />
        <div className="gm-branch-dropdown-menu" onMouseDown={(e) => e.stopPropagation()}>
          <div className="gm-branch-dropdown-search">
            <input
              ref={inputRef}
              type="text"
              placeholder="Filter branches..."
              value={filter}
              onChange={(e) => { setFilter(e.target.value); setVisibleCount(PAGE_SIZE) }}
              onKeyDown={handleDropdownKeyDown}
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
                  className={`gm-branch-dropdown-item${b.name === currentBranch && b.section === 'local' ? ' gm-branch-dropdown-item-active' : ''}${b.section === 'remote' ? ' gm-branch-dropdown-item-remote' : ''}${i === focusIdx ? ' gm-branch-dropdown-item-focused' : ''}`}
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
        </>
      )}
    </div>
  )
})

const BranchIcon: React.FC = React.memo(() => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <line x1="6" y1="3" x2="6" y2="15" />
    <circle cx="18" cy="6" r="3" />
    <circle cx="6" cy="18" r="3" />
    <path d="M18 9a9 9 0 01-9 9" />
  </svg>
))

const ChevronIcon: React.FC<{ open: boolean }> = React.memo(({ open }) => (
  <svg
    width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
    style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}
  >
    <polyline points="6 9 12 15 18 9" />
  </svg>
))

// --- Context menu ---

const CommitContextMenu: React.FC<{
  x: number; y: number
  commit: GitCommitInfo
  currentBranch?: string
  branches: GitBranchInfo[]
  projectDir: string
  onClose: () => void
  onAction: () => void
  onError: (msg: string, retry?: () => Promise<void>) => void
  onCheckout: (name: string) => void
  onReset: (c: GitCommitInfo) => void
  onCreateBranch: (c: GitCommitInfo) => void
  onCreateTag: (c: GitCommitInfo) => void
}> = ({ x, y, commit, currentBranch, branches, projectDir, onClose, onAction, onError, onCheckout, onReset, onCreateBranch, onCreateTag }) => {
  const ref = useRef<HTMLDivElement>(null)
  const subRef = useRef<HTMLDivElement>(null)
  const [copySubmenu, setCopySubmenu] = useState(false)
  const [checkoutSubmenu, setCheckoutSubmenu] = useState(false)
  const [mergeSubmenu, setMergeSubmenu] = useState(false)
  const [claudeSubmenu, setClaudeSubmenu] = useState(false)
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

  const doCheckout = () => {
    onClose()
    onCheckout(commit.hash)
  }

  const doRevert = async () => {
    onClose()
    const r = await api.gitManager.revert(projectDir, commit.hash)
    if (!r.success) onError(`Revert failed: ${r.error || 'Unknown error'}`, async () => {
      const r2 = await api.gitManager.revert(projectDir, commit.hash)
      if (!r2.success) throw new Error(r2.error || 'Revert still failed')
    })
    else onAction()
  }

  const doCherryPick = async () => {
    onClose()
    const r = await api.gitManager.cherryPick(projectDir, commit.hash)
    if (!r.success) onError(`Cherry-pick failed: ${r.error || 'Unknown error'}`, async () => {
      const r2 = await api.gitManager.cherryPick(projectDir, commit.hash)
      if (!r2.success) throw new Error(r2.error || 'Cherry-pick still failed')
    })
    else onAction()
  }

  // Branches that point at this commit
  const commitBranches = commit.refs
    .filter((r) => !r.startsWith('tag:') && r !== 'HEAD' && !r.endsWith('/HEAD'))
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
                      <div key={bName} className="gm-ctx-item" onClick={() => {
                        onClose()
                        onCheckout(bName)
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
                        if (!r.success) onError(`Merge failed: ${r.error || 'Unknown error'}`, async () => {
                          const r2 = await api.gitManager.mergeBranch(projectDir, bName)
                          if (!r2.success) throw new Error(r2.error || 'Merge still failed')
                        })
                        else onAction()
                      }}>
                        Merge {bName} into {currentBranch || 'HEAD'}
                      </div>
                    )) : (
                      <div className="gm-ctx-item" onClick={async () => {
                        onClose()
                        const r = await api.gitManager.mergeBranch(projectDir, commit.hash)
                        if (!r.success) onError(`Merge failed: ${r.error || 'Unknown error'}`, async () => {
                          const r2 = await api.gitManager.mergeBranch(projectDir, commit.hash)
                          if (!r2.success) throw new Error(r2.error || 'Merge still failed')
                        })
                        else onAction()
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
      <div className="gm-ctx-separator" />
      <div
        className="gm-ctx-item gm-ctx-submenu-trigger"
        onMouseEnter={() => setClaudeSubmenu(true)}
        onMouseLeave={() => setClaudeSubmenu(false)}
      >
        <span className="gm-ctx-item-label"><svg className="gm-ctx-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5L12 3z" /><path d="M19 15l.5 2 2 .5-2 .5-.5 2-.5-2-2-.5 2-.5.5-2z" /></svg>Claude Actions</span>
        <span className="gm-ctx-arrow">&#9656;</span>
        {claudeSubmenu && (
          <div className={`gm-ctx-submenu${subFlip ? ' gm-ctx-submenu-left' : ''}`} ref={adjustSubmenuRef}>
            <div className="gm-ctx-item" onClick={() => { onClose(); sendWriteTestsTask([], commit.hash, commit.subject) }}><span className="gm-ctx-item-label"><svg className="gm-ctx-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 2v6.5L20 22H4L9.5 8.5V2" /><line x1="8" y1="2" x2="16" y2="2" /><line x1="6" y1="18" x2="18" y2="18" /></svg>Write Tests</span></div>
            <div className="gm-ctx-item" onClick={() => { onClose(); sendReferenceThisTask([], commit.hash, commit.subject) }}><span className="gm-ctx-item-label"><svg className="gm-ctx-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2z" /><path d="M22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z" /></svg>Reference This</span></div>
          </div>
        )}
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
    if (!r.success) onError(`Stash apply failed: ${r.error || 'Unknown error'}`)
    onAction()
  }

  const doPop = async () => {
    onClose()
    const r = await api.gitManager.stashPop(projectDir, stash.index)
    if (!r.success) onError(`Stash pop failed: ${r.error || 'Unknown error'}`)
    onAction()
  }

  const doDrop = async () => {
    onClose()
    const r = await api.gitManager.stashDrop(projectDir, stash.index)
    if (!r.success) onError(`Stash drop failed: ${r.error || 'Unknown error'}`)
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

// --- Tag context menu ---

const TagContextMenu: React.FC<{
  x: number; y: number
  tagName: string
  commitHash: string
  projectDir: string
  onClose: () => void
  onAction: () => void
  onError: (msg: string, retry?: () => Promise<void>) => void
  onCheckout?: (name: string) => void
}> = ({ x, y, tagName, commitHash, projectDir, onClose, onAction, onError, onCheckout }) => {
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

  const doDelete = async () => {
    onClose()
    const r = await api.gitManager.deleteTag(projectDir, tagName)
    if (!r.success) onError(`Delete tag failed: ${r.error || 'Unknown error'}`)
    onAction()
  }

  const doCheckout = () => {
    onClose()
    if (onCheckout) {
      onCheckout(`tags/${tagName}`)
    } else {
      api.gitManager.checkoutBranch(projectDir, `tags/${tagName}`).then((r) => {
        if (!r.success) onError(`Checkout failed: ${r.error || 'Unknown error'}`)
        onAction()
      })
    }
  }

  return (
    <div className="gm-ctx-menu" ref={ref} style={{ left: x, top: y }}>
      <div className="gm-ctx-item" onClick={doCheckout}>
        Checkout tag
      </div>
      <div className="gm-ctx-separator" />
      <div className="gm-ctx-item" onClick={() => { navigator.clipboard.writeText(tagName); onClose() }}>
        Copy tag name
      </div>
      <div className="gm-ctx-item" onClick={() => { navigator.clipboard.writeText(commitHash); onClose() }}>
        Copy commit hash
      </div>
      <div className="gm-ctx-separator" />
      <div className="gm-ctx-item gm-ctx-danger" onClick={doDelete}>
        Delete tag
      </div>
    </div>
  )
}

// --- Branch ref context menu (commit log + sidebar) ---

const BranchRefContextMenu: React.FC<{
  x: number; y: number
  branchName: string
  isRemote: boolean
  projectDir: string
  onClose: () => void
  onAction: () => void
  onError: (msg: string, retry?: () => Promise<void>) => void
  onCheckout?: (name: string) => void
}> = ({ x, y, branchName, isRemote, projectDir, onClose, onAction, onError, onCheckout }) => {
  const ref = useRef<HTMLDivElement>(null)
  const [showDelete, setShowDelete] = useState(false)
  const [deleteRemote, setDeleteRemote] = useState(isRemote)
  const [deleteLocal, setDeleteLocal] = useState(!isRemote)
  const [deleting, setDeleting] = useState(false)

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
  }, [showDelete])

  const api = getDockApi()

  const doCheckout = () => {
    onClose()
    const name = isRemote ? branchName.replace(/^[^/]+\//, '') : branchName
    if (onCheckout) onCheckout(name)
    else api.gitManager.checkoutBranch(projectDir, name).then((r) => {
      if (!r.success) onError(`Checkout failed: ${r.error || 'Unknown error'}`)
      onAction()
    })
  }

  const doDelete = async () => {
    if (!deleteRemote && !deleteLocal) return
    setDeleting(true)
    try {
      const remoteName = isRemote ? branchName : `origin/${branchName}`
      const localName = isRemote ? branchName.replace(/^[^/]+\//, '') : branchName
      const name = deleteRemote ? remoteName : localName
      const r = await api.gitManager.deleteBranch(projectDir, name, true, { deleteRemote, deleteLocal })
      if (!r.success) onError(`Delete branch failed: ${r.error || 'Unknown error'}`)
      onClose()
      onAction()
    } catch (err) {
      onError(`Delete failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
      onClose()
    }
    setDeleting(false)
  }

  if (showDelete) {
    return (
      <div className="gm-ctx-menu gm-ctx-menu-wide" ref={ref} style={{ left: x, top: y }}>
        <div className="gm-ctx-header">Delete branch</div>
        <div className="gm-ctx-body">
          <div className="gm-ctx-branch-name">{branchName}</div>
          <label className="gm-ctx-checkbox">
            <input type="checkbox" checked={deleteRemote} onChange={(e) => setDeleteRemote(e.target.checked)} />
            Delete branch from remote repository
          </label>
          <label className="gm-ctx-checkbox">
            <input type="checkbox" checked={deleteLocal} onChange={(e) => setDeleteLocal(e.target.checked)} />
            Delete local tracking branch (if available)
          </label>
        </div>
        <div className="gm-ctx-footer">
          <button className="gm-small-btn" onClick={() => setShowDelete(false)}>Cancel</button>
          <button className="gm-small-btn gm-ctx-danger-btn" onClick={doDelete} disabled={deleting || (!deleteRemote && !deleteLocal)}>
            {deleting ? 'Deleting...' : 'Delete'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="gm-ctx-menu" ref={ref} style={{ left: x, top: y }}>
      {!isRemote && (
        <div className="gm-ctx-item" onClick={doCheckout}>
          Checkout branch
        </div>
      )}
      {isRemote && (
        <div className="gm-ctx-item" onClick={doCheckout}>
          Checkout (create local)
        </div>
      )}
      <div className="gm-ctx-separator" />
      <div className="gm-ctx-item" onClick={() => { navigator.clipboard.writeText(branchName); onClose() }}>
        Copy branch name
      </div>
      <div className="gm-ctx-separator" />
      <div className="gm-ctx-item gm-ctx-danger" onClick={() => setShowDelete(true)}>
        Delete branch...
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
    if (!r.success) { onError(`Reset failed: ${r.error || 'Unknown error'}`); onClose(); return }
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
              <div className="gm-reset-meta">Branch(es): {commit.refs.filter(r => !r.startsWith('tag:') && r !== 'HEAD' && !r.endsWith('/HEAD')).map(r => r.replace(/^HEAD -> /, '')).join(', ') || 'n/a'}</div>
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
    if (!r.success) { onError(`Create branch failed: ${r.error || 'Unknown error'}`); onClose(); return }
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
    if (!r.success) { onError(`Create tag failed: ${r.error || 'Unknown error'}`); onClose(); return }
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
}> = React.memo(({ mergeState, projectDir, onRefresh, onError }) => {
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [conflictContent, setConflictContent] = useState<GitConflictFileContent | null>(null)
  const [loadingContent, setLoadingContent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [viewMode, setViewMode] = useState<'chunks' | 'edit' | 'claude'>('chunks')
  // Manual edit state
  const [editContent, setEditContent] = useState('')
  const [editDirty, setEditDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  // Undo stack for chunk resolutions (stores raw file content before each resolve)
  const [undoStack, setUndoStack] = useState<string[]>([])
  // Claude resolve state
  const [claudePrompt, setClaudePrompt] = useState('')
  const [claudeSending, setClaudeSending] = useState(false)

  // Arrow key navigation for conflict files
  const handleConflictsKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
    e.preventDefault()

    const currentIdx = selectedFile ? mergeState.conflicts.findIndex(c => c.path === selectedFile) : -1
    if (currentIdx === -1 && e.key === 'ArrowUp') return

    const newIdx = e.key === 'ArrowDown'
      ? Math.min(mergeState.conflicts.length - 1, currentIdx + 1)
      : Math.max(0, currentIdx - 1)

    if (newIdx >= 0 && newIdx < mergeState.conflicts.length) {
      setSelectedFile(mergeState.conflicts[newIdx].path)
    }
  }, [selectedFile, mergeState.conflicts])

  // Load conflict content when file is selected
  useEffect(() => {
    if (!selectedFile) { setConflictContent(null); return }
    let cancelled = false
    setLoadingContent(true)
    setViewMode('chunks')
    setEditDirty(false)
    setUndoStack([])
    getDockApi().gitManager.getConflictContent(projectDir, selectedFile)
      .then((content) => {
        if (cancelled) return
        setConflictContent(content)
        setEditContent(content.raw)
      })
      .catch(() => { if (!cancelled) setConflictContent(null) })
      .finally(() => { if (!cancelled) setLoadingContent(false) })
    return () => { cancelled = true }
  }, [selectedFile, projectDir])

  const reloadContent = useCallback(async () => {
    if (!selectedFile) return
    try {
      const content = await getDockApi().gitManager.getConflictContent(projectDir, selectedFile)
      setConflictContent(content)
      setEditContent(content.raw)
      setEditDirty(false)
    } catch { /* ignore */ }
  }, [selectedFile, projectDir])

  const handleResolveChunk = useCallback(async (chunkIndex: number, resolution: 'ours' | 'theirs' | 'both') => {
    if (!selectedFile) return
    setBusy(true)
    if (conflictContent) setUndoStack(prev => [...prev, conflictContent.raw])
    const r = await getDockApi().gitManager.resolveConflict(projectDir, selectedFile, resolution, chunkIndex)
    if (!r.success) onError(`Resolve conflict failed: ${r.error || 'Unknown error'}`)
    await reloadContent()
    setBusy(false)
  }, [selectedFile, projectDir, onError, reloadContent, conflictContent])

  const handleResolveAll = useCallback(async (resolution: 'ours' | 'theirs' | 'both') => {
    if (!selectedFile) return
    setBusy(true)
    if (conflictContent) setUndoStack(prev => [...prev, conflictContent.raw])
    const r = await getDockApi().gitManager.resolveConflict(projectDir, selectedFile, resolution)
    if (!r.success) onError(`Resolve conflict failed: ${r.error || 'Unknown error'}`)
    await reloadContent()
    setBusy(false)
  }, [selectedFile, projectDir, onError, reloadContent, conflictContent])

  const handleUndo = useCallback(async () => {
    if (!selectedFile || undoStack.length === 0) return
    setBusy(true)
    const prevContent = undoStack[undoStack.length - 1]
    setUndoStack(prev => prev.slice(0, -1))
    const r = await getDockApi().gitManager.saveFile(projectDir, selectedFile, prevContent)
    if (!r.success) onError(`Undo failed: ${r.error || 'Unknown error'}`)
    await reloadContent()
    setBusy(false)
  }, [selectedFile, projectDir, undoStack, onError, reloadContent])

  const handleMarkResolved = useCallback(async () => {
    if (!selectedFile) return
    setBusy(true)
    const r = await getDockApi().gitManager.stage(projectDir, [selectedFile])
    if (!r.success) onError(`Stage failed: ${r.error || 'Unknown error'}`)
    onRefresh()
    setBusy(false)
  }, [selectedFile, projectDir, onRefresh, onError])

  const handleAbort = useCallback(async () => {
    setBusy(true)
    const r = await getDockApi().gitManager.abortMerge(projectDir)
    if (!r.success) onError(`Abort merge failed: ${r.error || 'Unknown error'}`)
    onRefresh()
    setBusy(false)
  }, [projectDir, onRefresh, onError])

  const handleContinue = useCallback(async () => {
    setBusy(true)
    const r = await getDockApi().gitManager.continueMerge(projectDir)
    if (!r.success) onError(`Continue merge failed: ${r.error || 'Unknown error'}`)
    onRefresh()
    setBusy(false)
  }, [projectDir, onRefresh, onError])

  const handleSaveEdit = useCallback(async () => {
    if (!selectedFile) return
    setSaving(true)
    const r = await getDockApi().gitManager.saveFile(projectDir, selectedFile, editContent)
    if (!r.success) {
      onError(`Save failed: ${r.error || 'Unknown error'}`)
    } else {
      setEditDirty(false)
      await reloadContent()
    }
    setSaving(false)
  }, [selectedFile, projectDir, editContent, onError, reloadContent])

  const handleClaudeResolve = useCallback(async () => {
    if (!selectedFile || !claudePrompt.trim()) return
    setClaudeSending(true)
    const r = await getDockApi().gitManager.resolveWithClaude(projectDir, selectedFile, claudePrompt.trim())
    if (!r.success) onError(`Failed to send to Claude: ${r.error || 'Unknown error'}`)
    setClaudeSending(false)
  }, [selectedFile, projectDir, claudePrompt, onError])

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
        <div className="gm-conflicts-file-list" tabIndex={0} onKeyDown={handleConflictsKeyDown}>
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
        {mergeState.type !== 'none' && (
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
        )}
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
                {/* View mode tabs */}
                <div className="gm-conflicts-mode-tabs">
                  <button
                    className={`gm-conflicts-mode-tab${viewMode === 'chunks' ? ' gm-conflicts-mode-tab-active' : ''}`}
                    onClick={() => setViewMode('chunks')}
                    title="Chunk-based conflict resolver"
                  >Chunks</button>
                  <button
                    className={`gm-conflicts-mode-tab${viewMode === 'edit' ? ' gm-conflicts-mode-tab-active' : ''}`}
                    onClick={() => { setViewMode('edit'); setEditContent(conflictContent.raw); setEditDirty(false) }}
                    title="Edit file manually with syntax highlighting"
                  >Edit</button>
                  <button
                    className={`gm-conflicts-mode-tab${viewMode === 'claude' ? ' gm-conflicts-mode-tab-active' : ''}`}
                    onClick={() => setViewMode('claude')}
                    title="Resolve with Claude AI"
                  ><ClaudeResolveIcon /> Claude</button>
                </div>
                {viewMode === 'chunks' && (
                  <>
                    {undoStack.length > 0 && (
                      <button className="gm-small-btn gm-conflicts-undo-btn" onClick={handleUndo} disabled={busy} title="Undo last resolution">
                        &#x21A9; Undo
                      </button>
                    )}
                    {hasConflicts && (
                      <>
                        <button className="gm-small-btn" onClick={() => handleResolveAll('ours')} disabled={busy}>Accept All Ours</button>
                        <button className="gm-small-btn" onClick={() => handleResolveAll('theirs')} disabled={busy}>Accept All Theirs</button>
                      </>
                    )}
                  </>
                )}
                {viewMode === 'edit' && (
                  <button
                    className="gm-small-btn gm-conflicts-save-btn"
                    onClick={handleSaveEdit}
                    disabled={saving || !editDirty}
                    title={editDirty ? 'Save changes to disk (Ctrl+S)' : 'No changes to save'}
                  >{saving ? 'Saving...' : 'Save'}</button>
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

            {viewMode === 'chunks' && (
              <div className="gm-conflicts-chunks">
                {conflictContent.chunks.map((chunk, ci) => (
                  <ConflictChunkView
                    key={ci}
                    chunk={chunk}
                    chunkIndex={ci}
                    onResolve={handleResolveChunk}
                    disabled={busy}
                    abbreviate={hasConflicts}
                  />
                ))}
              </div>
            )}

            {viewMode === 'edit' && (
              <ConflictEditor
                content={editContent}
                filePath={selectedFile}
                onChange={(val) => { setEditContent(val); setEditDirty(true) }}
                onSave={handleSaveEdit}
              />
            )}

            {viewMode === 'claude' && (
              <div className="gm-conflicts-claude">
                <div className="gm-conflicts-claude-header">
                  <ClaudeResolveIcon size={16} />
                  <span>Describe how to resolve the conflict in <strong>{selectedFile.split(/[/\\]/).pop()}</strong></span>
                </div>
                <textarea
                  className="gm-conflicts-claude-input"
                  value={claudePrompt}
                  onChange={(e) => setClaudePrompt(e.target.value)}
                  placeholder={"e.g. Keep our version of the settings but add their new \"theme\" field with value \"dark\""}
                  rows={4}
                />
                <div className="gm-conflicts-claude-actions">
                  <button
                    className="gm-small-btn gm-conflicts-claude-send"
                    onClick={handleClaudeResolve}
                    disabled={claudeSending || !claudePrompt.trim()}
                  >
                    {claudeSending ? 'Sending...' : 'Send to Claude'}
                  </button>
                  <span className="gm-conflicts-claude-hint">Opens the task in a Claude terminal in the dock window</span>
                </div>
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
})

// --- Conflict Editor (manual edit with syntax highlighting) ---

const ConflictEditor: React.FC<{
  content: string
  filePath: string
  onChange: (content: string) => void
  onSave: () => void
}> = ({ content, filePath, onChange, onSave }) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const preRef = useRef<HTMLPreElement>(null)
  const gutterRef = useRef<HTMLDivElement>(null)

  const highlighted = useMemo(() => highlightCode(filePath, content), [filePath, content])
  const lines = content.split('\n')

  // Sync scroll between textarea, pre, and gutter
  const handleScroll = useCallback(() => {
    if (textareaRef.current) {
      if (preRef.current) {
        preRef.current.scrollTop = textareaRef.current.scrollTop
        preRef.current.scrollLeft = textareaRef.current.scrollLeft
      }
      if (gutterRef.current) {
        gutterRef.current.scrollTop = textareaRef.current.scrollTop
      }
    }
  }, [])

  // Handle tab key for indentation
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      onSave()
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      const ta = e.currentTarget
      const start = ta.selectionStart
      const end = ta.selectionEnd
      const val = ta.value

      if (e.shiftKey) {
        // Shift+Tab — dedent selected lines
        const beforeSel = val.slice(0, start)
        const lineStart = beforeSel.lastIndexOf('\n') + 1
        const selected = val.slice(lineStart, end)
        const dedented = selected.split('\n').map(l => l.startsWith('  ') ? l.slice(2) : l.startsWith('\t') ? l.slice(1) : l).join('\n')
        const newVal = val.slice(0, lineStart) + dedented + val.slice(end)
        onChange(newVal)
        requestAnimationFrame(() => {
          ta.selectionStart = start - (selected.split('\n')[0].length - dedented.split('\n')[0].length)
          ta.selectionEnd = lineStart + dedented.length
        })
      } else if (start === end) {
        // No selection — insert 2 spaces
        const newVal = val.slice(0, start) + '  ' + val.slice(end)
        onChange(newVal)
        requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = start + 2 })
      } else {
        // Selection — indent all selected lines
        const beforeSel = val.slice(0, start)
        const lineStart = beforeSel.lastIndexOf('\n') + 1
        const selected = val.slice(lineStart, end)
        const indented = selected.split('\n').map(l => '  ' + l).join('\n')
        const newVal = val.slice(0, lineStart) + indented + val.slice(end)
        onChange(newVal)
        requestAnimationFrame(() => {
          ta.selectionStart = start + 2
          ta.selectionEnd = lineStart + indented.length
        })
      }
    }
  }, [onChange, onSave])

  return (
    <div className="gm-conflict-editor">
      {/* Line numbers */}
      <div className="gm-conflict-editor-gutter" ref={gutterRef} aria-hidden>
        {lines.map((_, i) => (
          <div key={i} className="gm-conflict-editor-linenum">{i + 1}</div>
        ))}
      </div>
      {/* Code area — textarea over highlighted pre */}
      <div className="gm-conflict-editor-code">
        <pre ref={preRef} className="gm-conflict-editor-pre gm-highlighted" aria-hidden>
          <code dangerouslySetInnerHTML={highlighted
            ? { __html: highlighted.join('\n') + '\n' }
            : undefined
          }>{highlighted ? undefined : content + '\n'}</code>
        </pre>
        <textarea
          ref={textareaRef}
          className="gm-conflict-editor-textarea"
          value={content}
          onChange={(e) => onChange(e.target.value)}
          onScroll={handleScroll}
          onKeyDown={handleKeyDown}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
        />
      </div>
    </div>
  )
}

const ClaudeResolveIcon: React.FC<{ size?: number }> = React.memo(({ size = 14 }) => (
  <svg className="gm-claude-resolve-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3l1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5L12 3z" />
    <path d="M19 15l.5 2 2 .5-2 .5-.5 2-.5-2-2-.5 2-.5.5-2z" />
  </svg>
))

const ConflictChunkView: React.FC<{
  chunk: GitConflictChunk
  chunkIndex: number
  onResolve: (index: number, resolution: 'ours' | 'theirs' | 'both') => void
  disabled: boolean
  abbreviate?: boolean
}> = ({ chunk, chunkIndex, onResolve, disabled, abbreviate = true }) => {
  if (chunk.type === 'common') {
    const lines = chunk.commonLines || []
    // Show abbreviated common sections (first 3 + last 3 if long), but only when there are still conflicts
    const abbreviated = abbreviate && lines.length > 8
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

// --- Error dialog with resolutions ---

const ErrorDialog: React.FC<{
  error: ActionError
  busyRef?: React.MutableRefObject<boolean>
  onClose: () => void
  onResolved: () => void
  onError: (msg: string) => void
  onReplaceError?: (newError: ActionError) => void
}> = ({ error, busyRef, onClose, onResolved, onError, onReplaceError }) => {
  const [busy, setBusy] = useState<string | null>(null)

  const handleResolution = async (r: ActionErrorResolution) => {
    setBusy(r.label)
    if (busyRef) busyRef.current = true
    try {
      await r.action()
      if (!r.keepOpen) onResolved()
    } catch (err: unknown) {
      // Special case: resolution wants to replace this dialog with a new one
      if (err && typeof err === 'object' && '__replaceDialog' in err) {
        const replacement = (err as { replacement: ActionError }).replacement
        onClose()
        // Use setTimeout to avoid React state update during render cycle
        setTimeout(() => onReplaceError?.(replacement), 0)
      } else {
        onError(err instanceof Error ? err.message : 'Resolution failed')
      }
    } finally {
      if (busyRef) busyRef.current = false
      setBusy(null)
    }
  }

  return (
    <div className="gm-modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="gm-modal gm-modal-sm">
        <div className="gm-modal-header gm-error-dialog-header">
          <WarningIcon />
          <span>{error.title}</span>
          <button className="gm-modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="gm-modal-body">
          <div className="gm-error-dialog-message">{error.message}</div>
          {(error.resolutions?.length ?? 0) > 0 && (
            <div className="gm-error-dialog-resolutions">
              <div className="gm-error-dialog-resolutions-label">Suggested actions:</div>
              {error.resolutions.map((r) => (
                <button
                  key={r.label}
                  className={`gm-error-dialog-resolution${r.danger ? ' gm-error-dialog-resolution-danger' : ''}`}
                  onClick={() => handleResolution(r)}
                  disabled={busy !== null}
                >
                  <span className="gm-error-resolution-label">{busy === r.label ? 'Running...' : r.label}</span>
                  {r.description && <span className="gm-error-resolution-desc">{r.description}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="gm-modal-footer">
          <button className="gm-modal-btn" onClick={onClose} disabled={busy !== null}>Dismiss</button>
        </div>
      </div>
    </div>
  )
}

// --- Identity setup modal ---

const IdentitySetupModal: React.FC<{
  projectDir: string
  onClose: () => void
  onSaved: () => void
}> = ({ projectDir, onClose, onSaved }) => {
  const api = getDockApi()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [scope, setScope] = useState<'global' | 'local'>('global')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    api.gitManager.getIdentity(projectDir).then((id) => {
      if (id.name) setName(id.name)
      if (id.email) setEmail(id.email)
      setLoaded(true)
    }).catch(() => setLoaded(true))
  }, [])

  const handleSave = async () => {
    if (!name.trim() || !email.trim()) return
    setBusy(true)
    setError(null)
    const result = await api.gitManager.setIdentity(projectDir, name.trim(), email.trim(), scope === 'global')
    if (result.success) {
      onSaved()
    } else {
      setError(result.error || 'Failed to save identity')
      setBusy(false)
    }
  }

  return (
    <div className="gm-modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="gm-modal gm-modal-sm">
        <div className="gm-modal-header">
          <span>Set Up Git Identity</span>
          <button className="gm-modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="gm-modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 12, color: 'var(--gm-text-secondary)', lineHeight: 1.5 }}>
            Git needs your name and email to create commits. This is stored in your git config and attached to each commit you make.
          </div>
          {!loaded ? (
            <div style={{ textAlign: 'center', padding: 10, fontSize: 12 }}>Loading...</div>
          ) : (
            <>
              <label style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span>Name</span>
                <input
                  className="gm-modal-input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your Name"
                  autoFocus
                />
              </label>
              <label style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span>Email</span>
                <input
                  className="gm-modal-input"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  onKeyDown={(e) => { if (e.key === 'Enter' && name.trim() && email.trim()) handleSave() }}
                />
              </label>
              <div style={{ fontSize: 11, display: 'flex', gap: 12 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                  <input type="radio" name="scope" checked={scope === 'global'} onChange={() => setScope('global')} />
                  <span>Global</span>
                  <span style={{ color: 'var(--gm-text-secondary)' }}>(all repositories)</span>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                  <input type="radio" name="scope" checked={scope === 'local'} onChange={() => setScope('local')} />
                  <span>This repo only</span>
                </label>
              </div>
            </>
          )}
          {error && <div style={{ fontSize: 12, color: 'var(--gm-danger)' }}>{error}</div>}
        </div>
        <div className="gm-modal-footer">
          <button className="gm-modal-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            className="gm-modal-btn gm-modal-btn-primary"
            onClick={handleSave}
            disabled={busy || !loaded || !name.trim() || !email.trim()}
          >
            {busy ? 'Saving...' : 'Save & Retry'}
          </button>
        </div>
      </div>
    </div>
  )
}

// --- Gitignore modal ---

const GitignoreModal: React.FC<{
  projectDir: string
  initialPattern: string
  hasTrackedFiles: boolean
  onClose: () => void
  onDone: () => void
  onError: (msg: string) => void
}> = ({ projectDir, initialPattern, hasTrackedFiles, onClose, onDone, onError }) => {
  const api = getDockApi()
  const [pattern, setPattern] = useState(initialPattern)
  const [preview, setPreview] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [removeFromIndex, setRemoveFromIndex] = useState(hasTrackedFiles)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    const p = pattern.trim()
    if (!p) { setPreview([]); return }
    setLoading(true)
    debounceRef.current = setTimeout(async () => {
      const result = await api.gitManager.previewGitignore(projectDir, p)
      setPreview(result)
      setLoading(false)
    }, 200)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [pattern, projectDir])

  const handleIgnore = async () => {
    const p = pattern.trim()
    if (!p) return
    const r = await api.gitManager.addToGitignore(projectDir, p, removeFromIndex)
    if (!r.success) { onError(`Add to .gitignore failed: ${r.error || 'Unknown error'}`); return }
    onDone()
    onClose()
  }

  return (
    <div className="gm-modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="gm-modal gm-gitignore-modal">
        <div className="gm-modal-header">
          <span>Add to .gitignore</span>
          <button className="gm-modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="gm-modal-body">
          <fieldset className="gm-gitignore-fieldset">
            <legend>Enter a file pattern to ignore</legend>
            <input
              className="gm-gitignore-input"
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleIgnore() }}
              autoFocus
              spellCheck={false}
            />
          </fieldset>
          <fieldset className="gm-gitignore-fieldset">
            <legend>Preview</legend>
            <div className="gm-gitignore-preview">
              {preview.length > 0 ? preview.map((f) => (
                <div key={f} className="gm-gitignore-preview-item">{f}</div>
              )) : (
                <div className="gm-gitignore-preview-empty">
                  {loading ? 'Searching...' : pattern.trim() ? 'No files matched' : 'Type a pattern above'}
                </div>
              )}
            </div>
            {preview.length > 0 && (
              <div className="gm-gitignore-count">{preview.length >= 200 ? '200+ ' : preview.length} file{preview.length !== 1 ? 's' : ''} matched</div>
            )}
          </fieldset>
          {hasTrackedFiles && (
            <label className="gm-gitignore-checkbox">
              <input type="checkbox" checked={removeFromIndex} onChange={(e) => setRemoveFromIndex(e.target.checked)} />
              Also remove matched files from tracking (keeps files on disk)
            </label>
          )}
        </div>
        <div className="gm-modal-footer">
          <button className="gm-modal-btn" onClick={onClose}>Cancel</button>
          <button className="gm-modal-btn gm-modal-btn-primary" onClick={handleIgnore} disabled={!pattern.trim()}>Ignore</button>
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
    else onError(`Add submodule failed: ${r.error || 'Unknown error'}`)
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
    else onError(`Add remote failed: ${r.error || 'Unknown error'}`)
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

const PLUGIN_SETTINGS: { key: string; label: string; type: 'boolean' | 'number' | 'multiselect'; default?: unknown; options?: { value: string; label: string }[] }[] = [
  { key: 'escToHide', label: 'Press Esc to hide window', type: 'boolean', default: true },
  { key: 'autoGenerateCommitMsg', label: 'Auto-generate commit messages', type: 'boolean', default: true },
  { key: 'autoFetchAll', label: 'Auto fetch all on open and on interval', type: 'boolean', default: false },
  { key: 'autoRecheckMinutes', label: 'Auto recheck interval (minutes, 0 to disable)', type: 'number', default: 15 },
  { key: 'changesRefreshSeconds', label: 'Working changes auto-refresh (seconds, 0 to disable)', type: 'number', default: 5 },
  { key: 'syntaxHighlighting', label: 'Syntax highlighting in diffs', type: 'boolean', default: true },
  { key: 'enableCiTab', label: 'Show CI tab', type: 'boolean', default: false },
  { key: 'enablePrTab', label: 'Show Pull/Merge Requests tab', type: 'boolean', default: false },
  { key: 'ciNotificationTypes', label: 'CI notifications', type: 'multiselect', default: ['started', 'success', 'failure'], options: [
    { value: 'started', label: 'Started' },
    { value: 'success', label: 'Success' },
    { value: 'failure', label: 'Failure' },
    { value: 'cancelled', label: 'Cancelled' }
  ]}
]

const SettingsDropdown: React.FC<{ projectDir: string }> = React.memo(({ projectDir }) => {
  const [open, setOpen] = useState(false)
  const [values, setValues] = useState<Record<string, unknown>>({})
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const api = getDockApi()
    Promise.all(
      PLUGIN_SETTINGS.map(async (s) => {
        const val = await api.plugins.getSetting(projectDir, 'git-manager', s.key)
        return [s.key, val ?? s.default] as const
      })
    ).then((entries) => setValues(Object.fromEntries(entries)))
  }, [open, projectDir])

  const toggle = async (key: string) => {
    const cur = !!values[key]
    const next = !cur
    setValues((prev) => ({ ...prev, [key]: next }))
    await getDockApi().plugins.setSetting(projectDir, 'git-manager', key, next)
    window.dispatchEvent(new CustomEvent('gm-setting-changed', { detail: { key, value: next } }))
  }

  const setNumber = async (key: string, val: number) => {
    setValues((prev) => ({ ...prev, [key]: val }))
    await getDockApi().plugins.setSetting(projectDir, 'git-manager', key, val)
  }

  const toggleMultiselect = async (key: string, optionValue: string) => {
    const current = (values[key] as string[] | undefined) ?? (PLUGIN_SETTINGS.find((s) => s.key === key)?.default as string[]) ?? []
    const next = current.includes(optionValue)
      ? current.filter((v: string) => v !== optionValue)
      : [...current, optionValue]
    setValues((prev) => ({ ...prev, [key]: next }))
    await getDockApi().plugins.setSetting(projectDir, 'git-manager', key, next)
  }

  return (
    <div className="gm-settings-dropdown" ref={ref}>
      <button className="gm-toolbar-btn" onClick={() => setOpen(!open)} title="Settings">
        <SettingsIcon />
      </button>
      {open && (
        <>
        <div className="gm-dropdown-backdrop" onMouseDown={() => setOpen(false)} />
        <div className="gm-settings-menu" onMouseDown={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
          <div className="gm-settings-title">Git Manager Settings</div>
          {PLUGIN_SETTINGS.map((s) => (
            s.type === 'boolean' ? (
              <label key={s.key} className="gm-settings-item">
                <input
                  type="checkbox"
                  checked={!!values[s.key]}
                  onChange={() => toggle(s.key)}
                />
                <span>{s.label}</span>
              </label>
            ) : s.type === 'multiselect' ? (
              <div key={s.key} className="gm-settings-item gm-settings-item-multiselect">
                <span className="gm-settings-multiselect-label">{s.label}</span>
                <div className="gm-settings-multiselect-options">
                  {(s.options ?? []).map((opt) => {
                    const selected = ((values[s.key] as string[] | undefined) ?? (s.default as string[]) ?? []).includes(opt.value)
                    return (
                      <label key={opt.value} className={`gm-settings-multiselect-chip${selected ? ' gm-settings-multiselect-chip-on' : ''}`}>
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => toggleMultiselect(s.key, opt.value)}
                        />
                        <span>{opt.label}</span>
                      </label>
                    )
                  })}
                </div>
              </div>
            ) : (
              <label key={s.key} className="gm-settings-item gm-settings-item-number">
                <span>{s.label}</span>
                <input
                  type="number"
                  min={0}
                  className="gm-settings-number-input"
                  value={values[s.key] != null ? Number(values[s.key]) : ''}
                  onChange={(e) => setNumber(s.key, Number(e.target.value))}
                />
              </label>
            )
          ))}
        </div>
        </>
      )}
    </div>
  )
})

const SettingsIcon: React.FC = React.memo(() => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
  </svg>
))

// --- Notification panel ---

const MAX_NOTIFICATIONS = 50

function gmNotifStorageKey(projectDir: string): string {
  return `gm-notifications:${projectDir.replace(/[\\/]/g, '/').toLowerCase()}`
}

function gmNotifReadKey(projectDir: string): string {
  return `gm-notifications-read:${projectDir.replace(/[\\/]/g, '/').toLowerCase()}`
}

const NotificationPanel: React.FC<{ projectDir: string; provider: GitProvider }> = React.memo(({ projectDir, provider }) => {
  const [open, setOpen] = useState(false)
  const [notifications, setNotifications] = useState<DockNotification[]>(() => {
    try { const raw = localStorage.getItem(gmNotifStorageKey(projectDir)); return raw ? JSON.parse(raw) : [] } catch { return [] }
  })
  const [readIds, setReadIds] = useState<Set<string>>(() => {
    try { const raw = localStorage.getItem(gmNotifReadKey(projectDir)); return raw ? new Set(JSON.parse(raw)) : new Set() } catch { return new Set() }
  })
  const ref = useRef<HTMLDivElement>(null)
  const markAllRead = useSettingsStore((s) => s.settings.behavior?.markNotificationsRead ?? false)

  // Reload stored notifications when projectDir changes (e.g. navigating into submodule)
  useEffect(() => {
    try { const raw = localStorage.getItem(gmNotifStorageKey(projectDir)); setNotifications(raw ? JSON.parse(raw) : []) } catch { setNotifications([]) }
    try { const raw = localStorage.getItem(gmNotifReadKey(projectDir)); setReadIds(raw ? new Set(JSON.parse(raw)) : new Set()) } catch { setReadIds(new Set()) }
  }, [projectDir])

  const unreadCount = notifications.filter((n) => !readIds.has(n.id)).length

  // Persist notifications (project-scoped)
  useEffect(() => {
    try { localStorage.setItem(gmNotifStorageKey(projectDir), JSON.stringify(notifications)) } catch { /* ignore */ }
  }, [notifications, projectDir])

  // Persist read state — prune stale IDs to prevent unbounded growth
  useEffect(() => {
    const notifIds = new Set(notifications.map((n) => n.id))
    const pruned = [...readIds].filter((id) => notifIds.has(id))
    try { localStorage.setItem(gmNotifReadKey(projectDir), JSON.stringify(pruned)) } catch { /* ignore */ }
    // Sync read state to the dock app's notification panel so both stay in sync
    try {
      const dockReadKey = `dock-notifications-read:${projectDir.replace(/[\\/]/g, '/').toLowerCase()}`
      const existing = localStorage.getItem(dockReadKey)
      const dockReadIds: Set<string> = existing ? new Set(JSON.parse(existing)) : new Set()
      let changed = false
      for (const id of pruned) {
        if (!dockReadIds.has(id)) { dockReadIds.add(id); changed = true }
      }
      if (changed) localStorage.setItem(dockReadKey, JSON.stringify([...dockReadIds]))
    } catch { /* ignore */ }
  }, [readIds, projectDir, notifications])

  const autoReadTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  useEffect(() => {
    const api = getDockApi()
    const norm = (p: string) => p.replace(/[\\/]/g, '/').toLowerCase()
    const cleanup = api.notifications.onShow((notification) => {
      // Only show project-scoped notifications in the matching project window
      if (notification.projectDir) {
        if (!projectDir || norm(notification.projectDir) !== norm(projectDir)) return
      }
      setNotifications((prev) => [notification, ...prev].slice(0, MAX_NOTIFICATIONS))
      // Auto-mark as read if the setting is enabled or window is focused
      if (markAllRead || document.hasFocus()) {
        setReadIds((prev) => new Set(prev).add(notification.id))
      } else if (notification.autoReadMs && notification.autoReadMs > 0) {
        const timer = setTimeout(() => {
          autoReadTimers.current.delete(notification.id)
          setReadIds((prev) => new Set(prev).add(notification.id))
        }, notification.autoReadMs)
        autoReadTimers.current.set(notification.id, timer)
      }
    })
    return () => {
      cleanup()
      for (const timer of autoReadTimers.current.values()) clearTimeout(timer)
      autoReadTimers.current.clear()
    }
  }, [markAllRead, projectDir])

  // Mark all as read when panel opens
  useEffect(() => {
    if (open) setReadIds(new Set(notifications.map((n) => n.id)))
  }, [open])

  // Listen for toast clicks marking individual notifications as read
  useEffect(() => {
    const handler = (e: Event) => {
      const id = (e as CustomEvent).detail as string
      if (id) setReadIds((prev) => new Set(prev).add(id))
    }
    window.addEventListener('notification-read', handler)
    return () => window.removeEventListener('notification-read', handler)
  }, [])

  const removeNotification = useCallback((id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id))
  }, [])

  const clearAll = useCallback(() => {
    setNotifications([])
    setReadIds(new Set())
    try {
      localStorage.removeItem(gmNotifStorageKey(projectDir))
      localStorage.removeItem(gmNotifReadKey(projectDir))
    } catch { /* ignore */ }
  }, [projectDir])

  return (
    <div className="gm-notif-dropdown" ref={ref}>
      <button className="gm-toolbar-btn" onClick={() => setOpen(!open)} title="Notifications">
        <NotificationBellIcon />
        {unreadCount > 0 && <span className="gm-notif-badge">{unreadCount > 9 ? '9+' : unreadCount}</span>}
      </button>
      {open && (
        <>
        <div className="gm-notif-backdrop" onMouseDown={() => setOpen(false)} />
        <div className="gm-notif-panel">
          <div className="gm-notif-header">
            <span className="gm-notif-title">Notifications</span>
            {notifications.length > 0 && (
              <button className="gm-notif-clear" onClick={clearAll}>Clear all</button>
            )}
          </div>
          <div className="gm-notif-list">
            {notifications.length === 0 ? (
              <div className="gm-notif-empty">No notifications</div>
            ) : (
              notifications.map((n) => (
                <div
                  key={n.id}
                  className={`gm-notif-item gm-notif-item-${n.type}${n.data?.runId ? ' gm-notif-item-clickable' : ''}`}
                  onClick={() => {
                    if (n.data?.runId) {
                      window.dispatchEvent(new CustomEvent('ci-navigate-run', { detail: n.data.runId }))
                      setOpen(false)
                    }
                  }}
                >
                  <span className="gm-notif-item-icon">{notifIcon(n.type)}</span>
                  <div className="gm-notif-item-body">
                    <div className="gm-notif-item-title">{n.title}</div>
                    <div className="gm-notif-item-msg">{n.message}</div>
                    {resolveNotifActions(n).filter((a) => a.event).map((a, i) => (
                      <button
                        key={i}
                        className="gm-notif-item-event-action"
                        onClick={(e) => {
                          e.stopPropagation()
                          if (a.event === 'ci-fix-with-claude' && n.data) {
                            getDockApi().ci.fixWithClaude(projectDir, n.data as Record<string, unknown>)
                          } else {
                            window.dispatchEvent(new CustomEvent(a.event!, { detail: n.data }))
                          }
                          setOpen(false)
                        }}
                      >
                        {a.event === 'ci-fix-with-claude' && <NotifRepairIcon />}
                        {a.label}
                      </button>
                    ))}
                  </div>
                  {resolveNotifActions(n).some((a) => a.url) && (
                    <button
                      className="gm-notif-item-action"
                      onClick={(e) => {
                        e.stopPropagation()
                        const urlAction = resolveNotifActions(n).find((a) => a.url)
                        if (urlAction?.url) getDockApi().app.openExternal(urlAction.url)
                      }}
                      title={resolveNotifActions(n).find((a) => a.url)?.label ?? 'Open'}
                    >
                      {n.data?.runId ? <ProviderIcon provider={provider} /> : <ExternalLinkMiniIcon />}
                    </button>
                  )}
                  <button
                    className="gm-notif-item-dismiss"
                    onClick={(e) => { e.stopPropagation(); removeNotification(n.id) }}
                    title="Dismiss"
                  >
                    &times;
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
        </>
      )}
    </div>
  )
})

function resolveNotifActions(n: DockNotification): NotificationAction[] {
  if (n.actions && n.actions.length > 0) return n.actions
  if (n.action) return [n.action]
  return []
}

function notifIcon(type: DockNotification['type']): string {
  switch (type) {
    case 'success': return '\u2713'
    case 'error': return '\u2717'
    case 'warning': return '\u26A0'
    default: return '\u2139'
  }
}

const NotificationBellIcon: React.FC = React.memo(() => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
  </svg>
))

const ExternalLinkMiniIcon: React.FC = React.memo(() => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    <polyline points="15 3 21 3 21 9" />
    <line x1="10" y1="14" x2="21" y2="3" />
  </svg>
))

const NotifRepairIcon: React.FC = React.memo(() => (
  <svg className="gm-notif-repair-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
  </svg>
))

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
  projectDir: string
  onSelect?: (path: string) => void
  onNavigate: (sub: GitSubmoduleInfo) => void
  onAddInFolder?: (basePath: string) => void
  onSwitchBranch: (subPath: string) => void
  onRemove?: (subPath: string) => void
  onRefresh?: () => void
}> = ({ submodules, selectedPath, projectDir, onSelect, onNavigate, onAddInFolder, onSwitchBranch, onRemove, onRefresh }) => {
  const tree = useMemo(() => buildSubmoduleTree(submodules), [submodules])
  return <>{tree.map((node) => <SubmoduleTreeNodeView key={node.name} node={node} selectedPath={selectedPath} projectDir={projectDir} onSelect={onSelect} onNavigate={onNavigate} onAddInFolder={onAddInFolder} onSwitchBranch={onSwitchBranch} onRemove={onRemove} onRefresh={onRefresh} depth={0} parentPath="" />)}</>
}

const SubmoduleTreeNodeView: React.FC<{
  node: SubmoduleTreeNode
  selectedPath?: string | null
  projectDir: string
  onSelect?: (path: string) => void
  onNavigate: (sub: GitSubmoduleInfo) => void
  onAddInFolder?: (basePath: string) => void
  onSwitchBranch: (subPath: string) => void
  onRemove?: (subPath: string) => void
  onRefresh?: () => void
  depth: number
  parentPath: string
}> = ({ node, selectedPath, projectDir, onSelect, onNavigate, onAddInFolder, onSwitchBranch, onRemove, onRefresh, depth, parentPath }) => {
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
        {ctxMenu && (
          <SubmoduleContextMenu
            x={ctxMenu.x}
            y={ctxMenu.y}
            subPath={sub.path}
            projectDir={projectDir}
            onSwitchBranch={onSwitchBranch}
            onRemove={onRemove}
            onRefresh={onRefresh}
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
        data-collapsible
        data-collapsed={collapsed}
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
        <SubmoduleTreeNodeView key={child.name} node={child} selectedPath={selectedPath} projectDir={projectDir} onSelect={onSelect} onNavigate={onNavigate} onAddInFolder={onAddInFolder} onSwitchBranch={onSwitchBranch} onRemove={onRemove} onRefresh={onRefresh} depth={depth + 1} parentPath={folderPath} />
      ))}
    </>
  )
}

// --- Stash sidebar entry with right-click context menu ---

const StashSidebarEntry: React.FC<{
  stash: GitStashEntry
  projectDir: string
  onError: (msg: string, retry?: () => Promise<void>) => void
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
    if (!r.success) onError(`Stash apply failed: ${r.error || 'Unknown error'}`, doApply)
    onRefresh()
  }

  const doPop = async () => {
    setCtxMenu(null)
    const r = await api.gitManager.stashPop(projectDir, stash.index)
    if (!r.success) onError(`Stash pop failed: ${r.error || 'Unknown error'}`, doPop)
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
        if (!r.success) onError(`Stash drop failed: ${r.error || 'Unknown error'}`)
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
  projectDir: string
  onSwitchBranch: (subPath: string) => void
  onRemove?: (subPath: string) => void
  onRefresh?: () => void
  onClose: () => void
}> = ({ x, y, subPath, projectDir, onSwitchBranch, onRemove, onRefresh, onClose }) => {
  const ref = useRef<HTMLDivElement>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  const api = getDockApi()

  const doSync = async () => {
    setBusy(true)
    await api.gitManager.syncSubmodules(projectDir, [subPath])
    setBusy(false)
    onRefresh?.()
    onClose()
  }

  const doUpdate = async () => {
    setBusy(true)
    await api.gitManager.updateSubmodules(projectDir, [subPath], true)
    setBusy(false)
    onRefresh?.()
    onClose()
  }

  return (
    <div className="gm-ctx-menu" ref={ref} style={{ left: x, top: y }}>
      <div
        className="gm-ctx-item"
        onClick={() => { onSwitchBranch(subPath); onClose() }}
      >
        Switch branch...
      </div>
      <div className="gm-ctx-separator" />
      <div className={`gm-ctx-item${busy ? ' gm-ctx-item-disabled' : ''}`} onClick={busy ? undefined : doSync}>
        Sync submodule
      </div>
      <div className={`gm-ctx-item${busy ? ' gm-ctx-item-disabled' : ''}`} onClick={busy ? undefined : doUpdate}>
        Update submodule (init)
      </div>
      <div className="gm-ctx-separator" />
      <div
        className="gm-ctx-item"
        onClick={() => { api.app.openInExplorer(projectDir + '/' + subPath); onClose() }}
      >
        Open in Explorer
      </div>
      <div className="gm-ctx-separator" />
      <div className={`gm-ctx-item${busy ? ' gm-ctx-item-disabled' : ''}`} onClick={busy ? undefined : async () => {
        setBusy(true)
        await api.gitManager.syncSubmodules(projectDir)
        await api.gitManager.updateSubmodules(projectDir, undefined, true)
        setBusy(false)
        onRefresh?.()
        onClose()
      }}>
        Sync &amp; Update all submodules
      </div>
      {onRemove && (
        <>
          <div className="gm-ctx-separator" />
          <div
            className="gm-ctx-item gm-ctx-danger"
            onClick={() => { onRemove(subPath); onClose() }}
          >
            Remove submodule
          </div>
        </>
      )}
    </div>
  )
}

const SwitchSubmoduleBranchModal: React.FC<{
  subPath: string
  projectDir: string
  onClose: () => void
  onDone: () => void
  onError: (msg: string) => void
}> = ({ subPath, projectDir, onClose, onDone, onError }) => {
  const [branches, setBranches] = useState<GitBranchInfo[]>([])
  const [filter, setFilter] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const subDir = projectDir + '/' + subPath

  useEffect(() => {
    let cancelled = false
    getDockApi().gitManager.getBranches(subDir).then((b) => {
      if (!cancelled) { setBranches(b); setLoading(false) }
    }).catch(() => {
      if (!cancelled) { setLoading(false) }
    })
    return () => { cancelled = true }
  }, [subDir])

  useEffect(() => { if (!loading) inputRef.current?.focus() }, [loading])

  const filtered = useMemo(() => {
    const q = filter.toLowerCase()
    return branches.filter((b) => b.name.toLowerCase().includes(q))
  }, [branches, filter])

  const localBranches = filtered.filter((b) => !b.remote)
  const remoteBranches = filtered.filter((b) => b.remote)

  const handleCheckout = async (name: string, isRemote: boolean) => {
    if (busy) return
    const checkoutName = isRemote ? name.replace(/^[^/]+\//, '') : name
    setBusy(true)
    try {
      const r = await getDockApi().gitManager.checkoutBranch(subDir, checkoutName)
      if (r.success) { onDone(); onClose() }
      else onError(`Switch branch failed: ${r.error || 'Unknown error'}`)
    } catch (e) {
      onError('Switch branch error: ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }

  const currentBranch = branches.find((b) => b.current)

  return (
    <div className="gm-modal-overlay" onClick={onClose}>
      <div className="gm-modal" onClick={(e) => e.stopPropagation()} style={{ maxHeight: '70vh' }}>
        <div className="gm-modal-header">
          <span>Switch branch — {subPath}</span>
          <button className="gm-modal-close" onClick={onClose}>&#10005;</button>
        </div>
        <div className="gm-modal-body" style={{ padding: '8px 12px', gap: 6 }}>
          <input
            ref={inputRef}
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter branches..."
            className="gm-modal-input"
          />
          {loading ? (
            <div style={{ color: 'var(--text-secondary)', fontSize: 12, padding: '12px 0' }}>Loading branches...</div>
          ) : branches.length === 0 ? (
            <div style={{ color: 'var(--text-secondary)', fontSize: 12, padding: '12px 0' }}>No branches found</div>
          ) : (
            <div style={{ overflow: 'auto', maxHeight: 'calc(70vh - 140px)' }}>
              {localBranches.length > 0 && (
                <>
                  <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-secondary)', padding: '6px 0 2px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Local</div>
                  {localBranches.map((b) => (
                    <div
                      key={b.name}
                      className={`gm-ctx-item${b.current ? ' gm-ctx-item-disabled' : ''}`}
                      style={{ fontSize: 12, fontFamily: 'var(--term-font-family)', opacity: b.current ? 0.5 : 1 }}
                      onClick={() => !b.current && handleCheckout(b.name, false)}
                    >
                      {b.name}{b.current ? ' (current)' : ''}
                    </div>
                  ))}
                </>
              )}
              {remoteBranches.length > 0 && (
                <>
                  <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-secondary)', padding: '6px 0 2px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Remote</div>
                  {remoteBranches.map((b) => (
                    <div
                      key={b.name}
                      className="gm-ctx-item"
                      style={{ fontSize: 12, fontFamily: 'var(--term-font-family)' }}
                      onClick={() => handleCheckout(b.name, true)}
                    >
                      {b.name}
                    </div>
                  ))}
                </>
              )}
              {filtered.length === 0 && (
                <div style={{ color: 'var(--text-secondary)', fontSize: 12, padding: '8px 0' }}>No matching branches</div>
              )}
            </div>
          )}
        </div>
        {busy && (
          <div className="gm-modal-footer" style={{ justifyContent: 'center', fontSize: 12, color: 'var(--text-secondary)' }}>
            Switching...
          </div>
        )}
      </div>
    </div>
  )
}

const TagSidebarIcon: React.FC = React.memo(() => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.6 }}>
    <path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z" />
    <line x1="7" y1="7" x2="7.01" y2="7" />
  </svg>
))

// --- SVG Icons ---

const BackIcon: React.FC = React.memo(() => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="15 18 9 12 15 6" />
  </svg>
))

const SubmoduleIcon: React.FC = React.memo(() => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
    <circle cx="12" cy="14" r="2" strokeWidth="1.5" />
  </svg>
))

const SubmoduleArrowUp: React.FC = React.memo(() => (
  <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="19" x2="12" y2="5" />
    <polyline points="5 12 12 5 19 12" />
  </svg>
))

const SubmoduleArrowDown: React.FC = React.memo(() => (
  <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="5" x2="12" y2="19" />
    <polyline points="19 12 12 19 5 12" />
  </svg>
))

const SubmoduleDirtyIcon: React.FC = React.memo(() => (
  <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
    <circle cx="8" cy="8" r="5" fill="#e0af68" />
  </svg>
))

const SubmoduleCommitIcon: React.FC = React.memo(() => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#9ece6a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="17 1 21 5 17 9" />
    <path d="M3 11V9a4 4 0 014-4h14" />
  </svg>
))

const StashIcon: React.FC = React.memo(() => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" />
    <polyline points="7.5 4.21 12 6.81 16.5 4.21" />
    <line x1="12" y1="22" x2="12" y2="6.81" />
  </svg>
))

const StashSidebarIcon: React.FC = React.memo(() => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#bb9af7" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
    <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" />
  </svg>
))

const BashIcon: React.FC = React.memo(() => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="4 17 10 11 4 5" />
    <line x1="12" y1="19" x2="20" y2="19" />
  </svg>
))

const OpenFolderIcon: React.FC = React.memo(() => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
    <line x1="12" y1="11" x2="12" y2="17" />
    <polyline points="9 14 12 11 15 14" />
  </svg>
))

const CopyIcon: React.FC = React.memo(() => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
  </svg>
))

// Provider icons and providerLabel are imported from ./ProviderIcons

const OpenFileIcon: React.FC = React.memo(() => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
    <polyline points="15 3 21 3 21 9" />
    <line x1="10" y1="14" x2="21" y2="3" />
  </svg>
))

const ShowInFolderIcon: React.FC = React.memo(() => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
    <polyline points="9 14 12 17 15 14" />
    <line x1="12" y1="10" x2="12" y2="17" />
  </svg>
))

const ResetChangeIcon: React.FC = React.memo(() => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="1 4 1 10 7 10" />
    <path d="M3.51 15a9 9 0 105.64-11.36L1 10" />
  </svg>
))

const WriteTestsIcon: React.FC = React.memo(() => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14.5 2v6.5L20 22H4L9.5 8.5V2" />
    <line x1="8" y1="2" x2="16" y2="2" />
    <line x1="6" y1="18" x2="18" y2="18" />
  </svg>
))

const ClaudeActionIcon: React.FC = React.memo(() => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3l1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5L12 3z" />
    <path d="M19 15l.5 2 2 .5-2 .5-.5 2-.5-2-2-.5 2-.5.5-2z" />
  </svg>
))

const ReferenceThisIcon: React.FC = React.memo(() => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2z" />
    <path d="M22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z" />
  </svg>
))

/** Claude action button — hover to expand action icons inline */
const ClaudeActionWheel: React.FC<{ files: string[]; commitHash?: string; commitSubject?: string; direction?: 'left' | 'right' }> = ({ files, commitHash, commitSubject, direction = 'right' }) => {
  const [open, setOpen] = useState(false)
  const leaveTimer = useRef<ReturnType<typeof setTimeout>>()

  const handleEnter = useCallback(() => {
    clearTimeout(leaveTimer.current)
    setOpen(true)
  }, [])

  const handleLeave = useCallback(() => {
    leaveTimer.current = setTimeout(() => setOpen(false), 200)
  }, [])

  return (
    <div
      className={`gm-claude-wrap${direction === 'left' ? ' gm-claude-left' : ''}`}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
    >
      <button className="gm-file-hover-btn gm-claude-trigger" title="Claude actions">
        <ClaudeActionIcon />
      </button>
      <div className={`gm-claude-actions${open ? ' open' : ''}`}>
        <button className="gm-claude-action-btn" onClick={(e) => { e.stopPropagation(); setOpen(false); sendWriteTestsTask(files, commitHash, commitSubject) }} title="Write Tests">
          <WriteTestsIcon />
        </button>
        <button className="gm-claude-action-btn" onClick={(e) => { e.stopPropagation(); setOpen(false); sendReferenceThisTask(files, commitHash, commitSubject) }} title="Reference This">
          <ReferenceThisIcon />
        </button>
      </div>
    </div>
  )
}

const FolderIcon: React.FC = React.memo(() => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.5 }}>
    <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
  </svg>
))

const SparkleIcon: React.FC = React.memo(() => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3l1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5L12 3z" />
    <path d="M19 15l.5 2 2 .5-2 .5-.5 2-.5-2-2-.5 2-.5.5-2z" />
  </svg>
))

const GitIcon: React.FC = React.memo(() => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="18" r="3" />
    <circle cx="12" cy="6" r="3" />
    <path d="M12 9v6" />
  </svg>
))

const FetchIcon: React.FC = React.memo(() => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </svg>
))

const PullIcon: React.FC = React.memo(() => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="8 17 12 21 16 17" />
    <line x1="12" y1="12" x2="12" y2="21" />
    <path d="M20.88 18.09A5 5 0 0018 9h-1.26A8 8 0 103 16.29" />
  </svg>
))

const PushIcon: React.FC = React.memo(() => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="16 16 12 12 8 16" />
    <line x1="12" y1="12" x2="12" y2="21" />
    <path d="M20.39 18.39A5 5 0 0018 9h-1.26A8 8 0 103 16.3" />
    <polyline points="16 16 12 12 8 16" />
  </svg>
))

const ChangesIcon: React.FC = React.memo(() => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="12" y1="18" x2="12" y2="12" />
    <line x1="9" y1="15" x2="15" y2="15" />
  </svg>
))

const TagIcon: React.FC = React.memo(() => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 3, flexShrink: 0 }}>
    <path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z" />
    <line x1="7" y1="7" x2="7.01" y2="7" />
  </svg>
))

const RefreshIcon: React.FC = React.memo(() => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="23 4 23 10 17 10" />
    <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
  </svg>
))

const WarningIcon: React.FC = React.memo(() => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#e0af68" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
    <line x1="12" y1="9" x2="12" y2="13" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  </svg>
))

const ConflictFileIcon: React.FC = React.memo(() => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#e0af68" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="12" y1="12" x2="12" y2="16" />
    <line x1="12" y1="18" x2="12.01" y2="18" />
  </svg>
))

const ConflictPlaceholderIcon: React.FC = React.memo(() => (
  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" opacity="0.3">
    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="9" y1="13" x2="15" y2="13" />
  </svg>
))

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

// --- Standalone commit detail window ---

const StandaloneCommitDetail: React.FC = () => {
  const loadSettings = useSettingsStore((s) => s.load)
  const [detail, setDetail] = useState<GitCommitDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const api = getDockApi()

  // Apply theme + zoom (same as GitManagerApp)
  useEffect(() => {
    loadSettings().then(() => {
      applyThemeToDocument(useSettingsStore.getState().settings)
    })
  }, [loadSettings])

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
      if (!(e.ctrlKey || e.metaKey)) return
      if (e.key === '=' || e.key === '+') { e.preventDefault(); applyZoom(zoom + STEP) }
      else if (e.key === '-') { e.preventDefault(); applyZoom(zoom - STEP) }
      else if (e.key === '0') { e.preventDefault(); applyZoom(1) }
    }
    window.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('wheel', onWheel); window.removeEventListener('keydown', onKeyDown) }
  }, [])

  useEffect(() => {
    if (!standaloneCommitHash || !projectDir) return
    setLoading(true)
    api.gitManager.getCommitDetail(projectDir, standaloneCommitHash)
      .then(setDetail)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load commit'))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="gm-app"><div className="gm-loading">Loading commit...</div></div>
  if (error) return <div className="gm-app"><div className="gm-error-bar"><span>{error}</span></div></div>
  if (!detail) return <div className="gm-app"><div className="gm-loading">No commit data</div></div>

  return (
    <div className="gm-app">
      <div className="gm-titlebar" onDoubleClick={() => api.win.maximize()}>
        <div className="gm-titlebar-left" style={{ userSelect: 'none' }}>
          <GitIcon />
          <span className="gm-titlebar-project">{detail.hash.slice(0, 8)}</span>
          <span style={{ fontSize: 11, color: 'var(--text-secondary)', marginLeft: 4 }}>{detail.subject}</span>
        </div>
        <div className="gm-titlebar-center" />
        <div className="gm-titlebar-right">
          <div className="toolbar-separator" />
          <div className="gm-win-controls">
            <button className="win-btn win-minimize" onClick={() => api.win.minimize()}>&#x2015;</button>
            <button className="win-btn win-maximize" onClick={() => api.win.maximize()}>&#9744;</button>
            <button className="win-btn win-close" onClick={() => api.win.close()}>&#10005;</button>
          </div>
        </div>
      </div>
      <div style={{ flex: 1, overflow: 'auto' }}>
        <CommitDetailPanel
          detail={detail}
          projectDir={projectDir}
          syntaxHL={true}
          onClose={() => api.win.close()}
          hideClose
        />
      </div>
    </div>
  )
}

export default standaloneCommitHash ? StandaloneCommitDetail : GitManagerApp
