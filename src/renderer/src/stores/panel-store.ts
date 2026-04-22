/**
 * Zustand store for the dockable panel system.
 *
 * Each edge (left / right / top / bottom) is an independent slot with its own
 * active panel, size, and visibility. A panel id remembers the edge it was
 * last placed on, so toggling its toolbar button restores it to the same side
 * — and another panel can sit on the opposite edge at the same time.
 *
 * State is persisted per-project in localStorage. The previous single-slot
 * shape is migrated on first load.
 */
import { create } from 'zustand'
import { getPanel } from '../panel-registry'

const log = (event: string, data?: unknown): void => {
  // eslint-disable-next-line no-console
  console.debug('[panel-store]', event, data ?? '')
}
const logError = (event: string, data?: unknown): void => {
  // eslint-disable-next-line no-console
  console.warn('[panel-store]', event, data ?? '')
}

export type PanelPosition = 'left' | 'right' | 'top' | 'bottom'

export const PANEL_POSITIONS: readonly PanelPosition[] = ['left', 'right', 'top', 'bottom'] as const

export interface PanelSlot {
  activePanelId: string | null
  size: number
  visible: boolean
}

interface PanelState {
  slots: Record<PanelPosition, PanelSlot>
  // Per-panel-id remembered edge (set when the user drags a panel, or seeded
  // from the registration's defaultPosition the first time it activates).
  panelPositions: Record<string, PanelPosition>

  /** Show a panel at its remembered edge (or registry defaultPosition). */
  setActivePanel: (id: string | null) => void
  /** Hide a panel by id (no-op if not visible anywhere). */
  hidePanel: (id: string) => void
  setVisibleAt: (position: PanelPosition, visible: boolean) => void
  setSizeAt: (position: PanelPosition, size: number) => void
  /** Move a panel to a different edge (used by drag-drop). */
  setPanelPosition: (panelId: string, pos: PanelPosition) => void

  /** Where, if anywhere, is this panel currently mounted? */
  getSlotForPanel: (panelId: string) => PanelPosition | null
  /** Is this panel id active AND visible at its slot? */
  isPanelVisible: (panelId: string) => boolean

  loadFromStorage: (projectDir: string) => void
}

const DEFAULT_SIZE: Record<PanelPosition, number> = {
  left: 250,
  right: 400,
  top: 200,
  bottom: 200
}

function emptySlots(): Record<PanelPosition, PanelSlot> {
  return {
    left: { activePanelId: null, size: DEFAULT_SIZE.left, visible: false },
    right: { activePanelId: null, size: DEFAULT_SIZE.right, visible: false },
    top: { activePanelId: null, size: DEFAULT_SIZE.top, visible: false },
    bottom: { activePanelId: null, size: DEFAULT_SIZE.bottom, visible: false }
  }
}

function storageKey(projectDir: string): string {
  return `dock-panel:${projectDir.replace(/\\/g, '/').toLowerCase()}`
}

interface PersistedShape {
  slots?: Partial<Record<PanelPosition, PanelSlot>>
  panelPositions?: Record<string, PanelPosition>
  // Legacy single-slot shape — migrated on load.
  activePanelId?: string | null
  position?: PanelPosition
  size?: number
  visible?: boolean
}

function loadPersisted(projectDir: string): { slots: Record<PanelPosition, PanelSlot>; panelPositions: Record<string, PanelPosition> } {
  const fresh = { slots: emptySlots(), panelPositions: {} as Record<string, PanelPosition> }
  try {
    const raw = localStorage.getItem(storageKey(projectDir))
    if (!raw) return fresh
    const saved = JSON.parse(raw) as PersistedShape

    // New shape
    if (saved.slots) {
      const slots = emptySlots()
      for (const pos of PANEL_POSITIONS) {
        const s = saved.slots[pos]
        if (s) slots[pos] = { activePanelId: s.activePanelId ?? null, size: s.size ?? DEFAULT_SIZE[pos], visible: !!s.visible }
      }
      return { slots, panelPositions: saved.panelPositions ?? {} }
    }

    // Legacy shape — migrate.
    if (saved.activePanelId !== undefined || saved.position !== undefined) {
      const pos: PanelPosition = saved.position ?? 'left'
      const slots = emptySlots()
      slots[pos] = {
        activePanelId: saved.activePanelId ?? null,
        size: saved.size ?? DEFAULT_SIZE[pos],
        visible: !!saved.visible
      }
      const panelPositions: Record<string, PanelPosition> = {}
      if (saved.activePanelId) panelPositions[saved.activePanelId] = pos
      log('migrated legacy single-slot persisted state', { projectDir, pos, activePanelId: saved.activePanelId })
      return { slots, panelPositions }
    }
  } catch (err) {
    logError('failed to load persisted state', { projectDir, error: (err as Error).message })
  }
  return fresh
}

let _currentProjectDir = ''

function persist(state: { slots: Record<PanelPosition, PanelSlot>; panelPositions: Record<string, PanelPosition> }): void {
  if (!_currentProjectDir) return
  try {
    localStorage.setItem(storageKey(_currentProjectDir), JSON.stringify({ slots: state.slots, panelPositions: state.panelPositions }))
  } catch (err) {
    logError('failed to persist state', { error: (err as Error).message })
  }
}

/** Resolve where a panel should appear: remembered position → registry default → 'left'. */
function resolvePosition(panelId: string, panelPositions: Record<string, PanelPosition>): PanelPosition {
  const remembered = panelPositions[panelId]
  if (remembered) return remembered
  const registration = getPanel(panelId)
  return registration?.defaultPosition ?? 'left'
}

export const usePanelStore = create<PanelState>((set, get) => ({
  slots: emptySlots(),
  panelPositions: {},

  setActivePanel: (id) => {
    if (id == null) {
      // Hide all slots — used by the legacy "deactivate" path.
      const slots = { ...get().slots }
      for (const pos of PANEL_POSITIONS) slots[pos] = { ...slots[pos], visible: false }
      set({ slots })
      persist({ slots, panelPositions: get().panelPositions })
      return
    }

    const registration = getPanel(id)
    const panelPositions = { ...get().panelPositions }
    const pos = resolvePosition(id, panelPositions)
    panelPositions[id] = pos

    const slots = { ...get().slots }
    const prev = slots[pos]
    const sizeForSlot = registration?.defaultSize && prev.activePanelId !== id ? registration.defaultSize : prev.size
    slots[pos] = { activePanelId: id, size: sizeForSlot, visible: true }

    log('setActivePanel', { id, pos, sizeForSlot, replaced: prev.activePanelId })
    set({ slots, panelPositions })
    persist({ slots, panelPositions })
  },

  hidePanel: (id) => {
    const pos = get().getSlotForPanel(id)
    if (!pos) return
    const slots = { ...get().slots, [pos]: { ...get().slots[pos], visible: false } }
    set({ slots })
    persist({ slots, panelPositions: get().panelPositions })
  },

  setVisibleAt: (position, visible) => {
    const slots = { ...get().slots, [position]: { ...get().slots[position], visible } }
    set({ slots })
    persist({ slots, panelPositions: get().panelPositions })
  },

  setSizeAt: (position, size) => {
    const slots = { ...get().slots, [position]: { ...get().slots[position], size } }
    set({ slots })
    persist({ slots, panelPositions: get().panelPositions })
  },

  setPanelPosition: (panelId, pos) => {
    const current = get().getSlotForPanel(panelId)
    if (current === pos) return

    const slots = { ...get().slots }
    const panelPositions = { ...get().panelPositions, [panelId]: pos }

    // Remove from current slot (if any).
    if (current) slots[current] = { ...slots[current], activePanelId: null, visible: false }

    // Place into target slot. If target had a different panel, the user is
    // explicitly replacing it via drag-drop, so evict it.
    const registration = getPanel(panelId)
    const target = slots[pos]
    const size = target.activePanelId === panelId ? target.size : (registration?.defaultSize ?? target.size)
    slots[pos] = { activePanelId: panelId, size, visible: true }

    log('setPanelPosition', { panelId, from: current, to: pos })
    set({ slots, panelPositions })
    persist({ slots, panelPositions })
  },

  getSlotForPanel: (panelId) => {
    const { slots } = get()
    for (const pos of PANEL_POSITIONS) {
      if (slots[pos].activePanelId === panelId) return pos
    }
    return null
  },

  isPanelVisible: (panelId) => {
    const pos = get().getSlotForPanel(panelId)
    return pos != null && get().slots[pos].visible
  },

  loadFromStorage: (projectDir) => {
    _currentProjectDir = projectDir
    const { slots, panelPositions } = loadPersisted(projectDir)
    set({ slots, panelPositions })
  }
}))
