/**
 * Claudest Memory Adapter
 *
 * Reads from ~/.claude-memory/conversations.db (SQLite with WAL mode).
 * This adapter is strictly read-only — it inspects the Claudest database
 * but never writes to it. Uses better-sqlite3 for synchronous, fast queries.
 */

import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { execFileSync } from 'child_process'
import type { MemoryAdapter } from './memory-adapter'
import type {
  MemoryAdapterInfo,
  MemorySection,
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
} from '../../../../shared/memory-types'

// Lazy-load better-sqlite3 to avoid hard crash if the native module isn't rebuilt.
// We resolve the native binding path explicitly because the `bindings` package
// uses stack trace sniffing to find the caller's directory, which fails when
// running from a standalone plugin override bundle (stack frames have no filename).
let Database: typeof import('better-sqlite3')
let nativeBindingPath: string | undefined

/** Find the better_sqlite3.node binary by searching known locations. */
function findNativeBinding(): string | undefined {
  const bindingName = 'better_sqlite3.node'
  const candidates: string[] = []

  // Try to resolve from the module itself first
  try {
    const modPath = require.resolve('better-sqlite3')
    const modDir = path.dirname(modPath)
    candidates.push(path.join(modDir, '..', 'build', 'Release', bindingName))
    candidates.push(path.join(modDir, 'build', 'Release', bindingName))
  } catch { /* not resolvable */ }

  // Standard node_modules location (dev mode)
  candidates.push(path.join(__dirname, '..', '..', '..', '..', 'node_modules', 'better-sqlite3', 'build', 'Release', bindingName))
  // Packaged app (asar unpacked) — relative to __dirname
  candidates.push(path.join(__dirname, '..', '..', '..', '..', '..', 'app.asar.unpacked', 'node_modules', 'better-sqlite3', 'build', 'Release', bindingName))
  // Packaged app — relative to process.resourcesPath
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'better-sqlite3', 'build', 'Release', bindingName))
  }

  for (const candidate of candidates) {
    try {
      const resolved = path.resolve(candidate)
      if (fs.existsSync(resolved)) return resolved
    } catch { /* ignore */ }
  }
  return undefined
}

function getDatabase(): typeof import('better-sqlite3') {
  if (!Database) {
    // Resolve native binding BEFORE requiring better-sqlite3, so it's ready
    // for the nativeBinding option when constructing Database instances.
    if (!nativeBindingPath) nativeBindingPath = findNativeBinding()
    Database = require('better-sqlite3')
  }
  return Database
}

const CLAUDEST_DB_NAME = 'conversations.db'
const CLAUDEST_DIR_NAME = '.claude-memory'

/** Known locations where the claude-memory plugin could be installed */
const PLUGIN_SEARCH_PATHS = [
  // Marketplace install (most common)
  path.join(os.homedir(), '.claude', 'plugins', 'marketplaces'),
  // Direct plugin dir
  path.join(os.homedir(), '.claude', 'plugins'),
  // Repos clone location
  path.join(os.homedir(), '.claude', 'plugins', 'repos')
]

const INSTALL_COMMANDS = [
  'claude plugin marketplace add gupsammy/claudest',
  'claude plugin install claude-memory@Claudest'
]

const SECTIONS: MemorySection[] = [
  { id: 'dashboard', label: 'Dashboard', description: 'Overview of memory statistics and recent activity' },
  { id: 'sessions', label: 'Sessions', description: 'Browse conversation sessions' },
  { id: 'branches', label: 'Branches', description: 'View conversation branches and context summaries' },
  { id: 'search', label: 'Search', description: 'Full-text search across all conversations' },
  { id: 'tokens', label: 'Token Usage', description: 'Token spending analytics and patterns' },
  { id: 'database', label: 'Database', description: 'Raw database info and import log' }
]

// ── Python environment ──────────────────────────────────────────────────────
// Resolve a working Python binary and maintain an isolated venv for scripts.

const VENV_DIR = path.join(os.homedir(), CLAUDEST_DIR_NAME, '.venv')

/** Find a working Python >= 3 binary on the system. */
function findSystemPython(): string | null {
  // On Windows: 'python' is usually the real install, 'py' is the launcher,
  // 'python3' is often the broken Microsoft Store alias.
  const candidates = process.platform === 'win32'
    ? ['python', 'py', 'python3']
    : ['python3', 'python']

  for (const cmd of candidates) {
    try {
      const ver = execFileSync(cmd, ['--version'], { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
      // Verify it's Python 3+
      if (/Python 3\.\d+/.test(ver)) return cmd
    } catch { /* not found or broken alias */ }
  }
  return null
}

/** Ensure the isolated venv exists. Creates it if missing. Returns venv Python path. */
function ensureVenv(): string | null {
  const venvPython = process.platform === 'win32'
    ? path.join(VENV_DIR, 'Scripts', 'python.exe')
    : path.join(VENV_DIR, 'bin', 'python3')

  // Already set up
  if (fs.existsSync(venvPython)) return venvPython

  const systemPython = findSystemPython()
  if (!systemPython) return null

  try {
    // Create venv (stdlib only — no pip needed since Claudest uses only stdlib)
    const memDir = path.join(os.homedir(), CLAUDEST_DIR_NAME)
    if (!fs.existsSync(memDir)) fs.mkdirSync(memDir, { recursive: true })
    execFileSync(systemPython, ['-m', 'venv', '--without-pip', VENV_DIR], { timeout: 30_000, stdio: 'pipe' })
    if (fs.existsSync(venvPython)) return venvPython
  } catch { /* venv creation failed */ }
  return null
}

/** Get the Python binary to use. Prefers venv, falls back to system Python. */
function getPython(): string {
  return ensureVenv() || findSystemPython() || 'python'
}

export class ClaudestAdapter implements MemoryAdapter {
  readonly id = 'claudest'
  readonly name = 'Claudest'

  private db: import('better-sqlite3').Database | null = null
  private dbPath: string

  constructor() {
    this.dbPath = path.join(os.homedir(), CLAUDEST_DIR_NAME, CLAUDEST_DB_NAME)
  }

  // ── Connection Management ──────────────────────────────────────────────────

  private getDb(): import('better-sqlite3').Database {
    if (this.db) return this.db

    if (!this.dbPath || !fs.existsSync(this.dbPath)) {
      throw new Error(`Database file not found: ${this.dbPath}`)
    }

    let Db: typeof import('better-sqlite3')
    try {
      Db = getDatabase()
    } catch (err) {
      throw new Error(`Failed to load database driver: ${err instanceof Error ? err.message : err}`)
    }

    let db: import('better-sqlite3').Database
    try {
      // Use explicit nativeBinding path to bypass the `bindings` package's
      // stack-trace sniffing, which crashes in standalone plugin override bundles.
      const opts: any = { readonly: true, fileMustExist: true }
      if (nativeBindingPath) opts.nativeBinding = nativeBindingPath
      db = new Db(this.dbPath, opts)
    } catch (err) {
      throw new Error(`Failed to open database: ${err instanceof Error ? err.message : err}`)
    }

    try {
      // Enable WAL mode reading without blocking Claudest's writes
      db.pragma('journal_mode = WAL')
    } catch {
      // WAL pragma can fail on locked/corrupt DBs — connection is still usable
      // for reads in most cases, so continue rather than throwing
    }

    this.db = db
    return this.db
  }

  private closeDb(): void {
    if (this.db) {
      try { this.db.close() } catch { /* ignore */ }
      this.db = null
    }
  }

  /**
   * Check if a table exists in the database.
   */
  private tableExists(name: string): boolean {
    try {
      const row = this.getDb().prepare(
        "SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table' AND name=?"
      ).get(name) as { cnt: number } | undefined
      return (row?.cnt ?? 0) > 0
    } catch {
      return false
    }
  }

  // ── Adapter Info ───────────────────────────────────────────────────────────

  getInfo(): MemoryAdapterInfo {
    const pluginDir = this.findPluginDir()
    const hasData = fs.existsSync(this.dbPath)
    const installed = pluginDir !== null
    let statusMessage: string
    let storePath: string | null = null

    if (!installed && !hasData) {
      statusMessage = 'Not installed — Claudest plugin not detected'
    } else if (installed && !hasData) {
      statusMessage = 'Plugin installed, but no conversation database found yet. Run a Claude session to populate.'
    } else if (!installed && hasData) {
      statusMessage = 'Database found, but Claudest plugin directory not detected'
    } else {
      // installed && hasData
      storePath = this.dbPath
      try {
        this.getDb()
        statusMessage = 'Connected'
      } catch (err) {
        statusMessage = `Database error: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    return {
      id: this.id,
      name: this.name,
      description: 'Gives Claude persistent memory across sessions. Automatically recalls relevant past conversations, decisions, and context so Claude remembers what you discussed — even weeks later.',
      version: this.getClaudestVersion(),
      installed,
      enabled: hasData, // Functionally enabled when there's data to read
      storePath,
      pluginDir,
      hasData,
      statusMessage,
      sections: hasData ? SECTIONS : [],
      installCommands: INSTALL_COMMANDS,
      canAutoInstall: true
    }
  }

  isAvailable(): boolean {
    if (!fs.existsSync(this.dbPath)) return false
    try {
      this.getDb()
      return true
    } catch {
      return false
    }
  }

  /** Scan known locations for the claude-memory plugin directory. */
  private findPluginDir(): string | null {
    // Check direct install first
    const directPath = path.join(os.homedir(), '.claude', 'plugins', 'claude-memory')
    if (this.isClaudestPluginDir(directPath)) return directPath

    // Search marketplace directories recursively (one level deep)
    for (const searchPath of PLUGIN_SEARCH_PATHS) {
      if (!fs.existsSync(searchPath)) continue
      try {
        const entries = fs.readdirSync(searchPath, { withFileTypes: true })
        for (const entry of entries) {
          if (!entry.isDirectory()) continue
          const candidateDirect = path.join(searchPath, entry.name, 'claude-memory')
          if (this.isClaudestPluginDir(candidateDirect)) return candidateDirect

          // Also check plugins/ subdirectory (marketplace layout)
          const candidateNested = path.join(searchPath, entry.name, 'plugins', 'claude-memory')
          if (this.isClaudestPluginDir(candidateNested)) return candidateNested
        }
      } catch { /* permission errors, etc. */ }
    }

    return null
  }

  /** Check if a directory looks like a valid claude-memory plugin installation. */
  private isClaudestPluginDir(dir: string): boolean {
    try {
      if (!fs.existsSync(dir)) return false
      // Must have hooks/ directory or .claude-plugin/ directory
      return fs.existsSync(path.join(dir, 'hooks')) ||
             fs.existsSync(path.join(dir, '.claude-plugin'))
    } catch {
      return false
    }
  }

  private getClaudestVersion(): string {
    const pluginDir = this.findPluginDir()
    if (!pluginDir) return 'unknown'

    // Try .claude-plugin/plugin.json first (standard location)
    const candidates = [
      path.join(pluginDir, '.claude-plugin', 'plugin.json'),
      path.join(pluginDir, 'plugin.json')
    ]
    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) {
          const pluginJson = JSON.parse(fs.readFileSync(candidate, 'utf-8'))
          if (pluginJson.version) return pluginJson.version
        }
      } catch { /* ignore */ }
    }
    return 'unknown'
  }

  /** Get installation commands for display or execution. */
  getInstallCommands(): string[] {
    return INSTALL_COMMANDS
  }

  // ── Dashboard ──────────────────────────────────────────────────────────────

  getDashboard(): MemoryDashboardStats {
    const db = this.getDb()

    const counts = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM projects) as totalProjects,
        (SELECT COUNT(*) FROM sessions) as totalSessions,
        (SELECT COUNT(*) FROM branches) as totalBranches,
        (SELECT COUNT(*) FROM messages) as totalMessages
    `).get() as any

    // Token aggregates
    let tokenStats = { totalTokensIn: 0, totalTokensOut: 0, totalCacheRead: 0, totalCacheCreation: 0, totalToolUses: 0, totalLinesModified: 0, averageSessionDuration: 0 }
    if (this.tableExists('token_snapshots')) {
      const ts = db.prepare(`
        SELECT
          COALESCE(SUM(input_tokens), 0) as totalTokensIn,
          COALESCE(SUM(output_tokens), 0) as totalTokensOut,
          COALESCE(SUM(cache_read_tokens), 0) as totalCacheRead,
          COALESCE(SUM(cache_creation_tokens), 0) as totalCacheCreation,
          COALESCE(SUM(user_message_count + assistant_message_count), 0) as totalToolUses,
          COALESCE(SUM(lines_added + lines_removed), 0) as totalLinesModified,
          COALESCE(AVG(duration_minutes), 0) as averageSessionDuration
        FROM token_snapshots
      `).get() as any
      tokenStats = ts
    }

    // Recent sessions
    const recentSessions = this.getSessions({ limit: 10, orderBy: 'recent' })

    // Project breakdown
    const projectBreakdown = db.prepare(`
      SELECT p.name as project,
             COUNT(DISTINCT s.id) as sessions,
             COUNT(DISTINCT m.id) as messages
      FROM projects p
      LEFT JOIN sessions s ON s.project_id = p.id
      LEFT JOIN branches b ON b.session_id = s.id
      LEFT JOIN branch_messages bm ON bm.branch_id = b.id
      LEFT JOIN messages m ON bm.message_id = m.id
      GROUP BY p.id
      ORDER BY sessions DESC
    `).all() as any[]

    // Daily activity (last 30 days)
    const dailyActivity = db.prepare(`
      SELECT DATE(b.started_at) as date,
             COUNT(DISTINCT s.id) as sessions,
             COUNT(DISTINCT m.id) as messages
      FROM branches b
      JOIN sessions s ON b.session_id = s.id
      LEFT JOIN branch_messages bm ON bm.branch_id = b.id
      LEFT JOIN messages m ON bm.message_id = m.id
      WHERE b.started_at >= datetime('now', '-30 days')
      GROUP BY DATE(b.started_at)
      ORDER BY date DESC
    `).all() as any[]

    return {
      totalProjects: counts.totalProjects,
      totalSessions: counts.totalSessions,
      totalBranches: counts.totalBranches,
      totalMessages: counts.totalMessages,
      totalTokensIn: tokenStats.totalTokensIn,
      totalTokensOut: tokenStats.totalTokensOut,
      totalCacheRead: tokenStats.totalCacheRead,
      totalCacheCreation: tokenStats.totalCacheCreation,
      totalToolUses: tokenStats.totalToolUses,
      totalLinesModified: tokenStats.totalLinesModified,
      averageSessionDuration: tokenStats.averageSessionDuration,
      recentSessions,
      projectBreakdown,
      dailyActivity
    }
  }

  // ── Projects ───────────────────────────────────────────────────────────────

  getProjects(): MemoryProject[] {
    return this.getDb().prepare(`
      SELECT id, path, key, name, created_at as createdAt
      FROM projects
      ORDER BY created_at DESC
    `).all() as MemoryProject[]
  }

  // ── Sessions ───────────────────────────────────────────────────────────────

  getSessions(opts?: MemorySessionListOptions): MemorySession[] {
    const limit = opts?.limit ?? 50
    const offset = opts?.offset ?? 0
    const orderBy = opts?.orderBy === 'oldest' ? 'ASC' : 'DESC'

    let where = ''
    const params: unknown[] = []
    if (opts?.projectId != null) {
      where = 'WHERE s.project_id = ?'
      params.push(opts.projectId)
    }

    params.push(limit, offset)

    return this.getDb().prepare(`
      SELECT s.id, s.uuid, s.project_id as projectId,
             p.name as projectName,
             s.git_branch as gitBranch,
             s.cwd, s.parent_session_id as parentSessionId,
             s.imported_at as createdAt,
             (SELECT COUNT(*) FROM branches WHERE session_id = s.id) as branchCount
      FROM sessions s
      LEFT JOIN projects p ON s.project_id = p.id
      ${where}
      ORDER BY s.imported_at ${orderBy}
      LIMIT ? OFFSET ?
    `).all(...params) as MemorySession[]
  }

  getSession(sessionId: number): MemorySession | null {
    return this.getDb().prepare(`
      SELECT s.id, s.uuid, s.project_id as projectId,
             p.name as projectName,
             s.git_branch as gitBranch,
             s.cwd, s.parent_session_id as parentSessionId,
             s.imported_at as createdAt,
             (SELECT COUNT(*) FROM branches WHERE session_id = s.id) as branchCount
      FROM sessions s
      LEFT JOIN projects p ON s.project_id = p.id
      WHERE s.id = ?
    `).get(sessionId) as MemorySession | null
  }

  // ── Branches ───────────────────────────────────────────────────────────────

  getBranches(opts?: MemoryBranchListOptions): MemoryBranch[] {
    const limit = opts?.limit ?? 50
    const offset = opts?.offset ?? 0

    const conditions: string[] = []
    const params: unknown[] = []

    if (opts?.sessionId != null) {
      conditions.push('b.session_id = ?')
      params.push(opts.sessionId)
    }
    if (opts?.activeOnly) {
      conditions.push('b.is_active = 1')
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    params.push(limit, offset)

    return this.getDb().prepare(`
      SELECT b.id, b.session_id as sessionId,
             s.uuid as sessionUuid,
             b.leaf_uuid as leafUuid,
             b.fork_point_uuid as forkPointUuid,
             b.is_active as isActive,
             b.started_at as startedAt,
             b.ended_at as endedAt,
             b.files_modified as filesModified,
             b.commits,
             b.tool_counts as toolCounts,
             b.context_summary as contextSummary,
             b.context_summary_json as contextSummaryJson,
             b.summary_version as summaryVersion,
             (SELECT COUNT(*) FROM branch_messages WHERE branch_id = b.id) as messageCount,
             COALESCE(
               CAST(json_extract(b.context_summary_json, '$.metadata.exchange_count') AS INTEGER),
               0
             ) as exchangeCount
      FROM branches b
      JOIN sessions s ON b.session_id = s.id
      ${where}
      ORDER BY b.started_at DESC
      LIMIT ? OFFSET ?
    `).all(...params) as MemoryBranch[]
  }

  getBranch(branchId: number): MemoryBranch | null {
    return this.getDb().prepare(`
      SELECT b.id, b.session_id as sessionId,
             s.uuid as sessionUuid,
             b.leaf_uuid as leafUuid,
             b.fork_point_uuid as forkPointUuid,
             b.is_active as isActive,
             b.started_at as startedAt,
             b.ended_at as endedAt,
             b.files_modified as filesModified,
             b.commits,
             b.tool_counts as toolCounts,
             b.context_summary as contextSummary,
             b.context_summary_json as contextSummaryJson,
             b.summary_version as summaryVersion,
             (SELECT COUNT(*) FROM branch_messages WHERE branch_id = b.id) as messageCount,
             COALESCE(
               CAST(json_extract(b.context_summary_json, '$.metadata.exchange_count') AS INTEGER),
               0
             ) as exchangeCount
      FROM branches b
      JOIN sessions s ON b.session_id = s.id
      WHERE b.id = ?
    `).get(branchId) as MemoryBranch | null
  }

  // ── Messages ───────────────────────────────────────────────────────────────

  getMessages(opts: MemoryMessageListOptions): MemoryMessage[] {
    const limit = opts.limit ?? 200
    const offset = opts.offset ?? 0

    const notifFilter = opts.excludeNotifications ? 'AND COALESCE(m.is_notification, 0) = 0' : ''

    return this.getDb().prepare(`
      SELECT m.id, m.uuid, m.parent_uuid as parentUuid,
             m.role, m.content,
             m.tool_summary as toolSummary,
             COALESCE(m.has_tool_use, 0) as hasToolUse,
             COALESCE(m.has_thinking, 0) as hasThinking,
             COALESCE(m.is_notification, 0) as isNotification,
             m.timestamp
      FROM branch_messages bm
      JOIN messages m ON bm.message_id = m.id
      WHERE bm.branch_id = ? ${notifFilter}
      ORDER BY m.timestamp ASC
      LIMIT ? OFFSET ?
    `).all(opts.branchId, limit, offset) as MemoryMessage[]
  }

  // ── Token Snapshots ────────────────────────────────────────────────────────

  getTokenSnapshots(sessionId?: number): MemoryTokenSnapshot[] {
    if (!this.tableExists('token_snapshots')) return []

    if (sessionId != null) {
      return this.getDb().prepare(`
        SELECT ts.id, s.id as sessionId,
               ts.session_uuid as sessionUuid,
               ts.input_tokens as inputTokens,
               ts.output_tokens as outputTokens,
               ts.cache_creation_tokens as cacheCreationTokens,
               ts.cache_read_tokens as cacheReadTokens,
               COALESCE(ts.user_message_count + ts.assistant_message_count, 0) as toolUseCount,
               ts.duration_minutes as duration,
               COALESCE(ts.lines_added + ts.lines_removed, 0) as linesModified,
               ts.start_time as timestamp
        FROM token_snapshots ts
        LEFT JOIN sessions s ON ts.session_uuid = s.uuid
        WHERE s.id = ?
        ORDER BY ts.start_time DESC
      `).all(sessionId) as MemoryTokenSnapshot[]
    }

    return this.getDb().prepare(`
      SELECT ts.id, s.id as sessionId,
             ts.session_uuid as sessionUuid,
             ts.input_tokens as inputTokens,
             ts.output_tokens as outputTokens,
             ts.cache_creation_tokens as cacheCreationTokens,
             ts.cache_read_tokens as cacheReadTokens,
             COALESCE(ts.user_message_count + ts.assistant_message_count, 0) as toolUseCount,
             ts.duration_minutes as duration,
             COALESCE(ts.lines_added + ts.lines_removed, 0) as linesModified,
             ts.start_time as timestamp
      FROM token_snapshots ts
      LEFT JOIN sessions s ON ts.session_uuid = s.uuid
      ORDER BY ts.start_time DESC
      LIMIT 500
    `).all() as MemoryTokenSnapshot[]
  }

  // ── Import Log ─────────────────────────────────────────────────────────────

  getImportLog(): MemoryImportLogEntry[] {
    if (!this.tableExists('import_log')) return []

    return this.getDb().prepare(`
      SELECT id, file_path as path, file_hash as fileHash,
             imported_at as importedAt,
             messages_imported as messageCount
      FROM import_log
      ORDER BY imported_at DESC
      LIMIT 100
    `).all() as MemoryImportLogEntry[]
  }

  // ── Search ─────────────────────────────────────────────────────────────────

  search(opts: MemorySearchOptions): MemorySearchResult[] {
    const limit = opts.limit ?? 20
    // Sanitize query: strip FTS operators to prevent injection
    const sanitized = opts.query.replace(/[*"(){}[\]^~:]/g, ' ').trim()
    if (!sanitized) return []

    const conditions: string[] = ['b.is_active = 1']
    const params: unknown[] = [sanitized]

    if (opts.projectName) {
      conditions.push('p.name = ?')
      params.push(opts.projectName)
    }
    if (opts.before) {
      conditions.push('b.started_at <= ?')
      params.push(opts.before)
    }
    if (opts.after) {
      conditions.push('b.started_at >= ?')
      params.push(opts.after)
    }

    params.push(limit)

    // Try FTS5 first, fall back to LIKE
    try {
      if (this.tableExists('branches_fts')) {
        return this.getDb().prepare(`
          SELECT b.id as branchId,
                 s.id as sessionId,
                 s.uuid as sessionUuid,
                 b.started_at as startedAt,
                 b.ended_at as endedAt,
                 p.name as projectName,
                 s.git_branch as gitBranch,
                 b.files_modified as filesModified,
                 b.commits,
                 snippet(branches_fts, 0, '<mark>', '</mark>', '...', 40) as snippet,
                 bm25(branches_fts) as rank
          FROM branches_fts
          JOIN branches b ON branches_fts.rowid = b.id
          JOIN sessions s ON b.session_id = s.id
          JOIN projects p ON s.project_id = p.id
          WHERE branches_fts MATCH ? AND ${conditions.join(' AND ')}
          ORDER BY bm25(branches_fts)
          LIMIT ?
        `).all(...params) as MemorySearchResult[]
      }
    } catch {
      // FTS5 not available — fall through to LIKE
    }

    // LIKE fallback
    const likeParam = `%${sanitized}%`
    const likeConditions = conditions.map(c => c === 'b.is_active = 1' ? c : c)
    const likeParams = [likeParam, ...params.slice(1)]

    return this.getDb().prepare(`
      SELECT b.id as branchId,
             s.id as sessionId,
             s.uuid as sessionUuid,
             b.started_at as startedAt,
             b.ended_at as endedAt,
             p.name as projectName,
             s.git_branch as gitBranch,
             b.files_modified as filesModified,
             b.commits,
             SUBSTR(b.aggregated_content, 1, 200) as snippet,
             0 as rank
      FROM branches b
      JOIN sessions s ON b.session_id = s.id
      JOIN projects p ON s.project_id = p.id
      WHERE b.aggregated_content LIKE ? AND ${likeConditions.join(' AND ')}
      ORDER BY b.started_at DESC
      LIMIT ?
    `).all(...likeParams) as MemorySearchResult[]
  }

  // ── Context Summaries ──────────────────────────────────────────────────────

  getContextSummary(branchId: number): MemoryContextSummaryParsed | null {
    const row = this.getDb().prepare(`
      SELECT context_summary_json FROM branches WHERE id = ?
    `).get(branchId) as { context_summary_json: string | null } | undefined

    if (!row?.context_summary_json) return null

    try {
      const raw = JSON.parse(row.context_summary_json)
      return {
        version: raw.version ?? 1,
        topic: raw.topic ?? '',
        disposition: raw.disposition ?? 'COMPLETED',
        markers: raw.markers ?? [],
        firstExchanges: raw.first_exchanges ?? [],
        lastExchanges: raw.last_exchanges ?? [],
        metadata: {
          exchangeCount: raw.metadata?.exchange_count ?? 0,
          filesModified: raw.metadata?.files_modified ?? null,
          commits: raw.metadata?.commits ?? null,
          toolCounts: raw.metadata?.tool_counts ?? null,
          startedAt: raw.metadata?.started_at ?? '',
          endedAt: raw.metadata?.ended_at ?? '',
          gitBranch: raw.metadata?.git_branch ?? ''
        }
      }
    } catch {
      return null
    }
  }

  // ── Database Info ──────────────────────────────────────────────────────────

  getDbInfo(): { path: string; sizeBytes: number; tables: { name: string; rowCount: number }[]; walSizeBytes: number } | null {
    if (!fs.existsSync(this.dbPath)) return null

    try {
      const stat = fs.statSync(this.dbPath)
      const walPath = this.dbPath + '-wal'
      const walSize = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0

      const tables = this.getDb().prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `).all() as { name: string }[]

      const tableInfo = tables.map((t) => {
        try {
          const row = this.getDb().prepare(`SELECT COUNT(*) as cnt FROM "${t.name}"`).get() as { cnt: number }
          return { name: t.name, rowCount: row.cnt }
        } catch {
          return { name: t.name, rowCount: -1 }
        }
      })

      return {
        path: this.dbPath,
        sizeBytes: stat.size,
        tables: tableInfo,
        walSizeBytes: walSize
      }
    } catch {
      return null
    }
  }

  // ── Configuration ──────────────────────────────────────────────────────────

  private get configPath(): string {
    return path.join(os.homedir(), CLAUDEST_DIR_NAME, 'config.json')
  }

  getConfig(): Record<string, unknown> {
    try {
      if (fs.existsSync(this.configPath)) {
        return JSON.parse(fs.readFileSync(this.configPath, 'utf-8'))
      }
    } catch { /* ignore */ }
    return {}
  }

  setConfig(updates: Record<string, unknown>): { success: boolean; error?: string } {
    try {
      const existing = this.getConfig()
      const merged = { ...existing, ...updates }
      const dir = path.dirname(this.configPath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(this.configPath, JSON.stringify(merged, null, 2))
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Write failed' }
    }
  }

  // ── Maintenance ───────────────────────────────────────────────────────────

  getMaintenanceActions(): { id: string; label: string; description: string; dangerous?: boolean }[] {
    return [
      { id: 'import', label: 'Import Conversations', description: 'Import all conversation history from Claude sessions into the memory database' },
      { id: 'sync', label: 'Sync Current Session', description: 'Force sync the current session to the database' },
      { id: 'stats', label: 'Show Statistics', description: 'Display database statistics and counts' },
      { id: 'backfill', label: 'Backfill Summaries', description: 'Generate context summaries for branches missing them' }
    ]
  }

  async runMaintenance(action: string): Promise<{ success: boolean; output?: string; error?: string }> {
    const pluginDir = this.findPluginDir()
    if (!pluginDir) return { success: false, error: 'Claudest plugin directory not found' }

    const { execFile } = require('child_process') as typeof import('child_process')
    const python = getPython()

    let script: string
    let args: string[] = []

    switch (action) {
      case 'import':
        script = path.join(pluginDir, 'hooks', 'import_conversations.py')
        break
      case 'sync':
        script = path.join(pluginDir, 'hooks', 'sync_current.py')
        break
      case 'stats':
        script = path.join(pluginDir, 'hooks', 'import_conversations.py')
        args = ['--stats']
        break
      case 'backfill':
        script = path.join(pluginDir, 'hooks', 'backfill_summaries.py')
        break
      default:
        return { success: false, error: `Unknown action: ${action}` }
    }

    if (!fs.existsSync(script)) return { success: false, error: `Script not found: ${script}` }

    return new Promise((resolve) => {
      execFile(python, [script, ...args], { timeout: 120_000 }, (err, stdout, stderr) => {
        if (err) {
          resolve({ success: false, error: stderr || err.message, output: stdout })
        } else {
          resolve({ success: true, output: (stdout + stderr).trim() })
        }
      })
    })
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  dispose(): void {
    this.closeDb()
  }
}
