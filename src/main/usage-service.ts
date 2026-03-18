import { app, safeStorage } from 'electron'
import * as https from 'https'
import * as fs from 'fs'
import * as path from 'path'
import { createSafeStore } from './safe-store'
import { log } from './logger'

export interface UsageData {
  spent: number
  limit: number
  percentage: number
  lastUpdated: number
}

export interface UsageResult {
  success: boolean
  data?: UsageData
  error?: string
}

interface CredStore {
  apiKeyEncrypted?: string
}

const MIN_FETCH_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes

let _store: ReturnType<typeof createSafeStore<CredStore>> | null = null
function credStore() {
  if (!_store) {
    _store = createSafeStore<CredStore>({ name: 'usage-credentials' })
  }
  return _store
}

function encryptValue(value: string): string {
  if (!safeStorage.isEncryptionAvailable()) return value
  return safeStorage.encryptString(value).toString('base64')
}

function decryptValue(blob: string): string {
  if (!safeStorage.isEncryptionAvailable()) return blob
  try {
    return safeStorage.decryptString(Buffer.from(blob, 'base64'))
  } catch {
    return blob
  }
}

let cachedResult: UsageResult | null = null
let lastFetchTime = 0
let unauthorizedLogged = false

export function setKey(key: string): { success: boolean } {
  try {
    credStore().set('apiKeyEncrypted', encryptValue(key))
    // Reset state so next fetch uses the new key
    cachedResult = null
    lastFetchTime = 0
    unauthorizedLogged = false
    return { success: true }
  } catch (err) {
    log(`usage-service: setKey failed: ${err}`)
    return { success: false }
  }
}

export function getKey(): string | null {
  // 1. Check encrypted credential store first
  try {
    const blob = credStore().get('apiKeyEncrypted')
    if (blob) return decryptValue(blob)
  } catch { /* fall through */ }

  // 2. Fall back to environment variable
  const envKey = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_ADMIN_KEY
  if (envKey) return envKey

  return null
}

export function hasKey(): boolean {
  return !!getKey()
}

export function clearKey(): { success: boolean } {
  try {
    credStore().delete('apiKeyEncrypted' as any)
    cachedResult = null
    lastFetchTime = 0
    unauthorizedLogged = false
    return { success: true }
  } catch (err) {
    log(`usage-service: clearKey failed: ${err}`)
    return { success: false }
  }
}

export function getCached(): UsageResult | null {
  return cachedResult
}

export async function fetchUsage(spendLimit: number): Promise<UsageResult> {
  const now = Date.now()
  if (cachedResult && now - lastFetchTime < MIN_FETCH_INTERVAL_MS) {
    return cachedResult
  }

  // Try admin key first (accurate live data), fall back to local stats
  const apiKey = getKey()
  if (apiKey?.startsWith('sk-ant-admin')) {
    try {
      const result = await fetchWithAdminKey(apiKey, spendLimit, now)
      if (result.success) return result
    } catch (err) {
      log(`[usage-service] admin API failed, falling back to local stats: ${err}`)
    }
  }

  // Primary path: estimate from local Claude Code stats
  return fetchFromLocalStats(spendLimit, now)
}

// --- Anthropic pricing per 1M tokens (USD) ---
const MODEL_PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  // Opus 4.6
  'claude-opus-4-6':            { input: 15, output: 75, cacheRead: 1.5,  cacheWrite: 18.75 },
  // Opus 4.5
  'claude-opus-4-5':            { input: 15, output: 75, cacheRead: 1.5,  cacheWrite: 18.75 },
  // Sonnet 4.6
  'claude-sonnet-4-6':          { input: 3,  output: 15, cacheRead: 0.3,  cacheWrite: 3.75 },
  // Sonnet 4.5
  'claude-sonnet-4-5':          { input: 3,  output: 15, cacheRead: 0.3,  cacheWrite: 3.75 },
  // Haiku 4.5
  'claude-haiku-4-5':           { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  // Sonnet 3.5 / 3.6
  'claude-3-5-sonnet':          { input: 3,  output: 15, cacheRead: 0.3,  cacheWrite: 3.75 },
  'claude-3-6-sonnet':          { input: 3,  output: 15, cacheRead: 0.3,  cacheWrite: 3.75 },
  // Opus 3
  'claude-3-opus':              { input: 15, output: 75, cacheRead: 1.5,  cacheWrite: 18.75 },
  // Haiku 3.5
  'claude-3-5-haiku':           { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
}

function findPricing(modelId: string): { input: number; output: number; cacheRead: number; cacheWrite: number } {
  // Exact match first
  if (MODEL_PRICING[modelId]) return MODEL_PRICING[modelId]
  // Prefix match (e.g. "claude-opus-4-6" matches "claude-opus-4-6-20260101")
  for (const [prefix, pricing] of Object.entries(MODEL_PRICING)) {
    if (modelId.startsWith(prefix)) return pricing
  }
  // Guess from model name
  if (modelId.includes('opus')) return MODEL_PRICING['claude-opus-4-6']
  if (modelId.includes('haiku')) return MODEL_PRICING['claude-haiku-4-5']
  // Default to sonnet pricing
  return MODEL_PRICING['claude-sonnet-4-6']
}

/**
 * Read ~/.claude/stats-cache.json and estimate cost from token counts.
 */
function fetchFromLocalStats(spendLimit: number, now: number): UsageResult {
  try {
    const home = process.env.USERPROFILE || process.env.HOME || app.getPath('home')
    const statsPath = path.join(home, '.claude', 'stats-cache.json')

    if (!fs.existsSync(statsPath)) {
      log('[usage-service] stats-cache.json not found')
      return { success: false, error: 'no_stats' }
    }

    const stats = JSON.parse(fs.readFileSync(statsPath, 'utf8'))
    const modelUsage = stats.modelUsage as Record<string, {
      inputTokens?: number
      outputTokens?: number
      cacheReadInputTokens?: number
      cacheCreationInputTokens?: number
    }> | undefined

    if (!modelUsage || Object.keys(modelUsage).length === 0) {
      log('[usage-service] no model usage data in stats-cache.json')
      return { success: false, error: 'no_stats' }
    }

    let totalCostEstimate = 0
    for (const [model, usage] of Object.entries(modelUsage)) {
      const pricing = findPricing(model)
      const inputCost = ((usage.inputTokens ?? 0) / 1_000_000) * pricing.input
      const outputCost = ((usage.outputTokens ?? 0) / 1_000_000) * pricing.output
      const cacheReadCost = ((usage.cacheReadInputTokens ?? 0) / 1_000_000) * pricing.cacheRead
      const cacheWriteCost = ((usage.cacheCreationInputTokens ?? 0) / 1_000_000) * pricing.cacheWrite
      totalCostEstimate += inputCost + outputCost + cacheReadCost + cacheWriteCost
    }

    const percentage = spendLimit > 0 ? Math.min((totalCostEstimate / spendLimit) * 100, 100) : 0

    log(`[usage-service] local stats estimate: $${totalCostEstimate.toFixed(2)} / $${spendLimit} (${percentage.toFixed(1)}%) [last computed: ${stats.lastComputedDate || 'unknown'}]`)

    cachedResult = {
      success: true,
      data: { spent: totalCostEstimate, limit: spendLimit, percentage, lastUpdated: now }
    }
    lastFetchTime = now
    return cachedResult
  } catch (err) {
    log(`[usage-service] local stats read failed: ${err}`)
    if (cachedResult?.success) return cachedResult
    return { success: false, error: 'stats_read_error' }
  }
}

/**
 * Admin key: use /v1/organizations/cost_report for actual spend data.
 */
async function fetchWithAdminKey(apiKey: string, spendLimit: number, now: number): Promise<UsageResult> {
  const startOfMonth = new Date()
  startOfMonth.setUTCDate(1)
  startOfMonth.setUTCHours(0, 0, 0, 0)

  const url = `https://api.anthropic.com/v1/organizations/cost_report?starting_at=${encodeURIComponent(startOfMonth.toISOString())}&ending_at=${encodeURIComponent(new Date().toISOString())}`

  const result = await fetchAnthropicAPI<{ data?: Array<{ total_cost_usd?: number }> }>(url, apiKey)

  if (result.status === 401 || result.status === 403) {
    if (!unauthorizedLogged) { log(`[usage-service] admin key unauthorized (${result.status})`); unauthorizedLogged = true }
    throw new Error('unauthorized')
  }

  if (result.status === 429) throw new Error('rate_limited')
  if (!result.ok || !result.data) throw new Error(`http_${result.status}`)

  unauthorizedLogged = false
  const entries = result.data.data || []
  const spent = entries.reduce((sum, e) => sum + (e.total_cost_usd ?? 0), 0)
  const percentage = spendLimit > 0 ? Math.min((spent / spendLimit) * 100, 100) : 0

  log(`[usage-service] admin API: $${spent.toFixed(2)} / $${spendLimit} (${percentage.toFixed(1)}%)`)
  cachedResult = { success: true, data: { spent, limit: spendLimit, percentage, lastUpdated: now } }
  lastFetchTime = now
  return cachedResult
}

interface APIResult<T> {
  ok: boolean
  status: number
  data?: T
  headers?: Record<string, string>
}

function fetchAnthropicAPI<T>(url: string, apiKey: string): Promise<APIResult<T>> {
  return new Promise((resolve) => {
    const parsed = new URL(url)
    const req = https.get(
      {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          Accept: 'application/json',
          'User-Agent': 'Claude-Dock'
        }
      },
      (res) => {
        let data = ''
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => {
          const status = res.statusCode ?? 0
          if (status < 200 || status >= 300) {
            resolve({ ok: false, status })
            return
          }
          try {
            resolve({ ok: true, status, data: JSON.parse(data) })
          } catch {
            resolve({ ok: false, status })
          }
        })
        res.on('error', () => resolve({ ok: false, status: 0 }))
      }
    )
    req.on('error', () => resolve({ ok: false, status: 0 }))
    req.setTimeout(10000, () => {
      req.destroy()
      resolve({ ok: false, status: 0 })
    })
  })
}

