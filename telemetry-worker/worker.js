/**
 * Cloudflare Worker: receives anonymous telemetry POSTs and commits
 * them as JSON to a public GitHub repo. No IP storage, no PII.
 *
 * Deploy: wrangler deploy
 * Set secret: wrangler secret put GITHUB_TOKEN
 */

const GITHUB_REPO_TELEMETRY = 'BenDol/Claude-Dock-Telemetry'
const GITHUB_REPO_CRASHES = 'BenDol/Claude-Dock-Crashes'
const TELEMETRY_REQUIRED_FIELDS = ['deviceId', 'sessionId', 'appVersion']
const CRASH_REQUIRED_FIELDS = ['deviceId', 'appVersion', 'type', 'error']
const MAX_TELEMETRY_SIZE = 2048
const MAX_CRASH_SIZE = 8192
const RATE_LIMIT = 10  // max payloads per deviceId per hour
const RATE_WINDOW_MS = 3600000

const rateLimits = new Map()
const crashRateLimits = new Map()

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST',
          'Access-Control-Allow-Headers': 'Content-Type'
        }
      })
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 })
    }

    const url = new URL(request.url)
    const isTelemetry = url.pathname === '/telemetry'
    const isCrash = url.pathname === '/crash'

    if (!isTelemetry && !isCrash) {
      return new Response('Not found', { status: 404 })
    }

    const maxSize = isCrash ? MAX_CRASH_SIZE : MAX_TELEMETRY_SIZE
    const requiredFields = isCrash ? CRASH_REQUIRED_FIELDS : TELEMETRY_REQUIRED_FIELDS
    const repo = isCrash ? GITHUB_REPO_CRASHES : GITHUB_REPO_TELEMETRY
    const commitPrefix = isCrash ? 'crash' : 'telemetry'
    const limitsMap = isCrash ? crashRateLimits : rateLimits

    // Size check
    const contentLength = parseInt(request.headers.get('content-length') || '0')
    if (contentLength > maxSize) {
      return new Response('Payload too large', { status: 413 })
    }

    let payload
    try {
      const text = await request.text()
      if (text.length > maxSize) {
        return new Response('Payload too large', { status: 413 })
      }
      payload = JSON.parse(text)
    } catch {
      return new Response('Invalid JSON', { status: 400 })
    }

    // Validate required fields (must be non-empty strings)
    for (const field of requiredFields) {
      if (!payload[field] || typeof payload[field] !== 'string' || payload[field].trim().length === 0) {
        return new Response(`Missing or empty required field: ${field}`, { status: 400 })
      }
    }

    // Validate GitHub token is configured
    if (!env.GITHUB_TOKEN) {
      return new Response('Service not configured', { status: 503 })
    }

    // Rate limit by deviceId
    const now = Date.now()
    const key = payload.deviceId
    let entry = limitsMap.get(key)
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + RATE_WINDOW_MS }
      limitsMap.set(key, entry)
    }
    entry.count++
    if (entry.count > RATE_LIMIT) {
      return new Response('Rate limited', { status: 429 })
    }

    // Cleanup stale entries
    if (limitsMap.size > 10000) {
      for (const [k, v] of limitsMap) {
        if (now > v.resetAt) limitsMap.delete(k)
      }
    }

    // Commit to GitHub
    const date = new Date()
    const year = date.getUTCFullYear()
    const month = String(date.getUTCMonth() + 1).padStart(2, '0')
    const day = String(date.getUTCDate()).padStart(2, '0')
    const filePath = `data/${year}/${month}/${year}-${month}-${day}.json`

    const ghHeaders = {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      'User-Agent': 'claude-dock-telemetry-worker',
      'Content-Type': 'application/json',
      Accept: 'application/vnd.github+json'
    }

    try {
      // Read existing file (may not exist yet)
      let existing = []
      let sha = null
      const getResp = await fetch(
        `https://api.github.com/repos/${repo}/contents/${filePath}`,
        { headers: ghHeaders }
      )
      if (getResp.ok) {
        const data = await getResp.json()
        sha = data.sha
        existing = JSON.parse(atob(data.content))
      }

      // Append new payload
      existing.push(payload)

      // Commit updated file
      const putBody = {
        message: `${commitPrefix}: ${year}-${month}-${day} (${existing.length} entries)`,
        content: btoa(JSON.stringify(existing, null, 2)),
        ...(sha ? { sha } : {})
      }

      const putResp = await fetch(
        `https://api.github.com/repos/${repo}/contents/${filePath}`,
        { method: 'PUT', headers: ghHeaders, body: JSON.stringify(putBody) }
      )

      if (putResp.status === 409) {
        // SHA conflict — retry once with fresh SHA
        const retryGet = await fetch(
          `https://api.github.com/repos/${repo}/contents/${filePath}`,
          { headers: ghHeaders }
        )
        if (retryGet.ok) {
          const retryData = await retryGet.json()
          const retryExisting = JSON.parse(atob(retryData.content))
          retryExisting.push(payload)
          const retryBody = {
            message: `${commitPrefix}: ${year}-${month}-${day} (${retryExisting.length} entries)`,
            content: btoa(JSON.stringify(retryExisting, null, 2)),
            sha: retryData.sha
          }
          const retryPut = await fetch(
            `https://api.github.com/repos/${repo}/contents/${filePath}`,
            { method: 'PUT', headers: ghHeaders, body: JSON.stringify(retryBody) }
          )
          if (!retryPut.ok) {
            return new Response('GitHub commit failed after retry', { status: 502 })
          }
        }
      } else if (!putResp.ok) {
        return new Response('GitHub commit failed', { status: 502 })
      }

      return new Response('OK', {
        status: 200,
        headers: { 'Access-Control-Allow-Origin': '*' }
      })
    } catch (err) {
      return new Response(`Internal error`, { status: 500 })
    }
  }
}
