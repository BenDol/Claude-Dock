import { createSafeStore, safeRead, safeWrite } from '../safe-store'
import type Store from 'electron-store'

export interface PluginOverrideEntry {
  version: string
  buildSha: string
  hash: string
  installedAt: number
}

interface PluginUpdateStoreData {
  lastChecked: number // ms since epoch
  dismissedVersions: Record<string, string> // pluginId → dismissed version
  verifiedHosts: string[] // cached allowlist
  verifiedHostsFetchedAt: number
  overrides: Record<string, PluginOverrideEntry> // installed built-in overrides
  seenOverrideHashes: Record<string, string> // pluginId → hash of override the user was notified about
}

let store: Store<PluginUpdateStoreData> | null = null

function getStore(): Store<PluginUpdateStoreData> {
  if (!store) {
    store = createSafeStore<PluginUpdateStoreData>({
      name: 'plugin-updates',
      defaults: {
        lastChecked: 0,
        dismissedVersions: {},
        verifiedHosts: [],
        verifiedHostsFetchedAt: 0,
        overrides: {},
        seenOverrideHashes: {}
      }
    })
  }
  return store
}

export function getLastChecked(): number {
  return safeRead(() => getStore().get('lastChecked', 0)) ?? 0
}

export function setLastChecked(ts: number): void {
  safeWrite(() => getStore().set('lastChecked', ts))
}

export function getDismissedVersions(): Record<string, string> {
  return safeRead(() => getStore().get('dismissedVersions', {})) ?? {}
}

export function dismissVersion(pluginId: string, version: string): void {
  const dismissed = getDismissedVersions()
  dismissed[pluginId] = version
  safeWrite(() => getStore().set('dismissedVersions', dismissed))
}

export function getVerifiedHosts(): { hosts: string[]; fetchedAt: number } {
  const hosts = safeRead(() => getStore().get('verifiedHosts', [])) ?? []
  const fetchedAt = safeRead(() => getStore().get('verifiedHostsFetchedAt', 0)) ?? 0
  return { hosts, fetchedAt }
}

export function setVerifiedHosts(hosts: string[]): void {
  safeWrite(() => {
    getStore().set('verifiedHosts', hosts)
    getStore().set('verifiedHostsFetchedAt', Date.now())
  })
}

export function getOverrides(): Record<string, PluginOverrideEntry> {
  return safeRead(() => getStore().get('overrides', {})) ?? {}
}

export function setOverride(pluginId: string, entry: PluginOverrideEntry): void {
  const overrides = getOverrides()
  overrides[pluginId] = entry
  safeWrite(() => getStore().set('overrides', overrides))
}

export function removeOverride(pluginId: string): void {
  const overrides = getOverrides()
  delete overrides[pluginId]
  safeWrite(() => getStore().set('overrides', overrides))
}

export function getSeenOverrideHashes(): Record<string, string> {
  return safeRead(() => getStore().get('seenOverrideHashes', {})) ?? {}
}

export function markOverrideSeen(pluginId: string, hash: string): void {
  const seen = getSeenOverrideHashes()
  seen[pluginId] = hash
  safeWrite(() => getStore().set('seenOverrideHashes', seen))
}
