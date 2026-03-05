import { create } from 'zustand'
import type { Settings } from '../../../shared/settings-schema'
import { DEFAULT_SETTINGS } from '../../../shared/settings-schema'
import { getDockApi } from '../lib/ipc-bridge'
import { applyThemeToDocument } from '../lib/theme'

interface SettingsState {
  settings: Settings
  loaded: boolean
  load: () => Promise<void>
  update: (partial: Partial<Settings>) => Promise<void>
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,

  load: async () => {
    const api = getDockApi()
    const settings = await api.settings.get()
    set({ settings, loaded: true })
    applyThemeToDocument(settings)

    // Listen for external changes
    api.settings.onChange((newSettings) => {
      set({ settings: newSettings })
      applyThemeToDocument(newSettings)
    })
  },

  update: async (partial) => {
    const api = getDockApi()
    await api.settings.set(partial)
    const newSettings = { ...get().settings, ...partial }
    set({ settings: newSettings })
    applyThemeToDocument(newSettings)
  }
}))
