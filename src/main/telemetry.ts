/**
 * Anonymous usage telemetry — opt-in, privacy-safe, crash-resilient.
 *
 * Collects non-identifying usage stats and sends them to a Cloudflare Worker
 * on app quit. Pending payloads are persisted to disk so crashes/force-quits
 * don't lose data — they're sent on next launch.
 *
 * NEVER collects: IP, username, hostname, file paths, terminal content, git data.
 */

import * as crypto from 'crypto'
import * as os from 'os'
import * as fs from 'fs'
import { app, net } from 'electron'
import { createSafeStore, safeWriteSync } from './safe-store'
import { getSetting, setSettings } from './settings-store'
import { log } from './logger'

declare const __BUILD_SHA__: string
declare const __DEV__: boolean

// The Worker URL — replace with your deployed Cloudflare Worker
const TELEMETRY_ENDPOINT = 'https://claude-dock-telemetry.dolb90.workers.dev/telemetry'
const MAX_PAYLOAD_SIZE = 2048

export interface TelemetryPayload {
  deviceId: string
  sessionId: string
  appVersion: string
  buildSha: string
  os: { platform: string; arch: string; release: string }
  sessionDurationMs: number
  crashCount: number
  crashTypes: string[]
  features: {
    gitManagerOpened: boolean
    ciTabUsed: boolean
    prTabUsed: boolean
    pluginCount: number
    linkedModeEnabled: boolean
  }
  terminalCount: number
  dockCount: number
  timestamp: string
}

interface PendingStore {
  payloads: TelemetryPayload[]
}

let _store: ReturnType<typeof createSafeStore<PendingStore>> | null = null
function pendingStore() {
  if (!_store) {
    _store = createSafeStore<PendingStore>({ name: 'telemetry-pending', defaults: { payloads: [] } })
  }
  return _store
}

export class TelemetryCollector {
  private static instance: TelemetryCollector | null = null
  private sessionId: string
  private sessionStart: number
  private crashCount = 0
  private crashTypes: string[] = []
  private features = {
    gitManagerOpened: false,
    ciTabUsed: false,
    prTabUsed: false,
    pluginCount: 0,
    linkedModeEnabled: false
  }
  private terminalCount = 0
  private dockCount = 0

  static getInstance(): TelemetryCollector {
    if (!TelemetryCollector.instance) {
      TelemetryCollector.instance = new TelemetryCollector()
    }
    return TelemetryCollector.instance
  }

  private constructor() {
    this.sessionId = crypto.randomUUID()
    this.sessionStart = Date.now()

    // Send any pending payloads from prior sessions (crashed before sending)
    if (this.isEnabled()) {
      this.sendPending()
    }
  }

  isEnabled(): boolean {
    if (typeof __DEV__ !== 'undefined' && __DEV__) return false
    try {
      const t = getSetting('telemetry')
      return !!(t?.enabled && t?.consentGiven && t?.deviceId)
    } catch {
      return false
    }
  }

  // --- Recording methods (all no-op if not enabled) ---

  recordCrash(type: string): void {
    if (!this.isEnabled()) return
    this.crashCount++
    if (!this.crashTypes.includes(type)) this.crashTypes.push(type)
    this.persistCurrent()
  }

  recordFeature(key: keyof TelemetryPayload['features'], value: unknown): void {
    if (!this.isEnabled()) return
    ;(this.features as Record<string, unknown>)[key] = value
  }

  recordTerminalSpawn(): void {
    if (!this.isEnabled()) return
    this.terminalCount++
  }

  recordDockOpen(): void {
    if (!this.isEnabled()) return
    this.dockCount++
  }

  // --- Persistence & sending ---

  /** Build the current payload snapshot */
  private buildPayload(): TelemetryPayload {
    // Read dynamic values at flush time
    try {
      const { PluginManager } = require('./plugins')
      this.features.pluginCount = PluginManager.getInstance().getPluginInfoList().length
    } catch { /* ok */ }
    try {
      this.features.linkedModeEnabled = getSetting('linked')?.enabled ?? false
    } catch { /* ok */ }

    const deviceId = getSetting('telemetry')?.deviceId || ''

    return {
      deviceId,
      sessionId: this.sessionId,
      appVersion: app.getVersion(),
      buildSha: typeof __BUILD_SHA__ !== 'undefined' ? __BUILD_SHA__ : '',
      os: {
        platform: process.platform,
        arch: process.arch,
        release: os.release()
      },
      sessionDurationMs: Date.now() - this.sessionStart,
      crashCount: this.crashCount,
      crashTypes: [...this.crashTypes],
      features: { ...this.features },
      terminalCount: this.terminalCount,
      dockCount: this.dockCount,
      timestamp: new Date().toISOString()
    }
  }

  /** Synchronously persist current payload to disk (crash resilience) */
  persistCurrent(): void {
    if (!this.isEnabled()) return
    try {
      const payload = this.buildPayload()
      const store = pendingStore()
      const existing = store.get('payloads') || []
      // Replace any existing payload for this session, or append
      const idx = existing.findIndex((p) => p.sessionId === this.sessionId)
      if (idx >= 0) existing[idx] = payload
      else existing.push(payload)
      safeWriteSync(() => store.set('payloads', existing))
    } catch (e) {
      log(`[telemetry] persistCurrent failed: ${e}`)
    }
  }

  /** Called on app quit — persist final state and fire-and-forget send */
  flush(): void {
    if (!this.isEnabled()) return
    this.persistCurrent()
    // Fire-and-forget — don't block quit
    this.sendPending()
  }

  /** Send all pending payloads to the Worker */
  private async sendPending(): Promise<void> {
    try {
      const store = pendingStore()
      const payloads = store.get('payloads') || []
      if (payloads.length === 0) return

      const sent: number[] = []
      for (let i = 0; i < payloads.length; i++) {
        const ok = await this.sendPayload(payloads[i])
        if (ok) sent.push(i)
      }

      if (sent.length > 0) {
        const remaining = payloads.filter((_, i) => !sent.includes(i))
        safeWriteSync(() => store.set('payloads', remaining))
        log(`[telemetry] sent ${sent.length}/${payloads.length} payload(s)`)
      }
    } catch (e) {
      log(`[telemetry] sendPending failed: ${e}`)
    }
  }

  private async sendPayload(payload: TelemetryPayload): Promise<boolean> {
    try {
      const body = JSON.stringify(payload)
      if (body.length > MAX_PAYLOAD_SIZE) {
        log('[telemetry] payload too large, dropping')
        return true // drop oversized payloads
      }

      const resp = await net.fetch(TELEMETRY_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body
      })
      return resp.ok || resp.status === 429 // 429 = rate limited, drop and move on
    } catch {
      return false // network error — retry next session
    }
  }

  // --- Device ID generation ---

  getOrCreateDeviceId(): string {
    try {
      const existing = getSetting('telemetry')?.deviceId
      if (existing) return existing
    } catch { /* ok */ }

    let machineId = ''
    try {
      if (process.platform === 'win32') {
        const { execSync } = require('child_process')
        const output = execSync(
          'reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid',
          { encoding: 'utf8', timeout: 5000, windowsHide: true }
        )
        const match = output.match(/MachineGuid\s+REG_SZ\s+(.+)/)
        machineId = match ? match[1].trim() : ''
      } else if (process.platform === 'darwin') {
        const { execSync } = require('child_process')
        const output = execSync('ioreg -rd1 -c IOPlatformExpertDevice', { encoding: 'utf8', timeout: 5000 })
        const match = output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)
        machineId = match ? match[1] : ''
      } else {
        try {
          machineId = fs.readFileSync('/etc/machine-id', 'utf8').trim()
        } catch {
          try { machineId = fs.readFileSync('/var/lib/dbus/machine-id', 'utf8').trim() } catch { /* ok */ }
        }
      }
    } catch (e) {
      log(`[telemetry] machine ID detection failed: ${e}`)
    }

    if (!machineId) machineId = crypto.randomUUID()

    const hash = crypto.createHash('sha256')
      .update(machineId + 'com.claude.dock')
      .digest('hex')

    try {
      const current = getSetting('telemetry') || { enabled: false, consentGiven: false, deviceId: '' }
      setSettings({ telemetry: { ...current, deviceId: hash } })
    } catch { /* ok */ }

    return hash
  }
}

/**
 * Check if the NSIS installer pre-consented to telemetry via registry.
 * Called once on first launch when consentGiven is false.
 */
export function checkInstallerConsent(): boolean {
  if (process.platform !== 'win32') return false
  try {
    const { execSync } = require('child_process')
    const output = execSync(
      'reg query "HKCU\\Software\\ClaudeDock" /v TelemetryConsent',
      { encoding: 'utf8', timeout: 5000, windowsHide: true }
    )
    return output.includes('1')
  } catch {
    return false
  }
}
