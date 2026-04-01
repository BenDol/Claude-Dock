/**
 * File content search engine for the workspace plugin.
 * Uses `git grep` for git repos (fast, respects .gitignore).
 * Falls back to manual recursive search for non-git repos.
 */
import { execFile } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export interface SearchOptions {
  query: string
  projectDir: string
  caseSensitive?: boolean
  wholeWord?: boolean
  regex?: boolean
  filePattern?: string   // glob like *.ts, *.java
  maxResults?: number
}

export interface SearchMatch {
  filePath: string       // relative to projectDir
  line: number
  column: number
  text: string           // the matched line content (trimmed)
  matchStart: number     // column offset of match in text
  matchEnd: number       // end column of match in text
}

export interface SearchResult {
  matches: SearchMatch[]
  totalMatches: number
  truncated: boolean
  durationMs: number
}

const MAX_RESULTS = 500
const SEARCH_TIMEOUT = 10000 // 10 seconds
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.cache', '__pycache__',
  '.next', '.nuxt', 'target', 'out', '.gradle', '.idea', '.vscode',
  'bin', 'obj', '.svelte-kit', '.output', 'coverage'
])
const BINARY_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'avif', 'tif', 'tiff',
  'pdf', 'zip', 'tar', 'gz', '7z', 'rar', 'exe', 'dll', 'so', 'dylib',
  'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp3', 'mp4', 'wav', 'ogg',
  'webm', 'mov', 'avi', 'class', 'pyc', 'o', 'obj', 'lock'
])

/** Check if project is a git repo */
function isGitRepo(dir: string): boolean {
  try { return fs.existsSync(path.join(dir, '.git')) } catch { return false }
}

/** Search using git grep (fast, respects .gitignore). Async to avoid blocking main process. */
async function searchWithGit(opts: SearchOptions): Promise<SearchResult> {
  const start = Date.now()
  const limit = opts.maxResults ?? MAX_RESULTS
  const args = ['grep', '-n', '--column', '-I']

  if (!opts.caseSensitive) args.push('-i')
  if (opts.wholeWord) args.push('-w')
  if (opts.regex) {
    args.push('-E')
  } else {
    args.push('-F')
  }
  args.push(`--max-count=${Math.ceil(limit / 5)}`)
  args.push('-e', opts.query)
  if (opts.filePattern) args.push('--', opts.filePattern)

  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: opts.projectDir,
      encoding: 'utf-8',
      timeout: SEARCH_TIMEOUT,
      maxBuffer: 10 * 1024 * 1024
    })
    return parseGitGrepOutput(stdout, limit, Date.now() - start)
  } catch (err: any) {
    // git grep exits 1 when no matches — that's not an error
    if (err.code === 1 || err.status === 1 || (err.stderr === '' && err.stdout === '')) {
      return { matches: [], totalMatches: 0, truncated: false, durationMs: Date.now() - start }
    }
    return { matches: [], totalMatches: 0, truncated: false, durationMs: Date.now() - start }
  }
}

function parseGitGrepOutput(stdout: string, limit: number, durationMs: number): SearchResult {
  const matches: SearchMatch[] = []
  let totalMatches = 0

  for (const line of stdout.split('\n')) {
    if (!line) continue
    // Format: file:line:column:content
    const m = line.match(/^(.+?):(\d+):(\d+):(.*)$/)
    if (!m) continue
    totalMatches++
    if (matches.length >= limit) continue

    const filePath = m[1]
    const lineNo = parseInt(m[2], 10)
    const col = parseInt(m[3], 10)
    const text = m[4].trim()

    matches.push({
      filePath,
      line: lineNo,
      column: col,
      text: text.length > 300 ? text.slice(0, 300) + '...' : text,
      matchStart: col - 1,
      matchEnd: col - 1 // approximate — git grep doesn't give match length
    })
  }

  return { matches, totalMatches, truncated: totalMatches > limit, durationMs }
}

/** Fallback: manual recursive search (for non-git repos). Async to avoid blocking main process. */
async function searchManual(opts: SearchOptions): Promise<SearchResult> {
  const start = Date.now()
  const limit = opts.maxResults ?? MAX_RESULTS
  const matches: SearchMatch[] = []
  let totalMatches = 0
  const flags = opts.caseSensitive ? 'g' : 'gi'
  let pattern: RegExp

  try {
    if (opts.regex) {
      pattern = new RegExp(opts.query, flags)
    } else {
      const escaped = opts.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      pattern = opts.wholeWord ? new RegExp(`\\b${escaped}\\b`, flags) : new RegExp(escaped, flags)
    }
  } catch {
    return { matches: [], totalMatches: 0, truncated: false, durationMs: 0 }
  }

  const filePatternRe = opts.filePattern ? globToRegex(opts.filePattern) : null

  // Collect files to search first (sync dir scan is fast), then read contents async
  const filesToSearch: { absPath: string; relPath: string }[] = []
  const collectFiles = (dir: string, relDir: string) => {
    if (filesToSearch.length >= limit * 10 || Date.now() - start > SEARCH_TIMEOUT) return
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (filesToSearch.length >= limit * 10) return
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) collectFiles(path.join(dir, entry.name), relDir ? `${relDir}/${entry.name}` : entry.name)
      } else if (entry.isFile()) {
        const ext = entry.name.split('.').pop()?.toLowerCase() || ''
        if (BINARY_EXTS.has(ext)) continue
        const relPath = relDir ? `${relDir}/${entry.name}` : entry.name
        if (filePatternRe && !filePatternRe.test(relPath)) continue
        filesToSearch.push({ absPath: path.join(dir, entry.name), relPath })
      }
    }
  }
  collectFiles(opts.projectDir, '')

  // Search file contents in batches to yield to the event loop
  const BATCH_SIZE = 20
  for (let i = 0; i < filesToSearch.length && matches.length < limit; i += BATCH_SIZE) {
    if (Date.now() - start > SEARCH_TIMEOUT) break
    // Yield to event loop between batches so the UI doesn't freeze
    if (i > 0) await new Promise((r) => setImmediate(r))

    const batch = filesToSearch.slice(i, i + BATCH_SIZE)
    for (const { absPath, relPath } of batch) {
      if (matches.length >= limit) break
      try {
        const stat = fs.statSync(absPath)
        if (stat.size > 1024 * 1024) continue
        const content = fs.readFileSync(absPath, 'utf-8')
        const lines = content.split('\n')
        for (let li = 0; li < lines.length && matches.length < limit; li++) {
          pattern.lastIndex = 0
          const m = pattern.exec(lines[li])
          if (m) {
            totalMatches++
            const text = lines[li].trim()
            matches.push({
              filePath: relPath,
              line: li + 1,
              column: m.index + 1,
              text: text.length > 300 ? text.slice(0, 300) + '...' : text,
              matchStart: m.index,
              matchEnd: m.index + m[0].length
            })
          }
        }
      } catch { /* skip unreadable files */ }
    }
  }

  return { matches, totalMatches, truncated: totalMatches > limit, durationMs: Date.now() - start }
}

function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(escaped, 'i')
}

/** Main search function — picks the best strategy. Async to avoid blocking main process. */
export async function searchFiles(opts: SearchOptions): Promise<SearchResult> {
  if (!opts.query || opts.query.length < 2) {
    return { matches: [], totalMatches: 0, truncated: false, durationMs: 0 }
  }
  if (isGitRepo(opts.projectDir)) {
    return searchWithGit(opts)
  }
  return searchManual(opts)
}

export interface ReplaceOptions {
  projectDir: string
  query: string
  replacement: string
  filePath?: string          // if set, replace only in this file
  caseSensitive?: boolean
  wholeWord?: boolean
  regex?: boolean
}

export interface ReplaceResult {
  replacements: number
  filesChanged: number
  errors: string[]
}

/** Undo/redo stack for replace operations */
interface ReplaceSnapshot {
  files: Map<string, string>  // absPath → original content before replace
  description: string
}

const undoStack: ReplaceSnapshot[] = []
const redoStack: ReplaceSnapshot[] = []
const MAX_UNDO = 20

export function undoReplace(): { success: boolean; filesRestored: number; description?: string } {
  const snapshot = undoStack.pop()
  if (!snapshot) return { success: false, filesRestored: 0 }
  // Save current state for redo before restoring
  const redoSnapshot: ReplaceSnapshot = { files: new Map(), description: snapshot.description }
  for (const [absPath] of snapshot.files) {
    try { redoSnapshot.files.set(absPath, fs.readFileSync(absPath, 'utf-8')) } catch { /* skip */ }
  }
  redoStack.push(redoSnapshot)
  // Restore files
  let restored = 0
  for (const [absPath, content] of snapshot.files) {
    try { fs.writeFileSync(absPath, content, 'utf-8'); restored++ } catch { /* skip */ }
  }
  return { success: true, filesRestored: restored, description: snapshot.description }
}

export function redoReplace(): { success: boolean; filesRestored: number; description?: string } {
  const snapshot = redoStack.pop()
  if (!snapshot) return { success: false, filesRestored: 0 }
  // Save current state for undo before re-applying
  const undoSnapshot: ReplaceSnapshot = { files: new Map(), description: snapshot.description }
  for (const [absPath] of snapshot.files) {
    try { undoSnapshot.files.set(absPath, fs.readFileSync(absPath, 'utf-8')) } catch { /* skip */ }
  }
  undoStack.push(undoSnapshot)
  let restored = 0
  for (const [absPath, content] of snapshot.files) {
    try { fs.writeFileSync(absPath, content, 'utf-8'); restored++ } catch { /* skip */ }
  }
  return { success: true, filesRestored: restored, description: snapshot.description }
}

export function hasUndo(): boolean { return undoStack.length > 0 }
export function hasRedo(): boolean { return redoStack.length > 0 }

/** Replace occurrences in a single file. Returns number of replacements made.
 *  Uses string replacement (not callback) to support $1, $2 capture groups in regex mode. */
function replaceInFile(absPath: string, pattern: RegExp, replacement: string): number {
  const content = fs.readFileSync(absPath, 'utf-8')
  const matches = content.match(pattern)
  const count = matches ? matches.length : 0
  if (count === 0) return 0
  const newContent = content.replace(pattern, replacement)
  fs.writeFileSync(absPath, newContent, 'utf-8')
  return count
}

/** Validate path stays within projectDir */
function isPathSafe(projectDir: string, filePath: string): boolean {
  const abs = path.resolve(projectDir, filePath)
  const normProject = path.resolve(projectDir) + path.sep
  return abs === path.resolve(projectDir) || abs.startsWith(normProject)
}

/** Replace across files. If filePath is set, only replaces in that file. */
export function replaceInFiles(opts: ReplaceOptions): ReplaceResult {
  if (!opts.query) return { replacements: 0, filesChanged: 0, errors: [] }

  const flags = opts.caseSensitive ? 'g' : 'gi'
  let pattern: RegExp
  try {
    if (opts.regex) {
      pattern = new RegExp(opts.query, flags)
    } else {
      const escaped = opts.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      pattern = opts.wholeWord ? new RegExp(`\\b${escaped}\\b`, flags) : new RegExp(escaped, flags)
    }
  } catch {
    return { replacements: 0, filesChanged: 0, errors: ['Invalid regex pattern'] }
  }

  const errors: string[] = []
  let totalReplacements = 0
  let filesChanged = 0
  // Snapshot files before replacing (for undo)
  const snapshot: ReplaceSnapshot = { files: new Map(), description: '' }

  if (opts.filePath) {
    if (!isPathSafe(opts.projectDir, opts.filePath)) {
      return { replacements: 0, filesChanged: 0, errors: ['Path traversal blocked'] }
    }
    const abs = path.resolve(opts.projectDir, opts.filePath)
    try {
      snapshot.files.set(abs, fs.readFileSync(abs, 'utf-8'))
      const count = replaceInFile(abs, pattern, opts.replacement)
      totalReplacements += count
      if (count > 0) filesChanged++
    } catch (err) {
      errors.push(`${opts.filePath}: ${err instanceof Error ? err.message : 'Failed'}`)
    }
  } else {
    const searchResult = searchFiles({
      query: opts.query,
      projectDir: opts.projectDir,
      caseSensitive: opts.caseSensitive,
      wholeWord: opts.wholeWord,
      regex: opts.regex,
      maxResults: 2000
    })
    const filePaths = [...new Set(searchResult.matches.map((m) => m.filePath))]
    for (const fp of filePaths) {
      if (!isPathSafe(opts.projectDir, fp)) continue
      const abs = path.resolve(opts.projectDir, fp)
      try {
        snapshot.files.set(abs, fs.readFileSync(abs, 'utf-8'))
        const count = replaceInFile(abs, pattern, opts.replacement)
        totalReplacements += count
        if (count > 0) filesChanged++
      } catch (err) {
        errors.push(`${fp}: ${err instanceof Error ? err.message : 'Failed'}`)
      }
    }
  }

  // Push to undo stack if any changes were made
  if (filesChanged > 0) {
    snapshot.description = `Replace "${opts.query}" → "${opts.replacement}" (${totalReplacements} in ${filesChanged} file${filesChanged > 1 ? 's' : ''})`
    undoStack.push(snapshot)
    if (undoStack.length > MAX_UNDO) undoStack.shift()
    redoStack.length = 0 // clear redo on new action
  }

  return { replacements: totalReplacements, filesChanged, errors }
}
