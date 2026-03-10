import Store from 'electron-store'
import { createSafeStore, safeRead, safeWriteSync } from '../safe-store'
import type { PluginProjectState, ProjectPluginStates } from '../../shared/plugin-types'

interface PluginStoreData {
  [normalizedPath: string]: ProjectPluginStates
}

let store: Store<PluginStoreData> | null = null

function getStore(): Store<PluginStoreData> {
  if (!store) {
    store = createSafeStore<PluginStoreData>({
      name: 'plugin-state'
    })
  }
  return store
}

function normalizePath(dir: string): string {
  return dir.replace(/\\/g, '/').toLowerCase()
}

export function isProjectConfigured(projectDir: string): boolean {
  const key = normalizePath(projectDir)
  return safeRead(() => getStore().has(key)) ?? false
}

export function markProjectConfigured(projectDir: string): void {
  const key = normalizePath(projectDir)
  const existing = safeRead(() => getStore().get(key))
  if (!existing) {
    safeWriteSync(() => getStore().set(key, {}))
  }
}

export function getPluginState(projectDir: string, pluginId: string): PluginProjectState | undefined {
  const key = normalizePath(projectDir)
  const project = safeRead(() => getStore().get(key))
  return project?.[pluginId]
}

export function getAllPluginStates(projectDir: string): ProjectPluginStates {
  const key = normalizePath(projectDir)
  return safeRead(() => getStore().get(key)) || {}
}

export function setPluginEnabled(projectDir: string, pluginId: string, enabled: boolean): void {
  const key = normalizePath(projectDir)
  const project = safeRead(() => getStore().get(key)) || {}
  if (!project[pluginId]) {
    project[pluginId] = { enabled, settings: {} }
  } else {
    project[pluginId].enabled = enabled
  }
  safeWriteSync(() => getStore().set(key, project))
}

export function getPluginSetting(projectDir: string, pluginId: string, settingKey: string): unknown {
  const state = getPluginState(projectDir, pluginId)
  return state?.settings?.[settingKey]
}

export function setPluginSetting(projectDir: string, pluginId: string, settingKey: string, value: unknown): void {
  const key = normalizePath(projectDir)
  const project = safeRead(() => getStore().get(key)) || {}
  if (!project[pluginId]) {
    project[pluginId] = { enabled: false, settings: {} }
  }
  project[pluginId].settings[settingKey] = value
  safeWriteSync(() => getStore().set(key, project))
}
