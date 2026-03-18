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
  try {
    const blob = credStore().get('apiKeyEncrypted')
    if (!blob) return null
    return decryptValue(blob)
  } catch {
    return null
  }
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

  try {
    const startOfMonth = new Date()
    startOfMonth.setUTCDate(1)
    startOfMonth.setUTCHours(0, 0, 0, 0)
    const startingAt = startOfMonth.toISOString()
    const endingAt = new Date().toISOString()

    const url = `https://api.anthropic.com/v1/organizations/usage?starting_at=${encodeURIComponent(startingAt)}&ending_at=${encodeURIComponent(endingAt)}`

    const result = await fetchAnthropicAPI<{ total_spend_cents?: number }>(url, apiKey)

    if (result.status === 401 || result.status === 403) {
      if (!unauthorizedLogged) {
        log(`usage-service: unauthorized (${result.status})`)
        unauthorizedLogged = true
      }
      cachedResult = { success: false, error: 'unauthorized' }
      lastFetchTime = now
      return cachedResult
    }

    if (result.status === 429) {
      // Rate limited — use cached or report error
      if (cachedResult?.success) return cachedResult
      return { success: false, error: 'rate_limited' }
    }

    if (!result.ok || !result.data) {
      return { success: false, error: `http_${result.status}` }
    }

    unauthorizedLogged = false
    const spentCents = result.data.total_spend_cents ?? 0
    const spent = spentCents / 100
    const percentage = spendLimit > 0 ? Math.min((spent / spendLimit) * 100, 100) : 0

    cachedResult = {
      success: true,
      data: { spent, limit: spendLimit, percentage, lastUpdated: now }
    }
    lastFetchTime = now
    return cachedResult
  } catch (err) {
    log(`usage-service: fetch error: ${err}`)
    // Return cached if available
    if (cachedResult?.success) return cachedResult
    return { success: false, error: 'network' }
  }
}

interface APIResult<T> {
  ok: boolean
  status: number
  data?: T
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
