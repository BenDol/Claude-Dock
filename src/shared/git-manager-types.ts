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

/** File status from git status --porcelain */
export interface GitFileStatusEntry {
  path: string
  indexStatus: string // staged status char (X)
  workTreeStatus: string // unstaged status char (Y)
  oldPath?: string // for renames
  isSubmodule?: boolean // true if this entry is a submodule
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
  branch?: string // current branch of the submodule
}

/** Conflicted file entry */
export interface GitConflictEntry {
  path: string
  oursStatus: string   // what our side did (A/U/D)
  theirsStatus: string // what their side did (A/U/D)
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

/** File content with parsed conflict markers */
export interface GitConflictFileContent {
  path: string
  chunks: GitConflictChunk[]
  raw: string
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
