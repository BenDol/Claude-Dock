import { create } from 'zustand'
import type { TerminalInfo, GridMode } from '../types'

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

  setDockInfo: (id, projectDir) => set({ dockId: id, projectDir }),

  addTerminal: (id) =>
    set((state) => {
      const unlockedTerminals = new Set(state.unlockedTerminals)
      unlockedTerminals.add(id)
      return {
        terminals: [...state.terminals, { id, title: `Terminal ${state.nextTerminalNum}`, isAlive: true }],
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
      return { terminals, focusedTerminalId, rcTerminals, unlockedTerminals }
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
    })
}))
