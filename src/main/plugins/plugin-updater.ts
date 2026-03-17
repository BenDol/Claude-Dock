import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'
import { app, dialog, BrowserWindow } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import { fetchJSON, downloadFile, extractHostname } from '../http-utils'
import { log, logError } from '../logger'
import { PluginManager } from './plugin-manager'
import { getServiceEntry } from './plugin-service-registry'
import { trustPlugin } from './plugin-loader'
import {
  getLastChecked,
  setLastChecked,
  getDismissedVersions,
  dismissVersion as dismissVersionInStore,
  getVerifiedHosts,
  setVerifiedHosts,
  getOverrides,
  setOverride,
  removeOverride,
  type PluginOverrideEntry
} from './plugin-update-store'
import type {
  PluginUpdateManifest,
  PluginUpdateEntry,
  ExternalUpdateManifest,
  PluginUpdateStatus
} from '../../shared/plugin-update-types'
import type { PluginManifest } from '../../shared/plugin-manifest'

declare const __BUILD_SHA__: string
declare const __DEV__: boolean
declare const __PLUGIN_BUILD_SHAS__: Record<string, string>

const GITHUB_REPO = 'BenDol/Claude-Dock'
const VERIFIED_UPDATERS_URL = `https://raw.githubusercontent.com/${GITHUB_REPO}/main/verified-updaters.json`
const VERIFIED_HOSTS_TTL = 24 * 60 * 60 * 1000 // 24 hours

/**
 * In dev mode, read from local dev/ directory instead of fetching from GitHub.
 * This allows testing the full update pipeline without a published release.
 */
function getDevDir(): string | null {
  if (typeof __DEV__ === 'undefined' || !__DEV__) return null
  // electron-vite dev: app root is CWD
  const devDir = path.join(process.cwd(), 'dev')
  return fs.existsSync(devDir) ? devDir : null
}

function parseVersion(v: string): number[] | null {
  const m = v.match(/(\d+)\.(\d+)\.(\d+)/)
  if (!m) return null
  return [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])]
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return 0
}

function isNewerVersion(current: string, remote: string): boolean {
  const a = parseVersion(current)
  const b = parseVersion(remote)
  if (!a || !b) return false
  return compareVersions(b, a) > 0
}

function hashDirectory(dirPath: string): string {
  const hash = crypto.createHash('sha256')
  const entries = fs.readdirSync(dirPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name)
    if (entry.isFile()) {
      hash.update(entry.name)
      hash.update(fs.readFileSync(fullPath))
    } else if (entry.isDirectory()) {
      hash.update(entry.name)
      hash.update(hashDirectory(fullPath))
    }
  }
  return hash.digest('hex')
}

function hashFile(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

export class PluginUpdateService {
  private static instance: PluginUpdateService
  private updates = new Map<string, PluginUpdateEntry>()
  private pluginsZipPath: string | null = null
  private checkInProgress: Promise<PluginUpdateEntry[]> | null = null

  static getInstance(): PluginUpdateService {
    if (!PluginUpdateService.instance) {
      PluginUpdateService.instance = new PluginUpdateService()
    }
    return PluginUpdateService.instance
  }

  // --- Public API ---

  async checkForUpdates(profile?: string): Promise<PluginUpdateEntry[]> {
    // If a check is already running, return that promise instead of starting another
    if (this.checkInProgress) {
      log('[plugin-updater] check already in progress, waiting...')
      return this.checkInProgress
    }

    this.checkInProgress = this.doCheck(profile)
    try {
      return await this.checkInProgress
    } finally {
      this.checkInProgress = null
    }
  }

  private async doCheck(profile?: string): Promise<PluginUpdateEntry[]> {
    log('[plugin-updater] checking for updates...')
    this.updates.clear()

    try {
      await this.checkBuiltinPlugins(profile || 'latest')
    } catch (err) {
      logError('[plugin-updater] built-in plugin check failed:', err)
    }

    try {
      await this.checkExternalPlugins()
    } catch (err) {
      logError('[plugin-updater] external plugin check failed:', err)
    }

    setLastChecked(Date.now())
    const results = Array.from(this.updates.values())
    log(`[plugin-updater] found ${results.length} update(s)`)
    return results
  }

  getAvailableUpdates(): PluginUpdateEntry[] {
    return Array.from(this.updates.values())
  }

  async installUpdate(pluginId: string): Promise<void> {
    const entry = this.updates.get(pluginId)
    if (!entry) throw new Error(`No update found for plugin: ${pluginId}`)
    if (entry.status === 'installed') return

    try {
      this.setStatus(pluginId, 'downloading')

      if (entry.source === 'builtin') {
        await this.installBuiltinUpdate(entry)
        // Hot-reload the plugin without requiring app restart
        this.hotReloadPlugin(pluginId)
      } else {
        await this.installExternalUpdate(entry)
      }

      this.setStatus(pluginId, 'installed')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      entry.error = msg
      this.setStatus(pluginId, 'failed')
      throw err
    }
  }

  async installAll(): Promise<{ success: string[]; failed: { pluginId: string; error: string }[] }> {
    const success: string[] = []
    const failed: { pluginId: string; error: string }[] = []

    const installable = Array.from(this.updates.values()).filter(
      (e) => e.status === 'available' && !e.requiresAppUpdate
    )

    for (const entry of installable) {
      try {
        await this.installUpdate(entry.pluginId)
        success.push(entry.pluginId)
      } catch (err) {
        failed.push({
          pluginId: entry.pluginId,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }

    return { success, failed }
  }

  dismissUpdate(pluginId: string, version: string): void {
    dismissVersionInStore(pluginId, version)
    this.updates.delete(pluginId)
    this.broadcastState()
  }

  // --- Built-in plugin checking ---

  private async checkBuiltinPlugins(profile: string): Promise<void> {
    let manifest: PluginUpdateManifest

    // In dev mode, read from local dev/plugins.update file
    const devDir = getDevDir()
    if (devDir) {
      const localManifest = path.join(devDir, 'plugins.update')
      if (fs.existsSync(localManifest)) {
        try {
          manifest = JSON.parse(fs.readFileSync(localManifest, 'utf-8'))
          log(`[plugin-updater] DEV: loaded manifest from ${localManifest}`)
        } catch (err) {
          log(`[plugin-updater] DEV: failed to read local manifest: ${err}`)
          return
        }
      } else {
        log('[plugin-updater] DEV: no dev/plugins.update file found')
        return
      }
    } else {
      const releaseTag = profile === 'bleeding-edge' ? 'bleeding-edge' : 'latest'
      // Cache-bust to avoid stale CDN responses after a fresh release upload
      const manifestUrl = `https://github.com/${GITHUB_REPO}/releases/download/${releaseTag}/plugins.update?_=${Date.now()}`

      try {
        manifest = await fetchJSON<PluginUpdateManifest>(manifestUrl)
      } catch {
        log('[plugin-updater] no plugins.update manifest available yet')
        return
      }
    }

    const pluginInfoList = PluginManager.getInstance().getPluginInfoList()
    const dismissed = getDismissedVersions()
    const installedOverrides = getOverrides()
    const currentAppVersion = app.getVersion()

    for (const info of pluginInfoList) {
      if (info.source !== 'builtin') continue

      const entry = manifest.plugins[info.id]
      if (!entry) continue

      // Skip if user dismissed this version
      if (dismissed[info.id] === entry.version) continue

      // Skip if this exact version is already installed as an override
      const installedOverride = installedOverrides[info.id]
      if (installedOverride && installedOverride.hash === entry.hash) continue

      // Skip if minAppVersion exceeds current app version
      if (entry.minAppVersion) {
        if (!isNewerVersion(entry.minAppVersion, currentAppVersion) && entry.minAppVersion !== currentAppVersion) {
          // Current app is older than required
          const reqVer = parseVersion(entry.minAppVersion)
          const curVer = parseVersion(currentAppVersion)
          if (reqVer && curVer && compareVersions(reqVer, curVer) > 0) continue
        }
      }

      // Determine if the plugin has changed.
      // - For bleeding-edge: compare per-plugin build SHAs (only changes when
      //   that plugin's source directory is modified, not on every repo commit)
      // - For latest: check if version is newer, OR if version matches but
      //   the content hash differs (hotfix to same version)
      const localPluginSha = __PLUGIN_BUILD_SHAS__?.[info.id]
      let hasUpdate: boolean
      if (profile === 'bleeding-edge') {
        hasUpdate = !!localPluginSha && entry.buildSha !== localPluginSha
      } else {
        const newerVersion = isNewerVersion(info.version, entry.version)
        const sameVersionDifferentHash = info.version === entry.version
          && !!localPluginSha && entry.buildSha !== localPluginSha
        hasUpdate = newerVersion || sameVersionDifferentHash
      }

      if (!hasUpdate) continue

      // In dev mode, use local plugins.zip; in production, use GitHub release
      let downloadUrl: string
      if (devDir) {
        const localZip = path.join(devDir, 'plugins.zip')
        downloadUrl = `file://${localZip.replace(/\\/g, '/')}`
      } else {
        const releaseTag = profile === 'bleeding-edge' ? 'bleeding-edge' : 'latest'
        downloadUrl = `https://github.com/${GITHUB_REPO}/releases/download/${releaseTag}/plugins.zip`
      }

      this.updates.set(info.id, {
        pluginId: info.id,
        pluginName: info.name,
        source: 'builtin',
        currentVersion: info.version,
        newVersion: entry.version,
        changelog: entry.changelog || '',
        downloadUrl,
        hash: entry.hash,
        archivePath: entry.archivePath,
        requiresAppUpdate: entry.requiresAppUpdate,
        status: 'available'
      })
    }
  }

  // --- External plugin checking ---

  private async checkExternalPlugins(): Promise<void> {
    const pluginInfoList = PluginManager.getInstance().getPluginInfoList()
    const dismissed = getDismissedVersions()
    const plugins = (PluginManager.getInstance() as any).plugins as any[]

    for (const plugin of plugins) {
      const manifest = (plugin as any).manifest as PluginManifest | undefined
      if (!manifest?.updateUrl) continue

      // Validate host against allowlist
      const hostname = extractHostname(manifest.updateUrl)
      if (!hostname) continue

      const allowed = await this.isHostVerified(hostname)
      if (!allowed) {
        log(`[plugin-updater] skipping external update for ${plugin.id}: host ${hostname} not verified`)
        continue
      }

      try {
        const updateManifest = await fetchJSON<ExternalUpdateManifest>(manifest.updateUrl)

        if (dismissed[plugin.id] === updateManifest.version) continue
        if (!isNewerVersion(manifest.version, updateManifest.version)) continue

        // Validate download URL host too
        const dlHostname = extractHostname(updateManifest.downloadUrl)
        if (!dlHostname || !(await this.isHostVerified(dlHostname))) {
          log(`[plugin-updater] skipping external update for ${plugin.id}: download host not verified`)
          continue
        }

        const info = pluginInfoList.find((p) => p.id === plugin.id)
        this.updates.set(plugin.id, {
          pluginId: plugin.id,
          pluginName: info?.name || plugin.name,
          source: 'external',
          currentVersion: manifest.version,
          newVersion: updateManifest.version,
          changelog: updateManifest.changelog || '',
          downloadUrl: updateManifest.downloadUrl,
          hash: updateManifest.hash,
          status: 'available'
        })
      } catch (err) {
        log(`[plugin-updater] failed to check external update for ${plugin.id}: ${err}`)
      }
    }
  }

  // --- Verified hosts ---

  private async isHostVerified(hostname: string): Promise<boolean> {
    const { hosts, fetchedAt } = getVerifiedHosts()
    const isStale = Date.now() - fetchedAt > VERIFIED_HOSTS_TTL

    if (!isStale && hosts.length > 0) {
      return hosts.includes(hostname)
    }

    // Fetch fresh allowlist
    try {
      const data = await fetchJSON<{ schemaVersion: number; allowedHosts: string[] }>(VERIFIED_UPDATERS_URL)
      if (data.allowedHosts && Array.isArray(data.allowedHosts)) {
        setVerifiedHosts(data.allowedHosts)
        return data.allowedHosts.includes(hostname)
      }
    } catch (err) {
      log(`[plugin-updater] failed to fetch verified-updaters: ${err}`)
    }

    // Fall back to cached if available, otherwise fail-closed
    if (hosts.length > 0) {
      return hosts.includes(hostname)
    }
    return false
  }

  // --- Install built-in ---

  private async installBuiltinUpdate(entry: PluginUpdateEntry): Promise<void> {
    if (entry.requiresAppUpdate) {
      throw new Error('This update requires a full app update')
    }

    // Download plugins.zip if not already cached
    if (!this.pluginsZipPath || !fs.existsSync(this.pluginsZipPath)) {
      if (entry.downloadUrl.startsWith('file://')) {
        // Dev mode: copy local zip instead of downloading
        const localPath = entry.downloadUrl.replace('file://', '').replace(/\//g, path.sep)
        if (!fs.existsSync(localPath)) {
          throw new Error(`DEV: local plugins.zip not found at ${localPath}`)
        }
        const tmpDir = path.join(os.tmpdir(), 'claude-dock-plugin-updates')
        fs.mkdirSync(tmpDir, { recursive: true })
        this.pluginsZipPath = path.join(tmpDir, 'plugins.zip')
        fs.copyFileSync(localPath, this.pluginsZipPath)
        log(`[plugin-updater] DEV: using local zip from ${localPath}`)
      } else {
        this.pluginsZipPath = await downloadFile(
          entry.downloadUrl,
          'plugins.zip',
          (downloaded, total) => {
            entry.progress = { downloaded, total }
            this.broadcastProgress(entry.pluginId, downloaded, total)
          }
        )
      }
    }

    this.setStatus(entry.pluginId, 'installing')

    // Extract using Node's built-in zip support (or use adm-zip if available)
    const overrideDir = this.getOverrideDir(entry.pluginId)
    fs.mkdirSync(overrideDir, { recursive: true })

    // Use tar/unzip via child_process for cross-platform zip extraction
    await this.extractFromZip(this.pluginsZipPath, entry.archivePath || entry.pluginId, overrideDir)

    // Verify hash
    const actualHash = hashDirectory(overrideDir)
    if (actualHash !== entry.hash) {
      // Clean up on hash mismatch
      fs.rmSync(overrideDir, { recursive: true, force: true })
      throw new Error(`Hash mismatch for ${entry.pluginId}: expected ${entry.hash}, got ${actualHash}`)
    }

    // Write meta.json
    const meta: PluginOverrideEntry = {
      version: entry.newVersion,
      buildSha: entry.hash,
      hash: actualHash,
      installedAt: Date.now()
    }
    fs.writeFileSync(path.join(overrideDir, 'meta.json'), JSON.stringify(meta, null, 2))
    setOverride(entry.pluginId, meta)
  }

  // --- Install external ---

  private async installExternalUpdate(entry: PluginUpdateEntry): Promise<void> {
    // Show native consent dialog
    const { response } = await dialog.showMessageBox({
      type: 'question',
      title: 'Plugin Update',
      message: `Update "${entry.pluginName}" from ${entry.currentVersion} to ${entry.newVersion}?`,
      detail: `Download from: ${extractHostname(entry.downloadUrl)}\n\nThis will replace the current plugin files.`,
      buttons: ['Update', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    })

    if (response !== 0) {
      this.setStatus(entry.pluginId, 'available')
      return
    }

    // Download zip
    const zipPath = await downloadFile(
      entry.downloadUrl,
      `${entry.pluginId}-update.zip`,
      (downloaded, total) => {
        entry.progress = { downloaded, total }
        this.broadcastProgress(entry.pluginId, downloaded, total)
      }
    )

    // Verify hash of downloaded file
    const fileHash = hashFile(zipPath)
    if (fileHash !== entry.hash) {
      fs.unlinkSync(zipPath)
      throw new Error(`Hash mismatch: expected ${entry.hash}, got ${fileHash}`)
    }

    this.setStatus(entry.pluginId, 'installing')

    // Extract to temp dir and validate
    const tempDir = path.join(os.tmpdir(), 'claude-dock-plugin-updates', `${entry.pluginId}-temp`)
    fs.mkdirSync(tempDir, { recursive: true })
    await this.extractZip(zipPath, tempDir)
    fs.unlinkSync(zipPath)

    // Find and validate plugin.json
    const manifestPath = this.findPluginManifest(tempDir)
    if (!manifestPath) {
      fs.rmSync(tempDir, { recursive: true, force: true })
      throw new Error('No plugin.json found in update package')
    }

    const manifestDir = path.dirname(manifestPath)
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))

    // Verify ID matches
    if (manifest.id !== entry.pluginId) {
      fs.rmSync(tempDir, { recursive: true, force: true })
      throw new Error(`Plugin ID mismatch: expected ${entry.pluginId}, got ${manifest.id}`)
    }

    // Backup existing plugin dir
    const pluginsDir = path.join(app.getPath('userData'), 'plugins')
    const pluginDir = path.join(pluginsDir, entry.pluginId)
    const backupDir = `${pluginDir}.backup.${Date.now()}`

    if (fs.existsSync(pluginDir)) {
      fs.renameSync(pluginDir, backupDir)
    }

    try {
      // Move new files into place
      if (manifestDir !== tempDir) {
        // The plugin content is in a subdirectory
        fs.renameSync(manifestDir, pluginDir)
      } else {
        fs.renameSync(tempDir, pluginDir)
      }

      // Update trust store with new manifest hash
      const rawManifest = fs.readFileSync(path.join(pluginDir, 'plugin.json'), 'utf-8')
      const newHash = crypto.createHash('sha256').update(rawManifest).digest('hex')
      trustPlugin(entry.pluginId, newHash)

      // Clean up backup
      if (fs.existsSync(backupDir)) {
        fs.rmSync(backupDir, { recursive: true, force: true })
      }
    } catch (err) {
      // Restore from backup on failure
      if (fs.existsSync(backupDir)) {
        if (fs.existsSync(pluginDir)) {
          fs.rmSync(pluginDir, { recursive: true, force: true })
        }
        fs.renameSync(backupDir, pluginDir)
      }
      throw err
    }

    // Clean up temp dir
    fs.rmSync(tempDir, { recursive: true, force: true })
  }

  // --- Hot-reload ---

  /**
   * Hot-reload a built-in plugin from its override directory.
   * Loads the new module, injects services if needed, and swaps it into
   * the PluginManager — no app restart required.
   */
  private hotReloadPlugin(pluginId: string): void {
    const overrideDir = this.getOverrideDir(pluginId)
    const mainPath = path.join(overrideDir, 'index.js')

    if (!fs.existsSync(mainPath)) {
      log(`[plugin-updater] hot-reload skipped for ${pluginId}: no index.js in override`)
      return
    }

    try {
      // Clear Node's require cache for the old module so it re-evaluates
      const resolved = require.resolve(mainPath)
      delete require.cache[resolved]

      // Load the new module
      const mod = require(mainPath)
      let newPlugin: import('./plugin').DockPlugin | null = null
      for (const exp of Object.values(mod)) {
        if (typeof exp === 'function' && (exp as any).prototype?.register) {
          newPlugin = new (exp as new () => import('./plugin').DockPlugin)()
          break
        }
      }

      if (!newPlugin) {
        log(`[plugin-updater] hot-reload failed for ${pluginId}: no DockPlugin export found`)
        return
      }

      // Inject services for plugins that need them
      const serviceEntry = getServiceEntry(pluginId)
      if (serviceEntry && typeof mod.setServices === 'function') {
        mod.setServices(serviceEntry.factory())
      }

      // Swap the plugin in the manager (dispose old, register new)
      PluginManager.getInstance().reload(pluginId, newPlugin)
      log(`[plugin-updater] hot-reloaded ${pluginId} successfully`)
    } catch (err) {
      logError(`[plugin-updater] hot-reload failed for ${pluginId}, rolling back override:`, err)
      // Roll back: remove the broken override so it doesn't persist across restarts.
      // The bundled plugin continues to work; the update can be retried later.
      try {
        fs.rmSync(overrideDir, { recursive: true, force: true })
        removeOverride(pluginId)
      } catch { /* best effort */ }
    }
  }

  // --- Helpers ---

  private getOverrideDir(pluginId: string): string {
    return path.join(app.getPath('userData'), 'plugin-overrides', pluginId)
  }

  private async extractFromZip(zipPath: string, archivePath: string, destDir: string): Promise<void> {
    // Use PowerShell on Windows, unzip on Unix
    const { execFile } = await import('child_process')

    return new Promise((resolve, reject) => {
      if (process.platform === 'win32') {
        // Extract entire zip to temp dir, then copy the specific archivePath
        const tempExtract = path.join(os.tmpdir(), 'claude-dock-plugin-updates', 'zip-extract')
        fs.mkdirSync(tempExtract, { recursive: true })

        const psCmd = `Expand-Archive -Path '${zipPath}' -DestinationPath '${tempExtract}' -Force`
        execFile('powershell', ['-NoProfile', '-Command', psCmd], (err) => {
          if (err) return reject(new Error(`Zip extraction failed: ${err.message}`))

          const sourcePath = path.join(tempExtract, archivePath)
          if (!fs.existsSync(sourcePath)) {
            return reject(new Error(`Archive path not found in zip: ${archivePath}`))
          }

          // Copy contents to destination
          this.copyDirContents(sourcePath, destDir)
          fs.rmSync(tempExtract, { recursive: true, force: true })
          resolve()
        })
      } else {
        execFile('unzip', ['-o', zipPath, `${archivePath}*`, '-d', destDir], (err) => {
          if (err) return reject(new Error(`Zip extraction failed: ${err.message}`))
          // Move contents up if extracted into a subdirectory
          const extracted = path.join(destDir, archivePath)
          if (fs.existsSync(extracted) && extracted !== destDir) {
            this.copyDirContents(extracted, destDir)
            fs.rmSync(extracted, { recursive: true, force: true })
          }
          resolve()
        })
      }
    })
  }

  private async extractZip(zipPath: string, destDir: string): Promise<void> {
    const { execFile } = await import('child_process')

    return new Promise((resolve, reject) => {
      if (process.platform === 'win32') {
        const psCmd = `Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force`
        execFile('powershell', ['-NoProfile', '-Command', psCmd], (err) => {
          if (err) return reject(new Error(`Zip extraction failed: ${err.message}`))
          resolve()
        })
      } else {
        execFile('unzip', ['-o', zipPath, '-d', destDir], (err) => {
          if (err) return reject(new Error(`Zip extraction failed: ${err.message}`))
          resolve()
        })
      }
    })
  }

  private findPluginManifest(dir: string): string | null {
    const direct = path.join(dir, 'plugin.json')
    if (fs.existsSync(direct)) return direct

    // Check one level of subdirectories
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const nested = path.join(dir, entry.name, 'plugin.json')
        if (fs.existsSync(nested)) return nested
      }
    } catch { /* ignore */ }

    return null
  }

  private copyDirContents(src: string, dest: string): void {
    fs.mkdirSync(dest, { recursive: true })
    const entries = fs.readdirSync(src, { withFileTypes: true })
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name)
      const destPath = path.join(dest, entry.name)
      if (entry.isDirectory()) {
        this.copyDirContents(srcPath, destPath)
      } else {
        fs.copyFileSync(srcPath, destPath)
      }
    }
  }

  private setStatus(pluginId: string, status: PluginUpdateStatus): void {
    const entry = this.updates.get(pluginId)
    if (entry) {
      entry.status = status
      this.broadcastState()
    }
  }

  private broadcastProgress(pluginId: string, downloaded: number, total: number): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC.PLUGIN_UPDATE_PROGRESS, pluginId, downloaded, total)
      }
    }
  }

  private broadcastState(): void {
    const updates = this.getAvailableUpdates()
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC.PLUGIN_UPDATE_STATE_CHANGED, updates)
      }
    }
  }
}
