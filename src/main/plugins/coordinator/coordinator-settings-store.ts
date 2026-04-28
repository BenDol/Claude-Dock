/**
 * Global Coordinator plugin configuration (API keys, provider, hotkey).
 *
 * Not per-project: API keys and provider selection are user-level concerns
 * that should persist across workspaces. Only the enabled/disabled toggle
 * lives in plugin-store, matching the voice/memory pattern.
 */
import Store from 'electron-store'
import { CoordinatorConfig, DEFAULT_COORDINATOR_CONFIG } from '../../../shared/coordinator-types'
import { createSafeStore, safeRead, safeWriteSync } from '../../safe-store'
import { log, logError } from '../../logger'

let store: Store<CoordinatorConfig> | null = null

function getStore(): Store<CoordinatorConfig> {
  if (!store) {
    store = createSafeStore<CoordinatorConfig>({
      name: 'coordinator-plugin',
      defaults: DEFAULT_COORDINATOR_CONFIG
    })
  }
  return store
}

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

// Removed providers — old configs may still hold these; rewrite to a sane
// default on first read so the orchestrator's createProvider switch never
// sees an unknown id. Both removed paths were Claude-subscription-only;
// migrate to the API-key Anthropic provider with a known-good default model.
const REMOVED_PROVIDER_IDS = new Set(['claude-sdk', 'claude-cli'])
const SUBSCRIPTION_FALLBACK_PROVIDER = 'anthropic' as const
const SUBSCRIPTION_FALLBACK_MODEL = 'claude-haiku-4-5-20251001'

export function getCoordinatorConfig(): CoordinatorConfig {
  const stored = safeRead(() => getStore().store)
  if (!stored) return DEFAULT_COORDINATOR_CONFIG
  const merged = deepMergeDefaults(DEFAULT_COORDINATOR_CONFIG, stored) as CoordinatorConfig
  if (REMOVED_PROVIDER_IDS.has(merged.provider as string)) {
    const previous = merged.provider as string
    merged.provider = SUBSCRIPTION_FALLBACK_PROVIDER
    merged.model = SUBSCRIPTION_FALLBACK_MODEL
    merged.baseUrl = ''
    // We can't infer an API key from the old subscription path, so leave
    // apiKey untouched (likely empty). The first-run gate in the renderer
    // will surface settings so the user can paste one in.
    log(`[coordinator-settings] migrated removed provider ${previous} -> ${SUBSCRIPTION_FALLBACK_PROVIDER}`)
    safeWriteSync(() => getStore().set(merged as unknown as Record<string, unknown>))
  }
  return merged
}

export type DeepPartial<T> = T extends object
  ? { [K in keyof T]?: DeepPartial<T[K]> }
  : T

export function setCoordinatorConfig(
  patch: DeepPartial<CoordinatorConfig>
): CoordinatorConfig {
  const current = getCoordinatorConfig()
  const merged = deepMergeDefaults(current, patch) as CoordinatorConfig
  const ok = safeWriteSync(() => getStore().set(merged as unknown as Record<string, unknown>))
  if (!ok) {
    logError('[coordinator-settings] failed to persist patch', patch)
  } else {
    log('[coordinator-settings] patch applied', Object.keys(patch as Record<string, unknown>))
  }
  return merged
}

export function resetCoordinatorConfig(): CoordinatorConfig {
  safeWriteSync(() =>
    getStore().set(DEFAULT_COORDINATOR_CONFIG as unknown as Record<string, unknown>)
  )
  log('[coordinator-settings] reset to defaults')
  return DEFAULT_COORDINATOR_CONFIG
}

export function getCoordinatorStorePath(): string {
  return getStore().path
}

/** Test helper — drop the cached singleton. */
export function __resetCoordinatorStoreForTests(): void {
  store = null
}
