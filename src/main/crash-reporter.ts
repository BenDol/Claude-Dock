/**
 * Crash reporter — sends crash details to a Cloudflare Worker that commits
 * them to the Claude-Dock-Crashes GitHub repo.
 *
 * Independent from telemetry: does NOT check telemetry consent.
 * Instead shows a "Send Crash Report?" dialog. If the dialog fails to show
 * (e.g. during a hard crash), the report is sent automatically.
 *
 * Pending crash reports are persisted to disk so force-quits don't lose data.
 */

import * as os from 'os'
import { app, net, dialog, BrowserWindow } from 'electron'
import { createSafeStore, safeWriteSync } from './safe-store'
import { getSetting } from './settings-store'
import { log, logError } from './logger'

declare const __BUILD_SHA__: string

const CRASH_ENDPOINT = 'https://claude-dock-telemetry.dolb90.workers.dev/crash'
const MAX_PAYLOAD_SIZE = 8192
const MAX_LOG_LINE_LENGTH = 200
const FETCH_TIMEOUT_MS = 10_000

export interface CrashPayload {
  version: 1
  deviceId: string
  appVersion: string
  buildSha: string
  os: { platform: string; arch: string; release: string }
  type: string
  error: string
  stack: string
  extraInfo: string
  recentLogs: string[]
  memoryUsage: { heapUsed: number; heapTotal: number; rss: number }
  uptime: number
  timestamp: string
}

interface PendingCrashStore {
  reports: CrashPayload[]
}

let _store: ReturnType<typeof createSafeStore<PendingCrashStore>> | null = null
function crashStore() {
  if (!_store) {
    _store = createSafeStore<PendingCrashStore>({ name: 'crash-pending', defaults: { reports: [] } })
  }
  return _store
}

/** Circular buffer of recent log lines for crash context */
const recentLogBuffer: string[] = []
const MAX_LOG_LINES = 30

/** Call from the logger to feed recent lines into the crash reporter */
export function feedLogLine(line: string): void {
  // Trim long lines to prevent payload bloat
  recentLogBuffer.push(line.length > MAX_LOG_LINE_LENGTH ? line.slice(0, MAX_LOG_LINE_LENGTH) + '...' : line)
  if (recentLogBuffer.length > MAX_LOG_LINES) recentLogBuffer.shift()
}

export class CrashReporter {
  private static instance: CrashReporter | null = null
  /** Guard against re-entrant calls (crash inside crash handler) */
  private reporting = false

  static getInstance(): CrashReporter {
    if (!CrashReporter.instance) {
      CrashReporter.instance = new CrashReporter()
    }
    return CrashReporter.instance
  }

  private constructor() {
    // Send any pending crash reports from prior sessions
    this.sendPending()
  }

  private getDeviceId(): string {
    try {
      return getSetting('telemetry')?.deviceId || 'unknown'
    } catch {
      return 'unknown'
    }
  }

  private buildPayload(type: string, error: string, stack: string, extraInfo: string = ''): CrashPayload {
    let mem = { heapUsed: 0, heapTotal: 0, rss: 0 }
    try {
      const m = process.memoryUsage()
      mem = {
        heapUsed: Math.round(m.heapUsed / 1024 / 1024),
        heapTotal: Math.round(m.heapTotal / 1024 / 1024),
        rss: Math.round(m.rss / 1024 / 1024)
      }
    } catch { /* process may be unstable */ }

    return {
      version: 1,
      deviceId: this.getDeviceId(),
      appVersion: app.getVersion(),
      buildSha: typeof __BUILD_SHA__ !== 'undefined' ? __BUILD_SHA__ : '',
      os: {
        platform: process.platform,
        arch: process.arch,
        release: os.release()
      },
      type,
      error: error.slice(0, 500),
      stack: stack.slice(0, 2000),
      extraInfo: extraInfo.slice(0, 500),
      recentLogs: [...recentLogBuffer],
      memoryUsage: mem,
      uptime: Math.round(process.uptime()),
      timestamp: new Date().toISOString()
    }
  }

  /** Persist a crash report to disk, then attempt to show a dialog and send */
  report(type: string, error: Error | string, extraInfo: string = ''): void {
    // Guard against re-entrant calls
    if (this.reporting) return
    this.reporting = true
    try {
      const errMsg = error instanceof Error ? error.message : String(error)
      const stack = error instanceof Error ? (error.stack || '') : ''
      const payload = this.buildPayload(type, errMsg, stack, extraInfo)

      // Persist immediately — crash-resilient
      this.persistReport(payload)
      log(`[crash-reporter] persisted crash report: ${type} - ${errMsg.slice(0, 100)}`)

      // Try to show confirmation dialog (async, fire-and-forget)
      this.promptAndSend(payload)
    } catch {
      // Absolute last resort — don't call logError() to avoid circular issues
    } finally {
      this.reporting = false
    }
  }

  /** Report a child-process-gone event */
  reportChildProcessGone(details: { type: string; reason: string; exitCode: number }): void {
    const extra = `process=${details.type} reason=${details.reason} exitCode=${details.exitCode}`
    this.report(
      `child-process-gone:${details.type}`,
      `${details.type} process gone: ${details.reason} (exit ${details.exitCode})`,
      extra
    )
  }

  private persistReport(payload: CrashPayload): void {
    try {
      const store = crashStore()
      const existing = store.get('reports') || []
      existing.push(payload)
      // Keep max 20 pending reports
      while (existing.length > 20) existing.shift()
      safeWriteSync(() => store.set('reports', existing))
    } catch {
      // Don't call logError — could be in a crash state
    }
  }

  private async promptAndSend(payload: CrashPayload): Promise<void> {
    try {
      // Only show dialog if app is ready and windows exist
      const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
      if (!win) {
        // No windows available — send automatically
        log('[crash-reporter] no windows available for dialog, sending automatically')
        await this.sendReport(payload)
        return
      }

      const { response } = await dialog.showMessageBox(win, {
        type: 'error',
        title: 'Claude Dock Crashed',
        message: `An unexpected error occurred: ${payload.type}`,
        detail: 'Would you like to send a crash report to help improve the app? No personal data is included.',
        buttons: ['Send Report', 'Don\'t Send'],
        defaultId: 0,
        cancelId: 1
      })

      if (response === 0) {
        await this.sendReport(payload)
      } else {
        // User declined — remove from pending
        this.removePendingReport(payload.timestamp)
      }
    } catch {
      // Dialog failed (hard crash state) — send automatically
      log('[crash-reporter] dialog failed, sending report automatically')
      await this.sendReport(payload)
    }
  }

  private removePendingReport(timestamp: string): void {
    try {
      const store = crashStore()
      const existing = store.get('reports') || []
      const filtered = existing.filter((r) => r.timestamp !== timestamp)
      safeWriteSync(() => store.set('reports', filtered))
    } catch { /* ok */ }
  }

  /** Send pending crash reports from prior sessions (fire-and-forget on startup) */
  private async sendPending(): Promise<void> {
    try {
      const store = crashStore()
      const reports = store.get('reports') || []
      if (reports.length === 0) return

      log(`[crash-reporter] sending ${reports.length} pending crash report(s)`)
      const sent: number[] = []
      for (let i = 0; i < reports.length; i++) {
        const ok = await this.sendReport(reports[i])
        if (ok) sent.push(i)
      }

      if (sent.length > 0) {
        const remaining = reports.filter((_, i) => !sent.includes(i))
        safeWriteSync(() => store.set('reports', remaining))
        log(`[crash-reporter] sent ${sent.length}/${reports.length} report(s)`)
      }
    } catch (e) {
      log(`[crash-reporter] sendPending failed: ${e}`)
    }
  }

  private async sendReport(payload: CrashPayload): Promise<boolean> {
    try {
      // Ensure payload fits within size limit
      const trimmed = this.trimPayload(payload)
      const body = JSON.stringify(trimmed)

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
      try {
        const resp = await net.fetch(CRASH_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: controller.signal as any
        })
        return resp.ok || resp.status === 429
      } finally {
        clearTimeout(timeout)
      }
    } catch {
      return false
    }
  }

  /** Trim payload to fit within MAX_PAYLOAD_SIZE */
  private trimPayload(payload: CrashPayload): CrashPayload {
    const p = { ...payload, recentLogs: [...payload.recentLogs] }
    let body = JSON.stringify(p)
    if (body.length <= MAX_PAYLOAD_SIZE) return p

    // Progressively trim to fit
    p.recentLogs = p.recentLogs.slice(-10)
    p.stack = p.stack.slice(0, 1000)
    body = JSON.stringify(p)
    if (body.length <= MAX_PAYLOAD_SIZE) return p

    p.recentLogs = p.recentLogs.slice(-5)
    p.stack = p.stack.slice(0, 500)
    p.extraInfo = p.extraInfo.slice(0, 200)
    body = JSON.stringify(p)
    if (body.length <= MAX_PAYLOAD_SIZE) return p

    // Last resort — drop logs entirely
    p.recentLogs = []
    p.stack = p.stack.slice(0, 300)
    return p
  }

  /** Flush pending reports — called on app quit */
  flush(): void {
    // Only persist, don't send — app is quitting and net.fetch may not complete.
    // Pending reports will be sent on next launch via sendPending().
  }
}
