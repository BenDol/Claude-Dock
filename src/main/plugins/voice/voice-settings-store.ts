/**
 * Centralized Voice plugin settings store (global, not per-project).
 *
 * Why global: hotkeys, transcriber backend, and microphone preferences are
 * user-level concerns that should persist across Dock workspaces. The
 * per-workspace plugin-store tracks only the enabled/disabled toggle.
 */
import Store from 'electron-store'
import { VoiceConfig, DEFAULT_VOICE_CONFIG } from '../../../shared/voice-types'
import { createSafeStore, safeRead, safeWriteSync } from '../../safe-store'
import { log, logError } from '../../logger'

let store: Store<VoiceConfig> | null = null

function getStore(): Store<VoiceConfig> {
  if (!store) {
    store = createSafeStore<VoiceConfig>({
      name: 'voice-plugin',
      defaults: DEFAULT_VOICE_CONFIG
    })
  }
  return store
}

/**
 * Deep merge stored settings onto defaults so newly introduced nested
 * keys always have a sensible value even when the persisted JSON
 * predates their introduction.
 */
function deepMergeDefaults(defaults: any, stored: any): any {
  if (stored === undefined || stored === null) return defaults
  if (Array.isArray(defaults) || Array.isArray(stored)) return stored
  if (typeof defaults !== 'object' || typeof stored !== 'object') return stored
  const result: Record<string, unknown> = { ...defaults }
  for (const key of Object.keys(stored)) {
    const sval = (stored as Record<string, unknown>)[key]
    const dval = (defaults as Record<string, unknown>)[key]
    if (sval === undefined) continue
    if (
      dval &&
      typeof dval === 'object' &&
      !Array.isArray(dval) &&
      sval &&
      typeof sval === 'object' &&
      !Array.isArray(sval)
    ) {
      result[key] = deepMergeDefaults(dval, sval)
    } else {
      result[key] = sval
    }
  }
  return result
}

export function getVoiceConfig(): VoiceConfig {
  const stored = safeRead(() => getStore().store)
  if (!stored) return DEFAULT_VOICE_CONFIG
  return deepMergeDefaults(DEFAULT_VOICE_CONFIG, stored) as VoiceConfig
}

export type DeepPartial<T> = T extends object
  ? { [K in keyof T]?: DeepPartial<T[K]> }
  : T

/**
 * Apply a deep-partial patch onto the current settings.
 * Scalars and arrays are replaced wholesale; nested objects are merged.
 */
export function setVoiceConfig(patch: DeepPartial<VoiceConfig>): VoiceConfig {
  const current = getVoiceConfig()
  const merged = deepMergeDefaults(current, patch) as VoiceConfig
  const ok = safeWriteSync(() => getStore().set(merged as unknown as Record<string, unknown>))
  if (!ok) {
    logError('[voice-settings] failed to persist patch', patch)
  } else {
    log('[voice-settings] patch applied', Object.keys(patch as Record<string, unknown>))
  }
  return merged
}

export function resetVoiceConfig(): VoiceConfig {
  safeWriteSync(() => getStore().set(DEFAULT_VOICE_CONFIG as unknown as Record<string, unknown>))
  log('[voice-settings] reset to defaults')
  return DEFAULT_VOICE_CONFIG
}

export function getVoiceStorePath(): string {
  return getStore().path
}

/** For tests only — drop the cached singleton so the next call re-reads disk. */
export function __resetVoiceStoreForTests(): void {
  store = null
}
