import { describe, it, expect } from 'vitest'
import type {
  PluginUpdateManifest,
  PluginUpdateManifestEntry,
  ExternalUpdateManifest,
  PluginUpdateEntry,
  PluginUpdateStatus
} from '../plugin-update-types'

describe('plugin-update-types', () => {
  describe('PluginUpdateManifest', () => {
    it('accepts valid manifest structure', () => {
      const manifest: PluginUpdateManifest = {
        schemaVersion: 1,
        buildSha: 'abc123def456',
        buildDate: '2026-03-16',
        plugins: {
          'git-sync': {
            version: '2.0.0',
            buildSha: 'plugin-sha',
            hash: 'content-hash',
            archivePath: 'git-sync/',
            changelog: 'New features',
            minAppVersion: '1.0.0',
            requiresAppUpdate: false
          }
        }
      }
      expect(manifest.schemaVersion).toBe(1)
      expect(manifest.plugins['git-sync'].version).toBe('2.0.0')
    })

    it('allows optional fields to be undefined', () => {
      const entry: PluginUpdateManifestEntry = {
        version: '1.0.0',
        buildSha: 'sha',
        hash: 'hash',
        archivePath: 'path/'
        // changelog, minAppVersion, requiresAppUpdate all optional
      }
      expect(entry.changelog).toBeUndefined()
      expect(entry.minAppVersion).toBeUndefined()
      expect(entry.requiresAppUpdate).toBeUndefined()
    })
  })

  describe('ExternalUpdateManifest', () => {
    it('accepts valid external manifest', () => {
      const manifest: ExternalUpdateManifest = {
        schemaVersion: 1,
        version: '2.0.0',
        hash: 'file-hash',
        downloadUrl: 'https://github.com/user/repo/releases/download/v2.0.0/plugin.zip',
        changelog: 'Bug fixes',
        minAppVersion: '1.5.0'
      }
      expect(manifest.downloadUrl).toContain('github.com')
    })
  })

  describe('PluginUpdateEntry', () => {
    it('tracks all states in the update lifecycle', () => {
      const statuses: PluginUpdateStatus[] = [
        'available', 'downloading', 'downloaded', 'installing', 'installed', 'failed'
      ]
      expect(statuses).toHaveLength(6)
    })

    it('accepts valid update entry', () => {
      const entry: PluginUpdateEntry = {
        pluginId: 'git-sync',
        pluginName: 'Git Sync',
        source: 'builtin',
        currentVersion: '1.0.0',
        newVersion: '2.0.0',
        changelog: 'New features',
        downloadUrl: 'https://example.com/plugins.zip',
        hash: 'abc123',
        archivePath: 'git-sync/',
        requiresAppUpdate: false,
        status: 'available'
      }
      expect(entry.source).toBe('builtin')
      expect(entry.status).toBe('available')
    })

    it('tracks download progress', () => {
      const entry: PluginUpdateEntry = {
        pluginId: 'git-sync',
        pluginName: 'Git Sync',
        source: 'builtin',
        currentVersion: '1.0.0',
        newVersion: '2.0.0',
        changelog: '',
        downloadUrl: 'https://example.com/plugins.zip',
        hash: 'abc123',
        status: 'downloading',
        progress: { downloaded: 500000, total: 1000000 }
      }
      expect(entry.progress!.downloaded).toBe(500000)
      expect(entry.progress!.total).toBe(1000000)
    })

    it('tracks error on failure', () => {
      const entry: PluginUpdateEntry = {
        pluginId: 'git-sync',
        pluginName: 'Git Sync',
        source: 'builtin',
        currentVersion: '1.0.0',
        newVersion: '2.0.0',
        changelog: '',
        downloadUrl: 'https://example.com/plugins.zip',
        hash: 'abc123',
        status: 'failed',
        error: 'Hash mismatch'
      }
      expect(entry.status).toBe('failed')
      expect(entry.error).toBe('Hash mismatch')
    })
  })
})
