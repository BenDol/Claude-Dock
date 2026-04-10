/**
 * Bug reporter — sends user-initiated bug reports to a Cloudflare Worker that
 * creates GitHub issues on BenDol/Claude-Dock. Attaches optional log file tail
 * and system info.
 *
 * Unlike crash-reporter/telemetry:
 * - No persistence or retry queue — user initiates the submit, they can retry
 *   the in-flight request from the modal if it fails.
 * - No consent gating — explicit per-submission action.
 * - Device ID reused from telemetry for rate limiting (generated on-demand).
 */

import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import { app, net } from 'electron'
import { getSetting } from './settings-store'
import { TelemetryCollector } from './telemetry'
import { getLogDir, log, logError, logInfo } from './logger'
import type { BugReportCategory, BugReportInput, BugReportResult } from '../shared/bug-report-types'

export type { BugReportCategory, BugReportInput, BugReportResult }

declare const __BUILD_SHA__: string
declare const __DEV__: boolean

const BUG_REPORT_ENDPOINT = 'https://claude-dock-telemetry.dolb90.workers.dev/bugreport'
const MAX_LOG_BYTES = 40 * 1024
const MAX_PAYLOAD_SIZE = 60 * 1024
const FETCH_TIMEOUT_MS = 15_000

export interface BugReportPayload {
  version: 1
  deviceId: string
  appVersion: string
  buildSha: string
  category: BugReportCategory
  title: string
  description: string
  stepsToReproduce: string
  githubHandle: string
  os: { platform: string; arch: string; release: string }
  memoryUsage: { heapUsed: number; heapTotal: number; rss: number }
  uptime: number
  logs: string
  logFileName: string
  logTruncated: boolean
  timestamp: string
}

export type BugReportResult =
  | { success: true; issueUrl: string; issueNumber: number }
  | { success: false; error: string }

export class BugReporter {
  private static instance: BugReporter | null = null

  static getInstance(): BugReporter {
    if (!BugReporter.instance) {
      BugReporter.instance = new BugReporter()
    }
    return BugReporter.instance
  }

  private constructor() {}

  async submit(input: BugReportInput): Promise<BugReportResult> {
    try {
      const validation = this.validateInput(input)
      if (validation) {
        return { success: false, error: validation }
      }

      const payload = this.buildPayload(input)
      const body = JSON.stringify(payload)

      if (body.length > MAX_PAYLOAD_SIZE) {
        logError(`[bug-reporter] payload too large: ${body.length} bytes`)
        // Try trimming logs and retry once
        const trimmed = this.trimPayload(payload)
        const trimmedBody = JSON.stringify(trimmed)
        if (trimmedBody.length > MAX_PAYLOAD_SIZE) {
          return { success: false, error: 'Report too large after trimming. Try disabling log attachment.' }
        }
        return await this.send(trimmedBody)
      }

      return await this.send(body)
    } catch (err) {
      logError('[bug-reporter] submit error:', err)
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  private validateInput(input: BugReportInput): string | null {
    if (!input || typeof input !== 'object') return 'Invalid input'
    const title = (input.title || '').trim()
    const description = (input.description || '').trim()
    if (title.length < 3) return 'Title must be at least 3 characters'
    if (title.length > 200) return 'Title must be 200 characters or fewer'
    if (description.length < 10) return 'Description must be at least 10 characters'
    if (description.length > 5000) return 'Description must be 5000 characters or fewer'
    const validCategories: BugReportCategory[] = ['bug', 'crash', 'feature-request', 'question']
    if (!validCategories.includes(input.category)) return 'Invalid category'
    if (input.stepsToReproduce && input.stepsToReproduce.length > 2000) {
      return 'Steps to reproduce must be 2000 characters or fewer'
    }
    if (input.githubHandle && input.githubHandle.length > 40) {
      return 'GitHub handle must be 40 characters or fewer'
    }
    return null
  }

  private buildPayload(input: BugReportInput): BugReportPayload {
    const deviceId = this.getDeviceId()
    const memory = this.getMemoryUsage()
    const { logs, logFileName, logTruncated } = input.includeLogs
      ? this.readLatestLogTail()
      : { logs: '', logFileName: '', logTruncated: false }

    const handle = (input.githubHandle || '').trim().replace(/^@+/, '')

    return {
      version: 1,
      deviceId,
      appVersion: app.getVersion(),
      buildSha: typeof __BUILD_SHA__ !== 'undefined' ? __BUILD_SHA__ : '',
      category: input.category,
      title: input.title.trim(),
      description: input.description.trim(),
      stepsToReproduce: (input.stepsToReproduce || '').trim(),
      githubHandle: handle,
      os: input.includeSystemInfo
        ? { platform: process.platform, arch: process.arch, release: os.release() }
        : { platform: '', arch: '', release: '' },
      memoryUsage: input.includeSystemInfo ? memory : { heapUsed: 0, heapTotal: 0, rss: 0 },
      uptime: input.includeSystemInfo ? Math.round(process.uptime()) : 0,
      logs,
      logFileName,
      logTruncated,
      timestamp: new Date().toISOString()
    }
  }

  private getDeviceId(): string {
    try {
      const existing = getSetting('telemetry')?.deviceId
      if (existing) return existing
    } catch { /* fall through */ }
    try {
      // Generate (and cache) a device ID without enabling telemetry.
      return TelemetryCollector.getInstance().getOrCreateDeviceId()
    } catch (err) {
      log(`[bug-reporter] device ID generation failed: ${err}`)
      return 'unknown'
    }
  }

  private getMemoryUsage(): { heapUsed: number; heapTotal: number; rss: number } {
    try {
      const m = process.memoryUsage()
      return {
        heapUsed: Math.round(m.heapUsed / 1024 / 1024),
        heapTotal: Math.round(m.heapTotal / 1024 / 1024),
        rss: Math.round(m.rss / 1024 / 1024)
      }
    } catch {
      return { heapUsed: 0, heapTotal: 0, rss: 0 }
    }
  }

  /** Read the tail of the most-recent dock-*.log file, up to MAX_LOG_BYTES. */
  private readLatestLogTail(): { logs: string; logFileName: string; logTruncated: boolean } {
    try {
      const logDir = getLogDir()
      if (!fs.existsSync(logDir)) {
        log('[bug-reporter] log dir does not exist')
        return { logs: '', logFileName: '', logTruncated: false }
      }

      const files = fs.readdirSync(logDir)
        .filter((f) => f.startsWith('dock-') && f.endsWith('.log'))
        .sort() // ISO-ish timestamps sort chronologically

      if (files.length === 0) {
        log('[bug-reporter] no log files found')
        return { logs: '', logFileName: '', logTruncated: false }
      }

      const latest = files[files.length - 1]
      const fullPath = path.join(logDir, latest)
      const stat = fs.statSync(fullPath)

      let logs: string
      let truncated = false

      if (stat.size <= MAX_LOG_BYTES) {
        logs = fs.readFileSync(fullPath, 'utf8')
      } else {
        // Read only the tail by opening the file and seeking
        const fd = fs.openSync(fullPath, 'r')
        try {
          const buf = Buffer.alloc(MAX_LOG_BYTES)
          fs.readSync(fd, buf, 0, MAX_LOG_BYTES, stat.size - MAX_LOG_BYTES)
          logs = buf.toString('utf8')
          // Drop the first (likely partial) line for cleanliness
          const firstNewline = logs.indexOf('\n')
          if (firstNewline !== -1 && firstNewline < 500) {
            logs = logs.slice(firstNewline + 1)
          }
          truncated = true
        } finally {
          fs.closeSync(fd)
        }
      }

      logInfo(`[bug-reporter] attached log ${latest} (${logs.length} bytes, truncated=${truncated})`)
      return { logs, logFileName: latest, logTruncated: truncated }
    } catch (err) {
      logError('[bug-reporter] failed to read log file:', err)
      return { logs: '', logFileName: '', logTruncated: false }
    }
  }

  /** If payload is oversize, progressively trim logs to fit. */
  private trimPayload(payload: BugReportPayload): BugReportPayload {
    const p = { ...payload }
    // Halve logs until we fit or logs are empty
    while (p.logs.length > 0) {
      p.logs = p.logs.slice(Math.floor(p.logs.length / 2))
      p.logTruncated = true
      if (JSON.stringify(p).length <= MAX_PAYLOAD_SIZE) return p
    }
    p.logs = ''
    p.logFileName = ''
    p.logTruncated = false
    return p
  }

  private async send(body: string): Promise<BugReportResult> {
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      logInfo('[bug-reporter] DEV mode — skipping real submission')
      return { success: false, error: 'Bug reports are disabled in development mode' }
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const resp = await net.fetch(BUG_REPORT_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal as any
      })

      const respText = await resp.text()
      let parsed: any = null
      try { parsed = JSON.parse(respText) } catch { /* ok — non-json response */ }

      if (resp.ok && parsed && parsed.success && parsed.issueUrl) {
        logInfo(`[bug-reporter] issue created: #${parsed.issueNumber} ${parsed.issueUrl}`)
        return { success: true, issueUrl: parsed.issueUrl, issueNumber: parsed.issueNumber }
      }

      if (resp.status === 429) {
        return { success: false, error: (parsed && parsed.error) || 'Too many bug reports. Please try again in an hour.' }
      }
      if (resp.status === 413) {
        return { success: false, error: 'Report too large. Try disabling log attachment.' }
      }
      if (resp.status >= 500) {
        return { success: false, error: 'Bug report service is temporarily unavailable. Please try again later.' }
      }

      const errMsg = (parsed && parsed.error) || `Request failed with status ${resp.status}`
      logError(`[bug-reporter] submission failed: ${errMsg}`)
      return { success: false, error: errMsg }
    } catch (err: any) {
      if (err && err.name === 'AbortError') {
        return { success: false, error: 'Request timed out. Please check your connection and try again.' }
      }
      logError('[bug-reporter] network error:', err)
      return { success: false, error: 'Network error. Please check your connection and try again.' }
    } finally {
      clearTimeout(timeout)
    }
  }
}
