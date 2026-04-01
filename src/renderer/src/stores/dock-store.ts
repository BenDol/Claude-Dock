import { create } from 'zustand'
import type { TerminalInfo, GridMode } from '../types'
import type { ClaudeTaskRequest } from '../../../shared/claude-task-types'

interface DockState {
  dockId: string
  projectDir: string
  terminals: TerminalInfo[]
  gridMode: GridMode
  focusedTerminalId: string | null
  /** Which region of the UI currently has keyboard focus */
  focusRegion: 'grid' | 'toolbar' | 'shell'
  nextTerminalNum: number
  unlockedTerminals: Set<string>
  rcTerminals: Set<string>
  loadingTerminals: Set<string>
  /** Maps terminal ID → task type string for terminals running Claude tasks */
  claudeTaskTerminals: Map<string, ClaudeTaskRequest['type']>
  /** Maps terminal ID → extra Claude CLI flags for task terminals */
  claudeTaskFlags: Map<string, string>
  /** Set of terminal IDs for persistent (non-ephemeral) task terminals */
  claudePersistentTaskTerminals: Set<string>
  /** Set of terminal IDs that are currently receiving data */
  activeTerminals: Set<string>
  /** Set of terminal IDs that were spawned from saved sessions (resume) */
  resumedTerminals: Set<string>
  /** Pending shell command to run in a terminal's shell panel (set by SHELL_RUN_COMMAND) */
  pendingShellCommand: { command: string; submit: boolean; targetTerminalId: string | null; shellType: string | null; targetShellId: string | null; shellLayout: 'split' | 'stack' | null } | null
  /** Maps terminal ID → git worktree path (terminals working from a worktree) */
  terminalWorktrees: Map<string, string>
  /** Maps terminal ID → branch name for terminals waiting on worktree creation */
  pendingWorktrees: Map<string, string>
  /** Maps terminal ID → session ID for manual resume (user-provided session ID) */
  manualResumeIds: Map<string, string>
  /** Shell events detected from ##DOCK_EVENT## markers */
  shellEvents: Array<{
    id: string
    sessionId: string
    shellId: string
    type: string
    payload: any
    timestamp: number
  }>
  /** Event hashes the user has chosen to ignore (type:hash or type for hashless) */
  ignoredEventHashes: string[]

  // Actions
  setDockInfo: (id: string, projectDir: string) => void
  addTerminal: (id: string) => void
  removeTerminal: (id: string) => void
  setTerminalTitle: (id: string, title: string) => void
  setTerminalAlive: (id: string, alive: boolean) => void
  setGridMode: (mode: GridMode) => void
  toggleTerminalLock: (id: string) => void
  swapTerminals: (id1: string, id2: string) => void
  setFocusedTerminal: (id: string | null) => void
  setFocusRegion: (region: 'grid' | 'toolbar' | 'shell') => void
  focusNextTerminal: () => void
  setTerminalRC: (id: string, active: boolean) => void
  setTerminalLoading: (id: string, loading: boolean) => void
  setTerminalClaudeTask: (id: string, taskType: ClaudeTaskRequest['type'] | null) => void
  setTerminalClaudeFlags: (id: string, flags: string | null) => void
  setTerminalPersistentTask: (id: string, persistent: boolean) => void
  setTerminalActive: (id: string, active: boolean) => void
  markTerminalResumed: (id: string) => void
  setPendingShellCommand: (command: { command: string; submit: boolean; targetTerminalId: string | null; shellType: string | null; targetShellId: string | null; shellLayout: 'split' | 'stack' | null } | null) => void
  setTerminalWorktree: (id: string, worktreePath: string | null) => void
  setPendingWorktree: (id: string, branch: string | null) => void
  setManualResumeId: (id: string, sessionId: string | null) => void
  addShellEvent: (event: { sessionId: string; shellId: string; type: string; payload: any; timestamp: number }) => void
  dismissShellEvent: (id: string) => void
  clearShellEvents: () => void
  ignoreEventHash: (key: string) => void
  unignoreEventHash: (key: string) => void
}

export const useDockStore = create<DockState>((set, get) => ({
  dockId: '',
  projectDir: '',
  terminals: [],
  gridMode: 'auto',
  focusedTerminalId: null,
  focusRegion: 'grid',
  nextTerminalNum: 1,
  unlockedTerminals: new Set<string>(),
  rcTerminals: new Set<string>(),
  loadingTerminals: new Set<string>(),
  claudeTaskTerminals: new Map<string, ClaudeTaskRequest['type']>(),
  claudeTaskFlags: new Map<string, string>(),
  claudePersistentTaskTerminals: new Set<string>(),
  activeTerminals: new Set<string>(),
  resumedTerminals: new Set<string>(),
  pendingShellCommand: null,
  terminalWorktrees: new Map<string, string>(),
  pendingWorktrees: new Map<string, string>(),
  manualResumeIds: new Map<string, string>(),
  shellEvents: [],
  ignoredEventHashes: [],

  setDockInfo: (id, projectDir) => set({ dockId: id, projectDir }),

  addTerminal: (id) =>
    set((state) => {
      const unlockedTerminals = new Set(state.unlockedTerminals)
      unlockedTerminals.add(id)
      return {
        terminals: [...state.terminals, { id, title: `Terminal ${state.nextTerminalNum}${state.projectDir ? ' - ' + (state.projectDir.split(/[/\\]/).pop() || state.projectDir) : ''}`, isAlive: true }],
        nextTerminalNum: state.nextTerminalNum + 1,
        focusedTerminalId: id,
        unlockedTerminals
      }
    }),

  removeTerminal: (id) =>
    set((state) => {
      const terminals = state.terminals.filter((t) => t.id !== id)
      const focusedTerminalId =
        state.focusedTerminalId === id
          ? terminals.length > 0
            ? terminals[terminals.length - 1].id
            : null
          : state.focusedTerminalId
      const rcTerminals = new Set(state.rcTerminals)
      rcTerminals.delete(id)
      const unlockedTerminals = new Set(state.unlockedTerminals)
      unlockedTerminals.delete(id)
      const claudeTaskTerminals = new Map(state.claudeTaskTerminals)
      claudeTaskTerminals.delete(id)
      const claudeTaskFlags = new Map(state.claudeTaskFlags)
      claudeTaskFlags.delete(id)
      const claudePersistentTaskTerminals = new Set(state.claudePersistentTaskTerminals)
      claudePersistentTaskTerminals.delete(id)
      const pendingWorktrees = new Map(state.pendingWorktrees)
      pendingWorktrees.delete(id)
      const manualResumeIds = new Map(state.manualResumeIds)
      manualResumeIds.delete(id)
      return { terminals, focusedTerminalId, rcTerminals, unlockedTerminals, claudeTaskTerminals, claudeTaskFlags, claudePersistentTaskTerminals, pendingWorktrees, manualResumeIds }
    }),

  setTerminalTitle: (id, title) =>
    set((state) => ({
      terminals: state.terminals.map((t) => (t.id === id ? { ...t, title } : t))
    })),

  setTerminalAlive: (id, alive) =>
    set((state) => ({
      terminals: state.terminals.map((t) => (t.id === id ? { ...t, isAlive: alive } : t))
    })),

  setGridMode: (mode) => set({ gridMode: mode }),

  toggleTerminalLock: (id) =>
    set((state) => {
      const next = new Set(state.unlockedTerminals)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return { unlockedTerminals: next }
    }),

  swapTerminals: (id1, id2) =>
    set((state) => {
      const idx1 = state.terminals.findIndex((t) => t.id === id1)
      const idx2 = state.terminals.findIndex((t) => t.id === id2)
      if (idx1 === -1 || idx2 === -1 || idx1 === idx2) return state
      const terminals = [...state.terminals]
      ;[terminals[idx1], terminals[idx2]] = [terminals[idx2], terminals[idx1]]
      return { terminals }
    }),

  setFocusedTerminal: (id) => set({ focusedTerminalId: id, focusRegion: 'grid' }),
  setFocusRegion: (region) => set({ focusRegion: region }),

  focusNextTerminal: () =>
    set((state) => {
      if (state.terminals.length === 0) return state
      const currentIdx = state.terminals.findIndex((t) => t.id === state.focusedTerminalId)
      const nextIdx = (currentIdx + 1) % state.terminals.length
      return { focusedTerminalId: state.terminals[nextIdx].id }
    }),

  setTerminalRC: (id, active) =>
    set((state) => {
      const next = new Set(state.rcTerminals)
      if (active) next.add(id)
      else next.delete(id)
      return { rcTerminals: next }
    }),

  setTerminalLoading: (id, loading) =>
    set((state) => {
      const next = new Set(state.loadingTerminals)
      if (loading) next.add(id)
      else next.delete(id)
      return { loadingTerminals: next }
    }),

  setTerminalClaudeTask: (id, taskType) =>
    set((state) => {
      const next = new Map(state.claudeTaskTerminals)
      if (taskType) next.set(id, taskType)
      else next.delete(id)
      return { claudeTaskTerminals: next }
    }),

  setTerminalClaudeFlags: (id, flags) =>
    set((state) => {
      const next = new Map(state.claudeTaskFlags)
      if (flags) next.set(id, flags)
      else next.delete(id)
      return { claudeTaskFlags: next }
    }),

  setTerminalPersistentTask: (id, persistent) =>
    set((state) => {
      const next = new Set(state.claudePersistentTaskTerminals)
      if (persistent) next.add(id)
      else next.delete(id)
      return { claudePersistentTaskTerminals: next }
    }),

  setTerminalActive: (id, active) =>
    set((state) => {
      const next = new Set(state.activeTerminals)
      if (active) next.add(id)
      else next.delete(id)
      return { activeTerminals: next }
    }),

  markTerminalResumed: (id) =>
    set((state) => {
      const next = new Set(state.resumedTerminals)
      next.add(id)
      return { resumedTerminals: next }
    }),

  setPendingShellCommand: (command) => set({ pendingShellCommand: command }),

  setTerminalWorktree: (id, worktreePath) => set((state) => {
    const terminalWorktrees = new Map(state.terminalWorktrees)
    if (worktreePath) {
      terminalWorktrees.set(id, worktreePath)
    } else {
      terminalWorktrees.delete(id)
    }
    return { terminalWorktrees }
  }),

  setPendingWorktree: (id, branch) => set((state) => {
    const pendingWorktrees = new Map(state.pendingWorktrees)
    if (branch) {
      pendingWorktrees.set(id, branch)
    } else {
      pendingWorktrees.delete(id)
    }
    return { pendingWorktrees }
  }),

  setManualResumeId: (id, sessionId) => set((state) => {
    const manualResumeIds = new Map(state.manualResumeIds)
    if (sessionId) {
      manualResumeIds.set(id, sessionId)
    } else {
      manualResumeIds.delete(id)
    }
    return { manualResumeIds }
  }),

  addShellEvent: (event) => set((state) => {
    // Skip events the user has ignored by hash
    const hash = typeof event.payload === 'object' ? event.payload.hash : undefined
    const ignoreKey = hash ? `${event.type}:${hash}` : event.type
    if (state.ignoredEventHashes.includes(ignoreKey)) return state

    // Deduplicate: remove any existing event with the same type+hash (or same
    // type within 10s for hashless events) so the new one appears at the end
    const filtered = state.shellEvents.filter((e) => {
      if (e.type !== event.type || e.sessionId !== event.sessionId) return true
      if (hash) return !(typeof e.payload === 'object' && e.payload.hash === hash)
      return event.timestamp - e.timestamp >= 10000
    })
    return {
      shellEvents: [...filtered, { ...event, id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` }].slice(-20)
    }
  }),

  dismissShellEvent: (id) => set((state) => {
    const event = state.shellEvents.find((e) => e.id === id)
    const hash = event && typeof event.payload === 'object' && event.payload?.hash
      ? `${event.type}:${event.payload.hash}` : null
    // Remove from the pending events file so the dedup cache is cleared —
    // future occurrences of the same event will be detected and shown again.
    if (hash) {
      window.dockApi?.shell.dismissEvents([hash]).catch(() => { /* non-critical */ })
    }
    return {
      shellEvents: state.shellEvents.filter((e) => e.id !== id)
    }
  }),

  clearShellEvents: () => set((state) => {
    const hashes = state.shellEvents
      .map((e) => typeof e.payload === 'object' && e.payload?.hash ? `${e.type}:${e.payload.hash}` : null)
      .filter(Boolean) as string[]
    // Clear from the pending events file so future occurrences can be detected
    if (hashes.length > 0) {
      window.dockApi?.shell.dismissEvents(hashes).catch(() => { /* non-critical */ })
    }
    return {
      shellEvents: [],
      ignoredEventHashes: [...new Set([...state.ignoredEventHashes, ...hashes])]
    }
  }),

  ignoreEventHash: (key) => set((state) => {
    // Also clear from pending file so it doesn't block future dedup checks
    window.dockApi?.shell.dismissEvents([key]).catch(() => { /* non-critical */ })
    return {
      ignoredEventHashes: [...new Set([...state.ignoredEventHashes, key])],
      shellEvents: state.shellEvents.filter((e) => {
        const h = typeof e.payload === 'object' && e.payload?.hash ? `${e.type}:${e.payload.hash}` : e.type
        return h !== key
      })
    }
  }),

  unignoreEventHash: (key) => set((state) => ({
    ignoredEventHashes: state.ignoredEventHashes.filter((k) => k !== key)
  }))
}))
