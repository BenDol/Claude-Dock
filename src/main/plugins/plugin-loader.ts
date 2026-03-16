import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { app, dialog } from 'electron'
import type { PluginManifest } from '../../shared/plugin-manifest'
import { RuntimePlugin } from './runtime-plugin'
import { createSafeStore, safeRead, safeWriteSync } from '../safe-store'
import { log, logError } from '../logger'
import type Store from 'electron-store'

// --- Trusted plugins store (global, persisted) ---

interface TrustedEntry {
  hash: string // SHA-256 of the plugin.json content at time of approval
}

interface TrustedPluginsData {
  // Maps plugin ID → trusted entry with manifest hash
  entries: Record<string, TrustedEntry>
}

let trustedStore: Store<TrustedPluginsData> | null = null

function getTrustedStore(): Store<TrustedPluginsData> {
  if (!trustedStore) {
    trustedStore = createSafeStore<TrustedPluginsData>({
      name: 'trusted-plugins',
      defaults: { entries: {} }
    })
  }
  return trustedStore
}

function hashManifest(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex')
}

/**
 * Checks if a plugin is trusted AND its manifest hasn't changed since approval.
 * If the manifest changes (update, tamper), re-prompt is required.
 */
function isTrusted(pluginId: string, manifestHash: string): boolean {
  const entries = safeRead(() => getTrustedStore().get('entries', {})) ?? {}
  const entry = entries[pluginId]
  return entry?.hash === manifestHash
}

export function trustPlugin(pluginId: string, manifestHash: string): void {
  const entries = safeRead(() => getTrustedStore().get('entries', {})) ?? {}
  entries[pluginId] = { hash: manifestHash }
  safeWriteSync(() => getTrustedStore().set('entries', entries))
}

// --- Plugin directory ---

/**
 * Returns the user-accessible plugins directory.
 * %APPDATA%/claude-dock/plugins/ on Windows.
 */
export function getPluginsDir(): string {
  return path.join(app.getPath('userData'), 'plugins')
}

// --- Validation ---

/** Pattern to detect script injection in SVG strings */
const DANGEROUS_SVG = /<script|on\w+\s*=|javascript\s*:|data\s*:\s*text\/html/i

function validateManifest(data: any, dir: string): data is PluginManifest {
  if (!data.id || typeof data.id !== 'string') {
    log(`[plugin-loader] invalid manifest in ${dir}: missing or invalid id`)
    return false
  }
  if (!data.name || typeof data.name !== 'string') {
    log(`[plugin-loader] invalid manifest in ${dir}: missing or invalid name`)
    return false
  }
  if (!data.version || typeof data.version !== 'string') {
    log(`[plugin-loader] invalid manifest in ${dir}: missing or invalid version`)
    return false
  }
  // Reject manifests with suspicious toolbar icon content
  if (data.toolbar?.icon && DANGEROUS_SVG.test(data.toolbar.icon)) {
    log(`[plugin-loader] BLOCKED ${dir}: toolbar icon contains potentially dangerous content`)
    return false
  }
  // Path traversal check: main and window.entry must resolve inside the plugin directory
  if (data.main && !isPathInsideDir(dir, data.main)) {
    log(`[plugin-loader] BLOCKED ${dir}: main path escapes plugin directory: ${data.main}`)
    return false
  }
  if (data.window?.entry && !isPathInsideDir(dir, data.window.entry)) {
    log(`[plugin-loader] BLOCKED ${dir}: window entry escapes plugin directory: ${data.window.entry}`)
    return false
  }
  return true
}

/**
 * Verifies that a relative path resolves inside the given directory.
 * Prevents path traversal attacks (e.g., "../../etc/passwd").
 */
function isPathInsideDir(dir: string, relativePath: string): boolean {
  const resolved = path.resolve(dir, relativePath)
  const normalizedDir = path.resolve(dir) + path.sep
  return resolved.startsWith(normalizedDir) || resolved === path.resolve(dir)
}

// --- Consent prompt ---

/**
 * Shows a blocking consent dialog for a new untrusted plugin.
 * Returns true if the user approves, false if denied.
 */
async function promptPluginConsent(manifest: PluginManifest, pluginDir: string): Promise<boolean> {
  const capabilities: string[] = []
  if (manifest.main) capabilities.push('Run code in the main process')
  if (manifest.toolbar) capabilities.push('Add a toolbar button')
  if (manifest.window) capabilities.push('Open its own window')

  const detail = [
    `Name: ${manifest.name}`,
    `Version: ${manifest.version}`,
    `ID: ${manifest.id}`,
    manifest.description ? `Description: ${manifest.description}` : '',
    `Location: ${pluginDir}`,
    '',
    capabilities.length > 0
      ? `This plugin will:\n  • ${capabilities.join('\n  • ')}`
      : 'This plugin has no special capabilities.',
    '',
    'Only allow plugins from sources you trust.'
  ].filter(Boolean).join('\n')

  const { response } = await dialog.showMessageBox({
    type: 'warning',
    title: 'New Plugin Detected',
    message: `Allow external plugin "${manifest.name}"?`,
    detail,
    buttons: ['Allow', 'Deny'],
    defaultId: 1,
    cancelId: 1,
    noLink: true
  })

  return response === 0
}

// --- Loader ---

/**
 * Scans the user plugins directory for plugin.json manifests,
 * validates them, prompts for consent on new plugins, and loads their modules.
 */
export async function loadRuntimePlugins(): Promise<RuntimePlugin[]> {
  const pluginsDir = getPluginsDir()
  const plugins: RuntimePlugin[] = []

  // Ensure plugins directory exists
  if (!fs.existsSync(pluginsDir)) {
    try {
      fs.mkdirSync(pluginsDir, { recursive: true })
      log(`[plugin-loader] created plugins directory: ${pluginsDir}`)
    } catch (err) {
      logError('[plugin-loader] failed to create plugins directory:', err)
      return plugins
    }
  }

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(pluginsDir, { withFileTypes: true })
  } catch (err) {
    logError('[plugin-loader] failed to read plugins directory:', err)
    return plugins
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    const pluginDir = path.join(pluginsDir, entry.name)
    const manifestPath = path.join(pluginDir, 'plugin.json')

    if (!fs.existsSync(manifestPath)) {
      log(`[plugin-loader] skipping ${entry.name}: no plugin.json`)
      continue
    }

    try {
      const raw = fs.readFileSync(manifestPath, 'utf-8')
      const manifest = JSON.parse(raw)

      if (!validateManifest(manifest, pluginDir)) continue

      // Set defaults for optional fields
      manifest.defaultEnabled = manifest.defaultEnabled ?? true
      manifest.description = manifest.description ?? ''

      // Consent gate: prompt for approval if this plugin hasn't been trusted
      // or if its manifest has changed since last approval (update / tamper)
      const manifestHash = hashManifest(raw)
      if (!isTrusted(manifest.id, manifestHash)) {
        log(`[plugin-loader] untrusted or modified plugin: ${manifest.id} — prompting for consent`)
        const allowed = await promptPluginConsent(manifest, pluginDir)
        if (!allowed) {
          log(`[plugin-loader] user denied plugin: ${manifest.id}`)
          manifest.defaultEnabled = false
          // Still register it (so it appears in settings as disabled) but skip loading its module
          plugins.push(new RuntimePlugin(manifest, pluginDir, null))
          continue
        }
        trustPlugin(manifest.id, manifestHash)
        log(`[plugin-loader] user approved plugin: ${manifest.id}`)
      }

      // Load main module if specified
      let mod: any = null
      if (manifest.main) {
        const mainPath = path.resolve(pluginDir, manifest.main)
        if (fs.existsSync(mainPath)) {
          try {
            mod = require(mainPath)
          } catch (err) {
            logError(`[plugin-loader] failed to load module for ${manifest.id}:`, err)
            continue
          }
        } else {
          log(`[plugin-loader] ${manifest.id}: main file not found: ${mainPath}`)
        }
      }

      plugins.push(new RuntimePlugin(manifest, pluginDir, mod))
      log(`[plugin-loader] loaded plugin: ${manifest.id} v${manifest.version}`)
    } catch (err) {
      logError(`[plugin-loader] failed to load plugin from ${pluginDir}:`, err)
    }
  }

  log(`[plugin-loader] loaded ${plugins.length} runtime plugin(s) from ${pluginsDir}`)
  return plugins
}
