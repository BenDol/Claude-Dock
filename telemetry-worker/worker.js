/**
 * Cloudflare Worker: receives anonymous telemetry POSTs and commits
 * them as JSON to a public GitHub repo. No IP storage, no PII.
 *
 * Deploy: wrangler deploy
 * Set secret: wrangler secret put GITHUB_TOKEN
 */

const GITHUB_REPO = 'BenDol/Claude-Dock-Telemetry'
const REQUIRED_FIELDS = ['deviceId', 'sessionId', 'appVersion']
const MAX_PAYLOAD_SIZE = 2048
const RATE_LIMIT = 10  // max payloads per deviceId per hour
const RATE_WINDOW_MS = 3600000

const rateLimits = new Map()

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
    if (url.pathname !== '/telemetry') {
      return new Response('Not found', { status: 404 })
    }

    // Size check
    const contentLength = parseInt(request.headers.get('content-length') || '0')
    if (contentLength > MAX_PAYLOAD_SIZE) {
      return new Response('Payload too large', { status: 413 })
    }

    let payload
    try {
      const text = await request.text()
      if (text.length > MAX_PAYLOAD_SIZE) {
        return new Response('Payload too large', { status: 413 })
      }
      payload = JSON.parse(text)
    } catch {
      return new Response('Invalid JSON', { status: 400 })
    }

    // Validate required fields
    for (const field of REQUIRED_FIELDS) {
      if (!payload[field] || typeof payload[field] !== 'string') {
        return new Response(`Missing required field: ${field}`, { status: 400 })
      }
    }

    // Rate limit by deviceId
    const now = Date.now()
    const key = payload.deviceId
    let entry = rateLimits.get(key)
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + RATE_WINDOW_MS }
      rateLimits.set(key, entry)
    }
    entry.count++
    if (entry.count > RATE_LIMIT) {
      return new Response('Rate limited', { status: 429 })
    }

    // Cleanup stale entries
    if (rateLimits.size > 10000) {
      for (const [k, v] of rateLimits) {
        if (now > v.resetAt) rateLimits.delete(k)
      }
    }

    // Commit to GitHub
    const date = new Date()
    const year = date.getUTCFullYear()
    const month = String(date.getUTCMonth() + 1).padStart(2, '0')
    const day = String(date.getUTCDate()).padStart(2, '0')
    const filePath = `data/${year}/${month}/${year}-${month}-${day}.json`

    const headers = {
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
        `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}`,
        { headers }
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
        message: `telemetry: ${year}-${month}-${day} (${existing.length} entries)`,
        content: btoa(JSON.stringify(existing, null, 2)),
        ...(sha ? { sha } : {})
      }

      const putResp = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}`,
        { method: 'PUT', headers, body: JSON.stringify(putBody) }
      )

      if (putResp.status === 409) {
        // SHA conflict — retry once with fresh SHA
        const retryGet = await fetch(
          `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}`,
          { headers }
        )
        if (retryGet.ok) {
          const retryData = await retryGet.json()
          const retryExisting = JSON.parse(atob(retryData.content))
          retryExisting.push(payload)
          const retryBody = {
            message: `telemetry: ${year}-${month}-${day} (${retryExisting.length} entries)`,
            content: btoa(JSON.stringify(retryExisting, null, 2)),
            sha: retryData.sha
          }
          const retryPut = await fetch(
            `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}`,
            { method: 'PUT', headers, body: JSON.stringify(retryBody) }
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
