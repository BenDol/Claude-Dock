import Store from 'electron-store'
import { Settings, DEFAULT_SETTINGS } from '../shared/settings-schema'
import { createSafeStore, safeRead, safeWriteSync } from './safe-store'

declare const __UPDATE_PROFILE__: string

let store: Store<Settings> | null = null

function getStore(): Store<Settings> {
  if (!store) {
    const defaults = {
      ...DEFAULT_SETTINGS,
      updater: { ...DEFAULT_SETTINGS.updater, profile: __UPDATE_PROFILE__ }
    }
    store = createSafeStore<Settings>({
      name: 'settings',
      defaults
    })
  }
  return store
}

/**
 * Deep merge stored settings with defaults so newly added keys
 * (e.g. keybindings, linked) always have values even when the
 * persisted JSON predates their introduction.
 */
function deepMergeDefaults(defaults: Record<string, any>, stored: Record<string, any>): any {
  const result = { ...defaults }
  for (const key of Object.keys(stored)) {
    const sval = stored[key]
    const dval = defaults[key]
    if (sval !== undefined && sval !== null) {
      if (dval && typeof dval === 'object' && !Array.isArray(dval) && typeof sval === 'object' && !Array.isArray(sval)) {
        result[key] = deepMergeDefaults(dval, sval)
      } else {
        result[key] = sval
      }
    }
  }
  return result
}

export function getSettings(): Settings {
  const stored = safeRead(() => getStore().store)
  if (!stored) return DEFAULT_SETTINGS
  return deepMergeDefaults(DEFAULT_SETTINGS, stored as Record<string, any>) as Settings
}

export function getSetting<K extends keyof Settings>(key: K): Settings[K] {
  return safeRead(() => getStore().get(key)) ?? DEFAULT_SETTINGS[key]
}

export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
  safeWriteSync(() => getStore().set(key, value))
}

export function setSettings(settings: Partial<Settings>): void {
  // Batch into a single write by merging with current settings
  const current = getSettings()
  const merged = { ...current }
  for (const [key, value] of Object.entries(settings)) {
    if (value !== undefined) {
      ;(merged as any)[key] = value
    }
  }
  safeWriteSync(() => getStore().set(merged))
}
