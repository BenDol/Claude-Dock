/**
 * Symbol indexer for the workspace plugin.
 *
 * Layer 1: Scans TS/JS files to feed Monaco's built-in TypeScript language service
 *          (via addExtraLib). Returns file paths + content.
 *
 * Layer 2: Regex-based symbol extraction for non-TS languages (Java, Python, Go, Rust, etc.)
 *          Builds an in-memory index for custom DefinitionProvider.
 */
import * as fs from 'fs'
import * as path from 'path'

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.cache', '__pycache__',
  '.next', '.nuxt', 'target', 'out', '.gradle', '.idea', '.vscode',
  'bin', 'obj', '.svelte-kit', '.output', 'coverage'
])

const TS_EXTENSIONS = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'])
const MAX_TS_FILES = 3000
const MAX_FILE_SIZE = 500 * 1024 // 500KB per file
const BATCH_SIZE = 30

// ── Layer 1: TypeScript file scanner ─────────────────────────────────

export interface TsFileEntry {
  filePath: string  // absolute path
  content: string
}

/** Scan workspace for TS/JS files and return their content for Monaco's addExtraLib */
export async function scanTsFiles(projectDir: string): Promise<TsFileEntry[]> {
  // Collect file paths first (fast dir walk)
  const filePaths: string[] = []
  const walk = (dir: string) => {
    if (filePaths.length >= MAX_TS_FILES) return
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (filePaths.length >= MAX_TS_FILES) return
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name))
      } else if (entry.isFile()) {
        const ext = entry.name.split('.').pop()?.toLowerCase() || ''
        if (TS_EXTENSIONS.has(ext)) filePaths.push(path.join(dir, entry.name))
      }
    }
  }
  walk(projectDir)

  // Read files in batches, yielding to event loop
  const results: TsFileEntry[] = []
  for (let i = 0; i < filePaths.length; i += BATCH_SIZE) {
    if (i > 0) await new Promise((r) => setImmediate(r))
    const batch = filePaths.slice(i, i + BATCH_SIZE)
    for (const absPath of batch) {
      try {
        const stat = fs.statSync(absPath)
        if (stat.size > MAX_FILE_SIZE) continue
        const content = fs.readFileSync(absPath, 'utf-8')
        results.push({ filePath: absPath, content })
      } catch { /* skip unreadable */ }
    }
  }
  return results
}

/** Read tsconfig.json compiler options from the project root */
export function readTsConfig(projectDir: string): Record<string, unknown> {
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    try {
      const raw = fs.readFileSync(path.join(projectDir, name), 'utf-8')
      // Strip comments (// and /* */) for JSON.parse
      const stripped = raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
      const parsed = JSON.parse(stripped)
      return parsed.compilerOptions || {}
    } catch { /* try next */ }
  }
  return {}
}

// ── Layer 2: Regex symbol index ──────────────────────────────────────

export interface SymbolEntry {
  name: string
  filePath: string  // relative to projectDir
  line: number
  column: number
  kind: 'class' | 'function' | 'type' | 'interface' | 'struct' | 'enum' | 'const' | 'variable' | 'method'
}

/** Language-specific regex patterns for symbol definitions */
const SYMBOL_PATTERNS: Record<string, { pattern: RegExp; kind: SymbolEntry['kind'] }[]> = {
  java: [
    { pattern: /(?:public\s+|private\s+|protected\s+)?(?:abstract\s+|static\s+|final\s+)*(?:class|interface|enum|record)\s+(\w+)/g, kind: 'class' },
    { pattern: /(?:public|private|protected)\s+(?:static\s+)?(?:final\s+)?(?:synchronized\s+)?(?:[\w<>\[\]]+)\s+(\w+)\s*\(/g, kind: 'method' },
  ],
  python: [
    { pattern: /^class\s+(\w+)/gm, kind: 'class' },
    { pattern: /^def\s+(\w+)/gm, kind: 'function' },
  ],
  go: [
    { pattern: /^func\s+(?:\(.*?\)\s+)?(\w+)/gm, kind: 'function' },
    { pattern: /^type\s+(\w+)\s+(?:struct|interface)/gm, kind: 'struct' },
    { pattern: /^type\s+(\w+)\s+/gm, kind: 'type' },
  ],
  rust: [
    { pattern: /(?:pub\s+)?fn\s+(\w+)/g, kind: 'function' },
    { pattern: /(?:pub\s+)?struct\s+(\w+)/g, kind: 'struct' },
    { pattern: /(?:pub\s+)?enum\s+(\w+)/g, kind: 'enum' },
    { pattern: /(?:pub\s+)?trait\s+(\w+)/g, kind: 'interface' },
    { pattern: /(?:pub\s+)?type\s+(\w+)/g, kind: 'type' },
  ],
  csharp: [
    { pattern: /(?:public|private|protected|internal)?\s*(?:abstract|static|sealed|partial)?\s*(?:class|interface|struct|enum|record)\s+(\w+)/g, kind: 'class' },
    { pattern: /(?:public|private|protected|internal)?\s*(?:static|virtual|override|abstract)?\s*\w+\s+(\w+)\s*\(/g, kind: 'method' },
  ],
  kotlin: [
    { pattern: /(?:class|interface|object|enum\s+class|data\s+class|sealed\s+class)\s+(\w+)/g, kind: 'class' },
    { pattern: /(?:fun)\s+(\w+)/g, kind: 'function' },
  ],
  ruby: [
    { pattern: /^class\s+(\w+)/gm, kind: 'class' },
    { pattern: /^module\s+(\w+)/gm, kind: 'class' },
    { pattern: /^def\s+(\w+)/gm, kind: 'function' },
  ],
  php: [
    { pattern: /(?:class|interface|trait|enum)\s+(\w+)/g, kind: 'class' },
    { pattern: /function\s+(\w+)/g, kind: 'function' },
  ],
  swift: [
    { pattern: /(?:class|struct|enum|protocol)\s+(\w+)/g, kind: 'class' },
    { pattern: /func\s+(\w+)/g, kind: 'function' },
  ],
}

// Map file extensions to pattern keys
const EXT_TO_LANG: Record<string, string> = {
  java: 'java', py: 'python', go: 'go', rs: 'rust',
  cs: 'csharp', kt: 'kotlin', kts: 'kotlin',
  rb: 'ruby', php: 'php', swift: 'swift',
}

/** In-memory symbol cache per project */
const symbolCache = new Map<string, SymbolEntry[]>()

/** Build the symbol index for all non-TS files in the workspace */
export async function buildSymbolIndex(projectDir: string): Promise<SymbolEntry[]> {
  const symbols: SymbolEntry[] = []
  const filePaths: { absPath: string; relPath: string; lang: string }[] = []

  // Collect indexable files
  const walk = (dir: string, relDir: string) => {
    if (filePaths.length >= 5000) return
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (filePaths.length >= 5000) return
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), relDir ? `${relDir}/${entry.name}` : entry.name)
      } else if (entry.isFile()) {
        const ext = entry.name.split('.').pop()?.toLowerCase() || ''
        const lang = EXT_TO_LANG[ext]
        if (lang) {
          filePaths.push({
            absPath: path.join(dir, entry.name),
            relPath: relDir ? `${relDir}/${entry.name}` : entry.name,
            lang
          })
        }
      }
    }
  }
  walk(projectDir, '')

  // Extract symbols in batches
  for (let i = 0; i < filePaths.length; i += BATCH_SIZE) {
    if (i > 0) await new Promise((r) => setImmediate(r))
    const batch = filePaths.slice(i, i + BATCH_SIZE)
    for (const { absPath, relPath, lang } of batch) {
      try {
        const stat = fs.statSync(absPath)
        if (stat.size > MAX_FILE_SIZE) continue
        const content = fs.readFileSync(absPath, 'utf-8')
        const patterns = SYMBOL_PATTERNS[lang]
        if (!patterns) continue

        // Build line offset index once per file for O(1) offset→line lookups
        const lineOffsets: number[] = [0]
        for (let ci = 0; ci < content.length; ci++) {
          if (content[ci] === '\n') lineOffsets.push(ci + 1)
        }
        const offsetToLine = (offset: number): { line: number; col: number } => {
          // Binary search for the line containing this offset
          let lo = 0, hi = lineOffsets.length - 1
          while (lo < hi) {
            const mid = (lo + hi + 1) >> 1
            if (lineOffsets[mid] <= offset) lo = mid
            else hi = mid - 1
          }
          return { line: lo + 1, col: offset - lineOffsets[lo] + 1 }
        }

        for (const { pattern, kind } of patterns) {
          pattern.lastIndex = 0
          let m: RegExpExecArray | null
          while ((m = pattern.exec(content)) !== null) {
            const name = m[1]
            if (!name || name.length < 2) continue
            const { line, col } = offsetToLine(m.index)
            symbols.push({ name, filePath: relPath, line, column: col, kind })
          }
        }
      } catch { /* skip */ }
    }
  }

  symbolCache.set(projectDir, symbols)
  return symbols
}

/** Query the symbol cache */
export function querySymbol(projectDir: string, name: string): SymbolEntry[] {
  const symbols = symbolCache.get(projectDir)
  if (!symbols) return []
  return symbols.filter((s) => s.name === name)
}

/** Clear cache for a project (call on workspace close) */
export function clearSymbolCache(projectDir?: string): void {
  if (projectDir) symbolCache.delete(projectDir)
  else symbolCache.clear()
}
