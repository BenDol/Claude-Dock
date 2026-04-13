import { contextBridge, ipcRenderer, webFrame } from 'electron'
import { IPC } from '../shared/ipc-channels'
import type { Settings } from '../shared/settings-schema'
import type { PluginInfo, ProjectPluginStates, PluginToolbarAction } from '../shared/plugin-types'
import type {
  GitCommitInfo,
  GitBranchInfo,
  GitStatusResult,
  GitFileDiff,
  GitCommitDetail,
  GitLogOptions,
  GitStashEntry,
  GitSubmoduleInfo,
  GitMergeState,
  GitConflictFileContent,
  GitSearchOptions,
  GitSearchResponse
} from '../shared/git-manager-types'
import type { CiWorkflow, CiWorkflowRun, CiJob, CiSetupStatus, DockNotification } from '../shared/ci-types'
import type { BugReportInput, BugReportResult } from '../shared/bug-report-types'
import type { ClaudeTaskRequest } from '../shared/claude-task-types'
import type {
  Issue,
  IssueState,
  IssueStateReason,
  IssueCreateRequest,
  IssueUpdateRequest,
  IssueActionResult,
  IssueComment,
  IssueLabel,
  IssueUser,
  IssueMilestone,
  IssueTypeProfiles
} from '../shared/issue-types'
import type { PluginUpdateEntry } from '../shared/plugin-update-types'
import type {
  CloudProviderId,
  CloudProviderInfo,
  CloudDashboardData,
  CloudCluster,
  CloudClusterDetail,
  CloudWorkload,
  CloudWorkloadDetail,
  CloudSetupStatus
} from '../shared/cloud-types'
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
  MemoryBranchListOptions,
  MemorySearchOptions,
  MemoryMessageListOptions
} from '../shared/memory-types'

export interface UpdateInfo {
  available: boolean
  version: string
  releaseNotes: string
  downloadUrl: string
  assetName: string
  assetSize: number
}

export interface ClaudeCliStatus {
  installed: boolean
  path?: string
  version?: string
}

export interface ClaudeInstallResult {
  success: boolean
  error?: string
}

export interface ClaudePathStatus {
  inPath: boolean
  claudeDir?: string
}

export interface ClaudeFixPathResult {
  success: boolean
  error?: string
  file?: string
}

export interface GitStatus {
  installed: boolean
}

export interface GitInstallResult {
  success: boolean
  error?: string
}

export interface DockApi {
  terminal: {
    spawn: (terminalId: string, options?: { ephemeral?: boolean; claudeFlags?: string; cwd?: string; resumeId?: string }) => Promise<boolean>
    write: (terminalId: string, data: string) => Promise<void>
    resize: (terminalId: string, cols: number, rows: number) => Promise<void>
    kill: (terminalId: string) => Promise<void>
    getSessionId: (terminalId: string) => Promise<string | null>
    resumeInNative: (terminalId: string, claudeFlags?: string) => Promise<{ success: boolean; resumeCmd?: string; error?: string }>
    syncOrder: (terminalIds: string[]) => Promise<void>
    respawn: (terminalId: string, sessionId: string) => Promise<boolean>
    listSessions: (count?: number) => Promise<{ sessionId: string; timestamp: number; summary: string }[]>
    popClosedSession: () => Promise<string | null>
    onData: (callback: (terminalId: string, data: string) => void) => () => void
    onExit: (callback: (terminalId: string, exitCode: number) => void) => () => void
  }
  shell: {
    spawn: (shellId: string, shellType?: string) => Promise<boolean>
    write: (shellId: string, data: string) => Promise<void>
    resize: (shellId: string, cols: number, rows: number) => Promise<void>
    kill: (shellId: string) => Promise<void>
    onData: (callback: (shellId: string, data: string) => void) => () => void
    onExit: (callback: (shellId: string, exitCode: number) => void) => () => void
    onRunCommand: (callback: (command: string, submit: boolean, targetTerminalId: string | null, shellType: string | null, targetShellId: string | null, shellLayout: 'split' | 'stack' | null) => void) => () => void
    onClearShell: (callback: (shellId: string) => void) => () => void
    onShellEvent: (handler: (_e: any, event: any) => void) => () => void
    dismissEvents: (hashKeys: string[]) => Promise<void>
  }
  dock: {
    getInfo: () => Promise<{ id: string; projectDir: string } | null>
    restart: () => Promise<void>
    switchProject: (dir: string) => Promise<void>
  }
  settings: {
    get: () => Promise<Settings>
    set: (settings: Partial<Settings>) => Promise<void>
    setProject: (partial: Partial<Settings>, tier: 'project' | 'local') => Promise<void>
    getOrigins: () => Promise<Record<string, string>>
    resetProjectKey: (keyPath: string, tier: 'project' | 'local') => Promise<void>
    onChange: (callback: (settings: Settings) => void) => () => void
  }
  app: {
    newDock: () => Promise<void>
    pickDirectory: () => Promise<string | null>
    getRecentPaths: () => Promise<{ path: string; name: string; lastOpened: number }[]>
    removeRecentPath: (dir: string) => Promise<void>
    openDockPath: (dir: string) => Promise<void>
    focusDockPath: (dir: string) => Promise<boolean>
    openExternal: (url: string) => Promise<void>
    openInExplorer: (dir: string) => Promise<void>
    relaunch: () => Promise<void>
    closeAll: () => Promise<void>
  }
  updater: {
    check: (profile: string) => Promise<UpdateInfo>
    download: (url: string, assetName: string) => Promise<string>
    install: () => Promise<void>
    savePendingProject: (dir: string) => Promise<void>
    isLocked: () => Promise<boolean>
    hasActiveTerminals: () => Promise<boolean>
    onProgress: (callback: (downloaded: number, total: number) => void) => () => void
  }
  git: {
    check: () => Promise<GitStatus>
    install: () => Promise<GitInstallResult>
    clone: (url: string, destDir: string) => Promise<{ success: boolean; clonedPath?: string; error?: string }>
    getBranch: (projectDir: string) => Promise<string | null>
  }
  llm: {
    status: () => Promise<{ modelAvailable: boolean; serverRunning: boolean; downloading: boolean; downloadProgress: number }>
    download: () => Promise<{ success: boolean; error?: string }>
    onDownloadProgress: (callback: (progress: number) => void) => () => void
  }
  claude: {
    checkInstall: () => Promise<ClaudeCliStatus>
    install: () => Promise<ClaudeInstallResult>
    version: () => Promise<string | null>
    checkPath: () => Promise<ClaudePathStatus>
    fixPath: (claudeDir: string) => Promise<ClaudeFixPathResult>
  }
  win: {
    minimize: () => Promise<void>
    maximize: () => Promise<void>
    close: () => Promise<void>
  }
  linked: {
    checkMcp: () => Promise<{ installed: boolean }>
    installMcp: () => Promise<{ success: boolean; error?: string }>
    uninstallMcp: () => Promise<{ success: boolean; error?: string }>
    setEnabled: (enabled: boolean) => Promise<void>
    setMessaging: (enabled: boolean) => Promise<void>
  }
  plugins: {
    getList: () => Promise<PluginInfo[]>
    getStates: (projectDir: string) => Promise<ProjectPluginStates>
    setEnabled: (projectDir: string, pluginId: string, enabled: boolean) => Promise<void>
    getSetting: (projectDir: string, pluginId: string, key: string) => Promise<unknown>
    setSetting: (projectDir: string, pluginId: string, key: string, value: unknown) => Promise<void>
    isConfigured: (projectDir: string) => Promise<boolean>
    markConfigured: (projectDir: string) => Promise<void>
    getToolbarActions: () => Promise<PluginToolbarAction[]>
    getDir: () => Promise<string>
    openDir: () => Promise<void>
    resetTrust: (pluginId: string) => Promise<{ success: boolean }>
    getOverrides: () => Promise<Record<string, { version: string; hash: string; installedAt: number }>>
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
    getOpenWindows: (projectDir: string) => Promise<string[]>
    onWindowStateChanged: (callback: (data: { pluginId: string; projectDir: string; open: boolean }) => void) => () => void
  }
  gitManager: {
    isRepo: (projectDir: string) => Promise<boolean>
    open: (projectDir: string) => Promise<void>
    openCommit: (projectDir: string, commitHash: string) => Promise<void>
    openFileHistory: (projectDir: string, filePath: string) => Promise<void>
    getLog: (projectDir: string, opts?: GitLogOptions) => Promise<GitCommitInfo[]>
    getFileLog: (projectDir: string, filePath: string, opts?: GitLogOptions) => Promise<GitCommitInfo[]>
    getCommitCount: (projectDir: string) => Promise<number>
    getCommitIndex: (projectDir: string, hash: string) => Promise<number>
    getBranches: (projectDir: string) => Promise<GitBranchInfo[]>
    getStatus: (projectDir: string, fast?: boolean) => Promise<GitStatusResult>
    getDiff: (projectDir: string, filePath?: string, staged?: boolean) => Promise<GitFileDiff[]>
    getCommitDetail: (projectDir: string, hash: string) => Promise<GitCommitDetail | null>
    getFileBlob: (projectDir: string, filePath: string, ref?: string) => Promise<string | null>
    getCommitFileTree: (projectDir: string, hash: string) => Promise<{ path: string; type: 'blob' | 'tree' }[]>
    getFileAtCommit: (projectDir: string, hash: string, filePath: string) => Promise<string | null>
    grepCommit: (projectDir: string, hash: string, pattern: string) => Promise<{ path: string; line: number; text: string }[]>
    stage: (projectDir: string, paths: string[]) => Promise<{ success: boolean; error?: string }>
    unstage: (projectDir: string, paths: string[]) => Promise<{ success: boolean; error?: string }>
    commit: (projectDir: string, message: string) => Promise<{ success: boolean; hash?: string; error?: string }>
    checkoutBranch: (projectDir: string, name: string, trackRemote?: string) => Promise<{ success: boolean; error?: string }>
    createBranch: (projectDir: string, name: string, startPoint?: string) => Promise<{ success: boolean; error?: string }>
    deleteBranch: (projectDir: string, name: string, force?: boolean, options?: { deleteRemote?: boolean; deleteLocal?: boolean }) => Promise<{ success: boolean; error?: string }>
    pull: (projectDir: string, mode?: 'merge' | 'rebase') => Promise<{ success: boolean; output?: string; error?: string }>
    pullAdvanced: (projectDir: string, remote: string, branch: string, rebase: boolean, autostash: boolean, tags: boolean, prune: boolean) => Promise<{ success: boolean; output?: string; error?: string }>
    push: (projectDir: string) => Promise<{ success: boolean; output?: string; error?: string }>
    pushForceWithLease: (projectDir: string) => Promise<{ success: boolean; output?: string; error?: string }>
    pushWithTags: (projectDir: string) => Promise<{ success: boolean; output?: string; error?: string }>
    pushTag: (projectDir: string, tagName: string, force?: boolean) => Promise<{ success: boolean; error?: string }>
    cancelPush: () => Promise<{ cancelled: boolean }>
    onPushProgress: (callback: (progress: { phase: string; percent: number; detail: string }) => void) => () => void
    fetch: (projectDir: string) => Promise<{ success: boolean; output?: string; error?: string }>
    fetchSimple: (projectDir: string) => Promise<{ success: boolean; output?: string; error?: string }>
    fetchAll: (projectDir: string) => Promise<{ success: boolean; output?: string; error?: string }>
    fetchPruneAll: (projectDir: string) => Promise<{ success: boolean; output?: string; error?: string }>
    stashList: (projectDir: string) => Promise<GitStashEntry[]>
    stashSave: (projectDir: string, message?: string, flags?: string) => Promise<{ success: boolean; error?: string }>
    stashApply: (projectDir: string, index: number) => Promise<{ success: boolean; error?: string }>
    stashPop: (projectDir: string, index: number) => Promise<{ success: boolean; error?: string }>
    stashDrop: (projectDir: string, index: number) => Promise<{ success: boolean; error?: string }>
    getSubmodules: (projectDir: string) => Promise<GitSubmoduleInfo[]>
    getSubmoduleList: (projectDir: string) => Promise<GitSubmoduleInfo[]>
    onSubmoduleListRefreshed: (callback: (projectDir: string, list: GitSubmoduleInfo[]) => void) => () => void
    refreshSubmodule: (projectDir: string, subPath: string) => Promise<Partial<GitSubmoduleInfo> | null>
    generateCommitMsg: (projectDir: string) => Promise<{ success: boolean; message?: string; error?: string }>
    reset: (projectDir: string, hash: string, mode: string) => Promise<{ success: boolean; error?: string }>
    revert: (projectDir: string, hash: string) => Promise<{ success: boolean; error?: string }>
    cherryPick: (projectDir: string, hash: string) => Promise<{ success: boolean; error?: string }>
    createTag: (projectDir: string, name: string, hash: string, message?: string) => Promise<{ success: boolean; error?: string }>
    deleteTag: (projectDir: string, name: string) => Promise<{ success: boolean; error?: string }>
    getTags: (projectDir: string) => Promise<{ name: string; hash: string; date: string }[]>
    renameBranch: (projectDir: string, oldName: string, newName: string, renameRemote?: boolean) => Promise<{ success: boolean; error?: string }>
    discard: (projectDir: string, paths: string[]) => Promise<{ success: boolean; error?: string }>
    onDiscardProgress: (callback: (progress: { completed: number; total: number; path: string }) => void) => () => void
    restoreFileFromCommit: (projectDir: string, commitHash: string, filePath: string) => Promise<{ success: boolean; error?: string }>
    deleteFiles: (projectDir: string, paths: string[]) => Promise<{ success: boolean; error?: string }>
    showInFolder: (projectDir: string, filePath: string) => Promise<void>
    applyPatch: (projectDir: string, patch: string, cached: boolean, reverse: boolean, fuzzy?: boolean) => Promise<{ success: boolean; error?: string }>
    openBash: (projectDir: string) => Promise<void>
    addSubmodule: (projectDir: string, url: string, localPath?: string, branch?: string, force?: boolean) => Promise<{ success: boolean; error?: string }>
    registerSubmodule: (projectDir: string, subPath: string) => Promise<{ success: boolean; error?: string }>
    removeSubmodule: (projectDir: string, subPath: string) => Promise<{ success: boolean; error?: string }>
    syncSubmodules: (projectDir: string, subPaths?: string[]) => Promise<{ success: boolean; output?: string; error?: string }>
    updateSubmodules: (projectDir: string, subPaths?: string[], init?: boolean) => Promise<{ success: boolean; output?: string; error?: string }>
    pullRebaseSubmodules: (projectDir: string, subPaths?: string[]) => Promise<{ results: { path: string; success: boolean; output?: string; error?: string }[] }>
    forceReinitSubmodule: (projectDir: string, subPath: string) => Promise<{ success: boolean; output?: string; error?: string }>
    checkSubmoduleAccess: (projectDir: string, subPath: string) => Promise<{ accessible: boolean; url: string | null; error: string | null }>
    getRemotes: (projectDir: string) => Promise<{ name: string; fetchUrl: string; pushUrl: string }[]>
    addRemote: (projectDir: string, name: string, url: string) => Promise<{ success: boolean; error?: string }>
    removeRemote: (projectDir: string, name: string) => Promise<{ success: boolean; error?: string }>
    renameRemote: (projectDir: string, oldName: string, newName: string) => Promise<{ success: boolean; error?: string }>
    setRemoteUrl: (projectDir: string, name: string, url: string, pushUrl?: string) => Promise<{ success: boolean; error?: string }>
    getMergeState: (projectDir: string) => Promise<GitMergeState>
    getConflictContent: (projectDir: string, filePath: string) => Promise<GitConflictFileContent>
    resolveConflict: (projectDir: string, filePath: string, resolution: 'ours' | 'theirs' | 'both', chunkIndex?: number) => Promise<{ success: boolean; error?: string }>
    abortMerge: (projectDir: string) => Promise<{ success: boolean; error?: string }>
    continueMerge: (projectDir: string) => Promise<{ success: boolean; error?: string }>
    mergeBranch: (projectDir: string, branchName: string) => Promise<{ success: boolean; error?: string }>
    getBehindCount: (projectDir: string) => Promise<number>
    getSetting: (projectDir: string, key: string) => Promise<unknown>
    removeLockFile: (projectDir: string) => Promise<{ success: boolean; error?: string }>
    getIdentity: (projectDir: string) => Promise<{ name: string; email: string }>
    setIdentity: (projectDir: string, name: string, email: string, global: boolean) => Promise<{ success: boolean; error?: string }>
    search: (projectDir: string, opts: GitSearchOptions) => Promise<GitSearchResponse>
    getActiveTerminals: (projectDir: string) => Promise<{ id: string; title: string; sessionId: string }[]>
    saveFile: (projectDir: string, filePath: string, content: string) => Promise<{ success: boolean; error?: string }>
    resolveWithClaude: (projectDir: string, filePath: string, instructions: string) => Promise<{ success: boolean; error?: string }>
    previewGitignore: (projectDir: string, pattern: string) => Promise<string[]>
    addToGitignore: (projectDir: string, pattern: string, removeFromIndex: boolean) => Promise<{ success: boolean; error?: string }>
    migrateToLfs: (projectDir: string, filePaths: string[]) => Promise<{ success: boolean; message?: string; error?: string }>
    listWorktrees: (projectDir: string) => Promise<{ path: string; branch: string; head: string; isMain: boolean }[]>
    addWorktree: (projectDir: string, branch: string, targetPath?: string) => Promise<{ success: boolean; path?: string; error?: string }>
    removeWorktree: (projectDir: string, worktreePath: string, force?: boolean) => Promise<{ success: boolean; error?: string }>
    resolveWorktree: (projectDir: string, worktreePath: string, commitMessage: string, targetBranch?: string) => Promise<{ success: boolean; commitHash?: string; merged?: boolean; error?: string }>
    onReopen: (callback: () => void) => () => void
  }
  ci: {
    checkAvailable: (projectDir: string) => Promise<string | false>
    getSetupStatus: (projectDir: string) => Promise<CiSetupStatus>
    runSetupAction: (projectDir: string, actionId: string, data?: Record<string, string>) => Promise<{ success: boolean; error?: string }>
    getWorkflows: (projectDir: string) => Promise<CiWorkflow[]>
    getWorkflowRuns: (projectDir: string, workflowId: number, page: number, perPage: number) => Promise<CiWorkflowRun[]>
    getActiveRuns: (projectDir: string) => Promise<CiWorkflowRun[]>
    getRunJobs: (projectDir: string, runId: number) => Promise<CiJob[]>
    cancelRun: (projectDir: string, runId: number) => Promise<{ success: boolean; error?: string }>
    getJobLog: (projectDir: string, jobId: number) => Promise<string>
    saveJobLog: (projectDir: string, runId: number, jobId: number, jobName: string) => Promise<{ path: string; error?: string }>
    startPolling: (projectDir: string) => Promise<void>
    stopPolling: (projectDir: string) => Promise<void>
    fixWithClaude: (projectDir: string, data: Record<string, unknown>) => Promise<boolean>
    onFixWithClaude: (callback: (data: Record<string, unknown>) => void) => () => void
    rerunFailed: (projectDir: string, runId: number) => Promise<{ success: boolean; error?: string }>
    dispatchWorkflow: (projectDir: string, workflowId: number, ref: string, inputs?: Record<string, string>) => Promise<{ success: boolean; error?: string }>
    navigateToRun: (projectDir: string, runId: number) => Promise<boolean>
    onNavigateToRun: (callback: (runId: number) => void) => () => void
  }
  pr: {
    checkAvailable: (projectDir: string) => Promise<string | false>
    getSetupStatus: (projectDir: string) => Promise<CiSetupStatus>
    runSetupAction: (projectDir: string, actionId: string, data?: Record<string, string>) => Promise<{ success: boolean; error?: string }>
    list: (projectDir: string, state?: string) => Promise<import('../shared/pr-types').PullRequest[]>
    get: (projectDir: string, id: number) => Promise<import('../shared/pr-types').PullRequest | null>
    create: (projectDir: string, request: import('../shared/pr-types').PrCreateRequest) => Promise<import('../shared/pr-types').PrCreateResult>
    getDefaultBranch: (projectDir: string) => Promise<string>
    getNewUrl: (projectDir: string, sourceBranch: string, targetBranch: string) => Promise<string | null>
  }
  issues: {
    checkAvailable: (projectDir: string) => Promise<string | false>
    getSetupStatus: (projectDir: string) => Promise<CiSetupStatus>
    runSetupAction: (projectDir: string, actionId: string, data?: Record<string, string>) => Promise<{ success: boolean; error?: string }>
    list: (projectDir: string, state?: IssueState | 'all') => Promise<Issue[]>
    get: (projectDir: string, id: number) => Promise<Issue | null>
    create: (projectDir: string, request: IssueCreateRequest) => Promise<IssueActionResult>
    update: (projectDir: string, id: number, request: IssueUpdateRequest) => Promise<IssueActionResult>
    setState: (projectDir: string, id: number, state: IssueState, reason?: IssueStateReason) => Promise<IssueActionResult>
    addLabel: (projectDir: string, id: number, labels: string[]) => Promise<IssueActionResult>
    removeLabel: (projectDir: string, id: number, labels: string[]) => Promise<IssueActionResult>
    listLabels: (projectDir: string) => Promise<IssueLabel[]>
    addAssignee: (projectDir: string, id: number, logins: string[]) => Promise<IssueActionResult>
    removeAssignee: (projectDir: string, id: number, logins: string[]) => Promise<IssueActionResult>
    listAssignees: (projectDir: string) => Promise<IssueUser[]>
    listMilestones: (projectDir: string) => Promise<IssueMilestone[]>
    setMilestone: (projectDir: string, id: number, milestone: number | string | null) => Promise<IssueActionResult>
    listComments: (projectDir: string, issueId: number) => Promise<IssueComment[]>
    addComment: (projectDir: string, issueId: number, body: string) => Promise<IssueComment | null>
    updateComment: (projectDir: string, issueId: number, commentId: number | string, body: string) => Promise<IssueComment | null>
    deleteComment: (projectDir: string, issueId: number, commentId: number | string) => Promise<boolean>
    getCurrentUser: (projectDir: string) => Promise<IssueUser | null>
    fixWithClaude: (projectDir: string, data: { issueId: number; force?: boolean }) => Promise<{ success: boolean; alreadyRunning?: boolean; startedAt?: number; runId?: string; behavior?: string; behaviorSource?: string; error?: string }>
    startPolling: (projectDir: string) => Promise<void>
    stopPolling: (projectDir: string) => Promise<void>
    getTypeProfiles: (projectDir: string) => Promise<IssueTypeProfiles>
    setTypeProfiles: (projectDir: string, profiles: IssueTypeProfiles) => Promise<{ success: boolean; json?: string; error?: string }>
  }
  telemetry: {
    setConsent: (consent: boolean) => Promise<void>
    recordFeature: (key: string, value: unknown) => Promise<void>
  }
  bugReport: {
    submit: (data: BugReportInput) => Promise<BugReportResult>
  }
  notifications: {
    onShow: (callback: (notification: DockNotification) => void) => () => void
    emit: (notification: DockNotification) => void
  }
  launcher: {
    setZoom: (factor: number) => void
    getZoom: () => number
  }
  claudeTask: {
    send: (projectDir: string, task: ClaudeTaskRequest) => Promise<boolean>
    onTask: (callback: (task: ClaudeTaskRequest) => void) => () => void
  }
  pluginUpdater: {
    check: () => Promise<PluginUpdateEntry[]>
    getAvailable: () => Promise<PluginUpdateEntry[]>
    install: (pluginId: string) => Promise<{ success: boolean; error?: string }>
    installAll: () => Promise<{ success: string[]; failed: { pluginId: string; error: string }[] }>
    dismiss: (pluginId: string, version: string) => Promise<void>
    getNewOverrides: () => Promise<{ pluginId: string; pluginName: string; version: string; buildSha: string; hash: string; changelog: string }[]>
    markOverrideSeen: (pluginId: string, hash: string) => Promise<void>
    onProgress: (callback: (pluginId: string, downloaded: number, total: number) => void) => () => void
    onStateChanged: (callback: (updates: PluginUpdateEntry[]) => void) => () => void
  }
  contextMenu: {
    check: () => Promise<{ registered: boolean }>
    register: () => Promise<{ success: boolean; error?: string }>
    unregister: () => Promise<{ success: boolean; error?: string }>
  }
  usage: {
    fetch: () => Promise<{ success: boolean; data?: { spent: number; limit: number; percentage: number; lastUpdated: number }; error?: string }>
    getCached: () => Promise<{ success: boolean; data?: { spent: number; limit: number; percentage: number; lastUpdated: number }; error?: string } | null>
    setKey: (key: string) => Promise<{ success: boolean }>
    hasKey: () => Promise<{ hasKey: boolean }>
    clearKey: () => Promise<{ success: boolean }>
  }
  cloudIntegration: {
    open: (projectDir: string) => Promise<void>
    getProviders: () => Promise<CloudProviderInfo[]>
    getActiveProvider: (projectDir: string) => Promise<CloudProviderInfo | null>
    setProvider: (projectDir: string, providerId: CloudProviderId) => Promise<CloudProviderInfo | null>
    getDashboard: (projectDir: string) => Promise<CloudDashboardData | null>
    getClusters: (projectDir: string) => Promise<CloudCluster[]>
    getClusterDetail: (projectDir: string, clusterName: string) => Promise<CloudClusterDetail | null>
    getWorkloads: (projectDir: string, clusterName?: string) => Promise<CloudWorkload[]>
    getWorkloadDetail: (projectDir: string, clusterName: string, namespace: string, workloadName: string, kind: string) => Promise<CloudWorkloadDetail | null>
    getConsoleUrl: (projectDir: string, section: string, params?: Record<string, string>) => Promise<string | null>
    checkAuth: (projectDir: string) => Promise<boolean>
    reauth: (projectDir: string, command?: string) => Promise<boolean>
    getSetupStatus: (projectDir: string, providerId?: string) => Promise<CloudSetupStatus | null>
  }
  debug: {
    write: (text: string) => Promise<void>
    reportCrash: (type: string, message: string, stack: string) => Promise<void>
    openDevTools: () => Promise<void>
    openLogs: () => Promise<void>
  }
  memory: {
    open: (projectDir: string) => Promise<void>
    getAdapters: () => Promise<MemoryAdapterInfo[]>
    setAdapterEnabled: (adapterId: string, enabled: boolean) => Promise<{ success: boolean }>
    getDashboard: (adapterId?: string) => Promise<MemoryDashboardStats | null>
    getProjects: (adapterId?: string) => Promise<MemoryProject[]>
    getSessions: (opts?: MemorySessionListOptions, adapterId?: string) => Promise<MemorySession[]>
    getSession: (sessionId: number, adapterId?: string) => Promise<MemorySession | null>
    getBranches: (opts?: MemoryBranchListOptions, adapterId?: string) => Promise<MemoryBranch[]>
    getBranch: (branchId: number, adapterId?: string) => Promise<MemoryBranch | null>
    getMessages: (opts: MemoryMessageListOptions, adapterId?: string) => Promise<MemoryMessage[]>
    getTokenSnapshots: (sessionId?: number, adapterId?: string) => Promise<MemoryTokenSnapshot[]>
    getImportLog: (adapterId?: string) => Promise<MemoryImportLogEntry[]>
    search: (opts: MemorySearchOptions, adapterId?: string) => Promise<MemorySearchResult[]>
    getContextSummary: (branchId: number, adapterId?: string) => Promise<MemoryContextSummaryParsed | null>
    getDbInfo: (adapterId?: string) => Promise<{ path: string; sizeBytes: number; tables: { name: string; rowCount: number }[]; walSizeBytes: number } | null>
    refresh: (adapterId?: string) => Promise<{ success: boolean }>
    installAdapter: (adapterId: string) => Promise<{ success: boolean; results?: { cmd: string; success: boolean; output?: string; error?: string }[]; error?: string }>
    uninstallAdapter: (adapterId: string) => Promise<{ success: boolean; output?: string; error?: string }>
    getAdapterConfig: (adapterId?: string) => Promise<Record<string, unknown>>
    setAdapterConfig: (updates: Record<string, unknown>, adapterId?: string) => Promise<{ success: boolean; error?: string }>
    runMaintenance: (action: string, adapterId?: string) => Promise<{ success: boolean; output?: string; error?: string }>
    onReopen: (callback: () => void) => () => void
  }
  testRunner: {
    open: (projectDir: string) => Promise<void>
    detect: (projectDir: string) => Promise<{ adapterId: string; configFile: string; configDir: string; confidence: number }[]>
    discover: (projectDir: string, adapterId: string) => Promise<any[]>
    run: (projectDir: string, adapterId: string, testIds: string[], options?: any) => Promise<{ success: boolean; runId?: string; error?: string }>
    stop: (projectDir: string) => Promise<{ stopped: boolean }>
    getStatus: (projectDir: string) => Promise<{ running: boolean }>
    onOutput: (callback: (data: string) => void) => () => void
    onResults: (callback: (results: any) => void) => () => void
    onStatus: (callback: (status: any) => void) => () => void
  }
  workspace: {
    readDir: (projectDir: string, relativePath: string, hideIgnored?: boolean) => Promise<any[]>
    readTree: (projectDir: string, maxDepth?: number, hideIgnored?: boolean) => Promise<any[]>
    openFile: (projectDir: string, relativePath: string) => Promise<void>
    openInExplorer: (projectDir: string, relativePath: string) => Promise<void>
    rename: (projectDir: string, relativePath: string, newName: string) => Promise<{ success: boolean; error?: string }>
    delete: (projectDir: string, relativePath: string) => Promise<{ success: boolean; error?: string }>
    createFile: (projectDir: string, relativePath: string) => Promise<{ success: boolean; error?: string }>
    createFolder: (projectDir: string, relativePath: string) => Promise<{ success: boolean; error?: string }>
    moveClaude: (projectDir: string, sourcePath: string, targetDir: string) => Promise<{ success: boolean; error?: string }>
    readFile: (projectDir: string, relativePath: string) => Promise<{ content?: string; error?: string }>
    writeFile: (projectDir: string, relativePath: string, content: string) => Promise<{ success: boolean; error?: string }>
    detachEditor: (projectDir: string, tabData: string) => Promise<{ success: boolean; error?: string }>
    scanTsFiles: (projectDir: string) => Promise<{ filePath: string; content: string }[]>
    buildSymbolIndex: (projectDir: string) => Promise<{ name: string; filePath: string; line: number; column: number; kind: string }[]>
    querySymbol: (projectDir: string, name: string) => Promise<{ name: string; filePath: string; line: number; column: number; kind: string }[]>
    search: (projectDir: string, opts: { query: string; caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean; filePattern?: string }) => Promise<any>
    replace: (projectDir: string, opts: { query: string; replacement: string; filePath?: string; caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean }) => Promise<any>
    undoReplace: () => Promise<{ success: boolean; filesRestored: number; description?: string }>
    redoReplace: () => Promise<{ success: boolean; filesRestored: number; description?: string }>
    getDetachedTabs: () => Promise<string | null>
    watchStart: (projectDir: string) => Promise<void>
    watchStop: (projectDir: string) => Promise<void>
    onChanged: (callback: (changes: string[]) => void) => () => void
    onTreeRefreshed: (callback: (tree: any[]) => void) => () => void
    onHydrateTabs: (callback: (tabData: string) => void) => () => void
  }
}

const dockApi: DockApi = {
  terminal: {
    spawn: (terminalId, options) => ipcRenderer.invoke(IPC.TERMINAL_SPAWN, terminalId, options),
    write: (terminalId, data) => ipcRenderer.invoke(IPC.TERMINAL_WRITE, terminalId, data),
    resize: (terminalId, cols, rows) => ipcRenderer.invoke(IPC.TERMINAL_RESIZE, terminalId, cols, rows),
    kill: (terminalId) => ipcRenderer.invoke(IPC.TERMINAL_KILL, terminalId),
    getSessionId: (terminalId) => ipcRenderer.invoke(IPC.TERMINAL_GET_SESSION_ID, terminalId),
    resumeInNative: (terminalId, claudeFlags) => ipcRenderer.invoke(IPC.TERMINAL_RESUME_IN_NATIVE, terminalId, claudeFlags),
    syncOrder: (terminalIds) => ipcRenderer.invoke(IPC.TERMINAL_SYNC_ORDER, terminalIds),
    respawn: (terminalId, sessionId) => ipcRenderer.invoke(IPC.TERMINAL_RESPAWN, terminalId, sessionId),
    listSessions: (count) => ipcRenderer.invoke(IPC.TERMINAL_LIST_SESSIONS, count),
    popClosedSession: () => ipcRenderer.invoke(IPC.TERMINAL_POP_CLOSED_SESSION),
    onData: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, terminalId: string, data: string) => {
        callback(terminalId, data)
      }
      ipcRenderer.on(IPC.TERMINAL_DATA, handler)
      return () => ipcRenderer.removeListener(IPC.TERMINAL_DATA, handler)
    },
    onExit: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, terminalId: string, exitCode: number) => {
        callback(terminalId, exitCode)
      }
      ipcRenderer.on(IPC.TERMINAL_EXIT, handler)
      return () => ipcRenderer.removeListener(IPC.TERMINAL_EXIT, handler)
    }
  },
  shell: {
    spawn: (shellId, shellType) => ipcRenderer.invoke(IPC.SHELL_SPAWN, shellId, shellType),
    write: (shellId, data) => ipcRenderer.invoke(IPC.SHELL_WRITE, shellId, data),
    resize: (shellId, cols, rows) => ipcRenderer.invoke(IPC.SHELL_RESIZE, shellId, cols, rows),
    kill: (shellId) => ipcRenderer.invoke(IPC.SHELL_KILL, shellId),
    onData: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, shellId: string, data: string) => callback(shellId, data)
      ipcRenderer.on(IPC.SHELL_DATA, handler)
      return () => ipcRenderer.removeListener(IPC.SHELL_DATA, handler)
    },
    onExit: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, shellId: string, exitCode: number) => callback(shellId, exitCode)
      ipcRenderer.on(IPC.SHELL_EXIT, handler)
      return () => ipcRenderer.removeListener(IPC.SHELL_EXIT, handler)
    },
    onRunCommand: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, command: string, submit?: boolean, targetTerminalId?: string | null, shellType?: string | null, targetShellId?: string | null, shellLayout?: 'split' | 'stack' | null) => callback(command, submit ?? true, targetTerminalId ?? null, shellType ?? null, targetShellId ?? null, shellLayout ?? null)
      ipcRenderer.on(IPC.SHELL_RUN_COMMAND, handler)
      return () => ipcRenderer.removeListener(IPC.SHELL_RUN_COMMAND, handler)
    },
    onClearShell: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, shellId: string) => callback(shellId)
      ipcRenderer.on(IPC.SHELL_CLEAR, handler)
      return () => ipcRenderer.removeListener(IPC.SHELL_CLEAR, handler)
    },
    onShellEvent: (handler) => {
      ipcRenderer.on(IPC.SHELL_EVENT, handler)
      return () => ipcRenderer.removeListener(IPC.SHELL_EVENT, handler)
    },
    dismissEvents: (hashKeys: string[]) => ipcRenderer.invoke(IPC.SHELL_EVENT_DISMISS, hashKeys)
  },
  dock: {
    getInfo: () => ipcRenderer.invoke(IPC.DOCK_GET_INFO),
    restart: () => ipcRenderer.invoke(IPC.DOCK_RESTART),
    switchProject: (dir) => ipcRenderer.invoke(IPC.DOCK_SWITCH_PROJECT, dir)
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.SETTINGS_GET),
    set: (settings) => ipcRenderer.invoke(IPC.SETTINGS_SET, settings),
    setProject: (partial, tier) => ipcRenderer.invoke(IPC.SETTINGS_SET_PROJECT, partial, tier),
    getOrigins: () => ipcRenderer.invoke(IPC.SETTINGS_GET_ORIGINS),
    resetProjectKey: (keyPath, tier) => ipcRenderer.invoke(IPC.SETTINGS_RESET_PROJECT_KEY, keyPath, tier),
    onChange: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, settings: Settings) => {
        callback(settings)
      }
      ipcRenderer.on(IPC.SETTINGS_CHANGED, handler)
      return () => ipcRenderer.removeListener(IPC.SETTINGS_CHANGED, handler)
    }
  },
  app: {
    newDock: () => ipcRenderer.invoke(IPC.APP_NEW_DOCK),
    pickDirectory: () => ipcRenderer.invoke(IPC.APP_PICK_DIRECTORY),
    getRecentPaths: () => ipcRenderer.invoke(IPC.APP_GET_RECENT_PATHS),
    removeRecentPath: (dir) => ipcRenderer.invoke(IPC.APP_REMOVE_RECENT_PATH, dir),
    openDockPath: (dir) => ipcRenderer.invoke(IPC.APP_OPEN_DOCK_PATH, dir),
    focusDockPath: (dir) => ipcRenderer.invoke(IPC.APP_FOCUS_DOCK_PATH, dir),
    openExternal: (url) => ipcRenderer.invoke(IPC.APP_OPEN_EXTERNAL, url),
    openInExplorer: (dir) => ipcRenderer.invoke(IPC.APP_OPEN_IN_EXPLORER, dir),
    relaunch: () => ipcRenderer.invoke(IPC.APP_RELAUNCH),
    closeAll: () => ipcRenderer.invoke(IPC.APP_CLOSE_ALL)
  },
  updater: {
    check: (profile) => ipcRenderer.invoke(IPC.UPDATER_CHECK, profile),
    download: (url, assetName) => ipcRenderer.invoke(IPC.UPDATER_DOWNLOAD, url, assetName),
    install: () => ipcRenderer.invoke(IPC.UPDATER_INSTALL),
    savePendingProject: (dir) => ipcRenderer.invoke(IPC.UPDATER_SAVE_PENDING_PROJECT, dir),
    isLocked: () => ipcRenderer.invoke(IPC.UPDATER_IS_LOCKED),
    hasActiveTerminals: () => ipcRenderer.invoke(IPC.UPDATER_HAS_ACTIVE_TERMINALS),
    onProgress: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, downloaded: number, total: number) => {
        callback(downloaded, total)
      }
      ipcRenderer.on(IPC.UPDATER_PROGRESS, handler)
      return () => ipcRenderer.removeListener(IPC.UPDATER_PROGRESS, handler)
    }
  },
  git: {
    check: () => ipcRenderer.invoke(IPC.GIT_CHECK),
    install: () => ipcRenderer.invoke(IPC.GIT_INSTALL),
    clone: (url, destDir) => ipcRenderer.invoke(IPC.GIT_CLONE, url, destDir),
    getBranch: (projectDir) => ipcRenderer.invoke(IPC.GIT_GET_BRANCH, projectDir)
  },
  llm: {
    status: () => ipcRenderer.invoke(IPC.LLM_STATUS),
    download: () => ipcRenderer.invoke(IPC.LLM_DOWNLOAD),
    onDownloadProgress: (callback) => {
      const handler = (_event: unknown, progress: number) => callback(progress)
      ipcRenderer.on(IPC.LLM_DOWNLOAD_PROGRESS, handler)
      return () => ipcRenderer.removeListener(IPC.LLM_DOWNLOAD_PROGRESS, handler)
    }
  },
  claude: {
    checkInstall: () => ipcRenderer.invoke(IPC.CLAUDE_CHECK_INSTALL),
    install: () => ipcRenderer.invoke(IPC.CLAUDE_INSTALL),
    version: () => ipcRenderer.invoke(IPC.CLAUDE_VERSION),
    checkPath: () => ipcRenderer.invoke(IPC.CLAUDE_CHECK_PATH),
    fixPath: (claudeDir) => ipcRenderer.invoke(IPC.CLAUDE_FIX_PATH, claudeDir)
  },
  win: {
    minimize: () => ipcRenderer.invoke(IPC.WIN_MINIMIZE),
    maximize: () => ipcRenderer.invoke(IPC.WIN_MAXIMIZE),
    close: () => ipcRenderer.invoke(IPC.WIN_CLOSE)
  },
  linked: {
    checkMcp: () => ipcRenderer.invoke(IPC.LINKED_CHECK_MCP),
    installMcp: () => ipcRenderer.invoke(IPC.LINKED_INSTALL_MCP),
    uninstallMcp: () => ipcRenderer.invoke(IPC.LINKED_UNINSTALL_MCP),
    setEnabled: (enabled) => ipcRenderer.invoke(IPC.LINKED_SET_ENABLED, enabled),
    setMessaging: (enabled) => ipcRenderer.invoke(IPC.LINKED_SET_MESSAGING, enabled)
  },
  plugins: {
    getList: () => ipcRenderer.invoke(IPC.PLUGIN_GET_LIST),
    getStates: (projectDir) => ipcRenderer.invoke(IPC.PLUGIN_GET_STATES, projectDir),
    setEnabled: (projectDir, pluginId, enabled) => ipcRenderer.invoke(IPC.PLUGIN_SET_ENABLED, projectDir, pluginId, enabled),
    getSetting: (projectDir, pluginId, key) => ipcRenderer.invoke(IPC.PLUGIN_GET_SETTING, projectDir, pluginId, key),
    setSetting: (projectDir, pluginId, key, value) => ipcRenderer.invoke(IPC.PLUGIN_SET_SETTING, projectDir, pluginId, key, value),
    isConfigured: (projectDir) => ipcRenderer.invoke(IPC.PLUGIN_IS_CONFIGURED, projectDir),
    markConfigured: (projectDir) => ipcRenderer.invoke(IPC.PLUGIN_MARK_CONFIGURED, projectDir),
    getToolbarActions: () => ipcRenderer.invoke(IPC.PLUGIN_GET_TOOLBAR_ACTIONS),
    getDir: () => ipcRenderer.invoke(IPC.PLUGIN_GET_DIR),
    openDir: () => ipcRenderer.invoke(IPC.PLUGIN_OPEN_DIR),
    resetTrust: (pluginId: string) => ipcRenderer.invoke(IPC.PLUGIN_RESET_TRUST, pluginId),
    getOverrides: () => ipcRenderer.invoke(IPC.PLUGIN_GET_OVERRIDES),
    invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
    getOpenWindows: (projectDir) => ipcRenderer.invoke(IPC.PLUGIN_GET_OPEN_WINDOWS, projectDir),
    onWindowStateChanged: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { pluginId: string; projectDir: string; open: boolean }) => callback(data)
      ipcRenderer.on(IPC.PLUGIN_WINDOW_STATE, handler)
      return () => ipcRenderer.removeListener(IPC.PLUGIN_WINDOW_STATE, handler)
    }
  },
  gitManager: {
    isRepo: (projectDir) => ipcRenderer.invoke(IPC.GIT_MGR_IS_REPO, projectDir),
    open: (projectDir) => ipcRenderer.invoke(IPC.GIT_MGR_OPEN, projectDir),
    openCommit: (projectDir: string, commitHash: string) => ipcRenderer.invoke(IPC.GIT_MGR_OPEN_COMMIT, projectDir, commitHash),
    openFileHistory: (projectDir, filePath) => ipcRenderer.invoke(IPC.GIT_MGR_OPEN_FILE_HISTORY, projectDir, filePath),
    getLog: (projectDir, opts) => ipcRenderer.invoke(IPC.GIT_MGR_GET_LOG, projectDir, opts),
    getFileLog: (projectDir, filePath, opts) => ipcRenderer.invoke(IPC.GIT_MGR_GET_FILE_LOG, projectDir, filePath, opts),
    getCommitCount: (projectDir) => ipcRenderer.invoke(IPC.GIT_MGR_GET_COMMIT_COUNT, projectDir),
    getCommitIndex: (projectDir, hash) => ipcRenderer.invoke(IPC.GIT_MGR_GET_COMMIT_INDEX, projectDir, hash),
    getBranches: (projectDir) => ipcRenderer.invoke(IPC.GIT_MGR_GET_BRANCHES, projectDir),
    getStatus: (projectDir, fast?) => ipcRenderer.invoke(IPC.GIT_MGR_GET_STATUS, projectDir, fast),
    getDiff: (projectDir, filePath, staged) => ipcRenderer.invoke(IPC.GIT_MGR_GET_DIFF, projectDir, filePath, staged),
    getCommitDetail: (projectDir, hash) => ipcRenderer.invoke(IPC.GIT_MGR_GET_COMMIT_DETAIL, projectDir, hash),
    getFileBlob: (projectDir: string, filePath: string, ref?: string) => ipcRenderer.invoke(IPC.GIT_MGR_GET_FILE_BLOB, projectDir, filePath, ref) as Promise<string | null>,
    getCommitFileTree: (projectDir, hash) => ipcRenderer.invoke(IPC.GIT_MGR_GET_COMMIT_FILE_TREE, projectDir, hash),
    getFileAtCommit: (projectDir, hash, filePath) => ipcRenderer.invoke(IPC.GIT_MGR_GET_FILE_AT_COMMIT, projectDir, hash, filePath),
    grepCommit: (projectDir, hash, pattern) => ipcRenderer.invoke(IPC.GIT_MGR_GREP_COMMIT, projectDir, hash, pattern),
    stage: (projectDir, paths) => ipcRenderer.invoke(IPC.GIT_MGR_STAGE, projectDir, paths),
    unstage: (projectDir, paths) => ipcRenderer.invoke(IPC.GIT_MGR_UNSTAGE, projectDir, paths),
    commit: (projectDir, message) => ipcRenderer.invoke(IPC.GIT_MGR_COMMIT, projectDir, message),
    checkoutBranch: (projectDir, name, trackRemote) => ipcRenderer.invoke(IPC.GIT_MGR_CHECKOUT_BRANCH, projectDir, name, trackRemote),
    createBranch: (projectDir, name, startPoint) => ipcRenderer.invoke(IPC.GIT_MGR_CREATE_BRANCH, projectDir, name, startPoint),
    deleteBranch: (projectDir, name, force, options) => ipcRenderer.invoke(IPC.GIT_MGR_DELETE_BRANCH, projectDir, name, force, options),
    pull: (projectDir, mode) => ipcRenderer.invoke(IPC.GIT_MGR_PULL, projectDir, mode),
    pullAdvanced: (projectDir, remote, branch, rebase, autostash, tags, prune) => ipcRenderer.invoke(IPC.GIT_MGR_PULL_ADVANCED, projectDir, remote, branch, rebase, autostash, tags, prune),
    push: (projectDir) => ipcRenderer.invoke(IPC.GIT_MGR_PUSH, projectDir),
    pushForceWithLease: (projectDir) => ipcRenderer.invoke(IPC.GIT_MGR_PUSH_FORCE_WITH_LEASE, projectDir),
    pushWithTags: (projectDir) => ipcRenderer.invoke(IPC.GIT_MGR_PUSH_WITH_TAGS, projectDir),
    pushTag: (projectDir, tagName, force?) => ipcRenderer.invoke(IPC.GIT_MGR_PUSH_TAG, projectDir, tagName, force),
    cancelPush: () => ipcRenderer.invoke(IPC.GIT_MGR_CANCEL_PUSH),
    onPushProgress: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: { phase: string; percent: number; detail: string }) => callback(progress)
      ipcRenderer.on('git-manager:push-progress', handler)
      return () => ipcRenderer.removeListener('git-manager:push-progress', handler)
    },
    fetch: (projectDir) => ipcRenderer.invoke(IPC.GIT_MGR_FETCH, projectDir),
    fetchSimple: (projectDir) => ipcRenderer.invoke(IPC.GIT_MGR_FETCH_SIMPLE, projectDir),
    fetchAll: (projectDir) => ipcRenderer.invoke(IPC.GIT_MGR_FETCH_ALL, projectDir),
    fetchPruneAll: (projectDir) => ipcRenderer.invoke(IPC.GIT_MGR_FETCH_PRUNE_ALL, projectDir),
    stashList: (projectDir) => ipcRenderer.invoke(IPC.GIT_MGR_STASH_LIST, projectDir),
    stashSave: (projectDir, message, flags) => ipcRenderer.invoke(IPC.GIT_MGR_STASH_SAVE, projectDir, message, flags),
    stashApply: (projectDir, index) => ipcRenderer.invoke(IPC.GIT_MGR_STASH_APPLY, projectDir, index),
    stashPop: (projectDir, index) => ipcRenderer.invoke(IPC.GIT_MGR_STASH_POP, projectDir, index),
    stashDrop: (projectDir, index) => ipcRenderer.invoke(IPC.GIT_MGR_STASH_DROP, projectDir, index),
    getSubmodules: (projectDir) => ipcRenderer.invoke(IPC.GIT_MGR_GET_SUBMODULES, projectDir),
    getSubmoduleList: (projectDir) => ipcRenderer.invoke(IPC.GIT_MGR_GET_SUBMODULE_LIST, projectDir),
    onSubmoduleListRefreshed: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, projectDir: string, list: GitSubmoduleInfo[]) => callback(projectDir, list)
      ipcRenderer.on('gitManager:submoduleListRefreshed', handler)
      return () => ipcRenderer.removeListener('gitManager:submoduleListRefreshed', handler)
    },
    refreshSubmodule: (projectDir, subPath) => ipcRenderer.invoke(IPC.GIT_MGR_REFRESH_SUBMODULE, projectDir, subPath),
    generateCommitMsg: (projectDir) => ipcRenderer.invoke(IPC.GIT_MGR_GENERATE_COMMIT_MSG, projectDir),
    reset: (projectDir, hash, mode) => ipcRenderer.invoke(IPC.GIT_MGR_RESET, projectDir, hash, mode),
    revert: (projectDir, hash) => ipcRenderer.invoke(IPC.GIT_MGR_REVERT, projectDir, hash),
    cherryPick: (projectDir, hash) => ipcRenderer.invoke(IPC.GIT_MGR_CHERRY_PICK, projectDir, hash),
    createTag: (projectDir, name, hash, message) => ipcRenderer.invoke(IPC.GIT_MGR_CREATE_TAG, projectDir, name, hash, message),
    deleteTag: (projectDir, name) => ipcRenderer.invoke(IPC.GIT_MGR_DELETE_TAG, projectDir, name),
    getTags: (projectDir) => ipcRenderer.invoke(IPC.GIT_MGR_GET_TAGS, projectDir),
    renameBranch: (projectDir, oldName, newName, renameRemote) => ipcRenderer.invoke(IPC.GIT_MGR_RENAME_BRANCH, projectDir, oldName, newName, renameRemote),
    discard: (projectDir, paths) => ipcRenderer.invoke(IPC.GIT_MGR_DISCARD, projectDir, paths),
    onDiscardProgress: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: { completed: number; total: number; path: string }) => callback(progress)
      ipcRenderer.on('git-manager:discard-progress', handler)
      return () => ipcRenderer.removeListener('git-manager:discard-progress', handler)
    },
    restoreFileFromCommit: (projectDir, commitHash, filePath) => ipcRenderer.invoke(IPC.GIT_MGR_RESTORE_FILE_FROM_COMMIT, projectDir, commitHash, filePath),
    deleteFiles: (projectDir, paths) => ipcRenderer.invoke(IPC.GIT_MGR_DELETE_FILES, projectDir, paths),
    showInFolder: (projectDir, filePath) => ipcRenderer.invoke(IPC.GIT_MGR_SHOW_IN_FOLDER, projectDir, filePath),
    applyPatch: (projectDir, patch, cached, reverse, fuzzy) => ipcRenderer.invoke(IPC.GIT_MGR_APPLY_PATCH, projectDir, patch, cached, reverse, fuzzy),
    openBash: (projectDir) => ipcRenderer.invoke(IPC.GIT_MGR_OPEN_BASH, projectDir),
    addSubmodule: (projectDir, url, localPath, branch, force) => ipcRenderer.invoke(IPC.GIT_MGR_ADD_SUBMODULE, projectDir, url, localPath, branch, force),
    registerSubmodule: (projectDir, subPath) => ipcRenderer.invoke(IPC.GIT_MGR_REGISTER_SUBMODULE, projectDir, subPath),
    removeSubmodule: (projectDir, subPath) => ipcRenderer.invoke(IPC.GIT_MGR_REMOVE_SUBMODULE, projectDir, subPath),
    syncSubmodules: (projectDir, subPaths?) => ipcRenderer.invoke(IPC.GIT_MGR_SYNC_SUBMODULES, projectDir, subPaths),
    updateSubmodules: (projectDir, subPaths?, init?) => ipcRenderer.invoke(IPC.GIT_MGR_UPDATE_SUBMODULES, projectDir, subPaths, init),
    pullRebaseSubmodules: (projectDir, subPaths?) => ipcRenderer.invoke(IPC.GIT_MGR_PULL_REBASE_SUBMODULES, projectDir, subPaths),
    forceReinitSubmodule: (projectDir, subPath) => ipcRenderer.invoke(IPC.GIT_MGR_FORCE_REINIT_SUBMODULE, projectDir, subPath),
    checkSubmoduleAccess: (projectDir, subPath) => ipcRenderer.invoke(IPC.GIT_MGR_CHECK_SUBMODULE_ACCESS, projectDir, subPath),
    getRemotes: (projectDir) => ipcRenderer.invoke(IPC.GIT_MGR_GET_REMOTES, projectDir),
    addRemote: (projectDir, name, url) => ipcRenderer.invoke(IPC.GIT_MGR_ADD_REMOTE, projectDir, name, url),
    removeRemote: (projectDir, name) => ipcRenderer.invoke(IPC.GIT_MGR_REMOVE_REMOTE, projectDir, name),
    renameRemote: (projectDir, oldName, newName) => ipcRenderer.invoke(IPC.GIT_MGR_RENAME_REMOTE, projectDir, oldName, newName),
    setRemoteUrl: (projectDir, name, url, pushUrl) => ipcRenderer.invoke(IPC.GIT_MGR_SET_REMOTE_URL, projectDir, name, url, pushUrl),
    getMergeState: (projectDir) => ipcRenderer.invoke(IPC.GIT_MGR_GET_MERGE_STATE, projectDir),
    getConflictContent: (projectDir, filePath) => ipcRenderer.invoke(IPC.GIT_MGR_GET_CONFLICT_CONTENT, projectDir, filePath),
    resolveConflict: (projectDir, filePath, resolution, chunkIndex) => ipcRenderer.invoke(IPC.GIT_MGR_RESOLVE_CONFLICT, projectDir, filePath, resolution, chunkIndex),
    abortMerge: (projectDir) => ipcRenderer.invoke(IPC.GIT_MGR_ABORT_MERGE, projectDir),
    continueMerge: (projectDir) => ipcRenderer.invoke(IPC.GIT_MGR_CONTINUE_MERGE, projectDir),
    mergeBranch: (projectDir, branchName) => ipcRenderer.invoke(IPC.GIT_MGR_MERGE_BRANCH, projectDir, branchName),
    getBehindCount: (projectDir) => ipcRenderer.invoke(IPC.GIT_MGR_GET_BEHIND_COUNT, projectDir),
    getSetting: (projectDir, key) => ipcRenderer.invoke(IPC.GIT_MGR_GET_SETTING, projectDir, key),
    removeLockFile: (projectDir) => ipcRenderer.invoke(IPC.GIT_MGR_REMOVE_LOCK_FILE, projectDir),
    getIdentity: (projectDir) => ipcRenderer.invoke(IPC.GIT_MGR_GET_IDENTITY, projectDir),
    setIdentity: (projectDir, name, email, global) => ipcRenderer.invoke(IPC.GIT_MGR_SET_IDENTITY, projectDir, name, email, global),
    search: (projectDir, opts) => ipcRenderer.invoke(IPC.GIT_MGR_SEARCH, projectDir, opts),
    getActiveTerminals: (projectDir) => ipcRenderer.invoke(IPC.GIT_MGR_GET_ACTIVE_TERMINALS, projectDir),
    saveFile: (projectDir, filePath, content) => ipcRenderer.invoke(IPC.GIT_MGR_SAVE_FILE, projectDir, filePath, content),
    resolveWithClaude: (projectDir, filePath, instructions) => ipcRenderer.invoke(IPC.GIT_MGR_RESOLVE_WITH_CLAUDE, projectDir, filePath, instructions),
    previewGitignore: (projectDir, pattern) => ipcRenderer.invoke(IPC.GIT_MGR_PREVIEW_GITIGNORE, projectDir, pattern),
    addToGitignore: (projectDir, pattern, removeFromIndex) => ipcRenderer.invoke(IPC.GIT_MGR_ADD_TO_GITIGNORE, projectDir, pattern, removeFromIndex),
    migrateToLfs: (projectDir, filePaths) => ipcRenderer.invoke(IPC.GIT_MGR_MIGRATE_TO_LFS, projectDir, filePaths),
    listWorktrees: (projectDir) => ipcRenderer.invoke(IPC.GIT_MGR_LIST_WORKTREES, projectDir),
    addWorktree: (projectDir, branch, targetPath) => ipcRenderer.invoke(IPC.GIT_MGR_ADD_WORKTREE, projectDir, branch, targetPath),
    removeWorktree: (projectDir, worktreePath, force) => ipcRenderer.invoke(IPC.GIT_MGR_REMOVE_WORKTREE, projectDir, worktreePath, force),
    resolveWorktree: (projectDir, worktreePath, commitMessage, targetBranch) => ipcRenderer.invoke(IPC.GIT_MGR_RESOLVE_WORKTREE, projectDir, worktreePath, commitMessage, targetBranch),
    onReopen: (callback) => {
      const handler = () => callback()
      ipcRenderer.on('git-manager:reopen', handler)
      return () => ipcRenderer.removeListener('git-manager:reopen', handler)
    }
  },
  ci: {
    checkAvailable: (projectDir) => ipcRenderer.invoke(IPC.CI_CHECK_AVAILABLE, projectDir),
    getSetupStatus: (projectDir) => ipcRenderer.invoke(IPC.CI_GET_SETUP_STATUS, projectDir),
    runSetupAction: (projectDir, actionId, data) => ipcRenderer.invoke(IPC.CI_RUN_SETUP_ACTION, projectDir, actionId, data),
    getWorkflows: (projectDir) => ipcRenderer.invoke(IPC.CI_GET_WORKFLOWS, projectDir),
    getWorkflowRuns: (projectDir, workflowId, page, perPage) => ipcRenderer.invoke(IPC.CI_GET_WORKFLOW_RUNS, projectDir, workflowId, page, perPage),
    getActiveRuns: (projectDir) => ipcRenderer.invoke(IPC.CI_GET_ACTIVE_RUNS, projectDir),
    getRunJobs: (projectDir, runId) => ipcRenderer.invoke(IPC.CI_GET_RUN_JOBS, projectDir, runId),
    cancelRun: (projectDir, runId) => ipcRenderer.invoke(IPC.CI_CANCEL_RUN, projectDir, runId),
    getJobLog: (projectDir, jobId) => ipcRenderer.invoke(IPC.CI_GET_JOB_LOG, projectDir, jobId),
    saveJobLog: (projectDir, runId, jobId, jobName) => ipcRenderer.invoke(IPC.CI_SAVE_JOB_LOG, projectDir, runId, jobId, jobName),
    startPolling: (projectDir) => ipcRenderer.invoke(IPC.CI_START_POLLING, projectDir),
    stopPolling: (projectDir) => ipcRenderer.invoke(IPC.CI_STOP_POLLING, projectDir),
    fixWithClaude: (projectDir, data) => ipcRenderer.invoke(IPC.CI_FIX_WITH_CLAUDE, projectDir, data),
    onFixWithClaude: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, data: Record<string, unknown>) => callback(data)
      ipcRenderer.on('ci-fix-with-claude', handler)
      return () => ipcRenderer.removeListener('ci-fix-with-claude', handler)
    },
    rerunFailed: (projectDir, runId) => ipcRenderer.invoke(IPC.CI_RERUN_FAILED, projectDir, runId),
    dispatchWorkflow: (projectDir, workflowId, ref, inputs) => ipcRenderer.invoke(IPC.CI_DISPATCH_WORKFLOW, projectDir, workflowId, ref, inputs),
    navigateToRun: (projectDir, runId) => ipcRenderer.invoke(IPC.CI_NAVIGATE_TO_RUN, projectDir, runId),
    onNavigateToRun: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, runId: number) => callback(runId)
      ipcRenderer.on('ci-navigate-run', handler)
      return () => ipcRenderer.removeListener('ci-navigate-run', handler)
    }
  },
  pr: {
    checkAvailable: (projectDir) => ipcRenderer.invoke(IPC.PR_CHECK_AVAILABLE, projectDir),
    getSetupStatus: (projectDir) => ipcRenderer.invoke(IPC.PR_GET_SETUP_STATUS, projectDir),
    runSetupAction: (projectDir, actionId, data) => ipcRenderer.invoke(IPC.PR_RUN_SETUP_ACTION, projectDir, actionId, data),
    list: (projectDir, state) => ipcRenderer.invoke(IPC.PR_LIST, projectDir, state),
    get: (projectDir, id) => ipcRenderer.invoke(IPC.PR_GET, projectDir, id),
    create: (projectDir, request) => ipcRenderer.invoke(IPC.PR_CREATE, projectDir, request),
    getDefaultBranch: (projectDir) => ipcRenderer.invoke(IPC.PR_GET_DEFAULT_BRANCH, projectDir),
    getNewUrl: (projectDir, sourceBranch, targetBranch) => ipcRenderer.invoke(IPC.PR_GET_NEW_URL, projectDir, sourceBranch, targetBranch)
  },
  issues: {
    checkAvailable: (projectDir) => ipcRenderer.invoke(IPC.ISSUE_CHECK_AVAILABLE, projectDir),
    getSetupStatus: (projectDir) => ipcRenderer.invoke(IPC.ISSUE_GET_SETUP_STATUS, projectDir),
    runSetupAction: (projectDir, actionId, data) => ipcRenderer.invoke(IPC.ISSUE_RUN_SETUP_ACTION, projectDir, actionId, data),
    list: (projectDir, state) => ipcRenderer.invoke(IPC.ISSUE_LIST, projectDir, state),
    get: (projectDir, id) => ipcRenderer.invoke(IPC.ISSUE_GET, projectDir, id),
    create: (projectDir, request) => ipcRenderer.invoke(IPC.ISSUE_CREATE, projectDir, request),
    update: (projectDir, id, request) => ipcRenderer.invoke(IPC.ISSUE_UPDATE, projectDir, id, request),
    setState: (projectDir, id, state, reason) => ipcRenderer.invoke(IPC.ISSUE_SET_STATE, projectDir, id, state, reason),
    addLabel: (projectDir, id, labels) => ipcRenderer.invoke(IPC.ISSUE_ADD_LABEL, projectDir, id, labels),
    removeLabel: (projectDir, id, labels) => ipcRenderer.invoke(IPC.ISSUE_REMOVE_LABEL, projectDir, id, labels),
    listLabels: (projectDir) => ipcRenderer.invoke(IPC.ISSUE_LIST_LABELS, projectDir),
    addAssignee: (projectDir, id, logins) => ipcRenderer.invoke(IPC.ISSUE_ADD_ASSIGNEE, projectDir, id, logins),
    removeAssignee: (projectDir, id, logins) => ipcRenderer.invoke(IPC.ISSUE_REMOVE_ASSIGNEE, projectDir, id, logins),
    listAssignees: (projectDir) => ipcRenderer.invoke(IPC.ISSUE_LIST_ASSIGNEES, projectDir),
    listMilestones: (projectDir) => ipcRenderer.invoke(IPC.ISSUE_LIST_MILESTONES, projectDir),
    setMilestone: (projectDir, id, milestone) => ipcRenderer.invoke(IPC.ISSUE_SET_MILESTONE, projectDir, id, milestone),
    listComments: (projectDir, issueId) => ipcRenderer.invoke(IPC.ISSUE_LIST_COMMENTS, projectDir, issueId),
    addComment: (projectDir, issueId, body) => ipcRenderer.invoke(IPC.ISSUE_ADD_COMMENT, projectDir, issueId, body),
    updateComment: (projectDir, issueId, commentId, body) => ipcRenderer.invoke(IPC.ISSUE_UPDATE_COMMENT, projectDir, issueId, commentId, body),
    deleteComment: (projectDir, issueId, commentId) => ipcRenderer.invoke(IPC.ISSUE_DELETE_COMMENT, projectDir, issueId, commentId),
    getCurrentUser: (projectDir) => ipcRenderer.invoke(IPC.ISSUE_GET_CURRENT_USER, projectDir),
    fixWithClaude: (projectDir, data) => ipcRenderer.invoke(IPC.ISSUE_FIX_WITH_CLAUDE, projectDir, data),
    startPolling: (projectDir) => ipcRenderer.invoke(IPC.ISSUE_START_POLLING, projectDir),
    stopPolling: (projectDir) => ipcRenderer.invoke(IPC.ISSUE_STOP_POLLING, projectDir),
    getTypeProfiles: (projectDir) => ipcRenderer.invoke(IPC.ISSUE_GET_TYPE_PROFILES, projectDir),
    setTypeProfiles: (projectDir, profiles) => ipcRenderer.invoke(IPC.ISSUE_SET_TYPE_PROFILES, projectDir, profiles)
  },
  telemetry: {
    setConsent: (consent) => ipcRenderer.invoke(IPC.TELEMETRY_SET_CONSENT, consent),
    recordFeature: (key: string, value: unknown) => ipcRenderer.invoke(IPC.TELEMETRY_RECORD_FEATURE, key, value)
  },
  bugReport: {
    submit: (data) => ipcRenderer.invoke(IPC.BUG_REPORT_SUBMIT, data)
  },
  notifications: {
    onShow: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, notification: DockNotification) => {
        callback(notification)
      }
      ipcRenderer.on(IPC.NOTIFICATION_SHOW, handler)
      return () => ipcRenderer.removeListener(IPC.NOTIFICATION_SHOW, handler)
    },
    emit: (notification: DockNotification) => {
      if (!notification.timestamp) notification.timestamp = Date.now()
      ipcRenderer.emit(IPC.NOTIFICATION_SHOW, {} as Electron.IpcRendererEvent, notification)
    }
  },
  launcher: {
    setZoom: (factor) => webFrame.setZoomFactor(factor),
    getZoom: () => webFrame.getZoomFactor()
  },
  claudeTask: {
    send: (projectDir, task) => ipcRenderer.invoke(IPC.CLAUDE_SEND_TASK, projectDir, task),
    onTask: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, task: ClaudeTaskRequest) => callback(task)
      ipcRenderer.on('claude:task', handler)
      return () => ipcRenderer.removeListener('claude:task', handler)
    }
  },
  pluginUpdater: {
    check: () => ipcRenderer.invoke(IPC.PLUGIN_UPDATE_CHECK),
    getAvailable: () => ipcRenderer.invoke(IPC.PLUGIN_UPDATE_GET_AVAILABLE),
    install: (pluginId) => ipcRenderer.invoke(IPC.PLUGIN_UPDATE_INSTALL, pluginId),
    installAll: () => ipcRenderer.invoke(IPC.PLUGIN_UPDATE_INSTALL_ALL),
    dismiss: (pluginId, version) => ipcRenderer.invoke(IPC.PLUGIN_UPDATE_DISMISS, pluginId, version),
    getNewOverrides: () => ipcRenderer.invoke(IPC.PLUGIN_UPDATE_GET_NEW_OVERRIDES),
    markOverrideSeen: (pluginId, hash) => ipcRenderer.invoke(IPC.PLUGIN_UPDATE_MARK_OVERRIDE_SEEN, pluginId, hash),
    onProgress: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, pluginId: string, downloaded: number, total: number) => {
        callback(pluginId, downloaded, total)
      }
      ipcRenderer.on(IPC.PLUGIN_UPDATE_PROGRESS, handler)
      return () => ipcRenderer.removeListener(IPC.PLUGIN_UPDATE_PROGRESS, handler)
    },
    onStateChanged: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, updates: PluginUpdateEntry[]) => {
        callback(updates)
      }
      ipcRenderer.on(IPC.PLUGIN_UPDATE_STATE_CHANGED, handler)
      return () => ipcRenderer.removeListener(IPC.PLUGIN_UPDATE_STATE_CHANGED, handler)
    }
  },
  contextMenu: {
    check: () => ipcRenderer.invoke(IPC.CONTEXT_MENU_CHECK),
    register: () => ipcRenderer.invoke(IPC.CONTEXT_MENU_REGISTER),
    unregister: () => ipcRenderer.invoke(IPC.CONTEXT_MENU_UNREGISTER)
  },
  usage: {
    fetch: () => ipcRenderer.invoke(IPC.USAGE_FETCH),
    getCached: () => ipcRenderer.invoke(IPC.USAGE_CACHED),
    setKey: (key) => ipcRenderer.invoke(IPC.USAGE_SET_KEY, key),
    hasKey: () => ipcRenderer.invoke(IPC.USAGE_HAS_KEY),
    clearKey: () => ipcRenderer.invoke(IPC.USAGE_CLEAR_KEY)
  },
  cloudIntegration: {
    open: (projectDir) => ipcRenderer.invoke(IPC.CLOUD_OPEN, projectDir),
    getProviders: () => ipcRenderer.invoke(IPC.CLOUD_GET_PROVIDERS),
    getActiveProvider: (projectDir) => ipcRenderer.invoke(IPC.CLOUD_GET_ACTIVE_PROVIDER, projectDir),
    setProvider: (projectDir, providerId) => ipcRenderer.invoke(IPC.CLOUD_SET_PROVIDER, projectDir, providerId),
    getDashboard: (projectDir) => ipcRenderer.invoke(IPC.CLOUD_GET_DASHBOARD, projectDir),
    getClusters: async (projectDir) => {
      const r = await ipcRenderer.invoke(IPC.CLOUD_GET_CLUSTERS, projectDir)
      if (r?.error) {
        const err = new Error(r.error) as any
        err.authExpired = !!r.authExpired
        throw err
      }
      return r?.data ?? r  // handle both { data } and plain array (backward compat)
    },
    getClusterDetail: (projectDir, clusterName) => ipcRenderer.invoke(IPC.CLOUD_GET_CLUSTER_DETAIL, projectDir, clusterName),
    getWorkloads: async (projectDir, clusterName) => {
      const r = await ipcRenderer.invoke(IPC.CLOUD_GET_WORKLOADS, projectDir, clusterName)
      if (r?.error) {
        const err = new Error(r.error) as any
        err.authExpired = !!r.authExpired
        throw err
      }
      return r?.data ?? r
    },
    getWorkloadDetail: (projectDir, clusterName, namespace, workloadName, kind) => ipcRenderer.invoke(IPC.CLOUD_GET_WORKLOAD_DETAIL, projectDir, clusterName, namespace, workloadName, kind),
    getConsoleUrl: (projectDir, section, params) => ipcRenderer.invoke(IPC.CLOUD_GET_CONSOLE_URL, projectDir, section, params),
    checkAuth: (projectDir) => ipcRenderer.invoke(IPC.CLOUD_CHECK_AUTH, projectDir),
    reauth: (projectDir, command) => ipcRenderer.invoke(IPC.CLOUD_REAUTH, projectDir, command),
    getSetupStatus: (projectDir, providerId) => ipcRenderer.invoke(IPC.CLOUD_GET_SETUP_STATUS, projectDir, providerId)
  },
  debug: {
    write: (text) => ipcRenderer.invoke(IPC.DEBUG_WRITE, text),
    reportCrash: (type: string, message: string, stack: string) => ipcRenderer.invoke(IPC.DEBUG_REPORT_CRASH, type, message, stack),
    openDevTools: () => ipcRenderer.invoke(IPC.DEBUG_OPEN_DEVTOOLS),
    openLogs: () => ipcRenderer.invoke(IPC.DEBUG_OPEN_LOGS)
  },
  memory: {
    open: (projectDir) => ipcRenderer.invoke(IPC.MEMORY_OPEN, projectDir),
    getAdapters: () => ipcRenderer.invoke(IPC.MEMORY_GET_ADAPTERS),
    setAdapterEnabled: (adapterId, enabled) => ipcRenderer.invoke(IPC.MEMORY_SET_ADAPTER_ENABLED, adapterId, enabled),
    getDashboard: (adapterId?) => ipcRenderer.invoke(IPC.MEMORY_GET_DASHBOARD, adapterId),
    getProjects: (adapterId?) => ipcRenderer.invoke(IPC.MEMORY_GET_PROJECTS, adapterId),
    getSessions: (opts?, adapterId?) => ipcRenderer.invoke(IPC.MEMORY_GET_SESSIONS, opts, adapterId),
    getSession: (sessionId, adapterId?) => ipcRenderer.invoke(IPC.MEMORY_GET_SESSION, sessionId, adapterId),
    getBranches: (opts?, adapterId?) => ipcRenderer.invoke(IPC.MEMORY_GET_BRANCHES, opts, adapterId),
    getBranch: (branchId, adapterId?) => ipcRenderer.invoke(IPC.MEMORY_GET_BRANCH, branchId, adapterId),
    getMessages: (opts, adapterId?) => ipcRenderer.invoke(IPC.MEMORY_GET_MESSAGES, opts, adapterId),
    getTokenSnapshots: (sessionId?, adapterId?) => ipcRenderer.invoke(IPC.MEMORY_GET_TOKEN_SNAPSHOTS, sessionId, adapterId),
    getImportLog: (adapterId?) => ipcRenderer.invoke(IPC.MEMORY_GET_IMPORT_LOG, adapterId),
    search: (opts, adapterId?) => ipcRenderer.invoke(IPC.MEMORY_SEARCH, opts, adapterId),
    getContextSummary: (branchId, adapterId?) => ipcRenderer.invoke(IPC.MEMORY_GET_CONTEXT_SUMMARY, branchId, adapterId),
    getDbInfo: (adapterId?) => ipcRenderer.invoke(IPC.MEMORY_GET_DB_INFO, adapterId),
    refresh: (adapterId?) => ipcRenderer.invoke(IPC.MEMORY_REFRESH, adapterId),
    installAdapter: (adapterId) => ipcRenderer.invoke(IPC.MEMORY_INSTALL_ADAPTER, adapterId),
    uninstallAdapter: (adapterId) => ipcRenderer.invoke(IPC.MEMORY_UNINSTALL_ADAPTER, adapterId),
    getAdapterConfig: (adapterId?) => ipcRenderer.invoke(IPC.MEMORY_GET_ADAPTER_CONFIG, adapterId),
    setAdapterConfig: (updates, adapterId?) => ipcRenderer.invoke(IPC.MEMORY_SET_ADAPTER_CONFIG, updates, adapterId),
    runMaintenance: (action, adapterId?) => ipcRenderer.invoke(IPC.MEMORY_RUN_MAINTENANCE, action, adapterId),
    onReopen: (callback) => {
      const handler = () => callback()
      ipcRenderer.on('memory:reopen', handler)
      return () => ipcRenderer.removeListener('memory:reopen', handler)
    }
  },
  testRunner: {
    open: (projectDir) => ipcRenderer.invoke(IPC.TEST_RUNNER_OPEN, projectDir),
    detect: (projectDir) => ipcRenderer.invoke(IPC.TEST_RUNNER_DETECT, projectDir),
    discover: (projectDir, adapterId) => ipcRenderer.invoke(IPC.TEST_RUNNER_DISCOVER, projectDir, adapterId),
    run: (projectDir, adapterId, testIds, options?) => ipcRenderer.invoke(IPC.TEST_RUNNER_RUN, projectDir, adapterId, testIds, options),
    stop: (projectDir) => ipcRenderer.invoke(IPC.TEST_RUNNER_STOP, projectDir),
    getStatus: (projectDir) => ipcRenderer.invoke(IPC.TEST_RUNNER_GET_STATUS, projectDir),
    onOutput: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, data: string) => callback(data)
      ipcRenderer.on('testRunner:output', handler)
      return () => ipcRenderer.removeListener('testRunner:output', handler)
    },
    onResults: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, results: any) => callback(results)
      ipcRenderer.on('testRunner:results', handler)
      return () => ipcRenderer.removeListener('testRunner:results', handler)
    },
    onStatus: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, status: any) => callback(status)
      ipcRenderer.on('testRunner:status', handler)
      return () => ipcRenderer.removeListener('testRunner:status', handler)
    }
  },
  workspace: {
    readDir: (projectDir, relativePath, hideIgnored?) => ipcRenderer.invoke(IPC.WORKSPACE_READ_DIR, projectDir, relativePath, hideIgnored),
    readTree: (projectDir, maxDepth?, hideIgnored?) => ipcRenderer.invoke(IPC.WORKSPACE_READ_TREE, projectDir, maxDepth, hideIgnored),
    openFile: (projectDir, relativePath) => ipcRenderer.invoke(IPC.WORKSPACE_OPEN_FILE, projectDir, relativePath),
    openInExplorer: (projectDir, relativePath) => ipcRenderer.invoke(IPC.WORKSPACE_OPEN_IN_EXPLORER, projectDir, relativePath),
    rename: (projectDir, relativePath, newName) => ipcRenderer.invoke(IPC.WORKSPACE_RENAME, projectDir, relativePath, newName),
    delete: (projectDir, relativePath) => ipcRenderer.invoke(IPC.WORKSPACE_DELETE, projectDir, relativePath),
    createFile: (projectDir, relativePath) => ipcRenderer.invoke(IPC.WORKSPACE_CREATE_FILE, projectDir, relativePath),
    createFolder: (projectDir, relativePath) => ipcRenderer.invoke(IPC.WORKSPACE_CREATE_FOLDER, projectDir, relativePath),
    moveClaude: (projectDir, sourcePath, targetDir) => ipcRenderer.invoke(IPC.WORKSPACE_MOVE_CLAUDE, projectDir, sourcePath, targetDir),
    readFile: (projectDir, relativePath) => ipcRenderer.invoke(IPC.WORKSPACE_READ_FILE, projectDir, relativePath),
    writeFile: (projectDir, relativePath, content) => ipcRenderer.invoke(IPC.WORKSPACE_WRITE_FILE, projectDir, relativePath, content),
    detachEditor: (projectDir, tabData) => ipcRenderer.invoke(IPC.WORKSPACE_DETACH_EDITOR, projectDir, tabData),
    scanTsFiles: (projectDir) => ipcRenderer.invoke(IPC.WORKSPACE_SCAN_TS_FILES, projectDir),
    buildSymbolIndex: (projectDir) => ipcRenderer.invoke(IPC.WORKSPACE_BUILD_SYMBOL_INDEX, projectDir),
    querySymbol: (projectDir, name) => ipcRenderer.invoke(IPC.WORKSPACE_QUERY_SYMBOL, projectDir, name),
    search: (projectDir, opts) => ipcRenderer.invoke(IPC.WORKSPACE_SEARCH, projectDir, opts),
    replace: (projectDir, opts) => ipcRenderer.invoke(IPC.WORKSPACE_REPLACE, projectDir, opts),
    undoReplace: () => ipcRenderer.invoke(IPC.WORKSPACE_UNDO_REPLACE),
    redoReplace: () => ipcRenderer.invoke(IPC.WORKSPACE_REDO_REPLACE),
    getDetachedTabs: () => ipcRenderer.invoke('workspace:getDetachedTabs'),
    watchStart: (projectDir) => ipcRenderer.invoke(IPC.WORKSPACE_WATCH_START, projectDir),
    watchStop: (projectDir) => ipcRenderer.invoke(IPC.WORKSPACE_WATCH_STOP, projectDir),
    onChanged: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, changes: string[]) => callback(changes)
      ipcRenderer.on('workspace:changed', handler)
      return () => ipcRenderer.removeListener('workspace:changed', handler)
    },
    onTreeRefreshed: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, tree: any[]) => callback(tree)
      ipcRenderer.on('workspace:treeRefreshed', handler)
      return () => ipcRenderer.removeListener('workspace:treeRefreshed', handler)
    },
    onHydrateTabs: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, tabData: string) => callback(tabData)
      ipcRenderer.on('editor:hydrate-tabs', handler)
      return () => ipcRenderer.removeListener('editor:hydrate-tabs', handler)
    }
  }
}

contextBridge.exposeInMainWorld('dockApi', dockApi)
