import { execFile, spawn, type ChildProcess } from 'child_process'
import * as https from 'https'
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { app } from 'electron'
import type {
  GitCommitInfo,
  GitBranchInfo,
  GitFileStatusEntry,
  GitStatusResult,
  GitLogOptions,
  GitCommitDetail,
  GitFileDiff,
  GitDiffHunk,
  GitDiffLine,
  GitStashEntry,
  GitSubmoduleInfo,
  GitMergeState,
  GitConflictEntry,
  GitConflictChunk,
  GitConflictFileContent,
  GitSearchOptions,
  GitSearchResponse,
  GitSearchResult,
  SearchResultSource,
  GitWorktreeInfo,
  ResolveWorktreeOptions,
  ResolveWorktreeResult,
  PruneWorktreesResult
} from '../../../shared/git-manager-types'
import { getServices } from './services'

function gitExecRaw(cwd: string, args: string[], timeout = 30000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        // Ensure stderr and stdout are included in error message — execFile
        // may omit them depending on Node.js version, and git outputs conflict
        // details to stdout (not stderr), so we need both.
        const extra: string[] = []
        if (stderr && !err.message.includes(stderr.trim().slice(0, 50))) {
          extra.push(stderr.trim())
        }
        if (stdout && !err.message.includes(stdout.trim().slice(0, 50))) {
          extra.push(stdout.trim())
        }
        if (extra.length > 0) err.message += '\n' + extra.join('\n')
        reject(err)
      } else {
        resolve({ stdout: stdout || '', stderr: stderr || '' })
      }
    })
  })
}

/**
 * Run a git command with automatic retry on index.lock errors.
 * If the first attempt fails because another git process holds the lock,
 * wait briefly for it to finish, then remove the stale lock and retry once.
 */
async function gitExec(cwd: string, args: string[], timeout = 30000): Promise<{ stdout: string; stderr: string }> {
  try {
    return await gitExecRaw(cwd, args, timeout)
  } catch (err: any) {
    const msg = err.message || ''
    if (msg.includes('index.lock') || msg.includes('Unable to create') && msg.includes('.lock')) {
      // Wait for the other process to finish (it may be our own parallel command)
      await new Promise((r) => setTimeout(r, 500))
      // Remove the lock if it's still there (stale from a crashed process)
      try {
        const lockPath = require('path').join(cwd, '.git', 'index.lock')
        require('fs').unlinkSync(lockPath)
        getServices().log(`[git-manager] removed stale index.lock in ${cwd}`)
      } catch { /* lock may have been released naturally */ }
      // Retry once
      return gitExecRaw(cwd, args, timeout)
    }
    throw err
  }
}

function gitExecStdin(cwd: string, args: string[], stdin: string, timeout = 30000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = execFile('git', args, { cwd, timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        if (stderr && !err.message.includes(stderr.trim().slice(0, 50))) {
          err.message += '\n' + stderr
        }
        reject(err)
      } else {
        resolve({ stdout: stdout || '', stderr: stderr || '' })
      }
    })
    if (proc.stdin) {
      proc.stdin.on('error', () => {}) // suppress EPIPE if process exits before stdin flush
      proc.stdin.write(stdin)
      proc.stdin.end()
    }
  })
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await gitExec(cwd, ['rev-parse', '--is-inside-work-tree'], 5000)
    return true
  } catch (err) {
    getServices().log(`[git-manager] isGitRepo(${cwd}): false —`, err instanceof Error ? err.message.split('\n')[0] : err)
    return false
  }
}

/**
 * Check that `cwd` is actually the root of its own git repository, not just
 * a subdirectory inside a parent repo.  Used when navigating into submodules
 * to detect broken/uninitialized submodules whose .git reference is missing,
 * which would cause git commands to silently operate on the parent repo.
 */
export async function isGitRoot(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await gitExec(cwd, ['rev-parse', '--show-toplevel'], 5000)
    const toplevel = stdout.trim().replace(/\\/g, '/').replace(/\/$/, '').toLowerCase()
    const expected = cwd.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase()
    return toplevel === expected
  } catch {
    return false
  }
}

// --- Log ---

const LOG_FORMAT = '%H%n%h%n%an%n%ae%n%aI%n%s%n%P%n%D%n---END---'

function parseLogOutput(output: string): GitCommitInfo[] {
  const commits: GitCommitInfo[] = []
  const blocks = output.split(/---END---\n?/)
  for (const block of blocks) {
    // Don't use trim() — it strips trailing empty lines (parents/refs on root commits)
    const lines = block.split('\n')
    if (lines.length < 6 || !lines[0]) continue
    commits.push({
      hash: lines[0],
      shortHash: lines[1] || '',
      author: lines[2] || '',
      authorEmail: lines[3] || '',
      date: lines[4] || '',
      subject: lines[5] || '',
      parents: (lines[6] || '').split(' ').filter(Boolean),
      refs: (lines[7] || '').split(',').map((r) => r.trim()).filter(Boolean)
    })
  }
  return commits
}

export async function getLog(cwd: string, opts: GitLogOptions = {}): Promise<GitCommitInfo[]> {
  const args = ['log', `--format=${LOG_FORMAT}`]
  args.push(`--max-count=${opts.maxCount ?? 200}`)
  if (opts.skip) args.push(`--skip=${opts.skip}`)
  if (opts.search) args.push(`--grep=${opts.search}`)
  if (opts.branch) {
    args.push(opts.branch)
  } else {
    args.push('--all')
  }
  try {
    const { stdout } = await gitExec(cwd, args, 15000)
    return parseLogOutput(stdout)
  } catch (err) {
    getServices().logError('[git-manager] getLog failed:', err)
    return []
  }
}

/** Get commit history for a specific file. Uses --follow to track renames. */
export async function getFileLog(cwd: string, filePath: string, opts: GitLogOptions = {}): Promise<GitCommitInfo[]> {
  const args = ['log', `--format=${LOG_FORMAT}`, '--follow']
  args.push(`--max-count=${opts.maxCount ?? 200}`)
  if (opts.skip) args.push(`--skip=${opts.skip}`)
  if (opts.branch) {
    args.push(opts.branch)
  } else {
    args.push('--all')
  }
  args.push('--', filePath)
  try {
    const { stdout } = await gitExec(cwd, args, 15000)
    return parseLogOutput(stdout)
  } catch (err) {
    getServices().logError('[git-manager] getFileLog failed:', err)
    return []
  }
}

export async function getCommitCount(cwd: string): Promise<number> {
  try {
    const { stdout } = await gitExec(cwd, ['rev-list', '--all', '--count'], 5000)
    return parseInt(stdout.trim(), 10) || 0
  } catch {
    return 0
  }
}

export async function getCommitIndex(cwd: string, hash: string): Promise<number> {
  try {
    const { stdout } = await gitExec(cwd, ['log', '--all', '--format=%H'], 15000)
    if (!stdout.trim()) return -1
    const lines = stdout.trim().split('\n')
    const idx = lines.findIndex((l) => l.startsWith(hash) || hash.startsWith(l))
    return idx
  } catch {
    return -1
  }
}

// --- Branches ---

export async function getBranches(cwd: string): Promise<GitBranchInfo[]> {
  const branches: GitBranchInfo[] = []

  // Fetch local and remote branches in a single git call
  try {
    const { stdout } = await gitExec(cwd, [
      'for-each-ref',
      '--format=%(refname)%09%(refname:short)%09%(upstream:short)%09%(upstream:track)%09%(HEAD)',
      'refs/heads/', 'refs/remotes/'
    ], 10000)

    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue
      const [refname, rawName, tracking, trackInfo, head] = line.split('\t')
      if (!rawName) continue

      if (refname.startsWith('refs/heads/')) {
        // Local branch
        if (/^HEAD(\/|$)/i.test(rawName)) continue
        const name = rawName.replace(/^heads?\//i, '')
        let ahead = 0, behind = 0
        if (trackInfo) {
          const aheadMatch = trackInfo.match(/ahead (\d+)/)
          const behindMatch = trackInfo.match(/behind (\d+)/)
          if (aheadMatch) ahead = parseInt(aheadMatch[1], 10)
          if (behindMatch) behind = parseInt(behindMatch[1], 10)
        }
        branches.push({
          name,
          current: head === '*',
          remote: false,
          tracking: tracking || undefined,
          ahead,
          behind
        })
      } else if (refname.startsWith('refs/remotes/')) {
        // Remote branch
        if (rawName.endsWith('/HEAD') || /\/HEAD$/i.test(rawName)) continue
        const name = rawName.replace(/^([^/]+\/)heads\//i, '$1')
        branches.push({
          name,
          current: false,
          remote: true,
          ahead: 0,
          behind: 0
        })
      }
    }
  } catch (err) {
    getServices().logError('[git-manager] getBranches failed:', err)
  }

  // If no local branch is marked as current, HEAD is detached — add a synthetic entry
  if (!branches.some((b) => b.current)) {
    try {
      const { stdout: hashOut } = await gitExec(cwd, ['rev-parse', '--short', 'HEAD'], 5000)
      const shortHash = hashOut.trim()
      if (shortHash) {
        branches.unshift({
          name: `(detached at ${shortHash})`,
          current: true,
          remote: false,
          ahead: 0,
          behind: 0
        })
      }
    } catch {
      // ignore — empty repo or other edge case
    }
  }

  return branches
}

// --- Status ---

function parseStatusChar(c: string): string {
  const map: Record<string, string> = {
    'M': 'modified',
    'A': 'added',
    'D': 'deleted',
    'R': 'renamed',
    'C': 'copied',
    'U': 'unmerged',
    'T': 'typechange',
    '?': 'untracked',
    '!': 'ignored'
  }
  return map[c] || c
}

/**
 * @param fast If true, uses -unormal instead of -uall for faster polling.
 *   This collapses untracked directories but is significantly faster for repos
 *   with large working trees or LFS files.
 */
export async function getStatus(cwd: string, fast?: boolean): Promise<GitStatusResult> {
  const result: GitStatusResult = {
    branch: '',
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicts: []
  }

  try {
    const { stdout } = await gitExec(cwd, ['status', '--porcelain=v2', '--branch', '-z', fast ? '-unormal' : '-uall'], 10000)
    const entries = stdout.split('\0')

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]
      if (!entry) continue

      if (entry.startsWith('# branch.head ')) {
        result.branch = entry.slice('# branch.head '.length)
      } else if (entry.startsWith('# branch.ab ')) {
        const match = entry.match(/\+(\d+) -(\d+)/)
        if (match) {
          result.ahead = parseInt(match[1], 10)
          result.behind = parseInt(match[2], 10)
        }
      } else if (entry.startsWith('1 ') || entry.startsWith('2 ')) {
        // Changed entry. Format: 1 XY sub mH mI mW hH hI path
        // or rename: 2 XY sub mH mI mW hH hI X### path\0origPath
        const parts = entry.split(' ')
        const xy = parts[1]
        const sub = parts[2] // N... for normal files, S<c><m><u> for submodules
        const x = xy[0] // index/staged
        const y = xy[1] // worktree/unstaged
        const isRename = entry.startsWith('2 ')
        const isSubmodule = sub.startsWith('S')
        // Rename entries (type 2) have an extra score field at index 8 (e.g. R098)
        const path = parts.slice(isRename ? 9 : 8).join(' ')
        let oldPath: string | undefined

        if (isRename) {
          oldPath = entries[++i] // next null-separated entry is the original path
        }

        const fileEntry: GitFileStatusEntry = {
          path,
          indexStatus: x,
          workTreeStatus: y,
          oldPath,
          isSubmodule: isSubmodule || undefined
        }

        if (x !== '.' && x !== '?') {
          result.staged.push({ ...fileEntry, indexStatus: parseStatusChar(x) })
        }
        if (y !== '.' && y !== '?') {
          result.unstaged.push({ ...fileEntry, workTreeStatus: parseStatusChar(y) })
        }
      } else if (entry.startsWith('u ')) {
        // Unmerged entry: u XY sub m1 m2 m3 mW h1 h2 h3 path
        const parts = entry.split(' ')
        const xy = parts[1]
        const sub = parts[2]
        const h1 = parts[7]  // base (common ancestor)
        const h2 = parts[8]  // ours
        const h3 = parts[9]  // theirs
        const filePath = parts.slice(10).join(' ')
        const isSubmodule = sub.startsWith('S')
        const conflictEntry: GitConflictEntry = {
          path: filePath,
          oursStatus: xy[0],
          theirsStatus: xy[1]
        }
        if (isSubmodule) {
          conflictEntry.isSubmodule = true
          conflictEntry.baseHash = h1
          conflictEntry.oursHash = h2
          conflictEntry.theirsHash = h3
        }
        result.conflicts.push(conflictEntry)
      } else if (entry.startsWith('? ')) {
        const filePath = entry.slice(2)
        const isNestedRepo = filePath.endsWith('/') && fs.existsSync(path.join(cwd, filePath, '.git'))
        result.untracked.push({
          path: filePath,
          indexStatus: '?',
          workTreeStatus: '?',
          isSubmodule: isNestedRepo || undefined
        })
      }
    }
  } catch (err) {
    // Suppress noisy logging for non-git directories (polls every few seconds)
    const msg = err instanceof Error ? err.message : ''
    if (!msg.includes('not a git repository')) {
      getServices().logError('[git-manager] getStatus failed:', err)
    }
    // Try fallback for branch name
    try {
      const { stdout } = await gitExec(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], 5000)
      result.branch = stdout.trim()
    } catch { /* ignore */ }
  }

  // Compute ahead/behind commit counts for submodule entries
  const stagedSubs = result.staged.filter(f => f.isSubmodule)
  const unstagedSubs = result.unstaged.filter(f => f.isSubmodule)
  if (stagedSubs.length > 0 || unstagedSubs.length > 0) {
    const promises: Promise<void>[] = []
    if (stagedSubs.length > 0) {
      promises.push(
        gitExec(cwd, ['diff', '--cached', '--submodule=log'], 5000)
          .then(({ stdout }) => applySubmoduleCounts(stdout, stagedSubs))
          .catch(() => {})
      )
    }
    if (unstagedSubs.length > 0) {
      promises.push(
        gitExec(cwd, ['diff', '--submodule=log'], 5000)
          .then(({ stdout }) => applySubmoduleCounts(stdout, unstagedSubs))
          .catch(() => {})
      )
    }
    await Promise.all(promises)
  }

  return result
}

/** Parse `git diff --submodule=log` output and attach ahead/behind counts */
function applySubmoduleCounts(output: string, entries: GitFileStatusEntry[]): void {
  // Format: "Submodule <path> <old>..<new>:\n  > msg\n  > msg\n"
  // Or rewind: "Submodule <path> <new>..<old> (rewind):\n  < msg\n"
  // Only match header lines that end with a colon (commit log blocks),
  // not "Submodule <path> contains modified/untracked content" lines.
  const blocks = output.split(/^(?=Submodule )/m)
  for (const block of blocks) {
    const headerMatch = block.match(/^Submodule (\S+) [0-9a-f]+\.\.[0-9a-f]+.*:/)
    if (!headerMatch) continue
    const subPath = headerMatch[1]
    const entry = entries.find(e => e.path === subPath)
    if (!entry) continue

    let ahead = 0
    let behind = 0
    const lines = block.split('\n')
    // Skip the header line, only count commit log lines (indented > or <)
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]
      if (/^\s+> /.test(line)) ahead++
      else if (/^\s+< /.test(line)) behind++
    }
    entry.submoduleAhead = ahead
    entry.submoduleBehind = behind
  }
}

// --- Diff ---

function parseDiffOutput(output: string): GitFileDiff[] {
  const files: GitFileDiff[] = []
  // Split by diff headers
  const diffBlocks = output.split(/^diff --git /m).filter(Boolean)

  for (const block of diffBlocks) {
    const lines = block.split('\n')
    const headerLine = lines[0] || ''
    // Extract paths from "a/path b/path"
    const pathMatch = headerLine.match(/a\/(.+?) b\/(.+)/)
    const path = pathMatch ? pathMatch[2] : headerLine
    const oldPath = pathMatch && pathMatch[1] !== pathMatch[2] ? pathMatch[1] : undefined

    // Detect status from diff header lines
    let status = 'modified'
    if (block.includes('new file mode')) status = 'added'
    else if (block.includes('deleted file mode')) status = 'deleted'
    else if (oldPath) status = 'renamed'

    // Detect binary
    if (block.includes('Binary files')) {
      files.push({ path, oldPath, status, hunks: [], isBinary: true })
      continue
    }

    const hunks: GitDiffHunk[] = []
    let currentHunk: GitDiffHunk | null = null
    let oldLineNo = 0
    let newLineNo = 0

    for (const line of lines) {
      const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)/)
      if (hunkMatch) {
        currentHunk = {
          oldStart: parseInt(hunkMatch[1], 10),
          oldLines: parseInt(hunkMatch[2] ?? '1', 10),
          newStart: parseInt(hunkMatch[3], 10),
          newLines: parseInt(hunkMatch[4] ?? '1', 10),
          header: hunkMatch[5]?.trim() || '',
          lines: []
        }
        oldLineNo = currentHunk.oldStart
        newLineNo = currentHunk.newStart
        hunks.push(currentHunk)
        continue
      }

      if (!currentHunk) continue

      if (line.startsWith('+')) {
        const diffLine: GitDiffLine = {
          type: 'add',
          content: line.slice(1),
          newLineNo: newLineNo++
        }
        currentHunk.lines.push(diffLine)
      } else if (line.startsWith('-')) {
        const diffLine: GitDiffLine = {
          type: 'delete',
          content: line.slice(1),
          oldLineNo: oldLineNo++
        }
        currentHunk.lines.push(diffLine)
      } else if (line.startsWith(' ')) {
        const diffLine: GitDiffLine = {
          type: 'context',
          content: line.slice(1),
          oldLineNo: oldLineNo++,
          newLineNo: newLineNo++
        }
        currentHunk.lines.push(diffLine)
      }
    }

    files.push({ path, oldPath, status, hunks, isBinary: false })
  }

  return files
}

export async function getDiff(cwd: string, filePath?: string, staged?: boolean): Promise<GitFileDiff[]> {
  const args = ['diff']
  if (staged) args.push('--cached')
  args.push('--no-color', '--unified=5')
  if (filePath) args.push('--', filePath)

  try {
    const { stdout } = await gitExec(cwd, args, 15000)
    const diffs = parseDiffOutput(stdout)

    // Cap total diff lines to prevent renderer OOM on very large diffs
    const MAX_TOTAL_LINES = 15000
    let totalLines = 0
    for (const diff of diffs) {
      for (const hunk of diff.hunks) {
        totalLines += hunk.lines.length
      }
      if (totalLines > MAX_TOTAL_LINES) {
        diff.hunks = [{ oldStart: 0, oldCount: 0, newStart: 0, newCount: 0, header: '@@ Diff too large — showing summary only @@', lines: [] }]
        diff.isBinary = true // signal the viewer to show placeholder instead of content
      }
    }
    // If no diff returned for a specific file, it may be untracked or newly added —
    // synthesize a full-content diff so the viewer can display it
    if (diffs.length === 0 && filePath) {
      const fsP = require('fs/promises') as typeof import('fs/promises')
      const pathMod = require('path') as typeof import('path')
      try {
        const absPath = pathMod.join(cwd, filePath)
        const stat = await fsP.stat(absPath)
        if (stat.isFile() && stat.size < 512 * 1024) { // skip files > 512KB
          const buf = await fsP.readFile(absPath)
          // Binary detection: check for null bytes in first 8KB (same heuristic as git)
          const isBin = buf.subarray(0, 8000).includes(0)
          if (isBin) {
            diffs.push({ path: filePath, status: 'added', isBinary: true, hunks: [] })
          } else {
            const content = buf.toString('utf-8')
            const lines = content.split('\n')
            // Remove trailing empty line from final newline
            if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
            const diffLines: GitDiffLine[] = lines.map((line, i) => ({
              type: 'add' as const,
              content: line,
              newLineNo: i + 1
            }))
            diffs.push({
              path: filePath,
              status: 'added',
              isBinary: false,
              hunks: [{
                oldStart: 0,
                oldLines: 0,
                newStart: 1,
                newLines: lines.length,
                header: 'new file',
                lines: diffLines
              }]
            })
          }
        }
      } catch { /* file unreadable — leave empty */ }
    }
    return diffs
  } catch (err) {
    getServices().logError('[git-manager] getDiff failed:', err)
    return []
  }
}

// --- Commit detail ---

export async function getCommitDetail(cwd: string, hash: string): Promise<GitCommitDetail | null> {
  try {
    // Get metadata first (fast) to determine parent structure
    const { stdout: metaOut } = await gitExec(cwd, [
      'log', '-1', `--format=${LOG_FORMAT}%n%b`, hash
    ], 10000)

    const lines = metaOut.split('\n')
    if (lines.length < 7) return null
    const parents = lines[6] ? lines[6].split(' ').filter(Boolean) : []
    const isMerge = parents.length > 1

    // For merge commits: diff against first parent to show all files the merge brought in.
    // Default combined diff only shows files differing from ALL parents (just conflict resolutions).
    // For regular commits: --root handles root commits (no parent → diff against empty tree).
    const numstatArgs = isMerge
      ? ['diff-tree', '--numstat', '-r', parents[0], hash]
      : ['diff-tree', '--root', '--numstat', '-r', hash]

    const { stdout: numstatOut } = await gitExec(cwd, numstatArgs, 10000)
      .catch(() => ({ stdout: '', stderr: '' }))

    // Find files that are too large for a full diff (>10K lines of changes)
    const MAX_DIFF_LINES = 10000
    const largeFiles = new Set<string>()
    const allFiles: { name: string; added: number; removed: number }[] = []
    for (const line of numstatOut.split('\n')) {
      const parts = line.trim().split('\t')
      if (parts.length >= 3 && parts[2]) {
        const added = parseInt(parts[0], 10) || 0
        const removed = parseInt(parts[1], 10) || 0
        allFiles.push({ name: parts[2], added, removed })
        if (added + removed >= MAX_DIFF_LINES) {
          largeFiles.add(parts[2])
        }
      }
    }

    // Build diff command, excluding large files
    const diffArgs = isMerge
      ? ['diff-tree', '-p', '--no-color', '--unified=5', '-r', parents[0], hash]
      : ['diff-tree', '--root', '-p', '--no-color', '--unified=5', '-r', hash]
    if (largeFiles.size > 0) {
      diffArgs.push('--')
      diffArgs.push('.')
      for (const f of largeFiles) diffArgs.push(`:(exclude)${f}`)
    }

    let diffOut = ''
    try {
      const result = await gitExec(cwd, diffArgs, 15000)
      diffOut = result.stdout
    } catch {
      // Timeout or error — build minimal diff entries from numstat so files still show
      for (const f of allFiles) {
        if (!largeFiles.has(f.name)) {
          diffOut += `\ndiff --git a/${f.name} b/${f.name}\n--- a/${f.name}\n+++ b/${f.name}\n@@ -1,${f.removed} +1,${f.added} @@\n Diff timed out — click file to view\n`
        }
      }
    }

    // Add synthetic entries for large files that were excluded
    for (const f of largeFiles) {
      const info = allFiles.find((a) => a.name === f)
      const label = info ? ` (${(info.added + info.removed).toLocaleString()} lines)` : ''
      diffOut += `\ndiff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -0,0 +0,0 @@\n File too large to display diff${label}\n`
    }

    const endIdx = lines.indexOf('---END---')
    const bodyLines = endIdx >= 0 ? lines.slice(endIdx + 1) : []

    const commit: GitCommitDetail = {
      hash: lines[0],
      shortHash: lines[1],
      author: lines[2],
      authorEmail: lines[3],
      date: lines[4],
      subject: lines[5],
      parents,
      refs: lines[7] ? lines[7].split(',').map((r) => r.trim()).filter(Boolean) : [],
      body: bodyLines.join('\n').trim(),
      files: parseDiffOutput(diffOut)
    }

    return commit
  } catch (err) {
    getServices().logError('[git-manager] getCommitDetail failed:', err)
    return null
  }
}

// --- Stage / Unstage ---

export async function stageFiles(cwd: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return
  // Use pathspec-from-file via stdin to avoid Windows command line length limits
  // with long paths or large file counts. Falls back to batched args for older git.
  try {
    await gitExecStdin(cwd, ['add', '--pathspec-from-file=-', '--'], paths.join('\n'), 60000)
  } catch (err: any) {
    if (err.message?.includes('pathspec-from-file')) {
      // Fallback: batch via args (git < 2.26)
      const BATCH = 30
      for (let i = 0; i < paths.length; i += BATCH) {
        await gitExec(cwd, ['add', '--', ...paths.slice(i, i + BATCH)], 30000)
      }
    } else {
      throw err
    }
  }
}

export async function unstageFiles(cwd: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return
  // Use pathspec-from-file via stdin to avoid command line length limits
  try {
    await gitExecStdin(cwd, ['restore', '--staged', '--pathspec-from-file=-', '--'], paths.join('\n'), 60000)
  } catch (err: any) {
    if (err.message?.includes('pathspec-from-file') || err.message?.includes('restore')) {
      // Fallback: batch via args
      const BATCH = 30
      for (let i = 0; i < paths.length; i += BATCH) {
        const chunk = paths.slice(i, i + BATCH)
        try {
          await gitExec(cwd, ['restore', '--staged', '--', ...chunk], 30000)
        } catch {
          await gitExec(cwd, ['reset', 'HEAD', '--', ...chunk], 30000)
        }
      }
    } else {
      throw err
    }
  }
}

// --- Git identity ---

export async function getGitIdentity(cwd: string): Promise<{ name: string; email: string }> {
  let name = '', email = ''
  try { name = (await gitExec(cwd, ['config', 'user.name'], 5000)).stdout.trim() } catch { /* not set */ }
  try { email = (await gitExec(cwd, ['config', 'user.email'], 5000)).stdout.trim() } catch { /* not set */ }
  return { name, email }
}

export async function setGitIdentity(cwd: string, name: string, email: string, global: boolean): Promise<void> {
  const scope = global ? '--global' : '--local'
  await gitExec(cwd, ['config', scope, 'user.name', name], 5000)
  await gitExec(cwd, ['config', scope, 'user.email', email], 5000)
}

// --- Commit ---

export async function createCommit(cwd: string, message: string): Promise<{ hash: string }> {
  await gitExec(cwd, ['commit', '-m', message], 15000)
  const { stdout } = await gitExec(cwd, ['rev-parse', 'HEAD'], 5000)
  return { hash: stdout.trim() }
}

// --- Branch operations ---

export async function checkoutBranch(cwd: string, name: string, trackRemote?: string): Promise<void> {
  const log = getServices().log
  log(`[git-manager] checkoutBranch: name=${name} trackRemote=${trackRemote || 'none'} cwd=${cwd}`)

  if (trackRemote) {
    // Build list of remote ref variants to try. Submodules often use refs like
    // origin/heads/1.0.2 but the UI strips the heads/ prefix for display,
    // so we need to try both the displayed name and the heads/ variant.
    const remotePrefix = trackRemote.match(/^([^/]+\/)/)?.[1] || ''
    const branchPart = trackRemote.slice(remotePrefix.length)
    const variants = [trackRemote]
    if (!branchPart.startsWith('heads/')) {
      variants.push(`${remotePrefix}heads/${branchPart}`)
    }

    for (const remote of variants) {
      // Step 1: Try creating a new local tracking branch
      try {
        await gitExec(cwd, ['checkout', '-b', name, '--track', remote], 15000)
        log(`[git-manager] checkoutBranch: created tracking branch ${name} -> ${remote}`)
        return
      } catch (e1) {
        log(`[git-manager] checkoutBranch: -b --track ${remote} failed: ${e1 instanceof Error ? e1.message.split('\n')[0] : e1}`)
      }

      // Step 2: Try force-creating/resetting the branch to the remote ref
      try {
        await gitExec(cwd, ['checkout', '-B', name, remote], 15000)
        log(`[git-manager] checkoutBranch: force-created branch ${name} from ${remote}`)
        try { await gitExec(cwd, ['branch', '--set-upstream-to', remote, name], 5000) } catch { /* best effort */ }
        return
      } catch (e2) {
        log(`[git-manager] checkoutBranch: -B ${remote} failed: ${e2 instanceof Error ? e2.message.split('\n')[0] : e2}`)
      }
    }

    // Step 3: Try plain checkout (works if there's only one remote with this branch)
    try {
      await gitExec(cwd, ['checkout', name], 15000)
      // Verify we're on a branch, not detached
      try {
        const { stdout: headRef } = await gitExec(cwd, ['symbolic-ref', '--short', 'HEAD'], 5000)
        if (headRef.trim()) {
          log(`[git-manager] checkoutBranch: plain checkout succeeded, on branch ${headRef.trim()}`)
          return
        }
      } catch { /* detached */ }
      log(`[git-manager] checkoutBranch: plain checkout resulted in detached HEAD, trying recovery`)
    } catch (e3) {
      log(`[git-manager] checkoutBranch: plain checkout failed: ${e3 instanceof Error ? e3.message.split('\n')[0] : e3}`)
    }

    // Step 4: Last resort — resolve the remote ref to a commit hash
    for (const remote of variants) {
      try {
        const { stdout: commitHash } = await gitExec(cwd, ['rev-parse', remote], 5000)
        const hash = commitHash.trim()
        if (hash) {
          await gitExec(cwd, ['checkout', '-B', name, hash], 15000)
          try { await gitExec(cwd, ['branch', '--set-upstream-to', remote, name], 5000) } catch { /* best effort */ }
          log(`[git-manager] checkoutBranch: created branch ${name} at ${hash.slice(0, 7)} (resolved from ${remote})`)
          return
        }
      } catch (e4) {
        log(`[git-manager] checkoutBranch: rev-parse ${remote} failed: ${e4 instanceof Error ? e4.message.split('\n')[0] : e4}`)
      }
    }
  }

  // No trackRemote or all recovery attempts failed
  await gitExec(cwd, ['checkout', name], 15000)
}

export async function createBranch(cwd: string, name: string, startPoint?: string): Promise<void> {
  const args = ['checkout', '-b', name]
  if (startPoint) args.push(startPoint)
  await gitExec(cwd, args, 10000)
}

export async function deleteBranch(cwd: string, name: string, force?: boolean): Promise<void> {
  await gitExec(cwd, ['branch', force ? '-D' : '-d', name], 10000)
}

export async function deleteRemoteBranch(cwd: string, remoteBranch: string): Promise<void> {
  // remoteBranch is in format "origin/feature-x" — split into remote and branch
  const slashIdx = remoteBranch.indexOf('/')
  if (slashIdx < 0) throw new Error(`Invalid remote branch format: ${remoteBranch}`)
  const remote = remoteBranch.slice(0, slashIdx)
  const branch = remoteBranch.slice(slashIdx + 1)
  await gitExec(cwd, ['push', remote, '--delete', branch], 30000)
}

// --- Discard / Delete ---

export async function discardFiles(
  cwd: string,
  paths: string[],
  onProgress?: (completed: number, total: number, path: string) => void
): Promise<void> {
  if (paths.length === 0) return
  // Process files individually to avoid LFS lock contention and provide progress.
  // LFS files can take a long time to restore so we use a generous timeout.
  for (let i = 0; i < paths.length; i++) {
    onProgress?.(i, paths.length, paths[i])
    await gitExec(cwd, ['checkout', '--', paths[i]], 120000)
  }
  onProgress?.(paths.length, paths.length, '')
}

/** Restore a file to its state before a given commit (i.e. from the commit's parent) */
export async function restoreFileFromCommit(cwd: string, commitHash: string, filePath: string): Promise<void> {
  await gitExec(cwd, ['checkout', `${commitHash}^`, '--', filePath], 10000)
}

export async function deleteUntrackedFiles(cwd: string, paths: string[]): Promise<void> {
  const fsP = require('fs/promises') as typeof import('fs/promises')
  const pathMod = require('path') as typeof import('path')
  for (const p of paths) {
    await fsP.rm(pathMod.join(cwd, p), { force: true, recursive: true })
  }
}

/** Remove .git/index.lock if it exists (stale lock from crashed git process) */
export async function removeLockFile(cwd: string): Promise<void> {
  const fsP = require('fs/promises') as typeof import('fs/promises')
  const pathMod = require('path') as typeof import('path')
  const lockPath = pathMod.join(cwd, '.git', 'index.lock')
  await fsP.rm(lockPath, { force: true })
}

/** Save raw content to a file (for manual conflict editing) */
export async function saveFileContent(cwd: string, filePath: string, content: string): Promise<void> {
  const fsP = require('fs/promises') as typeof import('fs/promises')
  const pathMod = require('path') as typeof import('path')
  const absPath = pathMod.resolve(cwd, filePath)
  // Security: ensure the file is within the repo
  if (!absPath.startsWith(pathMod.resolve(cwd))) throw new Error('Path escapes repository')
  await fsP.writeFile(absPath, content, 'utf-8')
}

// --- Gitignore ---

/** Write pattern to a temp file, run a callback with the path, then clean up */
async function withTempExcludeFile<T>(pattern: string, fn: (tmpPath: string) => Promise<T>): Promise<T> {
  const fsP = require('fs/promises') as typeof import('fs/promises')
  const osMod = require('os') as typeof import('os')
  const pathMod = require('path') as typeof import('path')
  const tmpDir = await fsP.mkdtemp(pathMod.join(osMod.tmpdir(), 'gm-gitignore-'))
  const tmpFile = pathMod.join(tmpDir, 'exclude')
  await fsP.writeFile(tmpFile, pattern + '\n', 'utf-8')
  try {
    return await fn(tmpFile)
  } finally {
    await fsP.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

/** Use git itself to find files matching a gitignore-style pattern */
export async function previewGitignorePattern(cwd: string, pattern: string): Promise<string[]> {
  if (!pattern.trim()) return []

  return withTempExcludeFile(pattern, async (tmpFile) => {
    // Get files matching our pattern AND files already ignored, then subtract
    const [matchResult, alreadyIgnoredResult] = await Promise.all([
      gitExec(cwd, ['ls-files', '--cached', '--others', '--ignored', '--exclude-from', tmpFile, '-z'], 10000),
      gitExec(cwd, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], 10000)
    ])
    const matched = matchResult.stdout.split('\0').filter(Boolean)
    const alreadyIgnored = new Set(alreadyIgnoredResult.stdout.split('\0').filter(Boolean))
    const filtered = matched.filter(f => !alreadyIgnored.has(f))
    return filtered.slice(0, 200)
  })
}

/** Append a pattern to .gitignore and optionally rm --cached the matched tracked files */
export async function addToGitignore(cwd: string, pattern: string, removeFromIndex: boolean): Promise<void> {
  const fsP = require('fs/promises') as typeof import('fs/promises')
  const pathMod = require('path') as typeof import('path')
  const gitignorePath = pathMod.join(cwd, '.gitignore')

  // If removing from index, find tracked matches BEFORE writing .gitignore
  // (after writing, git would already ignore them and ls-files --cached --ignored
  //  with the repo's own .gitignore would behave differently)
  let toRemove: string[] = []
  if (removeFromIndex) {
    toRemove = await withTempExcludeFile(pattern, async (tmpFile) => {
      const { stdout } = await gitExec(cwd, [
        'ls-files', '--cached', '--ignored', '--exclude-from', tmpFile, '-z'
      ], 10000)
      return stdout.split('\0').filter(Boolean)
    })
  }

  // Read existing content (if any)
  let existing = ''
  try {
    existing = await fsP.readFile(gitignorePath, 'utf-8')
  } catch { /* file doesn't exist yet */ }

  // Ensure we start on a new line
  const needsNewline = existing.length > 0 && !existing.endsWith('\n')
  const toAppend = (needsNewline ? '\n' : '') + pattern + '\n'
  await fsP.appendFile(gitignorePath, toAppend, 'utf-8')

  // Remove matched tracked files from the index (keeps them on disk)
  if (toRemove.length > 0) {
    const BATCH = 50
    for (let i = 0; i < toRemove.length; i += BATCH) {
      await gitExec(cwd, ['rm', '--cached', '--force', '--', ...toRemove.slice(i, i + BATCH)], 10000)
    }
  }
}

// --- Partial staging (apply patch) ---

export async function applyPatch(cwd: string, patch: string, cached: boolean, reverse: boolean, fuzzy?: boolean): Promise<void> {
  const args = ['apply', '--whitespace=nowarn']
  if (!fuzzy) args.push('--unidiff-zero')
  if (cached) args.push('--cached')
  if (reverse) args.push('--reverse')
  try {
    await gitExecStdin(cwd, args, patch)
  } catch (err) {
    if (!fuzzy) throw err
    // Retry with --3way to handle context mismatches (e.g. file modified since commit)
    const args3 = ['apply', '--whitespace=nowarn', '--3way']
    if (cached) args3.push('--cached')
    if (reverse) args3.push('--reverse')
    await gitExecStdin(cwd, args3, patch)
  }
}

// --- Reset / Revert / Cherry-pick ---

export async function resetBranch(cwd: string, hash: string, mode: 'soft' | 'mixed' | 'keep' | 'merge' | 'hard'): Promise<void> {
  await gitExec(cwd, ['reset', `--${mode}`, hash], 30000)
}

export async function revertCommit(cwd: string, hash: string): Promise<void> {
  await gitExec(cwd, ['revert', '--no-edit', hash], 30000)
}

export async function cherryPick(cwd: string, hash: string): Promise<void> {
  await gitExec(cwd, ['cherry-pick', hash], 30000)
}

export async function createTag(cwd: string, name: string, hash: string, message?: string): Promise<void> {
  if (message) {
    await gitExec(cwd, ['tag', '-a', name, hash, '-m', message], 10000)
  } else {
    await gitExec(cwd, ['tag', name, hash], 10000)
  }
}

export async function deleteTag(cwd: string, name: string): Promise<void> {
  await gitExec(cwd, ['tag', '-d', name], 10000)
}

export interface GitTagInfo {
  name: string
  hash: string
  date: string
}

export async function getTags(cwd: string): Promise<GitTagInfo[]> {
  try {
    const { stdout } = await gitExec(cwd, [
      'tag', '-l', '--sort=-creatordate',
      '--format=%(refname:short)%09%(objectname:short)%09%(creatordate:iso-strict)'
    ], 10000)
    if (!stdout.trim()) return []
    return stdout.trim().split('\n').map((line) => {
      const [name, hash, date] = line.split('\t')
      return { name, hash, date }
    })
  } catch {
    return []
  }
}

export async function renameBranch(cwd: string, oldName: string, newName: string, renameRemote?: boolean): Promise<void> {
  await gitExec(cwd, ['branch', '-m', oldName, newName], 10000)
  if (renameRemote) {
    // Find the remote for the old branch's tracking ref
    let remote = 'origin'
    try {
      const { stdout } = await gitExec(cwd, ['config', `branch.${oldName}.remote`], 5000)
      if (stdout.trim()) remote = stdout.trim()
    } catch { /* default to origin */ }
    // Delete old remote branch, push new one with tracking
    await gitExec(cwd, ['push', remote, '--delete', oldName], REMOTE_OP_TIMEOUT)
    await gitExec(cwd, ['push', '--set-upstream', remote, newName], REMOTE_OP_TIMEOUT)
  }
}

// --- Remote operations ---

export async function pull(cwd: string, mode?: 'merge' | 'rebase'): Promise<string> {
  // Check if HEAD is detached — git pull fails in detached HEAD state.
  // This commonly happens in submodules after `git submodule update`.
  // Auto-checkout the branch that matches HEAD's commit if possible.
  try {
    const { stdout: headRef } = await gitExec(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], 5000)
    if (headRef.trim() === 'HEAD') {
      // Detached — find a local branch pointing at the same commit
      const { stdout: headSha } = await gitExec(cwd, ['rev-parse', 'HEAD'], 5000)
      const { stdout: branchList } = await gitExec(cwd, ['branch', '--points-at', headSha.trim()], 5000)
      const localBranch = branchList.split('\n').map((l) => l.replace(/^\*?\s*/, '').trim()).filter(Boolean)[0]
      if (localBranch) {
        await gitExec(cwd, ['checkout', localBranch], 10000)
      } else {
        throw new Error('Cannot pull: HEAD is detached and no local branch points at this commit. Checkout a branch first.')
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('Cannot pull')) throw err
    // If the detached check fails, proceed with the pull and let git report the error
  }

  const args = ['pull']
  if (mode === 'rebase') args.push('--rebase', '--autostash')
  else if (mode === 'merge') args.push('--no-rebase')
  else args.push('--rebase', '--autostash') // default
  const { stdout, stderr } = await gitExec(cwd, args, 60000)
  return (stdout + stderr).trim()
}

export async function pullAdvanced(
  cwd: string,
  remote: string,
  branch: string,
  rebase: boolean,
  autostash: boolean,
  tags: boolean,
  prune: boolean
): Promise<string> {
  const args = ['pull']
  if (rebase) args.push('--rebase')
  else args.push('--no-rebase')
  if (autostash) args.push('--autostash')
  if (tags) args.push('--tags')
  if (prune) args.push('--prune')
  args.push(remote, branch)
  const { stdout, stderr } = await gitExec(cwd, args, 60000)
  return (stdout + stderr).trim()
}

// Push/pull timeout for non-streaming operations (fetch, rename-push, tag-push)
const REMOTE_OP_TIMEOUT = 300000

// Activity timeout for streaming push: resets whenever git produces output.
// Only triggers when the connection goes completely silent — a large push on
// slow internet will keep resetting this as long as data is flowing.
const PUSH_ACTIVITY_TIMEOUT = 120000 // 2 minutes of inactivity

export interface PushProgress {
  phase: string      // e.g. 'Enumerating objects', 'Writing objects'
  percent: number    // 0-100
  detail: string     // full line from git
}

/** Active push process — stored so it can be cancelled */
let activePushProcess: ChildProcess | null = null

/**
 * Spawn git with streaming stderr for progress.
 * Returns a promise that resolves with combined output on success.
 */
function gitPushStreaming(
  cwd: string,
  args: string[],
  onProgress?: (progress: PushProgress) => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, { cwd })
    activePushProcess = proc
    let stdout = ''
    let stderr = ''
    let killed = false

    // Activity-based timeout: resets every time git produces output.
    // A large push over slow internet keeps resetting as long as data flows.
    // Only triggers when the connection goes completely silent.
    let activityTimer: ReturnType<typeof setTimeout> | null = null
    const resetActivityTimer = () => {
      if (activityTimer) clearTimeout(activityTimer)
      activityTimer = setTimeout(() => {
        killed = true
        proc.kill()
        reject(new Error('git push timed out — no activity for 2 minutes'))
      }, PUSH_ACTIVITY_TIMEOUT)
    }
    resetActivityTimer()

    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      resetActivityTimer()
    })
    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stderr += text
      resetActivityTimer()

      if (!onProgress) return
      // Parse git progress lines (they use \r for in-place updates)
      for (const line of text.split(/[\r\n]+/)) {
        const trimmed = line.trim()
        if (!trimmed) continue
        // Match: "Phase: NN% (X/Y), ..." or "Phase: NN%"
        const match = trimmed.match(/^(.+?):\s+(\d+)%/)
        if (match) {
          onProgress({
            phase: match[1].trim(),
            percent: parseInt(match[2], 10),
            detail: trimmed
          })
        }
      }
    })

    proc.on('close', (code) => {
      if (activityTimer) clearTimeout(activityTimer)
      activePushProcess = null
      if (killed) return
      if (code === 0) {
        resolve((stdout + stderr).trim())
      } else {
        const err = new Error(`Command failed: git ${args.join(' ')}\n${stderr.trim()}`)
        reject(err)
      }
    })

    proc.on('error', (err) => {
      if (activityTimer) clearTimeout(activityTimer)
      activePushProcess = null
      reject(err)
    })
  })
}

export function cancelPush(): boolean {
  if (activePushProcess) {
    activePushProcess.kill()
    activePushProcess = null
    return true
  }
  return false
}

export async function push(cwd: string, onProgress?: (progress: PushProgress) => void): Promise<string> {
  // If the current branch has no upstream, push with --set-upstream to origin
  try {
    const { stdout: trackOut } = await gitExec(cwd, [
      'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'
    ], 5000)
    if (!trackOut.trim()) throw new Error('no upstream')
  } catch {
    // No upstream — push with --set-upstream
    const { stdout: branchOut } = await gitExec(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], 5000)
    const branch = branchOut.trim()
    if (branch && branch !== 'HEAD') {
      return gitPushStreaming(cwd, ['push', '--progress', '--set-upstream', 'origin', branch], onProgress)
    }
  }
  return gitPushStreaming(cwd, ['push', '--progress'], onProgress)
}

export async function pushForceWithLease(cwd: string, onProgress?: (progress: PushProgress) => void): Promise<string> {
  return gitPushStreaming(cwd, ['push', '--progress', '--force-with-lease'], onProgress)
}

export async function pushWithTags(cwd: string, onProgress?: (progress: PushProgress) => void): Promise<string> {
  return gitPushStreaming(cwd, ['push', '--progress', '--follow-tags'], onProgress)
}

export async function pushTag(cwd: string, tagName: string, force?: boolean): Promise<void> {
  const args = ['push', 'origin', `refs/tags/${tagName}`]
  if (force) args.push('--force')
  await gitExec(cwd, args, REMOTE_OP_TIMEOUT)
}

export async function fetch(cwd: string): Promise<string> {
  const { stdout, stderr } = await gitExec(cwd, ['fetch', '--all', '--prune'], 30000)
  return (stdout + stderr).trim()
}

export async function fetchSimple(cwd: string): Promise<string> {
  const { stdout, stderr } = await gitExec(cwd, ['fetch'], 30000)
  return (stdout + stderr).trim()
}

export async function fetchAll(cwd: string): Promise<string> {
  const { stdout, stderr } = await gitExec(cwd, ['fetch', '--all'], 30000)
  return (stdout + stderr).trim()
}

export async function fetchPruneAll(cwd: string): Promise<string> {
  const { stdout, stderr } = await gitExec(cwd, ['fetch', '--all', '--prune'], 30000)
  return (stdout + stderr).trim()
}

// --- Behind count (for badge) ---

export async function getBehindCount(cwd: string): Promise<number> {
  try {
    const { stdout } = await gitExec(cwd, ['status', '--porcelain=v2', '--branch', '-z'], 5000)
    const entries = stdout.split('\0')
    for (const entry of entries) {
      if (entry.startsWith('# branch.ab ')) {
        const match = entry.match(/\+(\d+) -(\d+)/)
        if (match) return parseInt(match[2], 10)
      }
    }
    return 0
  } catch {
    return 0
  }
}

// --- Stash ---

export async function getStashList(cwd: string): Promise<GitStashEntry[]> {
  try {
    const { stdout } = await gitExec(cwd, ['stash', 'list', '--format=%H%n%s%n%aI%n%P%n---END---'], 10000)
    const entries: GitStashEntry[] = []
    const blocks = stdout.split('---END---\n')
    let idx = 0
    for (const block of blocks) {
      const trimmed = block.trim()
      if (!trimmed) continue
      const lines = trimmed.split('\n')
      const parents = (lines[3] || '').split(' ').filter(Boolean)
      entries.push({
        index: idx++,
        hash: lines[0] || '',
        message: lines[1] || '',
        date: lines[2] || undefined,
        parentHash: parents[0] || undefined
      })
    }
    return entries
  } catch {
    return []
  }
}

export async function stashSave(cwd: string, message?: string, flags?: string): Promise<void> {
  const args = ['stash', 'push']
  if (flags) args.push(...flags.split(/\s+/).filter(Boolean))
  if (message) args.push('-m', message)
  await gitExec(cwd, args, 15000)
}

export async function stashPop(cwd: string, index: number): Promise<void> {
  await gitExec(cwd, ['stash', 'pop', `stash@{${index}}`], 15000)
}

export async function stashApply(cwd: string, index: number): Promise<void> {
  await gitExec(cwd, ['stash', 'apply', `stash@{${index}}`], 15000)
}

export async function stashDrop(cwd: string, index: number): Promise<void> {
  await gitExec(cwd, ['stash', 'drop', `stash@{${index}}`], 10000)
}

// --- Git LFS ---

/**
 * Migrate files to Git LFS: installs LFS, tracks the file extensions,
 * removes the files from the index, re-adds them with LFS, and amends the commit.
 */
export async function migrateToLfs(cwd: string, filePaths: string[]): Promise<string> {
  // 1. Install LFS (idempotent)
  await gitExec(cwd, ['lfs', 'install'], 15000)

  // 2. Track each unique extension
  const extensions = new Set(filePaths.map((f) => {
    const ext = f.split('.').pop()
    return ext ? `*.${ext}` : ''
  }).filter(Boolean))
  for (const pattern of extensions) {
    await gitExec(cwd, ['lfs', 'track', pattern], 10000)
  }

  // 3. Remove files from index (keep on disk) and re-add with LFS
  for (const f of filePaths) {
    await gitExec(cwd, ['rm', '--cached', f], 10000)
  }
  await gitExec(cwd, ['add', '.gitattributes', ...filePaths], 10000)

  // 4. Amend the current commit to include the LFS changes
  await gitExec(cwd, ['commit', '--amend', '--no-edit'], 15000)

  return `Migrated ${filePaths.length} file(s) to Git LFS (${[...extensions].join(', ')})`
}

// --- Remotes ---

export interface GitRemoteInfo {
  name: string
  fetchUrl: string
  pushUrl: string
}

export async function getRemotes(cwd: string): Promise<GitRemoteInfo[]> {
  try {
    const { stdout } = await gitExec(cwd, ['remote', '-v'], 10000)
    const map = new Map<string, GitRemoteInfo>()
    for (const line of stdout.split('\n')) {
      const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)/)
      if (!match) continue
      const [, name, url, type] = match
      if (!map.has(name)) map.set(name, { name, fetchUrl: '', pushUrl: '' })
      const info = map.get(name)!
      if (type === 'fetch') info.fetchUrl = url
      else info.pushUrl = url
    }
    return [...map.values()]
  } catch {
    return []
  }
}

export async function addRemote(cwd: string, name: string, url: string): Promise<void> {
  await gitExec(cwd, ['remote', 'add', name, url], 10000)
}

export async function removeRemote(cwd: string, name: string): Promise<void> {
  await gitExec(cwd, ['remote', 'remove', name], 10000)
}

export async function renameRemote(cwd: string, oldName: string, newName: string): Promise<void> {
  await gitExec(cwd, ['remote', 'rename', oldName, newName], 10000)
}

export async function setRemoteUrl(cwd: string, name: string, url: string, pushUrl?: string): Promise<void> {
  await gitExec(cwd, ['remote', 'set-url', name, url], 10000)
  if (pushUrl !== undefined) {
    await gitExec(cwd, ['remote', 'set-url', '--push', name, pushUrl], 10000)
  }
}

// --- Submodules ---

// --- Commit message generation ---

const CONV_COMMIT_TYPES = 'feat|fix|refactor|docs|chore|style|test|perf|build|ci|revert'
const CONV_COMMIT_RE = new RegExp(`^(${CONV_COMMIT_TYPES})(\\([^)]*\\))?:\\s`, 'i')
// Lines that clearly mean the LLM echoed the diff into the output.
// Bullets start with a space-dash (- text), so they don't match these.
const DIFF_MARKER_RE = /^(diff --git |index [0-9a-f]{4,}|@@ |--- [ab]?\/|--- \/dev|\+\+\+ [ab]?\/|\+\+\+ \/dev|[+-]\S)/

/**
 * Commit-message prompt.
 *
 * Structure enforced by the prompt (and reinforced by `cleanCommitMessage`):
 *
 *     <type>: <summary of all changes>       (under 72 chars, lowercase after colon)
 *                                            (blank line)
 *     - first notable change                 (bullets describe specific files/areas)
 *     - second notable change                (bullets MUST NOT start with a type prefix)
 *
 * A one-line summary with no bullets is valid for simple commits.
 */
const COMMIT_MSG_PROMPT = [
  'Write ONE git commit message describing all the staged changes together.',
  '',
  'Format:',
  '  <type>: <summary>',
  '',
  '  - <detail about change A>',
  '  - <detail about change B>',
  '',
  'Rules:',
  '- The first line uses conventional commit format: one of feat, fix, refactor, docs, chore, style, test, perf, build, ci, revert — followed by ": " and a short summary under 72 characters.',
  '- The word after the colon on the first line must be lowercase.',
  '- If the summary line alone covers everything, output just the summary line and stop.',
  '- If there are multiple distinct changes, follow the summary line with one blank line, then bullet points starting with "- " (dash, space). Each bullet describes one change. Bullets must NEVER start with a type prefix (no "fix:", no "feat:", etc.).',
  '- Describe all staged changes in the bullets — do not truncate to one area.',
  '- Do not copy diff content (no lines starting with +, -filename, @@, diff --git, index).',
  '- Output ONLY the commit message. No quotes, no code fences, no explanation.'
].join('\n')

/**
 * Strip a conventional-commit type prefix from the start of a line.
 * Used for bullet lines where the LLM sometimes echoes the prefix.
 */
function stripConventionalPrefix(text: string): string {
  return text.replace(CONV_COMMIT_RE, '').trim()
}

function cleanCommitMessage(raw: string): string {
  const msg = raw.trim()
    .replace(/^["']|["']$/g, '')
    .replace(/^```[^\n]*\n?|```$/gm, '')
    .trim()

  const rawLines = msg.split('\n')
    .map((l) => l.replace(/\r$/, ''))
    // Drop leading blank/whitespace-only lines so "firstLine" is the real summary
    .filter((l, i, arr) => i > 0 || l.trim().length > 0)

  // Small models occasionally emit the summary on line 2 after a blank line.
  // Find the first non-empty line that looks like a summary.
  let firstLineIdx = rawLines.findIndex((l) => l.trim().length > 0)
  if (firstLineIdx < 0) firstLineIdx = 0
  const firstLine = rawLines[firstLineIdx]?.trim() ?? ''

  // Small models sometimes emit a second commit message, echo the diff, or
  // repeat the summary line. Cut at whichever boundary appears first.
  let cutIdx = -1
  for (let i = firstLineIdx + 1; i < rawLines.length; i++) {
    const line = rawLines[i]
    const trimmed = line.trim()
    if (trimmed === firstLine && trimmed.length > 0) { cutIdx = i; break }
    // A full conventional commit line AFTER the first line is a second message.
    // Bullets stripped of their "- " prefix could look like conventional lines
    // (e.g. "- fix: ..."), so only cut when the line isn't a bullet.
    if (CONV_COMMIT_RE.test(trimmed) && !/^[-*]\s/.test(trimmed)) { cutIdx = i; break }
    if (DIFF_MARKER_RE.test(line)) { cutIdx = i; break }
  }
  const kept = cutIdx > 0 ? rawLines.slice(firstLineIdx, cutIdx) : rawLines.slice(firstLineIdx)

  const summary = kept[0] ?? ''
  const bodyLines = kept.slice(1)
  const bulletLines = bodyLines
    .filter((l) => /^\s*[-*]\s/.test(l))
    .map((l) => l.replace(/^\s*[-*]\s+/, '').trim())
    .map(stripConventionalPrefix)
    .filter((l) => l.length > 0)

  // Rebuild with canonical format: summary, blank line, dash-space bullets.
  // Dedupe bullets (small models sometimes repeat).
  const seenBullets = new Set<string>()
  const uniqueBullets: string[] = []
  for (const b of bulletLines) {
    const key = b.toLowerCase()
    if (!seenBullets.has(key)) {
      seenBullets.add(key)
      uniqueBullets.push(b)
    }
  }

  // Enforce lowercase after conventional commit prefix ("fix: Resolve" -> "fix: resolve")
  let cleanedSummary = summary.replace(/^(\w+(?:\([^)]*\))?:\s*)([A-Z])/, (_, prefix, ch) => prefix + ch.toLowerCase())
  if (cleanedSummary.length > 72) {
    cleanedSummary = cleanedSummary.slice(0, 72).replace(/\s+\S*$/, '')
  }

  // Reject garbage — must have a conventional commit prefix to be considered valid.
  // This lets callers retry instead of committing with nonsense text.
  if (!CONV_COMMIT_RE.test(cleanedSummary.trim())) return ''

  if (uniqueBullets.length === 0) return cleanedSummary.trim()
  return `${cleanedSummary.trim()}\n\n${uniqueBullets.map((b) => `- ${b}`).join('\n')}`
}

/** Assemble the LLM prompt: instructions, a worked example, then the actual diff. */
function buildCommitPrompt(stat: string, diff: string): string {
  const shortDiff = diff.length > 4000 ? diff.slice(0, 4000) + '\n... (truncated)' : diff
  return [
    COMMIT_MSG_PROMPT,
    '',
    'Example output for a commit that touches multiple files:',
    'refactor: extract shared logger utility',
    '',
    '- move log/logError from main/index.ts into src/shared/logger.ts',
    '- update all imports to use the shared module',
    '- remove duplicate log buffer initialization',
    '',
    '---',
    '',
    'Staged changes (file stats):',
    stat.trim(),
    '',
    'Diff:',
    shortDiff,
    '',
    'Now output the commit message for the changes above:'
  ].join('\n')
}

async function generateViaLocalLlm(stat: string, diff: string): Promise<string> {
  const { LocalLlmManager } = await import('../../local-llm')
  const raw = await LocalLlmManager.getInstance().generate(buildCommitPrompt(stat, diff))
  const msg = cleanCommitMessage(raw)
  if (!msg) throw new Error('Empty response from local LLM')
  return msg
}

async function generateViaClaude(stat: string, diff: string): Promise<string> {
  const { spawn } = require('child_process') as typeof import('child_process')
  const prompt = buildCommitPrompt(stat, diff)

  const stdout = await new Promise<string>((resolve, reject) => {
    const proc = spawn('claude', ['-p', '--model', 'haiku', '--max-turns', '1', '--output-format', 'text'], {
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32'
    })
    let out = ''
    let err = ''
    proc.stdout.on('data', (chunk: Buffer) => { out += chunk })
    proc.stderr.on('data', (chunk: Buffer) => { err += chunk })
    proc.on('error', (e: Error) => reject(e))
    proc.on('close', (code: number) => {
      if (code !== 0) reject(new Error(err || `claude exited with code ${code}`))
      else resolve(out)
    })
    proc.stdin.write(prompt)
    proc.stdin.end()
  })

  const msg = cleanCommitMessage(stdout)
  if (!msg) throw new Error('Empty response from Claude CLI')
  return msg
}

async function generateViaAnthropicAPI(stat: string, diff: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set')

  const prompt = buildCommitPrompt(stat, diff)

  const body = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }]
  })

  const response = await new Promise<string>((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      }
    }, (res) => {
      let data = ''
      res.on('data', (chunk) => data += chunk)
      res.on('end', () => {
        try {
          const json = JSON.parse(data)
          if (res.statusCode !== 200) {
            reject(new Error(json?.error?.message || `Anthropic API returned ${res.statusCode}`))
            return
          }
          const text = json?.content?.[0]?.text || ''
          resolve(text)
        } catch { reject(new Error('Invalid JSON from Anthropic API')) }
      })
    })
    req.on('error', (e) => reject(e))
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Anthropic API request timed out')) })
    req.write(body)
    req.end()
  })

  const msg = cleanCommitMessage(response)
  if (!msg) throw new Error('Empty response from Anthropic API')
  return msg
}

// File extensions that are data/binary — include in stat but exclude from diff
const DATA_FILE_PATTERNS = /\.(jsonl|json|csv|tsv|parquet|arrow|sqlite|db|pkl|pickle|npy|npz|h5|hdf5|bin|dat|model|onnx|pt|pth|safetensors|gguf|weights|tar|gz|zip|7z|rar|bz2|xz|log|lock)$/i

/** Build git pathspec excludes for data files: [':(exclude)*.jsonl', ':(exclude)*.csv', ...] */
function getDataFileExcludes(_cwd: string): string[] {
  const exts = ['jsonl', 'json', 'csv', 'tsv', 'parquet', 'arrow', 'sqlite', 'db',
    'pkl', 'pickle', 'npy', 'npz', 'h5', 'hdf5', 'bin', 'dat', 'model', 'onnx',
    'pt', 'pth', 'safetensors', 'gguf', 'weights', 'tar', 'gz', 'zip', '7z',
    'rar', 'bz2', 'xz', 'log', 'lock']
  return exts.map((ext) => `:(exclude)*.${ext}`)
}

export async function generateCommitMessage(cwd: string): Promise<string> {
  // Get staged file list, stat, and diff.
  // Cap diff fetch at 8KB — LLM providers only use 4000 chars anyway, and
  // fetching multi-MB diffs wastes memory on repos with large binary/data changes.
  const MAX_DIFF_BYTES = 8 * 1024
  const [namesResult, statResult, diffResult] = await Promise.all([
    gitExec(cwd, ['diff', '--cached', '--name-only'], 5000),
    gitExec(cwd, ['diff', '--cached', '--stat', '--no-color'], 10000),
    // Exclude large data files from the diff to avoid overwhelming the LLM
    new Promise<{ stdout: string; stderr: string }>((resolve) => {
      const args = ['diff', '--cached', '--no-color', '--unified=1', '--', '.', ...getDataFileExcludes(cwd)]
      execFile('git', args, { cwd, timeout: 10000, maxBuffer: MAX_DIFF_BYTES }, (err, stdout) => {
        // maxBuffer exceeded just means we got a partial diff — that's fine
        resolve({ stdout: stdout || '', stderr: '' })
      })
    })
  ])

  const stat = statResult.stdout.trim()
  if (!stat) throw new Error('No staged changes to describe')

  // Note which files are data-only (excluded from diff) so the LLM knows they exist
  const allFiles = namesResult.stdout.trim().split('\n').filter(Boolean)
  const dataFiles = allFiles.filter((f) => DATA_FILE_PATTERNS.test(f))
  let diff = diffResult.stdout
  if (dataFiles.length > 0) {
    diff += `\n\n(Data files changed but diff excluded: ${dataFiles.join(', ')})`
  }

  getServices().log(`[git-manager] generating commit message: stat=${stat.length} chars, diff=${diff.length} chars, dataFiles=${dataFiles.length}`)
  const t0 = Date.now()

  // Race available providers — local LLM is always primary
  const providers: Promise<string>[] = []

  providers.push(generateViaLocalLlm(stat, diff).then((r) => {
    getServices().log(`[git-manager] Local LLM responded in ${Date.now() - t0}ms`)
    return r
  }))

  // Claude is optional (off by default).
  // When inside a submodule, settings may be stored under the parent project,
  // so walk up the directory tree to find the nearest configured value.
  let claudeEnabled = false
  let settingsDir = cwd
  for (let i = 0; i < 5; i++) {
    const val = getServices().getPluginSetting(settingsDir, 'git-manager', 'enableClaude')
    if (val !== undefined) { claudeEnabled = !!val; break }
    const parent = path.dirname(settingsDir)
    if (parent === settingsDir) break
    settingsDir = parent
  }
  getServices().log(`[git-manager] commit msg providers: cwd=${cwd} settingsDir=${settingsDir} claudeEnabled=${claudeEnabled}`)
  if (claudeEnabled) {
    providers.push(generateViaClaude(stat, diff).then((r) => {
      getServices().log(`[git-manager] Claude CLI responded in ${Date.now() - t0}ms`)
      return r
    }))
    if (process.env.ANTHROPIC_API_KEY) {
      providers.push(generateViaAnthropicAPI(stat, diff).then((r) => {
        getServices().log(`[git-manager] Anthropic API responded in ${Date.now() - t0}ms`)
        return r
      }))
    }
  }

  // Promise.any resolves with the first successful result
  try {
    return await Promise.any(providers)
  } catch (agg) {
    const errors = agg instanceof AggregateError ? agg.errors : [agg]
    const reasons = errors.map((e: unknown) => e instanceof Error ? e.message : String(e))
    for (const r of reasons) getServices().log(`[git-manager] provider failed: ${r}`)
    throw new Error(
      'Could not generate commit message: ' + reasons[0] +
      (claudeEnabled ? '' : ' You can also enable Claude in Git Manager settings.')
    )
  }
}

// ── Submodule list cache (in-memory + disk) ─────────────────────────
// Stale-while-revalidate: return cached list instantly, refresh in background.

const submoduleListMemCache = new Map<string, GitSubmoduleInfo[]>()

function subCacheKey(cwd: string): string {
  return cwd.replace(/\\/g, '/').toLowerCase()
}

function subCacheDiskDir(): string {
  try { return path.join(app.getPath('userData'), 'submodule-cache') } catch { return '' }
}

function subCacheDiskPath(cwd: string): string {
  const hash = crypto.createHash('md5').update(subCacheKey(cwd)).digest('hex')
  return path.join(subCacheDiskDir(), hash + '.json')
}

function saveSubmoduleListCache(cwd: string, list: GitSubmoduleInfo[]): void {
  const key = subCacheKey(cwd)
  submoduleListMemCache.set(key, list)
  const dir = subCacheDiskDir()
  if (!dir) return
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(subCacheDiskPath(cwd), JSON.stringify({ v: 1, ts: Date.now(), list }))
  } catch { /* best-effort */ }
}

function loadSubmoduleListCache(cwd: string): GitSubmoduleInfo[] | null {
  // In-memory first (instant)
  const mem = submoduleListMemCache.get(subCacheKey(cwd))
  if (mem) return mem
  // Disk fallback (covers app restarts)
  const dir = subCacheDiskDir()
  if (!dir) return null
  try {
    const raw = JSON.parse(fs.readFileSync(subCacheDiskPath(cwd), 'utf-8'))
    if (raw.v !== 1) return null
    // Disk cache expires after 7 days
    if (Date.now() - raw.ts > 7 * 24 * 60 * 60 * 1000) return null
    const list = raw.list as GitSubmoduleInfo[]
    submoduleListMemCache.set(subCacheKey(cwd), list) // promote to memory
    return list
  } catch { return null }
}

/** Return cached submodule list if available. Used by IPC for instant response. */
export function getCachedSubmoduleList(cwd: string): GitSubmoduleInfo[] | null {
  return loadSubmoduleListCache(cwd)
}

/** Clear submodule list cache (called after mutations: add, remove, sync, etc.) */
export function invalidateSubmoduleCache(cwd: string): void {
  submoduleListMemCache.delete(subCacheKey(cwd))
  try { const p = subCacheDiskPath(cwd); if (fs.existsSync(p)) fs.unlinkSync(p) } catch { /* ignore */ }
}

// ─────────────────────────────────────────────────────────────────────

export async function getSubmodules(cwd: string): Promise<GitSubmoduleInfo[]> {
  try {
    const base = await getSubmoduleList(cwd)
    if (base.length === 0) return []
    return await enrichSubmoduleDetails(cwd, base)
  } catch (err) {
    getServices().logError('[git-manager] getSubmodules failed:', err)
    return []
  }
}

/**
 * Refresh a single submodule's details (branch, dirty status) without
 * reloading the entire submodule list.  Used when navigating back from
 * a submodule to update just the one that may have changed.
 */
export async function refreshSingleSubmodule(cwd: string, subPath: string): Promise<Partial<GitSubmoduleInfo> | null> {
  const subCwd = path.join(cwd, subPath)
  try {
    const [statusResult, branchResult, diffResult] = await Promise.allSettled([
      gitExec(subCwd, ['status', '--porcelain'], 5000),
      gitExec(subCwd, ['rev-parse', '--abbrev-ref', 'HEAD'], 5000),
      gitExec(cwd, ['diff', '--name-only', '--', subPath], 5000)
    ])

    const patch: Partial<GitSubmoduleInfo> = { path: subPath }

    if (statusResult.status === 'fulfilled') {
      const lines = statusResult.value.stdout.trim().split('\n').filter(Boolean)
      patch.hasDirtyWorkTree = lines.length > 0
      patch.changeCount = lines.length
    }
    if (branchResult.status === 'fulfilled') {
      const branch = branchResult.value.stdout.trim()
      if (branch && branch !== 'HEAD') { patch.branch = branch; patch.isDetached = false }
      else { patch.isDetached = true; patch.branch = undefined }
    }
    if (diffResult.status === 'fulfilled') {
      patch.status = diffResult.value.stdout.trim() ? 'modified' : 'current'
    }
    // Get current HEAD hash
    try {
      const { stdout: headOut } = await gitExec(subCwd, ['rev-parse', 'HEAD'], 3000)
      patch.hash = headOut.trim().slice(0, 8)
    } catch { /* keep existing */ }

    return patch
  } catch {
    return null
  }
}

/**
 * Fast submodule list — just names, paths, hashes, and status.
 * Uses `git submodule status` with fallback to .gitmodules parsing.
 * Exported so the renderer can show clickable items immediately while
 * enrichSubmoduleDetails() runs in the background.
 */
export async function getSubmoduleList(cwd: string): Promise<GitSubmoduleInfo[]> {
  const stdout = await new Promise<string>((resolve) => {
    execFile('git', ['submodule', 'status'], { cwd, timeout: 10000, maxBuffer: 10 * 1024 * 1024 }, (err, out) => {
      if (err) getServices().log('[git-manager] getSubmodules: git submodule status exited with error (output may still be usable):', err.message?.split('\n')[0])
      resolve(out || '')
    })
  })

  const submodules: GitSubmoduleInfo[] = []

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const prefix = trimmed[0]
    let status: GitSubmoduleInfo['status'] = 'current'
    if (prefix === '+') status = 'modified'
    else if (prefix === '-') status = 'uninitialized'

    const rest = (prefix === ' ' || prefix === '+' || prefix === '-')
      ? trimmed.slice(1).trim()
      : trimmed

    const parts = rest.split(/\s+/)
    const hash = parts[0] || ''
    let subPath = parts[1] || ''
    if (!subPath) continue
    subPath = subPath.replace(/^\.\//, '')
    if (!subPath || subPath === '.' || subPath === '/') continue

    submodules.push({
      name: subPath.split('/').pop() || subPath,
      path: subPath,
      hash: hash.slice(0, 8),
      status
    })
  }

  // Fallback: parse .gitmodules if git submodule status returned nothing
  if (submodules.length === 0) {
    try {
      const { stdout: cfgOut } = await gitExec(cwd, ['config', '--file', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$'], 5000)
      for (const cfgLine of cfgOut.split('\n')) {
        const match = cfgLine.match(/^submodule\.(.+)\.path\s+(.+)$/)
        if (match) {
          let subPath = match[2].trim().replace(/^\.\//, '')
          if (!subPath || subPath === '.' || subPath === '/') continue

          const absSubPath = path.join(cwd, subPath)
          const gitEntry = path.join(absSubPath, '.git')
          let status: GitSubmoduleInfo['status'] = 'uninitialized'
          let hash = '????????'

          if (fs.existsSync(gitEntry)) {
            status = 'current'
            try {
              const { stdout: headOut } = await gitExec(absSubPath, ['rev-parse', 'HEAD'], 5000)
              hash = headOut.trim().slice(0, 8)
            } catch { /* keep default hash */ }
            try {
              const { stdout: diffOut } = await gitExec(cwd, ['diff', '--name-only', '--', subPath], 5000)
              if (diffOut.trim()) status = 'modified'
            } catch { /* keep current status */ }
          }

          submodules.push({
            name: subPath.split('/').pop() || subPath,
            path: subPath,
            hash,
            status
          })
        }
      }
      if (submodules.length > 0) getServices().log(`[git-manager] getSubmodules: recovered ${submodules.length} submodule(s) from .gitmodules fallback`)
    } catch {
      // No .gitmodules or config parse failed — truly no submodules
    }
  }

  // Update cache with fresh list
  saveSubmoduleListCache(cwd, submodules)
  return submodules
}

/**
 * Enrich submodule list with per-submodule details: dirty status, change count,
 * current branch, tracking branch. Uses `git submodule foreach` to batch queries
 * into a single process spawn instead of 2N individual git calls.
 */
async function enrichSubmoduleDetails(cwd: string, submodules: GitSubmoduleInfo[]): Promise<GitSubmoduleInfo[]> {
  const enriched = submodules.map((s) => ({ ...s }))
  const initialized = enriched.filter((s) => s.status !== 'uninitialized')
  if (initialized.length === 0) return enriched

  // Read tracking branches from .gitmodules in one call
  const trackingBranches = new Map<string, string>()
  try {
    const { stdout: cfgOut } = await gitExec(cwd, ['config', '--file', '.gitmodules', '--get-regexp', '^submodule\\..*\\.branch$'], 5000)
    for (const cfgLine of cfgOut.split('\n')) {
      const match = cfgLine.match(/^submodule\.(.+)\.branch\s+(.+)$/)
      if (match) trackingBranches.set(match[1].trim(), match[2].trim())
    }
  } catch { /* no branch config */ }

  // Use `git submodule foreach` to get branch + dirty status in one spawn
  // instead of 2 spawns per submodule.  Output format per submodule:
  //   ===<path>===
  //   BRANCH:<branch-name-or-HEAD>
  //   DIRTY:<0-or-count>
  try {
    // git submodule foreach always uses a POSIX shell (even on Windows),
    // so quoting is consistent across platforms.
    const script = 'echo "====$sm_path====" && git rev-parse --abbrev-ref HEAD && git status --porcelain'

    const { stdout: foreachOut } = await gitExec(cwd, ['submodule', 'foreach', '--quiet', script], 15000)

    let currentPath = ''
    let branchLine = ''
    const dirtyLines: string[] = []

    const flush = () => {
      if (!currentPath) return
      const sub = initialized.find((s) => s.path === currentPath)
      if (sub) {
        if (branchLine && branchLine !== 'HEAD') {
          sub.branch = branchLine.replace(/^heads?\//i, '')
          sub.isDetached = false
        } else {
          sub.isDetached = true
        }
        const count = dirtyLines.filter(Boolean).length
        sub.hasDirtyWorkTree = count > 0
        sub.changeCount = count
      }
    }

    for (const line of foreachOut.split('\n')) {
      const pathMatch = line.match(/^====(.+)====$/)
      if (pathMatch) {
        flush()
        currentPath = pathMatch[1]
        branchLine = ''
        dirtyLines.length = 0
      } else if (!branchLine && currentPath) {
        branchLine = line.trim()
      } else if (currentPath) {
        if (line.trim()) dirtyLines.push(line.trim())
      }
    }
    flush()
  } catch (err) {
    // Fallback: individual per-submodule queries (slower but more resilient)
    getServices().log('[git-manager] getSubmodules: foreach failed, falling back to individual queries:', err instanceof Error ? err.message.split('\n')[0] : err)
    await Promise.allSettled(
      initialized.map(async (sub) => {
        const subCwd = path.join(cwd, sub.path)
        const [statusResult, branchResult] = await Promise.allSettled([
          gitExec(subCwd, ['status', '--porcelain'], 5000),
          gitExec(subCwd, ['rev-parse', '--abbrev-ref', 'HEAD'], 5000)
        ])
        if (statusResult.status === 'fulfilled') {
          const lines = statusResult.value.stdout.trim().split('\n').filter(Boolean)
          sub.hasDirtyWorkTree = lines.length > 0
          sub.changeCount = lines.length
        }
        if (branchResult.status === 'fulfilled') {
          const branch = branchResult.value.stdout.trim()
          if (branch && branch !== 'HEAD') { sub.branch = branch.replace(/^heads?\//i, ''); sub.isDetached = false }
          else sub.isDetached = true
        }
      })
    )
  }

  // Apply tracking branches (strip heads/ prefix from .gitmodules branch values)
  for (const sub of enriched) {
    const tb = trackingBranches.get(sub.name) || trackingBranches.get(sub.path)
    sub.trackingBranch = tb?.replace(/^heads?\//i, '')
  }

  return enriched
}

/**
 * Get file content as a base64 data URL. If ref is given, reads from that git ref;
 * otherwise reads from the working tree.
 */
export async function getCommitFileTree(cwd: string, hash: string): Promise<{ path: string; type: 'blob' | 'tree' }[]> {
  const { stdout } = await gitExec(cwd, ['ls-tree', '-r', '--name-only', hash], 15000)
  return stdout.trim().split('\n').filter(Boolean).map((p) => ({ path: p, type: 'blob' as const }))
}

export async function grepCommit(
  cwd: string, hash: string, pattern: string, maxResults = 200
): Promise<{ path: string; line: number; text: string }[]> {
  try {
    // -n = line numbers, -I = skip binary, --fixed-strings = literal match
    const { stdout } = await gitExec(cwd, [
      'grep', '-n', '-I', '-i', '--fixed-strings', `--max-count=${maxResults}`, pattern, hash
    ], 15000)
    const results: { path: string; line: number; text: string }[] = []
    // Output format: <hash>:<path>:<lineNo>:<text>
    const prefix = hash + ':'
    for (const line of stdout.split('\n')) {
      if (!line.startsWith(prefix)) continue
      const rest = line.slice(prefix.length)
      const colonIdx1 = rest.indexOf(':')
      if (colonIdx1 < 0) continue
      const filePath = rest.slice(0, colonIdx1)
      const rest2 = rest.slice(colonIdx1 + 1)
      const colonIdx2 = rest2.indexOf(':')
      if (colonIdx2 < 0) continue
      const lineNo = parseInt(rest2.slice(0, colonIdx2), 10)
      const text = rest2.slice(colonIdx2 + 1)
      if (!isNaN(lineNo)) results.push({ path: filePath, line: lineNo, text })
      if (results.length >= maxResults) break
    }
    return results
  } catch {
    // git grep exits 1 when no matches found
    return []
  }
}

export async function getFileAtCommit(cwd: string, hash: string, filePath: string): Promise<string | null> {
  try {
    const { stdout } = await gitExec(cwd, ['show', `${hash}:${filePath}`], 10000)
    return stdout
  } catch {
    return null
  }
}

export async function getFileBlob(cwd: string, filePath: string, ref?: string): Promise<string | null> {
  const ext = filePath.split('.').pop()?.toLowerCase() || ''
  const mimeMap: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon',
    avif: 'image/avif', tif: 'image/tiff', tiff: 'image/tiff',
    pdf: 'application/pdf'
  }
  const mime = mimeMap[ext] || 'application/octet-stream'

  try {
    if (ref) {
      // Read from git object store
      const buf = await new Promise<Buffer>((resolve, reject) => {
        execFile('git', ['show', `${ref}:${filePath}`], { cwd, maxBuffer: 50 * 1024 * 1024, encoding: 'buffer' }, (err, out) => {
          if (err) reject(err)
          else resolve(out as unknown as Buffer)
        })
      })
      return `data:${mime};base64,${buf.toString('base64')}`
    } else {
      // Read from working tree
      const absPath = path.join(cwd, filePath)
      const buf = await fs.promises.readFile(absPath)
      return `data:${mime};base64,${buf.toString('base64')}`
    }
  } catch {
    return null
  }
}

export async function syncSubmodules(cwd: string, subPaths?: string[]): Promise<string> {
  const args = ['submodule', 'sync']
  if (subPaths && subPaths.length > 0) args.push('--', ...subPaths)
  const { stdout, stderr } = await gitExec(cwd, args, 30000)
  invalidateSubmoduleCache(cwd)
  return (stdout + stderr).trim()
}

export async function pullRebaseSubmodules(
  cwd: string, subPaths?: string[]
): Promise<{ results: { path: string; success: boolean; output?: string; error?: string }[] }> {
  const svc = getServices()
  // If no specific paths given, get all submodules
  let paths = subPaths
  if (!paths || paths.length === 0) {
    const subs = await listSubmodules(cwd)
    paths = subs.map((s) => s.path)
  }
  const results: { path: string; success: boolean; output?: string; error?: string }[] = []
  for (const subPath of paths) {
    const absPath = path.resolve(cwd, subPath)
    // Check if the submodule directory exists and is a valid git repo
    const gitEntry = path.join(absPath, '.git')
    if (!fs.existsSync(gitEntry)) {
      // Submodule not initialized — try to init it first
      svc.log(`[git-manager] pullRebaseSubmodule ${subPath}: not initialized, running init`)
      try {
        await gitExec(cwd, ['submodule', 'sync', '--', subPath], 15000)
        await gitExec(cwd, ['submodule', 'update', '--init', '--', subPath], 120000)
      } catch (initErr) {
        // sync+update failed — try forceReinit as fallback
        svc.log(`[git-manager] pullRebaseSubmodule ${subPath}: init failed, trying forceReinit`)
        try {
          await forceReinitSubmodule(cwd, subPath)
        } catch (reinitErr) {
          const msg = reinitErr instanceof Error ? reinitErr.message : 'Unknown error'
          results.push({ path: subPath, success: false, error: `Submodule not initialized and reinit failed: ${msg}` })
          svc.logError(`[git-manager] pullRebaseSubmodule ${subPath} reinit failed:`, reinitErr)
          continue
        }
      }
      // Verify it's now initialized
      if (!fs.existsSync(gitEntry)) {
        results.push({ path: subPath, success: false, error: 'Submodule could not be initialized — directory is missing .git after init' })
        continue
      }
      svc.log(`[git-manager] pullRebaseSubmodule ${subPath}: initialized successfully`)
    }
    try {
      const output = await pull(absPath, 'rebase')
      results.push({ path: subPath, success: true, output })
      svc.log(`[git-manager] pullRebaseSubmodule ${subPath}: ${output || 'ok'}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      results.push({ path: subPath, success: false, error: msg })
      svc.logError(`[git-manager] pullRebaseSubmodule ${subPath} failed:`, err)
    }
  }
  invalidateSubmoduleCache(cwd)
  return { results }
}

export async function updateSubmodules(cwd: string, subPaths?: string[], init?: boolean): Promise<string> {
  const svc = getServices()

  const args = ['submodule', 'update']
  if (init) args.push('--init')
  if (subPaths && subPaths.length > 0) args.push('--', ...subPaths)
  const { stdout, stderr } = await gitExec(cwd, args, 120000)
  const output = (stdout + stderr).trim()
  svc.log(`[git-manager] updateSubmodules: ${output || '(no output)'}`)
  invalidateSubmoduleCache(cwd)
  return output
}

/**
 * Get the configured URL for a submodule from .gitmodules.
 */
export async function getSubmoduleUrl(cwd: string, subPath: string): Promise<string | null> {
  // Try direct path lookup first
  try {
    const { stdout } = await gitExec(cwd, ['config', '--file', '.gitmodules', `submodule.${subPath}.url`], 5000)
    if (stdout.trim()) return stdout.trim()
  } catch { /* try name lookup */ }
  // Fallback: search by path
  try {
    const { stdout } = await gitExec(cwd, ['config', '--file', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$'], 5000)
    for (const line of stdout.split('\n')) {
      const m = line.match(/^submodule\.(.+)\.path\s+(.+)$/)
      if (m && m[2].trim() === subPath) {
        const { stdout: u } = await gitExec(cwd, ['config', '--file', '.gitmodules', `submodule.${m[1].trim()}.url`], 5000)
        if (u.trim()) return u.trim()
      }
    }
  } catch { /* ignore */ }
  return null
}

/**
 * Check if a remote git URL is accessible. Returns an error message if not, null if OK.
 * Uses `git ls-remote --exit-code` which is fast (doesn't download objects).
 */
export async function checkRemoteAccess(cwd: string, url: string): Promise<string | null> {
  try {
    await gitExec(cwd, ['ls-remote', '--exit-code', '--heads', url], 15000)
    return null // accessible
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/not found|does not exist|repository.*not found/i.test(msg)) {
      return `Repository not found: ${url}`
    }
    if (/authentication|permission denied|could not read/i.test(msg)) {
      return `Authentication required for: ${url}`
    }
    return `Cannot access repository: ${url}\n${msg.split('\n')[0]}`
  }
}

/**
 * Force re-initialize a submodule by deiniting, removing its directory, and cloning fresh.
 * This is needed when the submodule dir exists with files but no .git entry.
 */
export async function forceReinitSubmodule(cwd: string, subPath: string): Promise<string> {
  const svc = getServices()
  const absPath = path.resolve(cwd, subPath)

  svc.log(`[git-manager] forceReinitSubmodule: deinit + remove + re-clone for ${subPath}`)

  // Check the submodule URL first so we can report it if clone fails
  let subUrl = ''
  try {
    const { stdout: urlOut } = await gitExec(cwd, ['config', '--file', '.gitmodules', `submodule.${subPath}.url`], 5000)
    subUrl = urlOut.trim()
    svc.log(`[git-manager] forceReinitSubmodule: submodule URL = ${subUrl}`)
  } catch {
    // Try with the submodule name instead of path
    try {
      const { stdout: cfgOut } = await gitExec(cwd, ['config', '--file', '.gitmodules', '--get-regexp', `^submodule\\..*\\.path$`], 5000)
      for (const line of cfgOut.split('\n')) {
        const m = line.match(/^submodule\.(.+)\.path\s+(.+)$/)
        if (m && m[2].trim() === subPath) {
          const { stdout: u } = await gitExec(cwd, ['config', '--file', '.gitmodules', `submodule.${m[1].trim()}.url`], 5000)
          subUrl = u.trim()
          break
        }
      }
    } catch { /* ignore */ }
    svc.log(`[git-manager] forceReinitSubmodule: submodule URL (from name lookup) = ${subUrl || '(not found)'}`)
  }

  // Deinit clears git's internal submodule state
  try {
    await gitExec(cwd, ['submodule', 'deinit', '--force', '--', subPath], 15000)
    svc.log(`[git-manager] forceReinitSubmodule: deinit complete`)
  } catch (e) {
    svc.log(`[git-manager] forceReinitSubmodule: deinit failed (continuing): ${e}`)
  }

  // Also clear the cached module in .git/modules/ which can block re-cloning
  try {
    const { stdout: gitDirOut } = await gitExec(cwd, ['rev-parse', '--git-dir'], 5000)
    const gitDir = gitDirOut.trim()
    const modulePath = path.join(cwd, gitDir, 'modules', subPath)
    if (fs.existsSync(modulePath)) {
      fs.rmSync(modulePath, { recursive: true, force: true })
      svc.log(`[git-manager] forceReinitSubmodule: removed cached module at ${modulePath}`)
    }
  } catch (e) {
    svc.log(`[git-manager] forceReinitSubmodule: could not clear cached module: ${e}`)
  }

  // Remove the working directory so git can clone into it
  if (fs.existsSync(absPath)) {
    fs.rmSync(absPath, { recursive: true, force: true })
    svc.log(`[git-manager] forceReinitSubmodule: removed working directory`)
  }

  // Re-sync URL, init, then update (separate steps for reliability)
  let output = ''
  try {
    await gitExec(cwd, ['submodule', 'sync', '--', subPath], 15000)
    svc.log(`[git-manager] forceReinitSubmodule: sync complete`)
  } catch (e) {
    svc.log(`[git-manager] forceReinitSubmodule: sync failed: ${e}`)
  }
  try {
    const { stdout, stderr } = await gitExec(cwd, ['submodule', 'update', '--init', '--', subPath], 120000)
    output = (stdout + stderr).trim()
    svc.log(`[git-manager] forceReinitSubmodule: update --init ${output || '(no output)'}`)
  } catch (e) {
    svc.log(`[git-manager] forceReinitSubmodule: update --init failed: ${e}`)
  }

  // Check if submodule was cloned — if not, try direct git clone as fallback
  const gitEntry = path.join(absPath, '.git')
  if (!fs.existsSync(gitEntry) && subUrl) {
    svc.log(`[git-manager] forceReinitSubmodule: submodule update didn't clone, trying direct git clone`)
    try {
      const { stdout: cloneOut, stderr: cloneErr } = await gitExec(cwd, ['clone', subUrl, subPath], 120000)
      output = (cloneOut + cloneErr).trim()
      svc.log(`[git-manager] forceReinitSubmodule: direct clone ${output || '(no output)'}`)
    } catch (cloneErr) {
      const cloneMsg = cloneErr instanceof Error ? cloneErr.message : String(cloneErr)
      svc.log(`[git-manager] forceReinitSubmodule: direct clone failed: ${cloneMsg}`)
      output += '\n' + cloneMsg
    }
  }

  // Final verification
  if (!fs.existsSync(gitEntry)) {
    const urlHint = subUrl ? `\n\nSubmodule URL: ${subUrl}` : ''
    throw new Error(
      `Submodule "${subPath}" could not be cloned.${urlHint}\n\n` +
      `Both "git submodule update --init" and direct "git clone" failed.\n\n` +
      `Possible causes:\n` +
      `  - The submodule URL is incorrect or inaccessible\n` +
      `  - Authentication is required (try: git clone ${subUrl || '<url>'} in a terminal)\n` +
      `  - Network connectivity issues` +
      (output ? `\n\nGit output:\n${output}` : '')
    )
  }

  return output
}

export async function addSubmodule(cwd: string, url: string, localPath?: string, branch?: string, force?: boolean): Promise<void> {
  const args = ['submodule', 'add']
  if (branch) args.push('-b', branch)
  if (force) args.push('--force')
  args.push(url)
  if (localPath) args.push(localPath)
  getServices().log(`[git-manager] addSubmodule: git ${args.join(' ')} in ${cwd}`)
  await gitExec(cwd, args, 60000)
  invalidateSubmoduleCache(cwd)
}

export async function registerSubmodule(cwd: string, subPath: string): Promise<void> {
  const svc = getServices()
  const absPath = path.resolve(cwd, subPath)
  svc.log(`[git-manager] registerSubmodule: cwd=${cwd} subPath=${subPath} absPath=${absPath}`)

  // Verify the directory exists and is a git repo
  const gitEntry = path.join(absPath, '.git')
  const gitExists = fs.existsSync(gitEntry)
  const gitIsDir = gitExists && fs.statSync(gitEntry).isDirectory()
  svc.log(`[git-manager] registerSubmodule: .git exists=${gitExists} isDir=${gitIsDir}`)
  if (!gitExists) throw new Error(`No .git found in ${absPath} — not a git repository`)

  // Read the remote URL from the nested git repo
  const { stdout } = await gitExec(absPath, ['remote', 'get-url', 'origin'], 5000)
  const url = stdout.trim()
  svc.log(`[git-manager] registerSubmodule: remote origin url=${url}`)
  if (!url) throw new Error('Submodule has no remote "origin" configured')

  // Unstage the gitlink entry if it's currently staged
  try {
    await gitExec(cwd, ['reset', 'HEAD', '--', subPath], 5000)
    svc.log('[git-manager] registerSubmodule: unstaged existing gitlink')
  } catch {
    svc.log('[git-manager] registerSubmodule: no staged gitlink to reset (ok)')
  }

  // Properly register via git submodule add (--force because dir already exists)
  svc.log(`[git-manager] registerSubmodule: running git submodule add --force ${url} ${subPath}`)
  await gitExec(cwd, ['submodule', 'add', '--force', url, subPath], 60000)

  // Verify the submodule is still a valid git repo after absorption
  const postGitExists = fs.existsSync(gitEntry)
  const postGitIsFile = postGitExists && fs.statSync(gitEntry).isFile()
  const postGitIsDir = postGitExists && fs.statSync(gitEntry).isDirectory()
  svc.log(`[git-manager] registerSubmodule: post-add .git exists=${postGitExists} isFile=${postGitIsFile} isDir=${postGitIsDir}`)

  if (!postGitExists) {
    // .git was absorbed but the gitdir file wasn't created — try to recover
    svc.logError('[git-manager] registerSubmodule: .git missing after submodule add, attempting recovery')
    try {
      await gitExec(cwd, ['submodule', 'absorbgitdirs', '--', subPath], 10000)
      svc.log('[git-manager] registerSubmodule: absorbgitdirs recovery attempted')
    } catch (absErr) {
      svc.logError('[git-manager] registerSubmodule: absorbgitdirs recovery failed:', absErr)
    }

    // If still missing, try init + update to recreate
    if (!fs.existsSync(gitEntry)) {
      svc.log('[git-manager] registerSubmodule: .git still missing, trying submodule init + update')
      try {
        await gitExec(cwd, ['submodule', 'init', '--', subPath], 10000)
        await gitExec(cwd, ['submodule', 'update', '--', subPath], 60000)
        svc.log('[git-manager] registerSubmodule: init + update completed')
      } catch (initErr) {
        svc.logError('[git-manager] registerSubmodule: init + update failed:', initErr)
        throw new Error(`Submodule registered in .gitmodules but .git is missing — the repository may need manual repair: ${initErr instanceof Error ? initErr.message : initErr}`)
      }
    }
  }

  // Final verification
  const valid = await isGitRepo(absPath)
  svc.log(`[git-manager] registerSubmodule: final isGitRepo check = ${valid}`)
  if (!valid) {
    throw new Error('Submodule was registered but the directory is no longer a valid git repository — check .git/modules/ for absorbed content')
  }
}

export async function removeSubmodule(cwd: string, subPath: string): Promise<void> {
  getServices().log(`[git-manager] removeSubmodule: ${subPath} in ${cwd}`)
  await gitExec(cwd, ['rm', '-f', subPath], 30000)
  invalidateSubmoduleCache(cwd)
}

// --- Merge conflict operations ---

export async function getMergeState(cwd: string): Promise<GitMergeState> {
  // Find the .git dir
  let gitDir: string
  try {
    const { stdout } = await gitExec(cwd, ['rev-parse', '--git-dir'], 5000)
    gitDir = path.resolve(cwd, stdout.trim())
  } catch {
    return { inProgress: false, type: 'none', conflicts: [] }
  }

  // Detect merge type by sentinel files
  let type: GitMergeState['type'] = 'none'
  let mergeHead: string | undefined

  if (fs.existsSync(path.join(gitDir, 'MERGE_HEAD'))) {
    type = 'merge'
    try { mergeHead = fs.readFileSync(path.join(gitDir, 'MERGE_HEAD'), 'utf-8').trim() } catch { /* ignore */ }
  } else if (fs.existsSync(path.join(gitDir, 'REBASE_HEAD')) || fs.existsSync(path.join(gitDir, 'rebase-merge'))) {
    type = 'rebase'
  } else if (fs.existsSync(path.join(gitDir, 'CHERRY_PICK_HEAD'))) {
    type = 'cherry-pick'
  } else if (fs.existsSync(path.join(gitDir, 'REVERT_HEAD'))) {
    type = 'revert'
  }

  if (type === 'none') return { inProgress: false, type: 'none', conflicts: [] }

  const status = await getStatus(cwd)

  // For rebase: sentinel files exist transiently while git auto-applies
  // commits. Without real conflicts the rebase completes on its own and
  // should not trigger the merge UI.
  // For merge/cherry-pick/revert: the user must explicitly commit even after
  // resolving all conflicts, so always report as in-progress while the
  // sentinel file exists.
  if (type === 'rebase' && status.conflicts.length === 0) {
    return { inProgress: false, type: 'none', conflicts: [] }
  }
  return { inProgress: true, type, conflicts: status.conflicts, mergeHead }
}

export async function getConflictFileContent(cwd: string, filePath: string): Promise<GitConflictFileContent> {
  const absPath = path.resolve(cwd, filePath)

  // Detect submodule conflicts — either a directory or mode 160000 in the index
  let isSubmodule = false
  let isDir = false
  try { isDir = fs.statSync(absPath).isDirectory(); isSubmodule = isDir } catch { /* path may not exist */ }

  // Also detect submodules when the directory doesn't exist (deleted submodule conflicts)
  let lsFilesOutput = ''
  if (!isSubmodule) {
    try {
      const { stdout: lsOut } = await gitExec(cwd, ['ls-files', '-u', '-z', '--', filePath], 3000)
      lsFilesOutput = lsOut
      isSubmodule = /^160000\s/m.test(lsOut)
    } catch { /* ignore */ }
  }

  if (isSubmodule) {
    // Get conflicting commit hashes from the index stages
    if (!lsFilesOutput) {
      const { stdout } = await gitExec(cwd, ['ls-files', '-u', '-z', '--', filePath], 5000)
      lsFilesOutput = stdout
    }
    const stages: Record<number, string> = {}
    for (const entry of lsFilesOutput.split('\0').filter(Boolean)) {
      const match = entry.match(/^(\d+)\s+([0-9a-f]+)\s+(\d)\s+/)
      if (match) stages[parseInt(match[3])] = match[2]
    }

    // Try to get commit messages from the submodule directory (only if it exists)
    let oursMessage: string | undefined
    let theirsMessage: string | undefined
    if (isDir) {
      if (stages[2]) {
        try {
          const { stdout: msg } = await gitExec(absPath, ['log', '--format=%s', '-1', stages[2]], 3000)
          oursMessage = msg.trim() || undefined
        } catch { /* commit may not be fetched locally */ }
      }
      if (stages[3]) {
        try {
          const { stdout: msg } = await gitExec(absPath, ['log', '--format=%s', '-1', stages[3]], 3000)
          theirsMessage = msg.trim() || undefined
        } catch { /* commit may not be fetched locally */ }
      }
    }

    return {
      path: filePath,
      chunks: [],
      raw: '',
      submodule: {
        baseHash: stages[1] || '',
        oursHash: stages[2] || '',
        theirsHash: stages[3] || '',
        oursMessage,
        theirsMessage,
      }
    }
  }

  // Detect delete conflicts (one side deleted the file, other modified it)
  // Check which stages exist in the index — missing stage = that side deleted
  if (!lsFilesOutput) {
    try {
      const { stdout: lsOut } = await gitExec(cwd, ['ls-files', '-u', '-z', '--', filePath], 3000)
      lsFilesOutput = lsOut
    } catch { /* ignore */ }
  }
  if (lsFilesOutput) {
    const stageHashes: Record<number, string> = {}
    for (const entry of lsFilesOutput.split('\0').filter(Boolean)) {
      const match = entry.match(/^(\d+)\s+([0-9a-f]+)\s+(\d)\s+/)
      if (match) stageHashes[parseInt(match[3])] = match[2]
    }
    const oursExists = !!stageHashes[2]
    const theirsExists = !!stageHashes[3]

    if (oursExists && !theirsExists) {
      // They deleted the file, we modified it — file should exist on disk with our content
      let content = ''
      try { content = fs.readFileSync(absPath, 'utf-8') } catch {
        try { const { stdout } = await gitExec(cwd, ['show', stageHashes[2]], 5000); content = stdout } catch { /* ignore */ }
      }
      return { path: filePath, chunks: [], raw: content, deleteConflict: { deletedBy: 'theirs', content } }
    }
    if (!oursExists && theirsExists) {
      // We deleted the file, they modified it — file may not exist on disk
      let content = ''
      try { const { stdout } = await gitExec(cwd, ['show', stageHashes[3]], 5000); content = stdout } catch { /* ignore */ }
      return { path: filePath, chunks: [], raw: content, deleteConflict: { deletedBy: 'ours', content } }
    }
  }

  // If the file doesn't exist on disk, it was deleted — treat as a delete conflict
  if (!fs.existsSync(absPath)) {
    // Figure out which side deleted by checking what stages exist
    const stageHashes: Record<number, string> = {}
    for (const entry of (lsFilesOutput || '').split('\0').filter(Boolean)) {
      const match = entry.match(/^(\d+)\s+([0-9a-f]+)\s+(\d)\s+/)
      if (match) stageHashes[parseInt(match[3])] = match[2]
    }
    // Try to get content from whatever stage exists
    let content = ''
    const contentHash = stageHashes[3] || stageHashes[2] || stageHashes[1]
    if (contentHash) {
      try { const { stdout } = await gitExec(cwd, ['show', contentHash], 5000); content = stdout } catch { /* ignore */ }
    }
    const deletedBy = stageHashes[2] && !stageHashes[3] ? 'theirs' as const
      : !stageHashes[2] && stageHashes[3] ? 'ours' as const
      : 'theirs' as const // default: treat as incoming deletion
    return { path: filePath, chunks: [], raw: content, deleteConflict: { deletedBy, content } }
  }

  const raw = fs.readFileSync(absPath, 'utf-8')
  const chunks = parseConflictMarkers(raw)
  return { path: filePath, chunks, raw }
}

function parseConflictMarkers(content: string): GitConflictChunk[] {
  const lines = content.split('\n').map(l => l.replace(/\r$/, ''))
  const chunks: GitConflictChunk[] = []
  let commonLines: string[] = []
  let commonStart = 1
  let i = 0

  while (i < lines.length) {
    if (lines[i].startsWith('<<<<<<<')) {
      // Flush common lines
      if (commonLines.length > 0) {
        chunks.push({ type: 'common', commonLines, startLine: commonStart, endLine: commonStart + commonLines.length - 1 })
        commonLines = []
      }

      const conflictStart = i + 1
      const oursLines: string[] = []
      const theirsLines: string[] = []
      let inTheirs = false
      i++ // skip <<<<<<< line

      while (i < lines.length) {
        if (lines[i].startsWith('=======')) {
          inTheirs = true
          i++
          continue
        }
        if (lines[i].startsWith('>>>>>>>')) {
          i++
          break
        }
        if (inTheirs) theirsLines.push(lines[i])
        else oursLines.push(lines[i])
        i++
      }

      chunks.push({ type: 'conflict', oursLines, theirsLines, startLine: conflictStart, endLine: i })
      commonStart = i + 1
    } else {
      commonLines.push(lines[i])
      i++
    }
  }

  // Flush remaining common lines
  if (commonLines.length > 0) {
    chunks.push({ type: 'common', commonLines, startLine: commonStart, endLine: commonStart + commonLines.length - 1 })
  }

  return chunks
}

export async function resolveConflictFile(
  cwd: string, filePath: string, resolution: 'ours' | 'theirs' | 'both', chunkIndex?: number
): Promise<void> {
  const absPath = path.resolve(cwd, filePath)

  // Submodule conflict — resolve by updating the index directly
  // Using git add on submodules can fail with "does not have a commit checked out"
  // so we set the index entry to the chosen side's hash and optionally update the working tree
  let isSubmoduleConflict = false
  try { isSubmoduleConflict = fs.statSync(absPath).isDirectory() } catch { /* path may not exist */ }
  // Also detect submodules via index mode even if the directory is gone
  if (!isSubmoduleConflict) {
    try {
      const { stdout: lsOut } = await gitExec(cwd, ['ls-files', '-u', '--', filePath], 3000)
      isSubmoduleConflict = /^160000\s/m.test(lsOut)
    } catch { /* ignore */ }
  }
  if (isSubmoduleConflict) {
    if (resolution === 'both') throw new Error('Submodule conflicts cannot use "accept both" — choose ours or theirs')
    // Get the target hash from the conflict stages (stage 2 = ours, stage 3 = theirs)
    const { stdout: lsFiles } = await gitExec(cwd, ['ls-files', '-u', '-z', '--', filePath], 5000)
    const targetStage = resolution === 'ours' ? 2 : 3
    let targetHash = ''
    for (const entry of lsFiles.split('\0').filter(Boolean)) {
      const match = entry.match(/^(\d+)\s+([0-9a-f]+)\s+(\d)\s+/)
      if (match && parseInt(match[3]) === targetStage) {
        targetHash = match[2]
        break
      }
    }
    if (!targetHash) throw new Error(`No ${resolution} version found for submodule conflict on ${filePath}`)
    // Clear all conflict stages and set a clean stage-0 entry
    await gitExec(cwd, ['update-index', '--force-remove', filePath], 5000)
    await gitExec(cwd, ['update-index', '--add', '--cacheinfo', `160000,${targetHash},${filePath}`], 5000)
    // Try to update the submodule working tree to match (non-critical)
    try { await gitExec(absPath, ['checkout', targetHash], 10000) } catch {
      try { await gitExec(cwd, ['submodule', 'update', '--init', '--', filePath], 15000) } catch { /* non-critical */ }
    }
    return
  }

  // Delete conflict — one side deleted the file, other modified it
  {
    const { stdout: lsOut } = await gitExec(cwd, ['ls-files', '-u', '-z', '--', filePath], 3000)
    const hasStage2 = lsOut.split('\0').some((e) => /\s2\s/.test(e))
    const hasStage3 = lsOut.split('\0').some((e) => /\s3\s/.test(e))
    if (!hasStage2 || !hasStage3) {
      if (resolution === 'both') throw new Error('Cannot accept both for delete conflicts — choose to keep or delete the file')
      // Determine if the chosen resolution keeps or deletes the file
      const keepFile = (resolution === 'ours' && hasStage2) || (resolution === 'theirs' && hasStage3)
      if (keepFile) {
        await gitExec(cwd, ['checkout', `--${resolution}`, '--', filePath], 5000)
        await gitExec(cwd, ['add', '--', filePath], 5000)
      } else {
        await gitExec(cwd, ['rm', '--', filePath], 5000)
      }
      return
    }
  }

  const raw = fs.readFileSync(absPath, 'utf-8')
  const lineEnding = raw.includes('\r\n') ? '\r\n' : '\n'
  const chunks = parseConflictMarkers(raw)

  const resolvedLines: string[] = []
  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci]
    if (chunk.type === 'common') {
      resolvedLines.push(...(chunk.commonLines || []))
    } else if (chunkIndex !== undefined && ci !== chunkIndex) {
      // Keep this conflict unresolved — reconstruct markers
      resolvedLines.push('<<<<<<< HEAD')
      resolvedLines.push(...(chunk.oursLines || []))
      resolvedLines.push('=======')
      resolvedLines.push(...(chunk.theirsLines || []))
      resolvedLines.push('>>>>>>> theirs')
    } else {
      // Resolve this chunk
      if (resolution === 'ours') resolvedLines.push(...(chunk.oursLines || []))
      else if (resolution === 'theirs') resolvedLines.push(...(chunk.theirsLines || []))
      else { resolvedLines.push(...(chunk.oursLines || [])); resolvedLines.push(...(chunk.theirsLines || [])) }
    }
  }

  fs.writeFileSync(absPath, resolvedLines.join(lineEnding), 'utf-8')
}

export async function abortMerge(cwd: string): Promise<void> {
  const state = await getMergeState(cwd)

  if (state.type !== 'none') {
    // A tracked operation is in progress — use the matching --abort subcommand.
    const cmd = state.type === 'rebase' ? 'rebase'
      : state.type === 'cherry-pick' ? 'cherry-pick'
      : state.type === 'revert' ? 'revert'
      : 'merge'
    await gitExec(cwd, [cmd, '--abort'], 15000)
    return
  }

  // No tracked merge/rebase/cherry-pick/revert, but there may still be unmerged
  // paths in the index (e.g. from `git stash pop` or `git stash apply` conflicts).
  // In this case `git merge --abort` fails because MERGE_HEAD is missing.
  // Resolve by restoring the conflicting files from HEAD.
  const status = await getStatus(cwd)
  if (status.conflicts.length > 0) {
    const paths = status.conflicts.map((c) => c.path)
    getServices().log('[git-manager] abortMerge: no tracked merge, resetting', paths.length, 'conflicting files from HEAD')
    // Reset the index entries for the conflicting files to HEAD, then checkout.
    // This clears the unmerged state and restores the files without touching
    // non-conflicting changes (so work-in-progress is preserved).
    await gitExec(cwd, ['reset', 'HEAD', '--', ...paths], 15000)
    await gitExec(cwd, ['checkout', '--', ...paths], 15000)
    return
  }

  // Nothing to abort — no tracked operation and no conflicts.
  getServices().log('[git-manager] abortMerge: nothing to abort')
}

export async function mergeBranch(cwd: string, branchName: string): Promise<void> {
  await gitExec(cwd, ['merge', branchName], 60000)
}

export async function continueMerge(cwd: string): Promise<void> {
  const state = await getMergeState(cwd)
  if (state.type === 'rebase') {
    // Suppress editor with -c core.editor=true (no-op) — git rebase --continue
    // may try to open an editor for reword/edit steps; we can't do interactive
    // editing here so we accept the default message.
    await gitExecNoEditor(cwd, ['rebase', '--continue'], 30000)
  } else {
    // merge/cherry-pick/revert: commit with the pre-filled merge message
    await gitExecNoEditor(cwd, ['commit', '--no-edit'], 30000)
  }
}

/**
 * Run a git command with the editor suppressed (core.editor=true).
 * Prevents git from trying to open vi/nano/notepad in a non-interactive context.
 */
function gitExecNoEditor(cwd: string, args: string[], timeout = 30000): Promise<{ stdout: string; stderr: string }> {
  return gitExec(cwd, ['-c', 'core.editor=true', ...args], timeout)
}

// --- Git Worktrees ---

// GitWorktreeInfo is imported from shared/git-manager-types

export async function listWorktrees(cwd: string): Promise<GitWorktreeInfo[]> {
  try {
    const { stdout } = await gitExec(cwd, ['worktree', 'list', '--porcelain'], 10000)
    const worktrees: GitWorktreeInfo[] = []
    let current: Partial<GitWorktreeInfo> = {}

    for (const line of stdout.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (current.path) worktrees.push(current as GitWorktreeInfo)
        current = { path: line.slice(9).trim(), branch: '', head: '', isMain: false, isBare: false }
      } else if (line.startsWith('HEAD ')) {
        current.head = line.slice(5).trim().slice(0, 8)
      } else if (line.startsWith('branch ')) {
        // refs/heads/main -> main
        current.branch = line.slice(7).trim().replace(/^refs\/heads\//, '')
      } else if (line === 'bare') {
        current.isBare = true
      } else if (line.trim() === 'prunable') {
        current.isPrunable = true
      } else if (line === '') {
        // Empty line separates entries
      }
    }
    if (current.path) worktrees.push(current as GitWorktreeInfo)

    // First worktree is always the main one
    if (worktrees.length > 0) worktrees[0].isMain = true

    // Enrich non-main, non-prunable worktrees with status info
    const enrichable = worktrees.filter(wt => !wt.isMain && !wt.isPrunable && !wt.isBare)
    await Promise.all(enrichable.map(async (wt) => {
      try {
        const { stdout: statusOut } = await gitExec(wt.path, ['status', '--porcelain'], 5000)
        const lines = statusOut.split('\n').filter(l => l.trim())
        wt.changeCount = lines.length
        wt.hasDirtyWorkTree = lines.length > 0
      } catch {
        // Worktree may be broken/locked — skip status
      }
    }))

    getServices().log(`[git-manager] listWorktrees: found ${worktrees.length} worktree(s) for ${cwd}`)
    return worktrees
  } catch (err) {
    getServices().logError('[git-manager] listWorktrees failed:', err)
    return []
  }
}

/**
 * Generate a short unique ID for a worktree directory.
 * Uses a hash of the branch name + timestamp to avoid collisions when
 * creating multiple worktrees from the same branch.
 */
function worktreeId(branch: string): string {
  const crypto = require('crypto') as typeof import('crypto')
  const hash = crypto.createHash('sha256')
    .update(branch + ':' + Date.now() + ':' + Math.random())
    .digest('hex')
    .slice(0, 8)
  const safeBranch = branch.replace(/^[^/]+\//, '').replace(/[/\\:*?"<>|]/g, '-').slice(0, 40)
  return `${safeBranch}-${hash}`
}

export async function addWorktree(cwd: string, branch: string, targetPath?: string): Promise<string> {
  // Store worktrees inside .claude/worktrees/ within the project directory
  const worktreeBase = path.join(cwd, '.claude', 'worktrees')
  const worktreePath = targetPath || path.join(worktreeBase, worktreeId(branch))

  getServices().log(`[git-manager] addWorktree: branch=${branch} path=${worktreePath} cwd=${cwd}`)
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true })
  await gitExec(cwd, ['worktree', 'add', worktreePath, branch], 30000)
  getServices().log(`[git-manager] addWorktree: created successfully at ${worktreePath}`)
  return worktreePath
}

export async function addWorktreeNewBranch(cwd: string, newBranch: string, startPoint?: string): Promise<string> {
  const worktreeBase = path.join(cwd, '.claude', 'worktrees')
  const worktreePath = path.join(worktreeBase, worktreeId(newBranch))

  getServices().log(`[git-manager] addWorktreeNewBranch: newBranch=${newBranch} startPoint=${startPoint || 'HEAD'} path=${worktreePath}`)
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true })
  const args = ['worktree', 'add', '-b', newBranch, worktreePath]
  if (startPoint) args.push(startPoint)
  await gitExec(cwd, args, 30000)
  getServices().log(`[git-manager] addWorktreeNewBranch: created successfully at ${worktreePath}`)
  return worktreePath
}

export async function removeWorktree(cwd: string, worktreePath: string, force?: boolean): Promise<void> {
  getServices().log(`[git-manager] removeWorktree: path=${worktreePath} force=${!!force} cwd=${cwd}`)
  const args = ['worktree', 'remove', worktreePath]
  if (force) args.push('--force')
  await gitExec(cwd, args, 15000)
  getServices().log(`[git-manager] removeWorktree: removed ${worktreePath}`)
}

/**
 * Prune orphaned worktree administrative entries (those whose directories were
 * deleted outside git). Safe to run any time — it only removes metadata for
 * worktrees git already considers missing.
 */
export async function pruneWorktrees(cwd: string): Promise<PruneWorktreesResult> {
  getServices().log(`[git-manager] pruneWorktrees: cwd=${cwd}`)
  try {
    const { stdout } = await gitExec(cwd, ['worktree', 'prune', '--verbose'], 15000)
    // Git emits lines like "Removing worktrees/foo: gitdir file points to non-existent location"
    // (forward slash on Unix, backslash on Windows)
    const pruned = stdout
      .split(/\r?\n/)
      .map((l) => {
        const m = l.match(/^Removing (?:worktrees[/\\])?([^:]+)/)
        return m ? m[1].trim() : null
      })
      .filter((s): s is string => !!s)
    getServices().log(`[git-manager] pruneWorktrees: pruned ${pruned.length} entries`)
    return { pruned }
  } catch (err: any) {
    getServices().logError('[git-manager] pruneWorktrees failed:', err)
    return { pruned: [], error: err instanceof Error ? err.message : 'Prune failed' }
  }
}

/**
 * Resolve a worktree: stage all changes, commit, optionally merge into a target branch, then remove the worktree.
 * If no targetBranch, the commit stays on the worktree's branch (headless or named).
 */
export async function resolveWorktree(
  mainCwd: string,
  worktreePath: string,
  commitMessage: string,
  targetBranch?: string,
  options?: ResolveWorktreeOptions
): Promise<ResolveWorktreeResult> {
  const warnings: string[] = []
  const log = (msg: string): void => getServices().log(`[git-manager] resolveWorktree: ${msg}`)
  log(`path=${worktreePath} target=${targetBranch || 'none'} captureBranch=${options?.captureBranchName || 'none'} cwd=${mainCwd}`)

  // --- 1. Probe worktree HEAD state -----------------------------------------
  let sourceBranch = ''
  try {
    const { stdout } = await gitExec(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'], 5000)
    sourceBranch = stdout.trim()
  } catch (err: any) {
    getServices().logError('[git-manager] resolveWorktree: could not read worktree HEAD:', err)
    return { success: false, error: `Could not read worktree HEAD: ${err?.message || 'unknown error'}` }
  }
  const isDetached = sourceBranch === 'HEAD' || sourceBranch === ''

  // --- 2. Detached-HEAD gate ------------------------------------------------
  if (isDetached && !targetBranch && !options?.captureBranchName) {
    log('detached HEAD detected with no merge target and no capture branch — prompting caller')
    return {
      success: false,
      needsCaptureBranch: true,
      error: 'Worktree is on a detached HEAD. Provide a capture branch name or a merge target so the commit is preserved.'
    }
  }

  if (isDetached && options?.captureBranchName) {
    const name = options.captureBranchName.trim()
    if (!name) return { success: false, error: 'Capture branch name is empty' }
    try {
      await gitExec(worktreePath, ['checkout', '-b', name], 10000)
      sourceBranch = name
      log(`created capture branch '${name}' in worktree`)
    } catch (err: any) {
      const msg = err?.message || ''
      const friendly = /already exists/i.test(msg)
        ? `Branch '${name}' already exists. Pick a different capture branch name.`
        : `Failed to create capture branch '${name}': ${msg}`
      return { success: false, needsCaptureBranch: true, error: friendly }
    }
  }

  // --- 3. Main-repo preflight (only if we plan to merge) --------------------
  if (targetBranch) {
    try {
      const mainStatus = await getStatus(mainCwd)
      const mainDirty = mainStatus.staged.length + mainStatus.unstaged.length + mainStatus.conflicts.length
      if (mainDirty > 0) {
        return {
          success: false,
          error: 'Main repository has uncommitted changes — commit or stash them before merging a worktree.'
        }
      }
    } catch (err: any) {
      getServices().logError('[git-manager] resolveWorktree: main preflight status failed:', err)
      return { success: false, error: `Could not check main repository state: ${err?.message || 'unknown error'}` }
    }
  }

  // --- 4. Detect and commit changes in the worktree ------------------------
  // Cross-check getStatus with `git diff-index` to avoid false "no changes"
  // when the porcelain parse silently swallowed an error.
  let hasTrackedChanges = false
  let hasUntracked = false
  try {
    await gitExec(worktreePath, ['diff-index', '--quiet', 'HEAD', '--'], 10000)
    hasTrackedChanges = false
  } catch {
    hasTrackedChanges = true // non-zero exit = dirty index or working tree
  }
  try {
    const { stdout } = await gitExec(worktreePath, ['ls-files', '--others', '--exclude-standard'], 10000)
    hasUntracked = stdout.trim().length > 0
  } catch (err) {
    getServices().logError('[git-manager] resolveWorktree: ls-files probe failed (continuing):', err)
  }

  let commitHash = ''
  let commitAttempted = false

  if (hasTrackedChanges || hasUntracked) {
    commitAttempted = true
    try {
      await gitExec(worktreePath, ['add', '-A'], 15000)
      log('staged all changes')
    } catch (err: any) {
      return { success: false, error: `Failed to stage changes: ${err?.message || 'unknown error'}` }
    }
    try {
      await gitExec(worktreePath, ['commit', '-m', commitMessage], 30000)
      log('committed successfully')
    } catch (err: any) {
      const msg = err?.message || ''
      // Benign: "nothing to commit" can happen if every staged path was
      // gitignored or an empty rename. Not fatal — we still proceed to merge/remove.
      if (/nothing to commit|no changes added/i.test(msg)) {
        warnings.push('Nothing to commit (staged paths were ignored or produced no diff).')
        log('nothing to commit — continuing as clean')
      } else {
        return { success: false, error: `Commit failed: ${msg}` }
      }
    }
  }

  // Canonical hash via rev-parse (stable regardless of commit output format).
  try {
    const { stdout } = await gitExec(worktreePath, ['rev-parse', 'HEAD'], 5000)
    commitHash = stdout.trim()
  } catch (err: any) {
    getServices().logError('[git-manager] resolveWorktree: rev-parse HEAD failed:', err)
    return { success: false, error: `Could not resolve worktree HEAD: ${err?.message || 'unknown error'}` }
  }

  if (!commitAttempted) log(`no changes to commit — HEAD=${commitHash.slice(0, 8)}`)

  // --- 5. Merge into target branch (optional) -------------------------------
  let merged = false
  if (targetBranch) {
    try {
      await gitExec(mainCwd, ['checkout', targetBranch], 15000)
      log(`checked out '${targetBranch}' in main repo`)
    } catch (err: any) {
      return { success: false, error: `Could not checkout '${targetBranch}' in main repo: ${err?.message || 'unknown error'}` }
    }

    let mergeThrew = false
    try {
      await gitExec(mainCwd, ['merge', sourceBranch, '--no-ff', '-m', `Merge worktree: ${commitMessage}`], 60000)
    } catch (err: any) {
      mergeThrew = true
      log(`merge command threw: ${err?.message || 'unknown'}`)
    }

    // Post-merge status: authoritative — determines conflicts even if merge exited 0.
    let postStatus: GitStatusResult | null = null
    try {
      postStatus = await getStatus(mainCwd)
    } catch (err) {
      getServices().logError('[git-manager] resolveWorktree: post-merge status failed:', err)
    }
    const conflictCount = postStatus?.conflicts.length ?? 0

    if (conflictCount > 0) {
      // Conflicts in main — keep worktree for safety; UI opens git-manager.
      log(`merge produced ${conflictCount} conflict(s) — leaving merge in progress, preserving worktree`)
      return {
        success: true,
        commitHash,
        merged: false,
        hasConflicts: true,
        mergeInProgress: true,
        removedWorktree: false,
        warnings
      }
    }

    if (mergeThrew) {
      // Threw but no conflicts detected — unexpected state. Try to rollback the merge.
      try { await gitExec(mainCwd, ['merge', '--abort'], 10000) } catch { /* nothing in progress */ }
      return { success: false, error: 'Merge failed and produced no conflicts. The merge has been aborted.' }
    }

    merged = true
    log(`merged '${sourceBranch}' into '${targetBranch}'`)
  }

  // --- 6. Remove the worktree ----------------------------------------------
  let removedWorktree = false
  try {
    await removeWorktree(mainCwd, worktreePath, true)
    removedWorktree = true
  } catch (err: any) {
    getServices().logError('[git-manager] resolveWorktree: failed to remove worktree:', err)
    warnings.push(`Worktree could not be removed: ${err?.message || 'unknown error'}`)
  }

  // --- 7. Optional source-branch cleanup -----------------------------------
  if (options?.deleteSourceBranch && removedWorktree && sourceBranch && sourceBranch !== 'HEAD') {
    // Never delete the branch currently checked out in mainCwd — fail-safe if
    // the rev-parse lookup fails rather than potentially deleting a load-bearing branch.
    let mainBranch: string | null = null
    try {
      const { stdout } = await gitExec(mainCwd, ['rev-parse', '--abbrev-ref', 'HEAD'], 5000)
      mainBranch = stdout.trim()
    } catch (err: any) {
      warnings.push(`Could not verify main repo's current branch — skipped deleting '${sourceBranch}' to be safe: ${err?.message || 'unknown'}`)
    }
    if (mainBranch !== null) {
      const protectedBranches = new Set(['main', 'master', 'develop', 'trunk', mainBranch].filter(Boolean))
      if (!protectedBranches.has(sourceBranch)) {
        try {
          await gitExec(mainCwd, ['branch', '-D', sourceBranch], 10000)
          log(`deleted source branch '${sourceBranch}'`)
        } catch (err: any) {
          warnings.push(`Could not delete source branch '${sourceBranch}': ${err?.message || 'unknown error'}`)
        }
      } else {
        warnings.push(`Skipped deleting protected branch '${sourceBranch}'.`)
      }
    }
  }

  return {
    success: true,
    commitHash,
    merged,
    hasConflicts: false,
    mergeInProgress: false,
    removedWorktree,
    warnings: warnings.length ? warnings : undefined
  }
}

// --- Search ---

const searchGeneration = new Map<string, number>()

function nextSearchGen(cwd: string): number {
  const gen = (searchGeneration.get(cwd) || 0) + 1
  searchGeneration.set(cwd, gen)
  return gen
}

function isSearchStale(cwd: string, gen: number): boolean {
  return (searchGeneration.get(cwd) || 0) !== gen
}

export async function searchRepo(cwd: string, opts: GitSearchOptions): Promise<GitSearchResponse> {
  const gen = nextSearchGen(cwd)
  const query = opts.query.trim()
  const maxResults = opts.maxResults ?? 100

  if (!query) return { results: [], truncated: false }

  if (opts.mode === 'working') {
    return searchWorking(cwd, query, maxResults, gen)
  }
  return searchLog(cwd, query, maxResults, gen)
}

async function searchLog(cwd: string, query: string, maxResults: number, gen: number): Promise<GitSearchResponse> {
  const results: GitSearchResult[] = []
  const seen = new Set<string>() // dedup key: hash:filePath

  const addResult = (r: GitSearchResult) => {
    const key = r.source.type === 'commit' ? `${r.source.hash}:${r.filePath}` : `w:${r.filePath}`
    if (seen.has(key)) {
      // Keep higher confidence
      const idx = results.findIndex((e) =>
        e.source.type === 'commit' && r.source.type === 'commit' &&
        e.source.hash === r.source.hash && e.filePath === r.filePath
      )
      if (idx >= 0 && results[idx].confidence < r.confidence) {
        results[idx] = r
      }
      return
    }
    seen.add(key)
    results.push(r)
  }

  // Strategy 1: Message grep
  const messageSearch = async () => {
    if (isSearchStale(cwd, gen)) return
    try {
      const { stdout } = await gitExec(cwd, [
        'log', '--all', '-i', `--grep=${query}`, `--format=%H%n%h%n%s`, '--max-count=50'
      ], 15000)
      if (isSearchStale(cwd, gen)) return
      const lines = stdout.trim().split('\n').filter(Boolean)
      for (let i = 0; i + 2 < lines.length; i += 3) {
        const hash = lines[i]
        const shortHash = lines[i + 1]
        const subject = lines[i + 2]
        const lowerSubject = subject.toLowerCase()
        const lowerQuery = query.toLowerCase()
        const confidence = lowerSubject === lowerQuery ? 100
          : lowerSubject.includes(lowerQuery) ? 95 : 90
        addResult({
          id: `msg:${hash}`,
          source: { type: 'commit', hash, shortHash, subject },
          filePath: '',
          matchType: 'subject',
          confidence
        })
      }
    } catch { /* ignore */ }
  }

  // Strategy 2: Pickaxe (content search)
  const pickaxeSearch = async () => {
    if (isSearchStale(cwd, gen)) return
    try {
      const { stdout } = await gitExec(cwd, [
        'log', '--all', `-S${query}`, `--format=%H%n%h%n%s`, '--max-count=30'
      ], 30000)
      if (isSearchStale(cwd, gen)) return
      const lines = stdout.trim().split('\n').filter(Boolean)
      const commits: { hash: string; shortHash: string; subject: string }[] = []
      for (let i = 0; i + 2 < lines.length; i += 3) {
        commits.push({ hash: lines[i], shortHash: lines[i + 1], subject: lines[i + 2] })
      }

      // For each commit, get lightweight diff to find file + line (parallel)
      const lowerQuery = query.toLowerCase()
      await Promise.all(commits.slice(0, 15).map(async (c) => {
        if (isSearchStale(cwd, gen)) return
        try {
          const { stdout: diffOut } = await gitExec(cwd, [
            'diff-tree', '--root', '-p', '--unified=0', c.hash
          ], 10000)
          let currentFile = ''
          let lineNum: number | undefined
          for (const line of diffOut.split('\n')) {
            if (line.startsWith('+++ b/')) {
              currentFile = line.slice(6)
            } else if (line.startsWith('@@')) {
              const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)/)
              if (match) lineNum = parseInt(match[1], 10)
            } else if ((line.startsWith('+') || line.startsWith('-')) && !line.startsWith('+++') && !line.startsWith('---')) {
              if (line.toLowerCase().includes(lowerQuery)) {
                const isAdd = line.startsWith('+')
                const confidence = isAdd ? 70 : 65
                addResult({
                  id: `pick:${c.hash}:${currentFile}:${lineNum}`,
                  source: { type: 'commit', hash: c.hash, shortHash: c.shortHash, subject: c.subject },
                  filePath: currentFile,
                  lineNumber: lineNum,
                  lineContent: line.slice(1).trim(),
                  matchType: 'diff-content',
                  confidence
                })
                // Only take first match per file per commit
                currentFile = ''
              }
              if (lineNum !== undefined && line.startsWith('+')) lineNum++
            }
          }
        } catch { /* ignore per-commit errors */ }
      }))
    } catch { /* ignore */ }
  }

  // Strategy 3: File path search
  const filePathSearch = async () => {
    if (isSearchStale(cwd, gen)) return
    try {
      const { stdout } = await gitExec(cwd, ['ls-tree', '-r', '--name-only', 'HEAD'], 10000)
      if (isSearchStale(cwd, gen)) return
      const lowerQuery = query.toLowerCase()
      const matchingPaths = stdout.trim().split('\n').filter((p) => p.toLowerCase().includes(lowerQuery))

      for (const filePath of matchingPaths.slice(0, 30)) {
        if (isSearchStale(cwd, gen)) return
        const basename = filePath.split('/').pop() || filePath
        const confidence = basename.toLowerCase().includes(lowerQuery) ? 85 : 80
        try {
          const { stdout: logOut } = await gitExec(cwd, [
            'log', '--all', '--format=%H%n%h%n%s', '--max-count=1', '--', filePath
          ], 5000)
          const lines = logOut.trim().split('\n').filter(Boolean)
          if (lines.length >= 3) {
            addResult({
              id: `fp:${lines[0]}:${filePath}`,
              source: { type: 'commit', hash: lines[0], shortHash: lines[1], subject: lines[2] },
              filePath,
              matchType: 'filepath',
              confidence
            })
          }
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  await Promise.all([messageSearch(), pickaxeSearch(), filePathSearch()])

  if (isSearchStale(cwd, gen)) return { results: [], truncated: false }

  results.sort((a, b) => b.confidence - a.confidence)
  const truncated = results.length > maxResults
  return { results: results.slice(0, maxResults), truncated }
}

async function searchWorking(cwd: string, query: string, maxResults: number, gen: number): Promise<GitSearchResponse> {
  const results: GitSearchResult[] = []
  const lowerQuery = query.toLowerCase()

  try {
    const status = await getStatus(cwd)
    if (isSearchStale(cwd, gen)) return { results: [], truncated: false }

    const sections: { files: GitFileStatusEntry[]; section: 'staged' | 'unstaged' | 'untracked' }[] = [
      { files: status.staged, section: 'staged' },
      { files: status.unstaged, section: 'unstaged' },
      { files: status.untracked, section: 'untracked' }
    ]

    // First pass: path matches
    const pathMatches = new Set<string>()
    for (const { files, section } of sections) {
      for (const f of files) {
        if (f.path.toLowerCase().includes(lowerQuery)) {
          pathMatches.add(f.path)
          const basename = f.path.split('/').pop() || f.path
          const confidence = basename.toLowerCase().includes(lowerQuery) ? 85 : 80
          results.push({
            id: `wc:${section}:${f.path}`,
            source: { type: 'working', section },
            filePath: f.path,
            matchType: 'filepath',
            confidence
          })
        }
      }
    }

    // Second pass: diff content search (only staged + unstaged, limit scope)
    const diffSections: { files: GitFileStatusEntry[]; section: 'staged' | 'unstaged'; staged: boolean }[] = [
      { files: status.staged, section: 'staged', staged: true },
      { files: status.unstaged, section: 'unstaged', staged: false }
    ]

    let diffCount = 0
    const MAX_DIFF_FILES = 20
    for (const { files, section, staged } of diffSections) {
      for (const f of files) {
        if (diffCount >= MAX_DIFF_FILES) break
        if (isSearchStale(cwd, gen)) return { results: [], truncated: false }
        // Skip files already found by path match unless we want content matches too
        diffCount++
        try {
          const diffs = await getDiff(cwd, f.path, staged)
          for (const diff of diffs) {
            for (const hunk of diff.hunks) {
              for (const line of hunk.lines) {
                if (line.content.toLowerCase().includes(lowerQuery)) {
                  const confidence = line.type === 'add' ? 70 : 65
                  const lineNo = line.type === 'delete' ? line.oldLineNo : line.newLineNo
                  results.push({
                    id: `wcd:${section}:${f.path}:${lineNo}`,
                    source: { type: 'working', section },
                    filePath: f.path,
                    lineNumber: lineNo,
                    lineContent: line.content.trim(),
                    matchType: 'diff-content',
                    confidence
                  })
                  break // one match per file is enough
                }
              }
            }
          }
        } catch { /* ignore per-file errors */ }
      }
    }
  } catch (err) {
    getServices().logError('[git-manager] searchWorking failed:', err)
  }

  if (isSearchStale(cwd, gen)) return { results: [], truncated: false }

  results.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence
    // Within same confidence: staged > unstaged > untracked
    const order = { staged: 0, unstaged: 1, untracked: 2 }
    const aOrder = a.source.type === 'working' ? order[a.source.section] : 3
    const bOrder = b.source.type === 'working' ? order[b.source.section] : 3
    return aOrder - bOrder
  })

  const truncated = results.length > maxResults
  return { results: results.slice(0, maxResults), truncated }
}
