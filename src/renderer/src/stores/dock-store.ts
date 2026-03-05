import { create } from 'zustand'
import type { Layout } from 'react-grid-layout'
import type { TerminalInfo, GridMode } from '../types'

interface DockState {
  dockId: string
  projectDir: string
  terminals: TerminalInfo[]
  gridMode: GridMode
  freeformLayout: Layout[]
  focusedTerminalId: string | null
  nextTerminalNum: number

  // Actions
  setDockInfo: (id: string, projectDir: string) => void
  addTerminal: (id: string) => void
  removeTerminal: (id: string) => void
  setTerminalTitle: (id: string, title: string) => void
  setTerminalAlive: (id: string, alive: boolean) => void
  setGridMode: (mode: GridMode) => void
  setFreeformLayout: (layout: Layout[]) => void
  setFocusedTerminal: (id: string | null) => void
  focusNextTerminal: () => void
}

export const useDockStore = create<DockState>((set, get) => ({
  dockId: '',
  projectDir: '',
  terminals: [],
  gridMode: 'auto',
  freeformLayout: [],
  focusedTerminalId: null,
  nextTerminalNum: 1,

  setDockInfo: (id, projectDir) => set({ dockId: id, projectDir }),

  addTerminal: (id) =>
    set((state) => ({
      terminals: [...state.terminals, { id, title: `Terminal ${state.nextTerminalNum}`, isAlive: true }],
      nextTerminalNum: state.nextTerminalNum + 1,
      focusedTerminalId: id
    })),

  removeTerminal: (id) =>
    set((state) => {
      const terminals = state.terminals.filter((t) => t.id !== id)
      const focusedTerminalId =
        state.focusedTerminalId === id
          ? terminals.length > 0
            ? terminals[terminals.length - 1].id
            : null
          : state.focusedTerminalId
      return { terminals, focusedTerminalId }
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

  setFreeformLayout: (layout) => set({ freeformLayout: layout }),

  setFocusedTerminal: (id) => set({ focusedTerminalId: id }),

  focusNextTerminal: () =>
    set((state) => {
      if (state.terminals.length === 0) return state
      const currentIdx = state.terminals.findIndex((t) => t.id === state.focusedTerminalId)
      const nextIdx = (currentIdx + 1) % state.terminals.length
      return { focusedTerminalId: state.terminals[nextIdx].id }
    })
}))
