/**
 * Zustand store for the dockable panel system.
 * Manages panel position, size, and visibility.
 * State is persisted per-project in localStorage.
 */
import { create } from 'zustand'

export type PanelPosition = 'left' | 'right' | 'top' | 'bottom'

interface PanelState {
  activePanelId: string | null
  position: PanelPosition
  size: number
  visible: boolean

  setActivePanel: (id: string | null) => void
  setPosition: (pos: PanelPosition) => void
  setSize: (size: number) => void
  setVisible: (visible: boolean) => void
  toggleVisible: () => void
  loadFromStorage: (projectDir: string) => void
}

function storageKey(projectDir: string): string {
  return `dock-panel:${projectDir.replace(/\\/g, '/').toLowerCase()}`
}

function saveToStorage(projectDir: string, state: Partial<PanelState>): void {
  try {
    const key = storageKey(projectDir)
    const existing = JSON.parse(localStorage.getItem(key) || '{}')
    const merged = { ...existing }
    if (state.activePanelId !== undefined) merged.activePanelId = state.activePanelId
    if (state.position !== undefined) merged.position = state.position
    if (state.size !== undefined) merged.size = state.size
    if (state.visible !== undefined) merged.visible = state.visible
    localStorage.setItem(key, JSON.stringify(merged))
  } catch { /* ignore */ }
}

// Track current project for persistence
let _currentProjectDir = ''

export const usePanelStore = create<PanelState>((set, get) => ({
  activePanelId: null,
  position: 'left',
  size: 250,
  visible: false,

  setActivePanel: (id) => {
    set({ activePanelId: id, visible: id != null ? true : get().visible })
    saveToStorage(_currentProjectDir, { activePanelId: id, visible: id != null ? true : get().visible })
  },
  setPosition: (pos) => {
    set({ position: pos })
    saveToStorage(_currentProjectDir, { position: pos })
  },
  setSize: (size) => {
    set({ size })
    saveToStorage(_currentProjectDir, { size })
  },
  setVisible: (visible) => {
    set({ visible })
    saveToStorage(_currentProjectDir, { visible })
  },
  toggleVisible: () => {
    const next = !get().visible
    set({ visible: next })
    saveToStorage(_currentProjectDir, { visible: next })
  },
  loadFromStorage: (projectDir) => {
    _currentProjectDir = projectDir
    try {
      const key = storageKey(projectDir)
      const raw = localStorage.getItem(key)
      if (raw) {
        const saved = JSON.parse(raw)
        set({
          activePanelId: saved.activePanelId ?? null,
          position: saved.position ?? 'left',
          size: saved.size ?? 250,
          visible: saved.visible ?? false
        })
      }
    } catch { /* ignore */ }
  }
}))
