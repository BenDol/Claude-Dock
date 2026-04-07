// ── Memory Plugin Types ──────────────────────────────────────────────────────
// Shared types for the generic memory adapter plugin system.
// Each memory tool (Claudest, etc.) implements a MemoryAdapter that exposes
// a unified data model for the viewer UI.

/** Unique adapter identifier (e.g. 'claudest') */
export type MemoryAdapterId = string

// ── Adapter Metadata ─────────────────────────────────────────────────────────

export interface MemoryAdapterInfo {
  id: MemoryAdapterId
  name: string
  description: string
  version: string
  /** Whether the underlying tool is detected/installed on the system */
  installed: boolean
  /** Whether the adapter is currently enabled */
  enabled: boolean
  /** Path to the memory store (e.g. DB file) — null if not found */
  storePath: string | null
  /** Path to the plugin installation directory — null if not installed */
  pluginDir: string | null
  /** Whether the database/storage exists (separate from plugin installation) */
  hasData: boolean
  /** Human-readable status message */
  statusMessage: string
  /** Sections/tabs this adapter provides for the viewer */
  sections: MemorySection[]
  /** Instructions for installing this tool (shown when not installed) */
  installCommands: string[]
  /** Whether this adapter supports programmatic install via CLI */
  canAutoInstall: boolean
}

export interface MemorySection {
  id: string
  label: string
  icon?: string // SVG markup or emoji
  description?: string
}

// ── Unified Data Model ───────────────────────────────────────────────────────

export interface MemoryProject {
  id: number
  path: string
  key: string
  name: string
  createdAt: string
}

export interface MemorySession {
  id: number
  uuid: string
  projectId: number
  projectName: string
  gitBranch: string | null
  cwd: string | null
  parentSessionId: string | null
  createdAt: string
  branchCount: number
}

export interface MemoryBranch {
  id: number
  sessionId: number
  sessionUuid: string
  leafUuid: string | null
  forkPointUuid: string | null
  isActive: boolean
  startedAt: string
  endedAt: string | null
  filesModified: string | null  // JSON string
  commits: string | null        // JSON string
  toolCounts: string | null     // JSON string
  contextSummary: string | null // pre-rendered markdown
  contextSummaryJson: string | null // structured JSON
  summaryVersion: number | null
  messageCount: number
  exchangeCount: number
}

export interface MemoryMessage {
  id: number
  uuid: string
  parentUuid: string | null
  role: 'user' | 'assistant'
  content: string
  toolSummary: string | null
  hasToolUse: boolean
  hasThinking: boolean
  isNotification: boolean
  timestamp: string
}

export interface MemoryTokenSnapshot {
  id: number
  sessionId: number
  sessionUuid: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  toolUseCount: number
  duration: number
  linesModified: number
  timestamp: string
}

export interface MemorySearchResult {
  branchId: number
  sessionId: number
  sessionUuid: string
  startedAt: string
  endedAt: string | null
  projectName: string
  gitBranch: string | null
  filesModified: string | null
  commits: string | null
  snippet: string
  rank: number
}

// ── Dashboard / Stats ────────────────────────────────────────────────────────

export interface MemoryDashboardStats {
  totalProjects: number
  totalSessions: number
  totalBranches: number
  totalMessages: number
  totalTokensIn: number
  totalTokensOut: number
  totalCacheRead: number
  totalCacheCreation: number
  totalToolUses: number
  totalLinesModified: number
  averageSessionDuration: number // seconds
  recentSessions: MemorySession[]
  projectBreakdown: { project: string; sessions: number; messages: number }[]
  dailyActivity: { date: string; sessions: number; messages: number }[]
}

export interface MemoryContextSummaryParsed {
  version: number
  topic: string
  disposition: 'COMPLETED' | 'IN_PROGRESS' | 'INTERRUPTED' | string
  markers: string[]
  firstExchanges: { user: string; assistant: string; timestamp: string; index: number }[]
  lastExchanges: { user: string; assistant: string; timestamp: string; index: number }[]
  metadata: {
    exchangeCount: number
    filesModified: string | null
    commits: string | null
    toolCounts: string | null
    startedAt: string
    endedAt: string
    gitBranch: string
  }
}

// ── Import Log ───────────────────────────────────────────────────────────────

export interface MemoryImportLogEntry {
  id: number
  path: string
  fileHash: string
  importedAt: string
  messageCount: number
}

// ── Adapter Query Options ────────────────────────────────────────────────────

export interface MemorySessionListOptions {
  projectId?: number
  limit?: number
  offset?: number
  orderBy?: 'recent' | 'oldest'
}

export interface MemoryBranchListOptions {
  sessionId?: number
  activeOnly?: boolean
  limit?: number
  offset?: number
}

export interface MemorySearchOptions {
  query: string
  projectName?: string
  limit?: number
  before?: string // ISO date
  after?: string  // ISO date
}

export interface MemoryMessageListOptions {
  branchId: number
  excludeNotifications?: boolean
  limit?: number
  offset?: number
}
