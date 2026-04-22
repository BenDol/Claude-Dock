/** Commit info returned from git log */
export interface GitCommitInfo {
  hash: string
  shortHash: string
  author: string
  authorEmail: string
  date: string // ISO string
  subject: string // first line of message
  parents: string[]
  refs: string[] // branch/tag names pointing at this commit
}

/** Branch info */
export interface GitBranchInfo {
  name: string
  current: boolean
  remote: boolean
  tracking?: string // upstream ref
  ahead: number
  behind: number
}

/** Branch-membership info for a single commit ("which branches contain this commit?"). */
export interface GitBranchesForCommit {
  /** Local branches, short names (e.g. `main`, `feature/foo`). HEAD is flagged separately. */
  local: string[]
  /** Remote branches, short names with the remote prefix (e.g. `origin/main`). */
  remote: string[]
  /** Short name of the currently checked-out local branch, if it contains the commit. */
  head: string | null
}

/** File status from git status --porcelain */
export interface GitFileStatusEntry {
  path: string
  indexStatus: string // staged status char (X)
  workTreeStatus: string // unstaged status char (Y)
  oldPath?: string // for renames
  isSubmodule?: boolean // true if this entry is a submodule
  submoduleCommitChanged?: boolean // true if the submodule's recorded commit moved (C flag in porcelain v2)
  submoduleAhead?: number // commits ahead of the recorded submodule commit
  submoduleBehind?: number // commits behind the recorded submodule commit
}

/** Stash entry */
export interface GitStashEntry {
  index: number
  message: string
  hash: string
  date?: string // ISO date string for timeline positioning
  parentHash?: string // the commit this stash is based on
}

/** Options for fetching commit log */
export interface GitLogOptions {
  maxCount?: number
  skip?: number
  branch?: string // ref to show (default: all)
  search?: string // grep commit messages
}

/** A single diff hunk */
export interface GitDiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  header: string
  lines: GitDiffLine[]
}

/** A single line within a diff hunk */
export interface GitDiffLine {
  type: 'context' | 'add' | 'delete'
  content: string
  oldLineNo?: number
  newLineNo?: number
}

/** Per-file diff */
export interface GitFileDiff {
  path: string
  oldPath?: string
  status: string
  hunks: GitDiffHunk[]
  isBinary: boolean
}

/** Full commit detail including diff */
export interface GitCommitDetail extends GitCommitInfo {
  body: string
  files: GitFileDiff[]
}

/** Submodule info */
export interface GitSubmoduleInfo {
  name: string
  path: string // relative path within parent repo
  hash: string
  status: 'current' | 'modified' | 'uninitialized'
  hasDirtyWorkTree?: boolean // submodule working tree has uncommitted changes
  changeCount?: number // number of working changes inside the submodule
  branch?: string // current branch of the submodule (undefined if detached)
  isDetached?: boolean // true when HEAD is detached (e.g. after git submodule update)
  trackingBranch?: string // branch configured in .gitmodules
}

/** Worktree info */
export interface GitWorktreeInfo {
  path: string
  branch: string
  head: string
  isMain: boolean
  isBare: boolean
  isPrunable?: boolean
  changeCount?: number
  hasDirtyWorkTree?: boolean
}

/**
 * Options for the worktree resolve (commit + optional merge + remove) flow.
 * `captureBranchName` is only used when the worktree is on a detached HEAD and
 * no merge target is set — the backend creates the branch in the worktree so
 * the commit has a reachable ref after worktree removal.
 */
export interface ResolveWorktreeOptions {
  captureBranchName?: string
  deleteSourceBranch?: boolean
}

/**
 * Rich result from resolveWorktree. `success=false` with `needsCaptureBranch`
 * signals the detached-HEAD case where the UI should prompt for a branch name
 * and retry; `hasConflicts` with `mergeInProgress` signals that the merge step
 * halted with conflicts in the main repo and the worktree was preserved so the
 * user can resolve them in git-manager.
 */
export interface ResolveWorktreeResult {
  success: boolean
  commitHash?: string
  merged?: boolean
  hasConflicts?: boolean
  mergeInProgress?: boolean
  removedWorktree?: boolean
  warnings?: string[]
  needsCaptureBranch?: boolean
  error?: string
}

/** Result of `git worktree prune` — directories that were pruned. */
export interface PruneWorktreesResult {
  pruned: string[]
  error?: string
}

/** Conflicted file entry */
export interface GitConflictEntry {
  path: string
  oursStatus: string   // what our side did (A/U/D)
  theirsStatus: string // what their side did (A/U/D)
  isSubmodule?: boolean
  baseHash?: string    // submodule commit hash for common ancestor
  oursHash?: string    // submodule commit hash for ours
  theirsHash?: string  // submodule commit hash for theirs
}

/** Parsed conflict chunk within a file */
export interface GitConflictChunk {
  type: 'common' | 'conflict'
  commonLines?: string[]
  oursLines?: string[]
  theirsLines?: string[]
  startLine: number
  endLine: number
}

/** Submodule conflict info (conflicting commit hashes) */
export interface SubmoduleConflictInfo {
  baseHash: string
  oursHash: string
  theirsHash: string
  oursMessage?: string
  theirsMessage?: string
}

/** Delete conflict info (one side deleted, other modified) */
export interface DeleteConflictInfo {
  deletedBy: 'ours' | 'theirs'
  content: string  // file content from the side that kept the file
}

/** File content with parsed conflict markers */
export interface GitConflictFileContent {
  path: string
  chunks: GitConflictChunk[]
  raw: string
  submodule?: SubmoduleConflictInfo
  deleteConflict?: DeleteConflictInfo
}

/** Overall merge/rebase/cherry-pick state */
export interface GitMergeState {
  inProgress: boolean
  type: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'none'
  conflicts: GitConflictEntry[]
  mergeHead?: string
}

/** Working tree status summary */
export interface GitStatusResult {
  branch: string
  ahead: number
  behind: number
  staged: GitFileStatusEntry[]
  unstaged: GitFileStatusEntry[]
  untracked: GitFileStatusEntry[]
  conflicts: GitConflictEntry[]
}

/** Search result source — commit or working tree */
export type SearchResultSource =
  | { type: 'commit'; hash: string; shortHash: string; subject: string }
  | { type: 'working'; section: 'staged' | 'unstaged' | 'untracked' }

/** A single search result */
export interface GitSearchResult {
  id: string
  source: SearchResultSource
  filePath: string
  lineNumber?: number
  lineContent?: string
  matchType: 'subject' | 'body' | 'filepath' | 'diff-content'
  confidence: number
}

/** Search options */
export interface GitSearchOptions {
  query: string
  mode: 'log' | 'working'
  maxResults?: number
}

/** Search response */
export interface GitSearchResponse {
  results: GitSearchResult[]
  truncated: boolean
}
