import { create } from 'zustand'
import type { Settings, SettingsOrigin } from '../../../shared/settings-schema'
import { DEFAULT_SETTINGS } from '../../../shared/settings-schema'
import { getDockApi } from '../lib/ipc-bridge'
import { applyThemeToDocument } from '../lib/theme'

interface SettingsState {
  settings: Settings
  loaded: boolean
  /** Maps dot-path keys to their origin tier (only project/local overrides are present) */
  origins: Record<string, SettingsOrigin>
  load: () => Promise<void>
  loadOrigins: () => Promise<void>
  update: (partial: Partial<Settings>) => Promise<void>
  /** Write a setting to the project or local tier */
  updateProject: (partial: Partial<Settings>, tier: 'project' | 'local') => Promise<void>
  /** Remove a project-scoped override, falling back to the next tier */
  resetProjectKey: (keyPath: string, tier: 'project' | 'local') => Promise<void>
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  origins: {},

  load: async () => {
    const api = getDockApi()
    const settings = await api.settings.get()
    set({ settings, loaded: true })
    applyThemeToDocument(settings)

    // Load origins (non-blocking)
    api.settings.getOrigins().then((origins) => set({ origins })).catch(() => {})

    // Listen for external changes
    api.settings.onChange((newSettings) => {
      set({ settings: newSettings })
      applyThemeToDocument(newSettings)
      // Refresh origins since the merge result changed
      api.settings.getOrigins().then((origins) => set({ origins })).catch(() => {})
    })
  },

  loadOrigins: async () => {
    try {
      const origins = await getDockApi().settings.getOrigins()
      set({ origins })
    } catch { /* ignore */ }
  },

  update: async (partial) => {
    const api = getDockApi()
    await api.settings.set(partial)
    const newSettings = { ...get().settings, ...partial }
    set({ settings: newSettings })
    applyThemeToDocument(newSettings)
  },

  updateProject: async (partial, tier) => {
    const api = getDockApi()
    await api.settings.setProject(partial, tier)
    // Re-fetch merged settings + origins
    const [settings, origins] = await Promise.all([
      api.settings.get(),
      api.settings.getOrigins()
    ])
    set({ settings, origins })
    applyThemeToDocument(settings)
  },

  resetProjectKey: async (keyPath, tier) => {
    const api = getDockApi()
    await api.settings.resetProjectKey(keyPath, tier)
    const [settings, origins] = await Promise.all([
      api.settings.get(),
      api.settings.getOrigins()
    ])
    set({ settings, origins })
    applyThemeToDocument(settings)
  }
}))
