import { execFile } from 'child_process'
import * as http from 'http'
import * as fs from 'fs'
import * as path from 'path'
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
  GitConflictFileContent
} from '../../../shared/git-manager-types'
import { log, logError } from '../../logger'

function gitExec(cwd: string, args: string[], timeout = 30000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        // Ensure stderr is included in error message — execFile may omit it
        // depending on Node.js version, but IPC handlers rely on err.message
        if (stderr && !err.message.includes(stderr.trim().slice(0, 50))) {
          err.message += '\n' + stderr
        }
        reject(err)
      } else {
        resolve({ stdout: stdout || '', stderr: stderr || '' })
      }
    })
  })
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
      proc.stdin.write(stdin)
      proc.stdin.end()
    }
  })
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await gitExec(cwd, ['rev-parse', '--is-inside-work-tree'], 5000)
    return true
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
    logError('[git-manager] getLog failed:', err)
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

  // Local branches with tracking info
  try {
    const { stdout } = await gitExec(cwd, [
      'for-each-ref',
      '--format=%(refname:short)%09%(upstream:short)%09%(upstream:track)%09%(HEAD)',
      'refs/heads/'
    ], 10000)

    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue
      const [name, tracking, trackInfo, head] = line.split('\t')
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
    }
  } catch (err) {
    logError('[git-manager] getBranches (local) failed:', err)
  }

  // Remote branches
  try {
    const { stdout } = await gitExec(cwd, [
      'for-each-ref',
      '--format=%(refname:short)',
      'refs/remotes/'
    ], 10000)

    for (const line of stdout.split('\n')) {
      const name = line.trim()
      if (!name || name.endsWith('/HEAD')) continue
      // Skip if already covered by a local tracking branch
      branches.push({
        name,
        current: false,
        remote: true,
        ahead: 0,
        behind: 0
      })
    }
  } catch (err) {
    logError('[git-manager] getBranches (remote) failed:', err)
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

export async function getStatus(cwd: string): Promise<GitStatusResult> {
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
    const { stdout } = await gitExec(cwd, ['status', '--porcelain=v2', '--branch', '-z', '-uall'], 10000)
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
        const path = parts.slice(8).join(' ')
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
        const filePath = parts.slice(10).join(' ')
        result.conflicts.push({
          path: filePath,
          oursStatus: xy[0],
          theirsStatus: xy[1]
        })
      } else if (entry.startsWith('? ')) {
        const path = entry.slice(2)
        result.untracked.push({
          path,
          indexStatus: '?',
          workTreeStatus: '?'
        })
      }
    }
  } catch (err) {
    logError('[git-manager] getStatus failed:', err)
    // Try fallback for branch name
    try {
      const { stdout } = await gitExec(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], 5000)
      result.branch = stdout.trim()
    } catch { /* ignore */ }
  }

  return result
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

    // Detect binary
    if (block.includes('Binary files')) {
      files.push({ path, oldPath, status: 'binary', hunks: [], isBinary: true })
      continue
    }

    // Detect status from diff header lines
    let status = 'modified'
    if (block.includes('new file mode')) status = 'added'
    else if (block.includes('deleted file mode')) status = 'deleted'
    else if (oldPath) status = 'renamed'

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
    // If no diff returned for a specific file, it may be untracked or newly added —
    // synthesize a full-content diff so the viewer can display it
    if (diffs.length === 0 && filePath) {
      const fsP = require('fs/promises') as typeof import('fs/promises')
      const pathMod = require('path') as typeof import('path')
      try {
        const absPath = pathMod.join(cwd, filePath)
        const stat = await fsP.stat(absPath)
        if (stat.isFile() && stat.size < 512 * 1024) { // skip files > 512KB
          const content = await fsP.readFile(absPath, 'utf-8')
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
      } catch { /* file unreadable — leave empty */ }
    }
    return diffs
  } catch (err) {
    logError('[git-manager] getDiff failed:', err)
    return []
  }
}

// --- Commit detail ---

export async function getCommitDetail(cwd: string, hash: string): Promise<GitCommitDetail | null> {
  try {
    // Run metadata and diff in parallel for speed
    const metaPromise = gitExec(cwd, [
      'log', '-1', `--format=${LOG_FORMAT}%n%b`, hash
    ], 10000)

    // For the diff, we need to know if it's a root commit (no parents).
    // Use --root flag speculatively — git ignores it for non-root commits.
    const diffPromise = gitExec(cwd, [
      'diff-tree', '--root', '-p', '--no-color', '--unified=5', '-r', hash
    ], 15000)

    const [{ stdout: metaOut }, { stdout: diffOut }] = await Promise.all([metaPromise, diffPromise])

    const lines = metaOut.split('\n')
    if (lines.length < 7) return null

    const endIdx = lines.indexOf('---END---')
    const bodyLines = endIdx >= 0 ? lines.slice(endIdx + 1) : []

    const commit: GitCommitDetail = {
      hash: lines[0],
      shortHash: lines[1],
      author: lines[2],
      authorEmail: lines[3],
      date: lines[4],
      subject: lines[5],
      parents: lines[6] ? lines[6].split(' ').filter(Boolean) : [],
      refs: lines[7] ? lines[7].split(',').map((r) => r.trim()).filter(Boolean) : [],
      body: bodyLines.join('\n').trim(),
      files: parseDiffOutput(diffOut)
    }

    return commit
  } catch (err) {
    logError('[git-manager] getCommitDetail failed:', err)
    return null
  }
}

// --- Stage / Unstage ---

export async function stageFiles(cwd: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return
  const BATCH = 50
  for (let i = 0; i < paths.length; i += BATCH) {
    await gitExec(cwd, ['add', '--', ...paths.slice(i, i + BATCH)], 10000)
  }
}

export async function unstageFiles(cwd: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return
  const BATCH = 50
  for (let i = 0; i < paths.length; i += BATCH) {
    const chunk = paths.slice(i, i + BATCH)
    try {
      await gitExec(cwd, ['restore', '--staged', '--', ...chunk], 10000)
    } catch {
      // Fallback for older git without restore
      await gitExec(cwd, ['reset', 'HEAD', '--', ...chunk], 10000)
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

export async function checkoutBranch(cwd: string, name: string): Promise<void> {
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

// --- Discard / Delete ---

export async function discardFiles(cwd: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return
  await gitExec(cwd, ['checkout', '--', ...paths], 10000)
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

// --- Partial staging (apply patch) ---

export async function applyPatch(cwd: string, patch: string, cached: boolean, reverse: boolean): Promise<void> {
  const args = ['apply', '--unidiff-zero', '--whitespace=nowarn']
  if (cached) args.push('--cached')
  if (reverse) args.push('--reverse')
  await gitExecStdin(cwd, args, patch)
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

export async function renameBranch(cwd: string, oldName: string, newName: string): Promise<void> {
  await gitExec(cwd, ['branch', '-m', oldName, newName], 10000)
}

// --- Remote operations ---

export async function pull(cwd: string, mode?: 'merge' | 'rebase'): Promise<string> {
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

export async function push(cwd: string): Promise<string> {
  const { stdout, stderr } = await gitExec(cwd, ['push'], 60000)
  return (stdout + stderr).trim()
}

export async function pushForceWithLease(cwd: string): Promise<string> {
  const { stdout, stderr } = await gitExec(cwd, ['push', '--force-with-lease'], 60000)
  return (stdout + stderr).trim()
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

// --- Submodules ---

// --- Commit message generation ---

const COMMIT_MSG_PROMPT = [
  'Write a single-line git commit message for the following staged changes.',
  'Use conventional commit format (feat:, fix:, refactor:, docs:, chore:, style:, test:).',
  'Keep it under 72 characters. Return ONLY the commit message — no quotes, no explanation, no extra text.'
].join(' ')

function cleanCommitMessage(raw: string): string {
  return raw.trim()
    .replace(/^["']|["']$/g, '')
    .split('\n')[0]
    .trim()
}

function ollamaRequest(path: string, body?: object, timeout = 30000): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: 11434,
      path,
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : {}
    }, (res) => {
      let data = ''
      res.on('data', (chunk) => data += chunk)
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch { reject(new Error('Invalid JSON from Ollama')) }
      })
    })
    req.on('error', () => reject(new Error('ollama_unavailable')))
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('Ollama request timed out')) })
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

// Cache Ollama model to avoid /api/tags call every time
let cachedOllamaModel: string | null = null
let ollamaModelCacheTime = 0
const OLLAMA_CACHE_TTL = 5 * 60 * 1000 // 5 minutes

// Track Ollama availability to skip it fast when down
let ollamaUnavailableUntil = 0
const OLLAMA_BACKOFF = 60 * 1000 // 1 minute backoff after failure

async function pickOllamaModel(): Promise<string> {
  if (cachedOllamaModel && Date.now() - ollamaModelCacheTime < OLLAMA_CACHE_TTL) {
    return cachedOllamaModel
  }
  const data = await ollamaRequest('/api/tags', undefined, 3000)
  const models: { name: string }[] = data?.models || []
  if (models.length === 0) {
    throw new Error('No Ollama models installed. Run: ollama pull llama3.2')
  }
  const preferred = ['qwen2.5-coder', 'deepseek-coder', 'codellama', 'llama3.2', 'llama3.1', 'phi', 'gemma']
  for (const pref of preferred) {
    const match = models.find((m) => m.name.startsWith(pref))
    if (match) { cachedOllamaModel = match.name; ollamaModelCacheTime = Date.now(); return match.name }
  }
  cachedOllamaModel = models[0].name
  ollamaModelCacheTime = Date.now()
  return cachedOllamaModel
}

async function generateViaOllama(stat: string, diff: string): Promise<string> {
  if (Date.now() < ollamaUnavailableUntil) throw new Error('ollama_unavailable')
  try {
    const model = await pickOllamaModel()
    const prompt = `${COMMIT_MSG_PROMPT}\n\nDiff summary:\n${stat}\n\nDiff:\n${diff}`
    const result = await ollamaRequest('/api/generate', {
      model,
      prompt,
      stream: false,
      options: { temperature: 0.3, num_predict: 100 }
    }, 30000)
    const msg = cleanCommitMessage(result?.response || '')
    if (!msg) throw new Error('Empty response from Ollama')
    return msg
  } catch (err) {
    if (err instanceof Error && err.message === 'ollama_unavailable') {
      ollamaUnavailableUntil = Date.now() + OLLAMA_BACKOFF
    }
    throw err
  }
}

async function generateViaClaude(stat: string, diff: string): Promise<string> {
  const { spawn } = require('child_process') as typeof import('child_process')
  // Use stat + compact diff for Claude — stat is usually enough context
  const prompt = `${COMMIT_MSG_PROMPT}\n\nDiff summary:\n${stat}\n\nDiff:\n${diff}`

  const stdout = await new Promise<string>((resolve, reject) => {
    const proc = spawn('claude', ['-p', '--model', 'haiku', '--max-turns', '1'], {
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe']
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

export async function generateCommitMessage(cwd: string): Promise<string> {
  // Get staged diff with minimal context (--unified=2) for speed
  const [statResult, diffResult] = await Promise.all([
    gitExec(cwd, ['diff', '--cached', '--stat', '--no-color'], 10000),
    gitExec(cwd, ['diff', '--cached', '--no-color', '--unified=2'], 10000)
  ])

  const stat = statResult.stdout.trim()
  if (!stat) throw new Error('No staged changes to describe')

  const maxLen = 4000
  const diff = diffResult.stdout.length > maxLen
    ? diffResult.stdout.slice(0, maxLen) + '\n... (truncated)'
    : diffResult.stdout

  log(`[git-manager] generating commit message: stat=${stat.length} chars, diff=${diff.length} chars`)
  const t0 = Date.now()

  // Race Ollama and Claude in parallel — use whichever responds first
  const ollamaSkipped = Date.now() < ollamaUnavailableUntil
  const providers: Promise<string>[] = []

  if (!ollamaSkipped) {
    providers.push(generateViaOllama(stat, diff).then((r) => {
      log(`[git-manager] Ollama responded in ${Date.now() - t0}ms`)
      return r
    }))
  }
  providers.push(generateViaClaude(stat, diff).then((r) => {
    log(`[git-manager] Claude CLI responded in ${Date.now() - t0}ms`)
    return r
  }))

  // Promise.any resolves with the first successful result
  try {
    return await Promise.any(providers)
  } catch (agg) {
    const errors = agg instanceof AggregateError ? agg.errors : [agg]
    for (const e of errors) log(`[git-manager] provider failed: ${e instanceof Error ? e.message : e}`)
    throw new Error(
      'Could not generate commit message. Install Ollama (https://ollama.com) or the Claude CLI.'
    )
  }
}

export async function getSubmodules(cwd: string): Promise<GitSubmoduleInfo[]> {
  try {
    // Use lenient execution: git submodule status may exit non-zero
    // (e.g., conflicting or partially-initialized submodules) while still
    // printing valid data to stdout. gitExec rejects on non-zero exit and
    // discards stdout, so we call execFile directly here.
    const stdout = await new Promise<string>((resolve) => {
      execFile('git', ['submodule', 'status'], { cwd, timeout: 10000, maxBuffer: 10 * 1024 * 1024 }, (err, out) => {
        if (err) log('[git-manager] getSubmodules: git submodule status exited with error (output may still be usable):', err.message?.split('\n')[0])
        resolve(out || '')
      })
    })

    const submodules: GitSubmoduleInfo[] = []

    for (const line of stdout.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      // Format: " <hash> <path> (<desc>)" or "+<hash> <path> (<desc>)" or "-<hash> <path>"
      // First char: ' ' = current, '+' = modified, '-' = uninitialized
      const prefix = trimmed[0]
      let status: GitSubmoduleInfo['status'] = 'current'
      if (prefix === '+') status = 'modified'
      else if (prefix === '-') status = 'uninitialized'

      const rest = (prefix === ' ' || prefix === '+' || prefix === '-')
        ? trimmed.slice(1).trim()
        : trimmed

      const parts = rest.split(/\s+/)
      const hash = parts[0] || ''
      const subPath = parts[1] || ''
      if (!subPath) continue

      submodules.push({
        name: subPath.split('/').pop() || subPath,
        path: subPath,
        hash: hash.slice(0, 8),
        status
      })
    }

    // Fallback: if git submodule status returned nothing, try parsing .gitmodules
    if (submodules.length === 0) {
      try {
        const { stdout: cfgOut } = await gitExec(cwd, ['config', '--file', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$'], 5000)
        for (const cfgLine of cfgOut.split('\n')) {
          const match = cfgLine.match(/^submodule\.(.+)\.path\s+(.+)$/)
          if (match) {
            const subPath = match[2].trim()
            submodules.push({
              name: subPath.split('/').pop() || subPath,
              path: subPath,
              hash: '????????',
              status: 'uninitialized'
            })
          }
        }
        if (submodules.length > 0) log(`[git-manager] getSubmodules: recovered ${submodules.length} submodule(s) from .gitmodules fallback`)
      } catch {
        // No .gitmodules or config parse failed — truly no submodules
      }
    }

    // Check dirty working tree, change count, and current branch for each initialized submodule
    const pathMod = require('path') as typeof import('path')
    await Promise.allSettled(
      submodules.map(async (sub) => {
        if (sub.status === 'uninitialized') return
        try {
          const subCwd = pathMod.join(cwd, sub.path)
          const { stdout: porcelain } = await gitExec(subCwd, ['status', '--porcelain'], 5000)
          const lines = porcelain.trim().split('\n').filter(Boolean)
          sub.hasDirtyWorkTree = lines.length > 0
          sub.changeCount = lines.length
        } catch {
          // ignore — submodule might not be accessible
        }
        try {
          const subCwd = pathMod.join(cwd, sub.path)
          const { stdout: branchOut } = await gitExec(subCwd, ['rev-parse', '--abbrev-ref', 'HEAD'], 5000)
          const branch = branchOut.trim()
          if (branch && branch !== 'HEAD') sub.branch = branch
        } catch {
          // ignore
        }
      })
    )

    return submodules
  } catch (err) {
    logError('[git-manager] getSubmodules failed:', err)
    return []
  }
}

export async function addSubmodule(cwd: string, url: string, localPath?: string, branch?: string, force?: boolean): Promise<void> {
  const args = ['submodule', 'add']
  if (branch) args.push('-b', branch)
  if (force) args.push('--force')
  args.push(url)
  if (localPath) args.push(localPath)
  await gitExec(cwd, args, 60000)
}

export async function removeSubmodule(cwd: string, subPath: string): Promise<void> {
  await gitExec(cwd, ['rm', '-f', subPath], 30000)
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

  // Get conflicts from status
  const status = await getStatus(cwd)
  return { inProgress: true, type, conflicts: status.conflicts, mergeHead }
}

export async function getConflictFileContent(cwd: string, filePath: string): Promise<GitConflictFileContent> {
  const absPath = path.resolve(cwd, filePath)
  const raw = fs.readFileSync(absPath, 'utf-8')
  const chunks = parseConflictMarkers(raw)
  return { path: filePath, chunks, raw }
}

function parseConflictMarkers(content: string): GitConflictChunk[] {
  const lines = content.split('\n')
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
  const cmd = state.type === 'rebase' ? 'rebase' : state.type === 'cherry-pick' ? 'cherry-pick' : state.type === 'revert' ? 'revert' : 'merge'
  await gitExec(cwd, [cmd, '--abort'], 15000)
}

export async function mergeBranch(cwd: string, branchName: string): Promise<void> {
  await gitExec(cwd, ['merge', branchName], 60000)
}

export async function continueMerge(cwd: string): Promise<void> {
  const state = await getMergeState(cwd)
  if (state.type === 'rebase') {
    await gitExec(cwd, ['rebase', '--continue'], 30000)
  } else {
    // merge/cherry-pick/revert: commit to continue
    await gitExec(cwd, ['commit', '--no-edit'], 30000)
  }
}
