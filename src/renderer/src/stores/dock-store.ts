import { create } from 'zustand'
import type { TerminalInfo, GridMode } from '../types'
import type { ClaudeTaskRequest } from '../../../shared/claude-task-types'

interface DockState {
  dockId: string
  projectDir: string
  terminals: TerminalInfo[]
  gridMode: GridMode
  focusedTerminalId: string | null
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
  pendingShellCommand: string | null
  /** Maps terminal ID → git worktree path (terminals working from a worktree) */
  terminalWorktrees: Map<string, string>

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
  focusNextTerminal: () => void
  setTerminalRC: (id: string, active: boolean) => void
  setTerminalLoading: (id: string, loading: boolean) => void
  setTerminalClaudeTask: (id: string, taskType: ClaudeTaskRequest['type'] | null) => void
  setTerminalClaudeFlags: (id: string, flags: string | null) => void
  setTerminalPersistentTask: (id: string, persistent: boolean) => void
  setTerminalActive: (id: string, active: boolean) => void
  markTerminalResumed: (id: string) => void
  setPendingShellCommand: (command: string | null) => void
  setTerminalWorktree: (id: string, worktreePath: string | null) => void
}

export const useDockStore = create<DockState>((set, get) => ({
  dockId: '',
  projectDir: '',
  terminals: [],
  gridMode: 'auto',
  focusedTerminalId: null,
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
      return { terminals, focusedTerminalId, rcTerminals, unlockedTerminals, claudeTaskTerminals, claudeTaskFlags, claudePersistentTaskTerminals }
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

  setFocusedTerminal: (id) => set({ focusedTerminalId: id }),

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
  })
}))
