/**
 * Reads per-project test runner configuration from .claude/test-runner.json.
 *
 * This file is committable to git so team members share the same test config.
 * Settings here override the plugin settings from the dock settings UI.
 *
 * Example .claude/test-runner.json:
 * {
 *   "junit-maven": {
 *     "profiles": "test,integration",
 *     "extraArgs": "-pl service-module -DskipITs=false",
 *     "env": { "SPRING_PROFILES_ACTIVE": "test" }
 *   },
 *   "junit-gradle": {
 *     "extraArgs": "--info",
 *     "env": {}
 *   },
 *   "vitest": {
 *     "extraArgs": "--pool=forks",
 *     "env": {}
 *   }
 * }
 */

import * as fs from 'fs'
import * as path from 'path'

export interface AdapterProjectConfig {
  profiles?: string       // comma-separated Maven profiles
  extraArgs?: string      // extra CLI arguments
  env?: Record<string, string> // extra environment variables
}

export interface TestRunnerProjectConfig {
  [adapterId: string]: AdapterProjectConfig
}

const CONFIG_FILE = 'test-runner.json'
const CLAUDE_DIR = '.claude'

/** Cache to avoid re-reading on every command */
const configCache = new Map<string, { config: TestRunnerProjectConfig; mtime: number }>()

/**
 * Read the project-level test runner config.
 * Returns cached version if the file hasn't changed.
 */
export function readProjectConfig(projectDir: string): TestRunnerProjectConfig {
  const filePath = path.join(projectDir, CLAUDE_DIR, CONFIG_FILE)
  try {
    if (!fs.existsSync(filePath)) return {}
    const stat = fs.statSync(filePath)
    const cached = configCache.get(projectDir)
    if (cached && cached.mtime === stat.mtimeMs) return cached.config
    const raw = fs.readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    configCache.set(projectDir, { config: parsed, mtime: stat.mtimeMs })
    return parsed
  } catch {
    return {}
  }
}

/** Get config for a specific adapter, merging project config with plugin settings */
export function getAdapterConfig(
  projectDir: string,
  adapterId: string,
  pluginSettings?: Record<string, unknown>
): AdapterProjectConfig {
  const projectConfig = readProjectConfig(projectDir)
  const adapterConfig = projectConfig[adapterId] || {}

  // Plugin settings can provide defaults that project config overrides
  const merged: AdapterProjectConfig = {}

  // Profiles: project config takes precedence, fallback to plugin setting
  if (adapterConfig.profiles) {
    merged.profiles = adapterConfig.profiles
  } else if (adapterId.startsWith('junit-maven') && pluginSettings?.mavenProfiles) {
    merged.profiles = String(pluginSettings.mavenProfiles)
  }

  // Extra args: project config takes precedence, fallback to plugin setting
  if (adapterConfig.extraArgs) {
    merged.extraArgs = adapterConfig.extraArgs
  } else {
    const key = adapterId === 'vitest' ? 'vitestExtraArgs'
      : adapterId.includes('maven') ? 'mavenExtraArgs'
      : adapterId.includes('gradle') ? 'gradleExtraArgs'
      : undefined
    if (key && pluginSettings?.[key]) {
      merged.extraArgs = String(pluginSettings[key])
    }
  }

  // Env: project config only (not from plugin settings)
  if (adapterConfig.env) {
    merged.env = adapterConfig.env
  }

  return merged
}

/** Clear the config cache (e.g., when rescanning) */
export function clearConfigCache(projectDir?: string): void {
  if (projectDir) configCache.delete(projectDir)
  else configCache.clear()
}
