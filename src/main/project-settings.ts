/**
 * Project-level settings: reads dock.json and dock.local.json from the
 * project's .claude/ directory, and merges them with global settings.
 *
 * Merge order: DEFAULT_SETTINGS < global (electron-store) < dock.json < dock.local.json
 *
 * Array fields listed in CONCATENATED_ARRAY_PATHS are concatenated
 * (deduplicated) across all tiers instead of replaced.
 */

import * as fs from 'fs'
import * as path from 'path'
import type { Settings, ProjectSettings, SettingsOrigin } from '../shared/settings-schema'
import { CONCATENATED_ARRAY_PATHS, DEFAULT_SETTINGS } from '../shared/settings-schema'
import { getSettings } from './settings-store'
import { log, logError } from './logger'

const DOCK_JSON = 'dock.json'
const DOCK_LOCAL_JSON = 'dock.local.json'
const CLAUDE_DIR = '.claude'

function claudeDir(projectDir: string): string {
  return path.join(projectDir, CLAUDE_DIR)
}

// ── Read / Write ──────────────────────────────────────────────────────────

export function readProjectSettings(projectDir: string): ProjectSettings {
  return readJsonSafe(path.join(claudeDir(projectDir), DOCK_JSON))
}

export function readLocalProjectSettings(projectDir: string): ProjectSettings {
  return readJsonSafe(path.join(claudeDir(projectDir), DOCK_LOCAL_JSON))
}

export function writeProjectSettings(projectDir: string, settings: ProjectSettings): void {
  writeJson(path.join(claudeDir(projectDir), DOCK_JSON), settings)
}

export function writeLocalProjectSettings(projectDir: string, settings: ProjectSettings): void {
  writeJson(path.join(claudeDir(projectDir), DOCK_LOCAL_JSON), settings)
}

function readJsonSafe(filePath: string): ProjectSettings {
  try {
    if (!fs.existsSync(filePath)) return {}
    const raw = fs.readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return parsed
  } catch (err) {
    log(`[project-settings] failed to read ${filePath}: ${err instanceof Error ? err.message : err}`)
    return {}
  }
}

function writeJson(filePath: string, data: ProjectSettings): void {
  try {
    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n')
    log(`[project-settings] wrote ${filePath}`)
  } catch (err) {
    logError(`[project-settings] failed to write ${filePath}:`, err)
  }
}

// ── Merge ─────────────────────────────────────────────────────────────────

/**
 * Deep merge an overlay on top of a base object.
 * Objects are recursively merged; scalars and arrays from the overlay
 * replace the base value (arrays in CONCATENATED_ARRAY_PATHS are handled
 * separately after the merge).
 */
function deepMergeOverlay(base: Record<string, any>, overlay: Record<string, any>): Record<string, any> {
  const result = { ...base }
  for (const key of Object.keys(overlay)) {
    const ov = overlay[key]
    const bv = base[key]
    if (ov === undefined) continue
    if (ov !== null && typeof ov === 'object' && !Array.isArray(ov) &&
        bv !== null && typeof bv === 'object' && !Array.isArray(bv)) {
      result[key] = deepMergeOverlay(bv, ov)
    } else {
      result[key] = ov
    }
  }
  return result
}

/** Get a nested value by dot path (e.g. 'terminal.additionalDirs') */
function getNestedValue(obj: any, dotPath: string): any {
  const keys = dotPath.split('.')
  let cur = obj
  for (const k of keys) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = cur[k]
  }
  return cur
}

/** Set a nested value by dot path */
function setNestedValue(obj: any, dotPath: string, value: any): void {
  const keys = dotPath.split('.')
  let cur = obj
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur[keys[i]] == null || typeof cur[keys[i]] !== 'object') {
      cur[keys[i]] = {}
    }
    cur = cur[keys[i]]
  }
  cur[keys[keys.length - 1]] = value
}

/**
 * Three-tier merge: global settings → project dock.json → local dock.local.json.
 *
 * For most keys, the later tier wins (simple deep merge).
 * For paths in CONCATENATED_ARRAY_PATHS, arrays from all tiers are concatenated
 * and deduplicated.
 */
export function mergeSettingsTiers(
  global: Settings,
  project: ProjectSettings,
  local: ProjectSettings
): Settings {
  let result = deepMergeOverlay(global as any, project as any)
  result = deepMergeOverlay(result, local as any)

  // Handle concatenated arrays
  for (const dotPath of CONCATENATED_ARRAY_PATHS) {
    const globalArr = getNestedValue(global, dotPath)
    const projectArr = getNestedValue(project, dotPath)
    const localArr = getNestedValue(local, dotPath)
    const arrays = [globalArr, projectArr, localArr].filter(Array.isArray)
    if (arrays.length > 0) {
      const combined = [...new Set(arrays.flat())]
      setNestedValue(result, dotPath, combined)
    }
  }

  return result as Settings
}

/**
 * Get the fully merged settings for a project directory.
 * Falls back to global settings if no project files exist.
 */
export function getProjectMergedSettings(projectDir: string): Settings {
  const global = getSettings()
  if (!projectDir) return global
  const project = readProjectSettings(projectDir)
  const local = readLocalProjectSettings(projectDir)
  return mergeSettingsTiers(global, project, local)
}

// ── Origins (for UI indicators) ───────────────────────────────────────────

export type SettingsOriginMap = Record<string, SettingsOrigin>

/**
 * Build a flat map of dot-path → origin for each leaf key that has been
 * overridden at the project or local tier. Keys not in the map are 'global'
 * (or 'default' — the UI doesn't need to distinguish those).
 */
export function getSettingsOrigins(projectDir: string): SettingsOriginMap {
  const project = readProjectSettings(projectDir)
  const local = readLocalProjectSettings(projectDir)
  const origins: SettingsOriginMap = {}

  function walk(obj: Record<string, any>, prefix: string, origin: SettingsOrigin) {
    for (const key of Object.keys(obj)) {
      const fullKey = prefix ? `${prefix}.${key}` : key
      const val = obj[key]
      if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
        walk(val, fullKey, origin)
      } else {
        origins[fullKey] = origin
      }
    }
  }

  // Project keys first, then local overwrites
  walk(project as any, '', 'project')
  walk(local as any, '', 'local')

  return origins
}

/**
 * Remove a specific key from a project settings file.
 * The key is a dot path like 'terminal.fontSize'.
 */
// ── File Watcher ──────────────────────────────────────────────────────────

/**
 * Watches .claude/dock.json and dock.local.json for external edits
 * and calls the onChange callback with the re-merged settings.
 */
export class ProjectSettingsWatcher {
  private watcher: fs.FSWatcher | null = null
  private debounceTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private projectDir: string,
    private onChange: (merged: Settings) => void
  ) {}

  start(): void {
    const dir = claudeDir(this.projectDir)
    if (!fs.existsSync(dir)) return
    try {
      this.watcher = fs.watch(dir, (_, filename) => {
        if (filename !== DOCK_JSON && filename !== DOCK_LOCAL_JSON) return
        if (this.debounceTimer) clearTimeout(this.debounceTimer)
        this.debounceTimer = setTimeout(() => {
          log(`[project-settings] file changed: ${filename} in ${this.projectDir}`)
          this.onChange(getProjectMergedSettings(this.projectDir))
        }, 500)
      })
    } catch (err) {
      log(`[project-settings] failed to watch ${dir}: ${err instanceof Error ? err.message : err}`)
    }
  }

  stop(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
    }
  }
}

export function removeProjectKey(projectDir: string, keyPath: string, tier: 'project' | 'local'): void {
  const read = tier === 'project' ? readProjectSettings : readLocalProjectSettings
  const write = tier === 'project' ? writeProjectSettings : writeLocalProjectSettings

  const settings = read(projectDir)
  const keys = keyPath.split('.')
  let cur: any = settings
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur[keys[i]] == null || typeof cur[keys[i]] !== 'object') return
    cur = cur[keys[i]]
  }
  delete cur[keys[keys.length - 1]]

  // Clean up empty parent objects
  const cleanEmpty = (obj: any, path: string[]): void => {
    if (path.length === 0) return
    let parent: any = obj
    for (let i = 0; i < path.length - 1; i++) parent = parent?.[path[i]]
    if (parent && typeof parent[path[path.length - 1]] === 'object' &&
        Object.keys(parent[path[path.length - 1]]).length === 0) {
      delete parent[path[path.length - 1]]
      cleanEmpty(obj, path.slice(0, -1))
    }
  }
  cleanEmpty(settings, keys.slice(0, -1))

  write(projectDir, settings)
}
