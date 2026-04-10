/**
 * Cloudflare Worker: receives anonymous telemetry, crash reports, and
 * user-submitted bug reports. Commits telemetry/crashes to public data repos
 * and creates GitHub issues for bug reports. No IP storage, no PII.
 *
 * Deploy: wrangler deploy
 * Secrets:
 *   wrangler secret put GITHUB_TOKEN          (Contents: Read/Write on data repos)
 *   wrangler secret put GITHUB_ISSUES_TOKEN   (Issues: Read/Write on BenDol/Claude-Dock)
 */

const GITHUB_REPO_TELEMETRY = 'BenDol/Claude-Dock-Telemetry'
const GITHUB_REPO_CRASHES = 'BenDol/Claude-Dock-Crashes'
const GITHUB_REPO_BUGS = 'BenDol/Claude-Dock'

const TELEMETRY_REQUIRED_FIELDS = ['deviceId', 'sessionId', 'appVersion']
const CRASH_REQUIRED_FIELDS = ['deviceId', 'appVersion', 'type', 'error']
const BUG_REPORT_REQUIRED_FIELDS = ['deviceId', 'appVersion', 'category', 'title', 'description']

const MAX_TELEMETRY_SIZE = 4096
const MAX_CRASH_SIZE = 8192
const MAX_BUG_REPORT_SIZE = 65 * 1024

const VALID_BUG_CATEGORIES = ['bug', 'crash', 'feature-request', 'question']

const TELEMETRY_RATE_LIMIT = 10
const CRASH_RATE_LIMIT = 10
const BUG_REPORT_RATE_LIMIT = 5
const RATE_WINDOW_MS = 3600000

const rateLimits = new Map()
const crashRateLimits = new Map()
const bugReportRateLimits = new Map()

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST',
  'Access-Control-Allow-Headers': 'Content-Type'
}

/** Check & increment rate limit. Returns true if allowed. */
function checkRateLimit(limitsMap, key, limit) {
  const now = Date.now()
  let entry = limitsMap.get(key)
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_WINDOW_MS }
    limitsMap.set(key, entry)
  }
  entry.count++
  if (entry.count > limit) return false
  // Cleanup stale entries
  if (limitsMap.size > 10000) {
    for (const [k, v] of limitsMap) {
      if (now > v.resetAt) limitsMap.delete(k)
    }
  }
  return true
}

/** Validate required string fields on payload. Returns error message or null. */
function validateRequired(payload, fields) {
  for (const field of fields) {
    if (!payload[field] || typeof payload[field] !== 'string' || payload[field].trim().length === 0) {
      return `Missing or empty required field: ${field}`
    }
  }
  return null
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS })
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 })
    }

    const url = new URL(request.url)
    const pathname = url.pathname

    if (pathname === '/telemetry' || pathname === '/crash') {
      return handleDataCommit(request, env, pathname)
    }

    if (pathname === '/bugreport') {
      return handleBugReport(request, env)
    }

    return new Response('Not found', { status: 404 })
  }
}

// ---- Telemetry + Crash (commits to data repos) ----

async function handleDataCommit(request, env, pathname) {
  const isCrash = pathname === '/crash'
  const maxSize = isCrash ? MAX_CRASH_SIZE : MAX_TELEMETRY_SIZE
  const requiredFields = isCrash ? CRASH_REQUIRED_FIELDS : TELEMETRY_REQUIRED_FIELDS
  const repo = isCrash ? GITHUB_REPO_CRASHES : GITHUB_REPO_TELEMETRY
  const commitPrefix = isCrash ? 'crash' : 'telemetry'
  const limitsMap = isCrash ? crashRateLimits : rateLimits
  const rateLimit = isCrash ? CRASH_RATE_LIMIT : TELEMETRY_RATE_LIMIT

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

  const validationError = validateRequired(payload, requiredFields)
  if (validationError) {
    return new Response(validationError, { status: 400 })
  }

  if (!env.GITHUB_TOKEN) {
    return new Response('Service not configured', { status: 503 })
  }

  if (!checkRateLimit(limitsMap, payload.deviceId, rateLimit)) {
    return new Response('Rate limited', { status: 429 })
  }

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

    existing.push(payload)

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

    return new Response('OK', { status: 200, headers: { 'Access-Control-Allow-Origin': '*' } })
  } catch {
    return new Response('Internal error', { status: 500 })
  }
}

// ---- Bug report (creates GitHub issues) ----

async function handleBugReport(request, env) {
  const contentLength = parseInt(request.headers.get('content-length') || '0')
  if (contentLength > MAX_BUG_REPORT_SIZE) {
    return jsonResponse({ error: 'Payload too large' }, 413)
  }

  let payload
  try {
    const text = await request.text()
    if (text.length > MAX_BUG_REPORT_SIZE) {
      return jsonResponse({ error: 'Payload too large' }, 413)
    }
    payload = JSON.parse(text)
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400)
  }

  const validationError = validateRequired(payload, BUG_REPORT_REQUIRED_FIELDS)
  if (validationError) {
    return jsonResponse({ error: validationError }, 400)
  }

  if (!VALID_BUG_CATEGORIES.includes(payload.category)) {
    return jsonResponse({ error: `Invalid category. Must be one of: ${VALID_BUG_CATEGORIES.join(', ')}` }, 400)
  }

  if (payload.title.length > 200) {
    return jsonResponse({ error: 'Title too long (max 200 chars)' }, 400)
  }
  if (payload.description.length > 5000) {
    return jsonResponse({ error: 'Description too long (max 5000 chars)' }, 400)
  }

  const token = env.GITHUB_ISSUES_TOKEN
  if (!token) {
    return jsonResponse({ error: 'Bug report service not configured' }, 503)
  }

  if (!checkRateLimit(bugReportRateLimits, payload.deviceId, BUG_REPORT_RATE_LIMIT)) {
    return jsonResponse({ error: 'Too many bug reports. Please try again in an hour.' }, 429)
  }

  const issueTitle = `[${payload.category}] ${payload.title.trim().slice(0, 200)}`
  const issueBody = formatIssueBody(payload)
  const labels = ['user-reported', payload.category, `version:${String(payload.appVersion).slice(0, 30)}`]

  const ghHeaders = {
    Authorization: `Bearer ${token}`,
    'User-Agent': 'claude-dock-bugreport-worker',
    'Content-Type': 'application/json',
    Accept: 'application/vnd.github+json'
  }

  try {
    const createResp = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO_BUGS}/issues`,
      {
        method: 'POST',
        headers: ghHeaders,
        body: JSON.stringify({ title: issueTitle, body: issueBody, labels })
      }
    )

    if (!createResp.ok) {
      const errText = await createResp.text().catch(() => '')
      // Surface "validation failed" / missing labels as 502 but don't leak token
      return jsonResponse({
        error: 'GitHub issue creation failed',
        status: createResp.status,
        detail: errText.slice(0, 200)
      }, 502)
    }

    const issue = await createResp.json()
    return jsonResponse({
      success: true,
      issueUrl: issue.html_url,
      issueNumber: issue.number
    }, 200)
  } catch (err) {
    return jsonResponse({ error: 'Internal error' }, 500)
  }
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  })
}

/** Build markdown body for a bug report issue. */
function formatIssueBody(payload) {
  const lines = []
  lines.push('## Description')
  lines.push('')
  lines.push(sanitize(payload.description, 5000))
  lines.push('')

  const steps = typeof payload.stepsToReproduce === 'string' ? payload.stepsToReproduce.trim() : ''
  lines.push('## Steps to reproduce')
  lines.push('')
  lines.push(steps ? sanitize(steps, 2000) : '_not provided_')
  lines.push('')

  lines.push('## System info')
  lines.push('')
  const os = payload.os || {}
  const mem = payload.memoryUsage || {}
  const buildSha = payload.buildSha ? ` (build ${String(payload.buildSha).slice(0, 12)})` : ''
  lines.push(`- **App version:** ${escapeMd(String(payload.appVersion))}${escapeMd(buildSha)}`)
  lines.push(`- **OS:** ${escapeMd(String(os.platform || '?'))} ${escapeMd(String(os.arch || '?'))} (${escapeMd(String(os.release || '?'))})`)
  if (typeof mem.heapUsed === 'number') {
    lines.push(`- **Memory:** heap ${mem.heapUsed}MB / ${mem.heapTotal}MB, rss ${mem.rss}MB`)
  }
  if (typeof payload.uptime === 'number') {
    lines.push(`- **Uptime:** ${payload.uptime}s`)
  }
  const handle = typeof payload.githubHandle === 'string' ? payload.githubHandle.trim().replace(/^@+/, '') : ''
  if (handle) {
    // Validate handle — github usernames match /^[a-z0-9-]{1,39}$/i
    if (/^[a-z0-9-]{1,39}$/i.test(handle)) {
      lines.push(`- **Reported by:** @${handle}`)
    } else {
      lines.push(`- **Reported by:** ${escapeMd(handle.slice(0, 40))}`)
    }
  } else {
    lines.push(`- **Reported by:** anonymous`)
  }
  lines.push('')

  const logs = typeof payload.logs === 'string' ? payload.logs : ''
  if (logs.length > 0) {
    const logFileName = typeof payload.logFileName === 'string' ? payload.logFileName : 'log'
    const truncated = payload.logTruncated ? ' (truncated — showing last 40KB)' : ''
    lines.push('## Debug logs')
    lines.push('')
    lines.push(`<details><summary>${escapeHtml(logFileName)}${truncated}</summary>`)
    lines.push('')
    lines.push('```')
    // Escape backticks in log content so the fence can't be broken
    lines.push(logs.replace(/```/g, '\u200b```'))
    lines.push('```')
    lines.push('')
    lines.push('</details>')
    lines.push('')
  }

  lines.push('---')
  const deviceIdShort = typeof payload.deviceId === 'string' ? payload.deviceId.slice(0, 8) : 'unknown'
  lines.push(`_Submitted via Claude Dock in-app bug reporter. Device ID: ${escapeMd(deviceIdShort)} (hashed)._`)

  return lines.join('\n')
}

function sanitize(str, maxLen) {
  if (typeof str !== 'string') return ''
  return str.slice(0, maxLen).replace(/\r\n/g, '\n')
}

function escapeMd(str) {
  return String(str).replace(/[<>]/g, (c) => (c === '<' ? '&lt;' : '&gt;'))
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
