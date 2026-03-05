import Store from 'electron-store'
import { Settings, DEFAULT_SETTINGS } from '../shared/settings-schema'

declare const __UPDATE_PROFILE__: string

let store: Store<Settings> | null = null

function getStore(): Store<Settings> {
  if (!store) {
    const defaults = {
      ...DEFAULT_SETTINGS,
      updater: { ...DEFAULT_SETTINGS.updater, profile: __UPDATE_PROFILE__ }
    }
    store = new Store<Settings>({
      name: 'settings',
      defaults
    })
  }
  return store
}

export function getSettings(): Settings {
  return getStore().store
}

export function getSetting<K extends keyof Settings>(key: K): Settings[K] {
  return getStore().get(key)
}

export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
  getStore().set(key, value)
}

export function setSettings(settings: Partial<Settings>): void {
  const s = getStore()
  for (const [key, value] of Object.entries(settings)) {
    s.set(key as keyof Settings, value)
  }
}
