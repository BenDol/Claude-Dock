/**
 * Base interface that all memory tool adapters implement.
 *
 * Each adapter wraps a specific memory tool (Claudest, etc.) and
 * exposes a unified query interface for the viewer UI. Adapters are
 * read-only — they inspect the tool's storage but never mutate it.
 */

import type {
  MemoryAdapterInfo,
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

export interface MemoryAdapter {
  /** Unique adapter identifier */
  readonly id: string
  readonly name: string

  /**
   * Detect whether the underlying tool is installed and accessible.
   * Returns full adapter info including install status, store path, and available sections.
   */
  getInfo(): MemoryAdapterInfo

  /**
   * Test whether the adapter can connect to the memory store.
   * Returns true if the store is accessible and readable.
   */
  isAvailable(): boolean

  // ── Dashboard ──────────────────────────────────────────────────────────────

  getDashboard(): MemoryDashboardStats

  // ── Projects ───────────────────────────────────────────────────────────────

  getProjects(): MemoryProject[]

  // ── Sessions ───────────────────────────────────────────────────────────────

  getSessions(opts?: MemorySessionListOptions): MemorySession[]
  getSession(sessionId: number): MemorySession | null

  // ── Branches ───────────────────────────────────────────────────────────────

  getBranches(opts?: MemoryBranchListOptions): MemoryBranch[]
  getBranch(branchId: number): MemoryBranch | null

  // ── Messages ───────────────────────────────────────────────────────────────

  getMessages(opts: MemoryMessageListOptions): MemoryMessage[]

  // ── Token Snapshots ────────────────────────────────────────────────────────

  getTokenSnapshots(sessionId?: number): MemoryTokenSnapshot[]

  // ── Import Log ─────────────────────────────────────────────────────────────

  getImportLog(): MemoryImportLogEntry[]

  // ── Search ─────────────────────────────────────────────────────────────────

  search(opts: MemorySearchOptions): MemorySearchResult[]

  // ── Context Summaries ──────────────────────────────────────────────────────

  getContextSummary(branchId: number): MemoryContextSummaryParsed | null

  // ── Database Info ──────────────────────────────────────────────────────────

  getDbInfo(): {
    path: string
    sizeBytes: number
    tables: { name: string; rowCount: number }[]
    walSizeBytes: number
  } | null

  /**
   * Close any open database connections. Called on plugin dispose.
   */
  dispose(): void
}
