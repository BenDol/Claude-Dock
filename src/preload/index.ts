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
import type { ClaudeTaskRequest } from '../shared/claude-task-types'
import type { PluginUpdateEntry } from '../shared/plugin-update-types'

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
    spawn: (terminalId: string, options?: { ephemeral?: boolean; claudeFlags?: string }) => Promise<boolean>
    write: (terminalId: string, data: string) => Promise<void>
    resize: (terminalId: string, cols: number, rows: number) => Promise<void>
    kill: (terminalId: string) => Promise<void>
    getSessionId: (terminalId: string) => Promise<string | null>
    syncOrder: (terminalIds: string[]) => Promise<void>
    onData: (callback: (terminalId: string, data: string) => void) => () => void
    onExit: (callback: (terminalId: string, exitCode: number) => void) => () => void
  }
  dock: {
    getInfo: () => Promise<{ id: string; projectDir: string } | null>
    restart: () => Promise<void>
    switchProject: (dir: string) => Promise<void>
  }
  settings: {
    get: () => Promise<Settings>
    set: (settings: Partial<Settings>) => Promise<void>
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
  }
  updater: {
    check: (profile: string) => Promise<UpdateInfo>
    download: (url: string, assetName: string) => Promise<string>
    install: () => Promise<void>
    onProgress: (callback: (downloaded: number, total: number) => void) => () => void
  }
  git: {
    check: () => Promise<GitStatus>
    install: () => Promise<GitInstallResult>
    clone: (url: string, destDir: string) => Promise<{ success: boolean; clonedPath?: string; error?: string }>
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
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
    getOpenWindows: (projectDir: string) => Promise<string[]>
    onWindowStateChanged: (callback: (data: { pluginId: string; projectDir: string; open: boolean }) => void) => () => void
  }
  gitManager: {
    isRepo: (projectDir: string) => Promise<boolean>
    open: (projectDir: string) => Promise<void>
    openCommit: (projectDir: string, commitHash: string) => Promise<void>
    getLog: (projectDir: string, opts?: GitLogOptions) => Promise<GitCommitInfo[]>
    getCommitCount: (projectDir: string) => Promise<number>
    getCommitIndex: (projectDir: string, hash: string) => Promise<number>
    getBranches: (projectDir: string) => Promise<GitBranchInfo[]>
    getStatus: (projectDir: string) => Promise<GitStatusResult>
    getDiff: (projectDir: string, filePath?: string, staged?: boolean) => Promise<GitFileDiff[]>
    getCommitDetail: (projectDir: string, hash: string) => Promise<GitCommitDetail | null>
    getFileBlob: (projectDir: string, filePath: string, ref?: string) => Promise<string | null>
    stage: (projectDir: string, paths: string[]) => Promise<{ success: boolean; error?: string }>
    unstage: (projectDir: string, paths: string[]) => Promise<{ success: boolean; error?: string }>
    commit: (projectDir: string, message: string) => Promise<{ success: boolean; hash?: string; error?: string }>
    checkoutBranch: (projectDir: string, name: string) => Promise<{ success: boolean; error?: string }>
    createBranch: (projectDir: string, name: string, startPoint?: string) => Promise<{ success: boolean; error?: string }>
    deleteBranch: (projectDir: string, name: string, force?: boolean) => Promise<{ success: boolean; error?: string }>
    pull: (projectDir: string, mode?: 'merge' | 'rebase') => Promise<{ success: boolean; output?: string; error?: string }>
    pullAdvanced: (projectDir: string, remote: string, branch: string, rebase: boolean, autostash: boolean, tags: boolean, prune: boolean) => Promise<{ success: boolean; output?: string; error?: string }>
    push: (projectDir: string) => Promise<{ success: boolean; output?: string; error?: string }>
    pushForceWithLease: (projectDir: string) => Promise<{ success: boolean; output?: string; error?: string }>
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
    generateCommitMsg: (projectDir: string) => Promise<{ success: boolean; message?: string; error?: string }>
    reset: (projectDir: string, hash: string, mode: string) => Promise<{ success: boolean; error?: string }>
    revert: (projectDir: string, hash: string) => Promise<{ success: boolean; error?: string }>
    cherryPick: (projectDir: string, hash: string) => Promise<{ success: boolean; error?: string }>
    createTag: (projectDir: string, name: string, hash: string, message?: string) => Promise<{ success: boolean; error?: string }>
    deleteTag: (projectDir: string, name: string) => Promise<{ success: boolean; error?: string }>
    getTags: (projectDir: string) => Promise<{ name: string; hash: string; date: string }[]>
    renameBranch: (projectDir: string, oldName: string, newName: string) => Promise<{ success: boolean; error?: string }>
    discard: (projectDir: string, paths: string[]) => Promise<{ success: boolean; error?: string }>
    restoreFileFromCommit: (projectDir: string, commitHash: string, filePath: string) => Promise<{ success: boolean; error?: string }>
    deleteFiles: (projectDir: string, paths: string[]) => Promise<{ success: boolean; error?: string }>
    showInFolder: (projectDir: string, filePath: string) => Promise<void>
    applyPatch: (projectDir: string, patch: string, cached: boolean, reverse: boolean, fuzzy?: boolean) => Promise<{ success: boolean; error?: string }>
    openBash: (projectDir: string) => Promise<void>
    addSubmodule: (projectDir: string, url: string, localPath?: string, branch?: string, force?: boolean) => Promise<{ success: boolean; error?: string }>
    removeSubmodule: (projectDir: string, subPath: string) => Promise<{ success: boolean; error?: string }>
    getRemotes: (projectDir: string) => Promise<{ name: string; fetchUrl: string; pushUrl: string }[]>
    addRemote: (projectDir: string, name: string, url: string) => Promise<{ success: boolean; error?: string }>
    removeRemote: (projectDir: string, name: string) => Promise<{ success: boolean; error?: string }>
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
    startPolling: (projectDir: string) => Promise<void>
    stopPolling: (projectDir: string) => Promise<void>
    fixWithClaude: (projectDir: string, data: Record<string, unknown>) => Promise<boolean>
    onFixWithClaude: (callback: (data: Record<string, unknown>) => void) => () => void
    rerunFailed: (projectDir: string, runId: number) => Promise<{ success: boolean; error?: string }>
    navigateToRun: (projectDir: string, runId: number) => Promise<boolean>
    onNavigateToRun: (callback: (runId: number) => void) => () => void
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
  debug: {
    write: (text: string) => Promise<void>
    openDevTools: () => Promise<void>
    openLogs: () => Promise<void>
  }
}

const dockApi: DockApi = {
  terminal: {
    spawn: (terminalId, options) => ipcRenderer.invoke(IPC.TERMINAL_SPAWN, terminalId, options),
    write: (terminalId, data) => ipcRenderer.invoke(IPC.TERMINAL_WRITE, terminalId, data),
    resize: (terminalId, cols, rows) => ipcRenderer.invoke(IPC.TERMINAL_RESIZE, terminalId, cols, rows),
    kill: (terminalId) => ipcRenderer.invoke(IPC.TERMINAL_KILL, terminalId),
    getSessionId: (terminalId) => ipcRenderer.invoke(IPC.TERMINAL_GET_SESSION_ID, terminalId),
    syncOrder: (terminalIds) => ipcRenderer.invoke(IPC.TERMINAL_SYNC_ORDER, terminalIds),
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
  dock: {
    getInfo: () => ipcRenderer.invoke(IPC.DOCK_GET_INFO),
    restart: () => ipcRenderer.invoke(IPC.DOCK_RESTART),
    switchProject: (dir) => ipcRenderer.invoke(IPC.DOCK_SWITCH_PROJECT, dir)
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.SETTINGS_GET),
    set: (settings) => ipcRenderer.invoke(IPC.SETTINGS_SET, settings),
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
    openInExplorer: (dir) => ipcRenderer.invoke(IPC.APP_OPEN_IN_EXPLORER, dir)
  },
  updater: {
    check: (profile) => ipcRenderer.invoke(IPC.UPDATER_CHECK, profile),
    download: (url, assetName) => ipcRenderer.invoke(IPC.UPDATER_DOWNLOAD, url, assetName),
    install: () => ipcRenderer.invoke(IPC.UPDATER_INSTALL),
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
    clone: (url, destDir) => ipcRenderer.invoke(IPC.GIT_CLONE, url, destDir)
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
    getLog: (projectDir, opts) => ipcRenderer.invoke(IPC.GIT_MGR_GET_LOG, projectDir, opts),
    getCommitCount: (projectDir) => ipcRenderer.invoke(IPC.GIT_MGR_GET_COMMIT_COUNT, projectDir),
    getCommitIndex: (projectDir, hash) => ipcRenderer.invoke(IPC.GIT_MGR_GET_COMMIT_INDEX, projectDir, hash),
    getBranches: (projectDir) => ipcRenderer.invoke(IPC.GIT_MGR_GET_BRANCHES, projectDir),
    getStatus: (projectDir) => ipcRenderer.invoke(IPC.GIT_MGR_GET_STATUS, projectDir),
    getDiff: (projectDir, filePath, staged) => ipcRenderer.invoke(IPC.GIT_MGR_GET_DIFF, projectDir, filePath, staged),
    getCommitDetail: (projectDir, hash) => ipcRenderer.invoke(IPC.GIT_MGR_GET_COMMIT_DETAIL, projectDir, hash),
    getFileBlob: (projectDir: string, filePath: string, ref?: string) => ipcRenderer.invoke(IPC.GIT_MGR_GET_FILE_BLOB, projectDir, filePath, ref) as Promise<string | null>,
    stage: (projectDir, paths) => ipcRenderer.invoke(IPC.GIT_MGR_STAGE, projectDir, paths),
    unstage: (projectDir, paths) => ipcRenderer.invoke(IPC.GIT_MGR_UNSTAGE, projectDir, paths),
    commit: (projectDir, message) => ipcRenderer.invoke(IPC.GIT_MGR_COMMIT, projectDir, message),
    checkoutBranch: (projectDir, name) => ipcRenderer.invoke(IPC.GIT_MGR_CHECKOUT_BRANCH, projectDir, name),
    createBranch: (projectDir, name, startPoint) => ipcRenderer.invoke(IPC.GIT_MGR_CREATE_BRANCH, projectDir, name, startPoint),
    deleteBranch: (projectDir, name, force) => ipcRenderer.invoke(IPC.GIT_MGR_DELETE_BRANCH, projectDir, name, force),
    pull: (projectDir, mode) => ipcRenderer.invoke(IPC.GIT_MGR_PULL, projectDir, mode),
    pullAdvanced: (projectDir, remote, branch, rebase, autostash, tags, prune) => ipcRenderer.invoke(IPC.GIT_MGR_PULL_ADVANCED, projectDir, remote, branch, rebase, autostash, tags, prune),
    push: (projectDir) => ipcRenderer.invoke(IPC.GIT_MGR_PUSH, projectDir),
    pushForceWithLease: (projectDir) => ipcRenderer.invoke(IPC.GIT_MGR_PUSH_FORCE_WITH_LEASE, projectDir),
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
    generateCommitMsg: (projectDir) => ipcRenderer.invoke(IPC.GIT_MGR_GENERATE_COMMIT_MSG, projectDir),
    reset: (projectDir, hash, mode) => ipcRenderer.invoke(IPC.GIT_MGR_RESET, projectDir, hash, mode),
    revert: (projectDir, hash) => ipcRenderer.invoke(IPC.GIT_MGR_REVERT, projectDir, hash),
    cherryPick: (projectDir, hash) => ipcRenderer.invoke(IPC.GIT_MGR_CHERRY_PICK, projectDir, hash),
    createTag: (projectDir, name, hash, message) => ipcRenderer.invoke(IPC.GIT_MGR_CREATE_TAG, projectDir, name, hash, message),
    deleteTag: (projectDir, name) => ipcRenderer.invoke(IPC.GIT_MGR_DELETE_TAG, projectDir, name),
    getTags: (projectDir) => ipcRenderer.invoke(IPC.GIT_MGR_GET_TAGS, projectDir),
    renameBranch: (projectDir, oldName, newName) => ipcRenderer.invoke(IPC.GIT_MGR_RENAME_BRANCH, projectDir, oldName, newName),
    discard: (projectDir, paths) => ipcRenderer.invoke(IPC.GIT_MGR_DISCARD, projectDir, paths),
    restoreFileFromCommit: (projectDir, commitHash, filePath) => ipcRenderer.invoke(IPC.GIT_MGR_RESTORE_FILE_FROM_COMMIT, projectDir, commitHash, filePath),
    deleteFiles: (projectDir, paths) => ipcRenderer.invoke(IPC.GIT_MGR_DELETE_FILES, projectDir, paths),
    showInFolder: (projectDir, filePath) => ipcRenderer.invoke(IPC.GIT_MGR_SHOW_IN_FOLDER, projectDir, filePath),
    applyPatch: (projectDir, patch, cached, reverse, fuzzy) => ipcRenderer.invoke(IPC.GIT_MGR_APPLY_PATCH, projectDir, patch, cached, reverse, fuzzy),
    openBash: (projectDir) => ipcRenderer.invoke(IPC.GIT_MGR_OPEN_BASH, projectDir),
    addSubmodule: (projectDir, url, localPath, branch, force) => ipcRenderer.invoke(IPC.GIT_MGR_ADD_SUBMODULE, projectDir, url, localPath, branch, force),
    removeSubmodule: (projectDir, subPath) => ipcRenderer.invoke(IPC.GIT_MGR_REMOVE_SUBMODULE, projectDir, subPath),
    getRemotes: (projectDir) => ipcRenderer.invoke(IPC.GIT_MGR_GET_REMOTES, projectDir),
    addRemote: (projectDir, name, url) => ipcRenderer.invoke(IPC.GIT_MGR_ADD_REMOTE, projectDir, name, url),
    removeRemote: (projectDir, name) => ipcRenderer.invoke(IPC.GIT_MGR_REMOVE_REMOTE, projectDir, name),
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
    startPolling: (projectDir) => ipcRenderer.invoke(IPC.CI_START_POLLING, projectDir),
    stopPolling: (projectDir) => ipcRenderer.invoke(IPC.CI_STOP_POLLING, projectDir),
    fixWithClaude: (projectDir, data) => ipcRenderer.invoke(IPC.CI_FIX_WITH_CLAUDE, projectDir, data),
    onFixWithClaude: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, data: Record<string, unknown>) => callback(data)
      ipcRenderer.on('ci-fix-with-claude', handler)
      return () => ipcRenderer.removeListener('ci-fix-with-claude', handler)
    },
    rerunFailed: (projectDir, runId) => ipcRenderer.invoke(IPC.CI_RERUN_FAILED, projectDir, runId),
    navigateToRun: (projectDir, runId) => ipcRenderer.invoke(IPC.CI_NAVIGATE_TO_RUN, projectDir, runId),
    onNavigateToRun: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, runId: number) => callback(runId)
      ipcRenderer.on('ci-navigate-run', handler)
      return () => ipcRenderer.removeListener('ci-navigate-run', handler)
    }
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
  debug: {
    write: (text) => ipcRenderer.invoke(IPC.DEBUG_WRITE, text),
    openDevTools: () => ipcRenderer.invoke(IPC.DEBUG_OPEN_DEVTOOLS),
    openLogs: () => ipcRenderer.invoke(IPC.DEBUG_OPEN_LOGS)
  }
}

contextBridge.exposeInMainWorld('dockApi', dockApi)
