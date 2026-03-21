/** Manifest served from GitHub release as `plugins.update` */
export interface PluginUpdateManifest {
  schemaVersion: number
  buildSha: string
  buildDate: string
  plugins: Record<string, PluginUpdateManifestEntry>
}

export interface PluginUpdateManifestEntry {
  version: string
  buildSha: string
  commitEpoch?: number // Unix epoch (seconds) of the last commit that modified this plugin
  hash: string // SHA-256 of extracted plugin contents
  archivePath: string // path inside plugins.zip (e.g. "git-manager/")
  changelog?: string
  minAppVersion?: string
  requiresAppUpdate?: boolean // true if renderer changes are included
}

/** Manifest served by external plugin hosts at their updateUrl */
export interface ExternalUpdateManifest {
  schemaVersion: number
  version: string
  hash: string
  downloadUrl: string
  changelog?: string
  minAppVersion?: string
}

/** Unified update entry tracked by the update service */
export interface PluginUpdateEntry {
  pluginId: string
  pluginName: string
  source: 'builtin' | 'external'
  currentVersion: string
  newVersion: string
  changelog: string
  downloadUrl: string
  hash: string
  archivePath?: string
  requiresAppUpdate?: boolean
  status: PluginUpdateStatus
  progress?: { downloaded: number; total: number }
  error?: string
}

export type PluginUpdateStatus =
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'installed'
  | 'failed'
