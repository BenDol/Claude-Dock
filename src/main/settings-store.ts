import Store from 'electron-store'
import { Settings, DEFAULT_SETTINGS, mergeSettingsPartial } from '../shared/settings-schema'
import { ENV_PROFILE } from '../shared/env-profile'
import { createSafeStore, safeRead, safeWriteSync } from './safe-store'

declare const __UPDATE_PROFILE__: string

let store: Store<Settings> | null = null
let profileAligned = false

function getStore(): Store<Settings> {
  if (!store) {
    const defaults = {
      ...DEFAULT_SETTINGS,
      updater: { ...DEFAULT_SETTINGS.updater, profile: __UPDATE_PROFILE__ },
      environment: { profile: ENV_PROFILE }
    }
    store = createSafeStore<Settings>({
      name: 'settings',
      defaults
    })
  }
  // First read after store init: ensure stored environment.profile matches the
  // running binary. If an old settings.json was copied between installs, or a
  // user is upgrading from a pre-env-profile build, the stored value could be
  // stale. Writing it back keeps `settings.environment.profile` truthful.
  if (!profileAligned) {
    profileAligned = true
    try {
      const current = store.get('environment') as Settings['environment'] | undefined
      if (!current || current.profile !== ENV_PROFILE) {
        store.set('environment', { profile: ENV_PROFILE })
      }
    } catch { /* best effort — don't break startup if the store is unreadable */ }
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
  // Deep-merge: callers may pass a partial section (e.g. `{ terminal: { fontSize } }`)
  // and must not clobber sibling fields like `fontFamily` or `lineHeight`.
  const current = getSettings()
  const merged = mergeSettingsPartial(current, settings)
  safeWriteSync(() => getStore().set(merged))
}
