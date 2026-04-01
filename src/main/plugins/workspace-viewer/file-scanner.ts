import * as fs from 'fs'
import * as path from 'path'

export interface FileEntry {
  name: string
  path: string      // relative to project root
  isDirectory: boolean
  size?: number
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.cache', '__pycache__',
  '.next', '.nuxt', 'target', 'out', '.gradle', '.idea', '.vscode',
  'bin', 'obj', '.svelte-kit', '.output', 'coverage'
])

const MAX_ENTRIES = 5000

/** Validate relative path doesn't escape project root */
function sanitizePath(projectDir: string, relativePath: string): string | null {
  if (!relativePath) return ''
  const resolved = path.resolve(projectDir, relativePath)
  const normProject = path.normalize(projectDir + path.sep)
  if (!resolved.startsWith(normProject) && resolved !== path.normalize(projectDir)) return null
  return relativePath
}

/** Read a single directory level. Returns entries sorted: dirs first, then alphabetical.
 *  Skips stat for directories (fast) — only stats files for size. */
export function readDirectory(projectDir: string, relativePath: string): FileEntry[] {
  const safe = sanitizePath(projectDir, relativePath)
  if (safe === null) return []
  const absDir = safe ? path.join(projectDir, safe) : projectDir
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(absDir, { withFileTypes: true }) } catch { return [] }

  const result: FileEntry[] = []
  for (const entry of entries) {
    const isDir = entry.isDirectory()
    if (isDir && SKIP_DIRS.has(entry.name)) continue
    // Skip dotfiles/dirs that are typically not useful
    const relPath = safe ? `${safe}/${entry.name}` : entry.name
    const fe: FileEntry = { name: entry.name, path: relPath, isDirectory: isDir }
    // Only stat files for size — skip for directories (much faster)
    if (!isDir) {
      try { fe.size = fs.statSync(path.join(absDir, entry.name)).size } catch { /* ignore */ }
    }
    result.push(fe)
  }

  return result.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

export interface TreeNode extends FileEntry {
  children?: TreeNode[]
}

/** Read a tree up to maxDepth levels deep. Caps total entries at MAX_ENTRIES. */
export function readTree(projectDir: string, maxDepth = 2): TreeNode[] {
  let totalEntries = 0
  const walk = (relPath: string, depth: number): TreeNode[] => {
    if (depth > maxDepth || totalEntries >= MAX_ENTRIES) return []
    const entries = readDirectory(projectDir, relPath)
    const nodes: TreeNode[] = []
    for (const entry of entries) {
      if (totalEntries >= MAX_ENTRIES) break
      totalEntries++
      const node: TreeNode = { ...entry }
      if (entry.isDirectory && depth < maxDepth) {
        node.children = walk(entry.path, depth + 1)
      }
      nodes.push(node)
    }
    return nodes
  }
  return walk('', 0)
}

export { sanitizePath }
