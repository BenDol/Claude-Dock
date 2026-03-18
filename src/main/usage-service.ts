import { safeStorage } from 'electron'
import * as https from 'https'
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
  // Rate-limit: return cached if recent enough
  const now = Date.now()
  if (cachedResult && now - lastFetchTime < MIN_FETCH_INTERVAL_MS) {
    return cachedResult
  }

  const apiKey = getKey()
  if (!apiKey) {
    return { success: false, error: 'no_key' }
  }

  const isAdminKey = apiKey.startsWith('sk-ant-admin')
  log(`[usage-service] fetching usage (keyType=${isAdminKey ? 'admin' : 'regular'})`)

  try {
    if (isAdminKey) {
      return await fetchWithAdminKey(apiKey, spendLimit, now)
    } else {
      return await fetchWithRegularKey(apiKey, spendLimit, now)
    }
  } catch (err) {
    log(`[usage-service] fetch error: ${err}`)
    if (cachedResult?.success) return cachedResult
    return { success: false, error: 'network' }
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
  log(`[usage-service] admin API response: status=${result.status}`)

  if (result.status === 401 || result.status === 403) {
    if (!unauthorizedLogged) { log(`[usage-service] unauthorized (${result.status})`); unauthorizedLogged = true }
    cachedResult = { success: false, error: 'unauthorized' }
    lastFetchTime = now
    return cachedResult
  }

  if (result.status === 429) {
    if (cachedResult?.success) return cachedResult
    return { success: false, error: 'rate_limited' }
  }

  if (!result.ok || !result.data) {
    log(`[usage-service] unexpected response: ${JSON.stringify(result.data).slice(0, 200)}`)
    return { success: false, error: `http_${result.status}` }
  }

  unauthorizedLogged = false

  // Sum up total_cost_usd from all data entries
  const entries = result.data.data || []
  const spent = entries.reduce((sum, e) => sum + (e.total_cost_usd ?? 0), 0)
  const percentage = spendLimit > 0 ? Math.min((spent / spendLimit) * 100, 100) : 0

  log(`[usage-service] spend: $${spent.toFixed(2)} / $${spendLimit} (${percentage.toFixed(1)}%)`)
  cachedResult = { success: true, data: { spent, limit: spendLimit, percentage, lastUpdated: now } }
  lastFetchTime = now
  return cachedResult
}

/**
 * Regular key: use a minimal /v1/messages call to read rate-limit headers.
 * The headers show token limits per minute — we report the percentage of
 * the input token rate limit currently consumed.
 */
async function fetchWithRegularKey(apiKey: string, spendLimit: number, now: number): Promise<UsageResult> {
  const result = await fetchAnthropicAPIWithHeaders(
    'https://api.anthropic.com/v1/messages',
    apiKey,
    JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }]
    })
  )

  log(`[usage-service] regular API response: status=${result.status}`)

  if (result.status === 401 || result.status === 403) {
    if (!unauthorizedLogged) { log(`[usage-service] unauthorized (${result.status})`); unauthorizedLogged = true }
    cachedResult = { success: false, error: 'unauthorized' }
    lastFetchTime = now
    return cachedResult
  }

  // Read rate limit headers
  const headers = result.headers || {}
  const tokensRemaining = parseFloat(headers['anthropic-ratelimit-input-tokens-remaining'] || '0')
  const tokensLimit = parseFloat(headers['anthropic-ratelimit-input-tokens-limit'] || '0')

  if (tokensLimit > 0) {
    const tokensUsed = tokensLimit - tokensRemaining
    const percentage = Math.min((tokensUsed / tokensLimit) * 100, 100)
    log(`[usage-service] rate limit: ${tokensUsed}/${tokensLimit} tokens (${percentage.toFixed(1)}%)`)
    cachedResult = {
      success: true,
      data: {
        spent: tokensUsed,
        limit: tokensLimit,
        percentage,
        lastUpdated: now
      }
    }
    lastFetchTime = now
    return cachedResult
  }

  // No rate limit headers — can't determine usage
  log(`[usage-service] no rate limit headers found`)
  return { success: false, error: 'no_usage_data' }
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

function fetchAnthropicAPIWithHeaders(url: string, apiKey: string, body: string): Promise<APIResult<unknown>> {
  return new Promise((resolve) => {
    const parsed = new URL(url)
    const req = https.request(
      {
        method: 'POST',
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': 'Claude-Dock'
        }
      },
      (res) => {
        const flatHeaders: Record<string, string> = {}
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === 'string') flatHeaders[k] = v
          else if (Array.isArray(v)) flatHeaders[k] = v[0]
        }
        let data = ''
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => {
          const status = res.statusCode ?? 0
          try {
            resolve({ ok: status >= 200 && status < 300, status, data: JSON.parse(data), headers: flatHeaders })
          } catch {
            resolve({ ok: false, status, headers: flatHeaders })
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
    req.write(body)
    req.end()
  })
}
