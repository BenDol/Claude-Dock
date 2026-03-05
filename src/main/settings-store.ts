import Store from 'electron-store'
import { Settings, DEFAULT_SETTINGS } from '../shared/settings-schema'

let store: Store<Settings> | null = null

function getStore(): Store<Settings> {
  if (!store) {
    store = new Store<Settings>({
      name: 'settings',
      defaults: DEFAULT_SETTINGS
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
