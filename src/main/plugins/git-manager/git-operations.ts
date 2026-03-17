import { execFile } from 'child_process'
import * as http from 'http'
import * as https from 'https'
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
  GitConflictFileContent,
  GitSearchOptions,
  GitSearchResponse,
  GitSearchResult,
  SearchResultSource
} from '../../../shared/git-manager-types'
import { getServices } from './services'

function gitExec(cwd: string, args: string[], timeout = 30000): Promise<{ stdout: string; stderr: string }> {
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
  } catch (err) {
    getServices().log(`[git-manager] isGitRepo(${cwd}): false —`, err instanceof Error ? err.message.split('\n')[0] : err)
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
    getServices().logError('[git-manager] getBranches (local) failed:', err)
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
    getServices().logError('[git-manager] getBranches (remote) failed:', err)
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
    getServices().logError('[git-manager] getStatus failed:', err)
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
    getServices().logError('[git-manager] getCommitDetail failed:', err)
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

export async function renameBranch(cwd: string, oldName: string, newName: string): Promise<void> {
  await gitExec(cwd, ['branch', '-m', oldName, newName], 10000)
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
  'Write a git commit message for the following staged changes.',
  'Use conventional commit format (feat:, fix:, refactor:, docs:, chore:, style:, test:).',
  'First line: a short summary under 72 characters.',
  'If the changes cover multiple distinct topics, add a blank line after the summary then bullet points (using -) for each change.',
  'Return ONLY the commit message — no quotes, no explanation, no markdown fences, no extra text.'
].join(' ')

function cleanCommitMessage(raw: string): string {
  let msg = raw.trim()
    .replace(/^["']|["']$/g, '')
    .replace(/^```[^\n]*\n?|```$/gm, '')
    .trim()
  // Ensure first line is under 72 chars
  const lines = msg.split('\n')
  if (lines[0].length > 72) {
    lines[0] = lines[0].slice(0, 72).replace(/\s+\S*$/, '')
  }
  return lines.join('\n').trim()
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
    const shortDiff = diff.length > 4000 ? diff.slice(0, 4000) + '\n... (truncated)' : diff
    const prompt = `${COMMIT_MSG_PROMPT}\n\nDiff summary:\n${stat}\n\nDiff:\n${shortDiff}`
    const result = await ollamaRequest('/api/generate', {
      model,
      prompt,
      stream: false,
      options: { temperature: 0.3, num_predict: 200 }
    }, 15000)
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
  const shortDiff = diff.length > 4000 ? diff.slice(0, 4000) + '\n... (truncated)' : diff
  const prompt = `${COMMIT_MSG_PROMPT}\n\nDiff summary:\n${stat}\n\nDiff:\n${shortDiff}`

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

  const shortDiff = diff.length > 4000 ? diff.slice(0, 4000) + '\n... (truncated)' : diff
  const prompt = `${COMMIT_MSG_PROMPT}\n\nDiff summary:\n${stat}\n\nDiff:\n${shortDiff}`

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

export async function generateCommitMessage(cwd: string): Promise<string> {
  // Get staged diff with minimal context for speed
  const [statResult, diffResult] = await Promise.all([
    gitExec(cwd, ['diff', '--cached', '--stat', '--no-color'], 10000),
    gitExec(cwd, ['diff', '--cached', '--no-color', '--unified=1'], 10000)
  ])

  const stat = statResult.stdout.trim()
  if (!stat) throw new Error('No staged changes to describe')

  const diff = diffResult.stdout

  getServices().log(`[git-manager] generating commit message: stat=${stat.length} chars, diff=${diff.length} chars`)
  const t0 = Date.now()

  // Race all available providers — use whichever responds first
  const ollamaSkipped = Date.now() < ollamaUnavailableUntil
  const providers: Promise<string>[] = []

  if (!ollamaSkipped) {
    providers.push(generateViaOllama(stat, diff).then((r) => {
      getServices().log(`[git-manager] Ollama responded in ${Date.now() - t0}ms`)
      return r
    }))
  }
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

  // Promise.any resolves with the first successful result
  try {
    return await Promise.any(providers)
  } catch (agg) {
    const errors = agg instanceof AggregateError ? agg.errors : [agg]
    for (const e of errors) getServices().log(`[git-manager] provider failed: ${e instanceof Error ? e.message : e}`)
    throw new Error(
      'Could not generate commit message. Ensure the Claude CLI is installed, Ollama is running, or ANTHROPIC_API_KEY is set.'
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
        if (err) getServices().log('[git-manager] getSubmodules: git submodule status exited with error (output may still be usable):', err.message?.split('\n')[0])
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
      let subPath = parts[1] || ''
      if (!subPath) continue
      // Normalize: strip leading './' and reject self-referential paths
      subPath = subPath.replace(/^\.\//, '')
      if (!subPath || subPath === '.' || subPath === '/') continue

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
            let subPath = match[2].trim().replace(/^\.\//, '')
            if (!subPath || subPath === '.' || subPath === '/') continue
            submodules.push({
              name: subPath.split('/').pop() || subPath,
              path: subPath,
              hash: '????????',
              status: 'uninitialized'
            })
          }
        }
        if (submodules.length > 0) getServices().log(`[git-manager] getSubmodules: recovered ${submodules.length} submodule(s) from .gitmodules fallback`)
      } catch {
        // No .gitmodules or config parse failed — truly no submodules
      }
    }

    // Read tracking branches from .gitmodules for all submodules
    const trackingBranches = new Map<string, string>()
    try {
      const { stdout: cfgOut } = await gitExec(cwd, ['config', '--file', '.gitmodules', '--get-regexp', '^submodule\\..*\\.branch$'], 5000)
      for (const cfgLine of cfgOut.split('\n')) {
        const match = cfgLine.match(/^submodule\.(.+)\.branch\s+(.+)$/)
        if (match) {
          // Key is the submodule name in .gitmodules, value is the branch
          const subPath = match[1].trim()
          trackingBranches.set(subPath, match[2].trim())
        }
      }
    } catch {
      // No .gitmodules or no branch config — that's fine
    }

    // Check dirty working tree, change count, current branch, and detached HEAD for each initialized submodule
    const pathMod = require('path') as typeof import('path')
    await Promise.allSettled(
      submodules.map(async (sub) => {
        if (sub.status === 'uninitialized') return

        // Set tracking branch from .gitmodules
        sub.trackingBranch = trackingBranches.get(sub.name) || trackingBranches.get(sub.path)

        try {
          const subCwd = pathMod.join(cwd, sub.path)
          const { stdout: porcelain } = await gitExec(subCwd, ['status', '--porcelain'], 5000)
          const lines = porcelain.trim().split('\n').filter(Boolean)
          sub.hasDirtyWorkTree = lines.length > 0
          sub.changeCount = lines.length
        } catch (err) {
          getServices().log(`[git-manager] getSubmodules: status failed for ${sub.path}:`, err instanceof Error ? err.message.split('\n')[0] : err)
        }
        try {
          const subCwd = pathMod.join(cwd, sub.path)
          const { stdout: branchOut } = await gitExec(subCwd, ['rev-parse', '--abbrev-ref', 'HEAD'], 5000)
          const branch = branchOut.trim()
          if (branch && branch !== 'HEAD') {
            sub.branch = branch
            sub.isDetached = false
          } else {
            // Detached HEAD — common after git submodule update
            sub.isDetached = true
          }
        } catch (err) {
          getServices().log(`[git-manager] getSubmodules: branch check failed for ${sub.path}:`, err instanceof Error ? err.message.split('\n')[0] : err)
        }
      })
    )

    return submodules
  } catch (err) {
    getServices().logError('[git-manager] getSubmodules failed:', err)
    return []
  }
}

/**
 * Get file content as a base64 data URL. If ref is given, reads from that git ref;
 * otherwise reads from the working tree.
 */
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

export async function addSubmodule(cwd: string, url: string, localPath?: string, branch?: string, force?: boolean): Promise<void> {
  const args = ['submodule', 'add']
  if (branch) args.push('-b', branch)
  if (force) args.push('--force')
  args.push(url)
  if (localPath) args.push(localPath)
  getServices().log(`[git-manager] addSubmodule: git ${args.join(' ')} in ${cwd}`)
  await gitExec(cwd, args, 60000)
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

  // Get conflicts from status — only report as in-progress if there are
  // actual unmerged files. During a normal `git pull --rebase`, sentinel files
  // exist transiently while git applies commits. Without real conflicts the
  // rebase completes on its own and should not trigger the conflict UI.
  const status = await getStatus(cwd)
  if (status.conflicts.length === 0) {
    return { inProgress: false, type: 'none', conflicts: [] }
  }
  return { inProgress: true, type, conflicts: status.conflicts, mergeHead }
}

export async function getConflictFileContent(cwd: string, filePath: string): Promise<GitConflictFileContent> {
  const absPath = path.resolve(cwd, filePath)
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

      // For each commit, get lightweight diff to find file + line
      for (const c of commits.slice(0, 15)) {
        if (isSearchStale(cwd, gen)) return
        try {
          const { stdout: diffOut } = await gitExec(cwd, [
            'diff-tree', '--root', '-p', '--unified=0', c.hash
          ], 10000)
          let currentFile = ''
          let lineNum: number | undefined
          let lineContent: string | undefined
          const lowerQuery = query.toLowerCase()
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
      }
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
