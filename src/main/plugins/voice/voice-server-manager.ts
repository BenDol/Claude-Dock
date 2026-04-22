/**
 * Singleton that owns the Voice hotkey daemon lifecycle across all Dock
 * workspaces.  The Electron main process is itself a singleton (enforced
 * by `app.requestSingleInstanceLock()`), so one instance of this manager
 * is enough to prevent concurrent daemons.
 *
 * Responsibilities:
 *   - Ref-count enabled workspaces.
 *   - Spawn the hotkey daemon when the first workspace enables voice; stop
 *     it when the last disables.
 *   - Supervise the daemon: log stderr, auto-restart on crash (≤3 restarts
 *     within 60 s), emit status events to subscribers.
 *   - Materialise the centralised settings JSON on disk so both the daemon
 *     and server.py can read it.
 */

import { BrowserWindow, systemPreferences } from 'electron'
import { spawn, ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { EventEmitter } from 'events'
import { getServices } from './services'
import { getVoiceConfig } from './voice-settings-store'
import {
  ensureRuntime,
  getVenvPython,
  runtimeExists,
  uninstallRuntime
} from './voice-python-runtime'
import {
  ensureMcpEntry,
  getMcpStatus,
  removeMcpEntry,
  VOICE_MCP_KEY
} from './voice-mcp-register'
import { verifyBundledPythonIntegrity, repairHintForSource } from './bundled-services'
import { IPC } from '../../../shared/ipc-channels'
import type {
  VoiceRuntimeStatus,
  VoiceSetupProgress,
  VoiceDaemonState,
  VoiceInstallState,
  VoiceHotkeySupport
} from '../../../shared/voice-types'

const svc = () => getServices()

const MAX_RESTARTS = 3
const RESTART_WINDOW_MS = 60_000
const SETUP_OVERALL_TIMEOUT_MS = 15 * 60_000

/**
 * Classify this host's ability to run the hotkey daemon. Recomputed on every
 * `startDaemon()` call so macOS users who grant Accessibility permission
 * mid-session pick it up without a restart.
 */
export function detectHotkeySupport(): VoiceHotkeySupport {
  if (process.platform === 'win32') return 'supported'
  if (process.platform === 'darwin') {
    try {
      return systemPreferences.isTrustedAccessibilityClient(false)
        ? 'supported'
        : 'needs-permission'
    } catch {
      // If systemPreferences can't be reached (e.g. from a pure node test
      // harness), assume permission is missing — the daemon would fail the
      // same way, better to keep the UI in a safe state.
      return 'needs-permission'
    }
  }
  if (process.platform === 'linux') {
    const wayland =
      (process.env.XDG_SESSION_TYPE ?? '').toLowerCase() === 'wayland' ||
      Boolean(process.env.WAYLAND_DISPLAY)
    return wayland ? 'wayland' : 'supported'
  }
  return 'unsupported'
}

function hotkeySupportMessage(s: VoiceHotkeySupport): string {
  switch (s) {
    case 'needs-permission':
      return 'Dock needs Accessibility permission to use the global hotkey. Grant it in System Settings → Privacy & Security → Accessibility, then click Re-check.'
    case 'wayland':
      return 'Global hotkey isn\'t available on Wayland. Use the /voice slash command in Claude — the MCP server works on Wayland.'
    case 'unsupported':
      return 'Global hotkey isn\'t supported on this platform. Use the /voice slash command in Claude.'
    default:
      return ''
  }
}

export class VoiceServerManager extends EventEmitter {
  private static instance: VoiceServerManager | null = null

  private enabled = new Set<string>()
  private daemon: ChildProcess | null = null
  private daemonStartedAt = 0
  private restartTimestamps: number[] = []
  private stoppingDaemon = false
  private stopInFlight: Promise<void> | null = null
  private voiceWindowIds = new Set<number>()

  private status: VoiceRuntimeStatus = {
    daemonState: 'stopped',
    installState: 'unknown',
    refCount: 0,
    pid: null,
    lastError: null,
    step: 'Idle',
    pythonPath: null,
    mcpRegisteredPath: null,
    platform: process.platform,
    hotkeySupport: detectHotkeySupport()
  }

  private setupPromise: Promise<void> | null = null

  static getInstance(): VoiceServerManager {
    if (!VoiceServerManager.instance) {
      VoiceServerManager.instance = new VoiceServerManager()
    }
    return VoiceServerManager.instance
  }

  /* -------------- public API -------------- */

  getStatus(): VoiceRuntimeStatus {
    return { ...this.status }
  }

  onStatusChange(cb: (s: VoiceRuntimeStatus) => void): () => void {
    this.on('status', cb)
    return () => this.off('status', cb)
  }

  async onProjectEnabled(projectDir: string): Promise<void> {
    if (!projectDir) return
    const first = this.enabled.size === 0
    this.enabled.add(projectDir)
    this.updateStatus({ refCount: this.enabled.size })
    svc().log(`[voice-manager] enabled for ${projectDir} (refCount=${this.enabled.size})`)

    if (first) {
      // Lazy: run setup only if never done. Otherwise start daemon straight away.
      if (!runtimeExists()) {
        await this.ensureSetup().catch((err) => {
          svc().logError('[voice-manager] auto-setup failed on enable', err)
        })
      }
      if (runtimeExists() && !this.daemon) {
        await this.startDaemon().catch((err) => {
          svc().logError('[voice-manager] failed to start daemon on enable', err)
        })
      }
    }
  }

  onProjectDisabled(projectDir: string): void {
    if (!this.enabled.has(projectDir)) return
    this.enabled.delete(projectDir)
    this.updateStatus({ refCount: this.enabled.size })
    svc().log(`[voice-manager] disabled for ${projectDir} (refCount=${this.enabled.size})`)
    if (this.enabled.size === 0) {
      this.stopDaemon(true).catch((err) => svc().logError('[voice-manager] stopDaemon error', err))
    }
  }

  onProjectClosed(projectDir: string): void {
    this.onProjectDisabled(projectDir)
  }

  /** Write the current centralized config to disk and restart the daemon. */
  async applySettings(): Promise<void> {
    this.materializeConfig()
    if (this.daemon) {
      svc().log('[voice-manager] settings changed — restarting daemon')
      await this.stopDaemon(true)
      // small delay so the global hotkey handle is fully released on Windows
      await new Promise((r) => setTimeout(r, 200))
      await this.startDaemon()
    }
  }

  /* -------------- setup / install -------------- */

  ensureSetup(onProgress?: (p: VoiceSetupProgress) => void): Promise<void> {
    if (this.setupPromise) return this.setupPromise
    const guarded = Promise.race([
      this.runSetup(onProgress),
      new Promise<void>((_resolve, reject) => {
        setTimeout(() => {
          reject(new Error(`Voice setup timed out after ${SETUP_OVERALL_TIMEOUT_MS / 60_000} minutes`))
        }, SETUP_OVERALL_TIMEOUT_MS).unref?.()
      })
    ])
    this.setupPromise = guarded.finally(() => {
      this.setupPromise = null
    })
    return this.setupPromise
  }

  private async runSetup(
    onProgress: ((p: VoiceSetupProgress) => void) | undefined
  ): Promise<void> {
    // Progress reporter. Terminal steps ('done' / 'error') must not rewrite
    // installState back to 'installing' — the caller owns the final transition
    // to 'installed' or 'error', and clobbering it here is what previously left
    // the setup wizard pinned open after a successful run.
    const report = (p: VoiceSetupProgress) => {
      if (p.step === 'error') {
        this.updateStatus({ step: p.message, installState: 'error' })
      } else if (p.step === 'done') {
        this.updateStatus({ step: p.message })
      } else {
        this.updateStatus({ step: p.message, installState: 'installing' })
      }
      onProgress?.(p)
      this.broadcastProgress(p)
    }

    try {
      this.updateStatus({ installState: 'installing', lastError: null })
      const pythonDir = svc().paths.pythonDir
      const requirements = path.join(pythonDir, 'requirements.txt')
      if (!fs.existsSync(requirements)) {
        throw new Error(`requirements.txt missing at ${requirements}`)
      }

      const { pythonPath, venvPython } = await ensureRuntime(requirements, report)
      svc().log(`[voice-manager] setup complete — base=${pythonPath} venv=${venvPython}`)

      // Write config before MCP registration so the server sees it on first launch.
      this.materializeConfig()

      report({ step: 'register-mcp', pct: 0, message: 'Registering MCP server…' })
      await this.registerMcp(venvPython)
      report({ step: 'register-mcp', pct: 100, message: 'MCP registered.' })

      this.updateStatus({
        installState: 'installed',
        pythonPath: venvPython,
        step: 'Ready'
      })
      report({ step: 'done', pct: 100, message: 'Setup complete.' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      svc().logError('[voice-manager] setup failed', err)
      this.updateStatus({ installState: 'error', lastError: message, step: 'Setup failed' })
      report({ step: 'error', pct: 0, message: 'Setup failed', error: message })
      svc().notify({
        title: 'Voice setup failed',
        body: message,
        projectDir: null,
        level: 'error'
      })
      throw err
    }
  }

  async registerMcp(venvPython: string): Promise<void> {
    const serverScript = path.join(svc().paths.pythonDir, 'server.py')
    const configPath = this.configPath()
    try {
      const status = getMcpStatus(venvPython, serverScript)
      if (!status.registered || !status.conflictsWithExisting) {
        const { key } = ensureMcpEntry(venvPython, serverScript, configPath, { force: !status.conflictsWithExisting })
        this.updateStatus({ mcpRegisteredPath: key === VOICE_MCP_KEY ? serverScript : `${key}:${serverScript}` })
      } else {
        svc().log('[voice-manager] MCP conflict detected — leaving existing entry in place, UI will prompt')
      }
    } catch (err) {
      svc().logError('[voice-manager] mcp registration failed', err)
      throw err
    }
  }

  async uninstall(): Promise<void> {
    await this.stopDaemon(true)
    let mcpRemoved = true
    try {
      removeMcpEntry()
    } catch (err) {
      mcpRemoved = false
      const msg = err instanceof Error ? err.message : String(err)
      svc().logError('[voice-manager] mcp remove failed', err)
      svc().notify({
        title: 'Voice uninstall incomplete',
        body: `MCP entry could not be removed from ~/.claude.json — you may need to edit it manually. (${msg})`,
        projectDir: null,
        level: 'warn'
      })
    }
    await uninstallRuntime()
    this.updateStatus({
      installState: 'missing',
      pythonPath: null,
      mcpRegisteredPath: mcpRemoved ? null : this.status.mcpRegisteredPath,
      step: mcpRemoved ? 'Uninstalled' : 'Uninstalled (MCP entry still present)'
    })
  }

  /* -------------- daemon lifecycle -------------- */

  async startDaemon(): Promise<void> {
    if (this.daemon) {
      svc().log('[voice-manager] startDaemon called but daemon already running')
      return
    }

    // Re-check per-OS support on every start so macOS users who just granted
    // Accessibility permission can retry without restarting Dock. Wayland,
    // missing permission, and exotic platforms keep the daemon in a clean
    // 'disabled' state so the MCP path continues to work and the UI can show
    // a targeted banner instead of a crash-restart cascade.
    const hotkeySupport = detectHotkeySupport()
    this.updateStatus({ hotkeySupport })
    if (hotkeySupport !== 'supported') {
      const step =
        hotkeySupport === 'needs-permission' ? 'Awaiting Accessibility permission' :
        hotkeySupport === 'wayland' ? 'Hotkey unsupported on Wayland' :
        'Hotkey unsupported on this OS'
      this.updateStatus({
        daemonState: 'disabled',
        step,
        lastError: hotkeySupportMessage(hotkeySupport)
      })
      svc().log(`[voice-manager] hotkey daemon skipped (${hotkeySupport}) on ${process.platform} — MCP path remains active`)
      return
    }

    const hotkeyEnabled = getVoiceConfig().hotkey.enabled
    if (!hotkeyEnabled) {
      this.updateStatus({ daemonState: 'disabled', step: 'Hotkey disabled' })
      return
    }

    const py = getVenvPython()
    if (!fs.existsSync(py)) {
      this.updateStatus({
        daemonState: 'stopped',
        installState: 'missing',
        lastError: 'Python venv not found — run setup first',
        step: 'Awaiting install'
      })
      return
    }

    const daemonScript = path.join(svc().paths.pythonDir, 'hotkey_daemon.py')
    if (!fs.existsSync(daemonScript)) {
      // Matches the dictation-daemon missing-script path: tell the user which
      // file is missing, where it was looked for, and how to repair (reinstall
      // / rebuild / clear override) based on the resolved source.
      const integrity = verifyBundledPythonIntegrity()
      const msg =
        `hotkey_daemon.py missing at ${daemonScript}. ` +
        `python source=${integrity.source}, missing=[${integrity.missing.join(', ')}]. ` +
        repairHintForSource(integrity.source)
      svc().logError(`[voice-manager] ${msg}`)
      this.updateStatus({
        daemonState: 'crashed',
        installState: 'missing',
        lastError: msg,
        step: 'Hotkey daemon script missing'
      })
      return
    }
    const configPath = this.configPath()
    const dataDir = svc().getVoiceDataDir()
    const pidFile = path.join(dataDir, 'hotkey.pid')
    const logFile = path.join(dataDir, 'hotkey.log')
    fs.mkdirSync(dataDir, { recursive: true })

    this.materializeConfig()
    this.updateStatus({ daemonState: 'starting', step: 'Starting hotkey daemon', lastError: null })

    let child: ChildProcess
    try {
      child = spawn(
        py,
        [daemonScript, '--config', configPath, '--pid-file', pidFile, '--log-file', logFile],
        {
          windowsHide: true,
          // stdin piped so stopDaemon() can request a graceful drain via
          // "shutdown\n" — Windows Node.kill('SIGTERM') is TerminateProcess
          // and would abort any in-flight transcription+paste.
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' }
        }
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.updateStatus({ daemonState: 'crashed', lastError: msg, step: 'Failed to spawn' })
      svc().logError('[voice-manager] spawn failed', err)
      return
    }

    this.daemon = child
    this.daemonStartedAt = Date.now()

    child.stdout?.on('data', (buf) => {
      const text = buf.toString('utf8').trim()
      if (text) svc().log(`[voice-daemon] ${text}`)
    })
    child.stderr?.on('data', (buf) => {
      const text = buf.toString('utf8').trim()
      if (text) svc().log(`[voice-daemon:err] ${text}`)
    })
    child.on('error', (err) => {
      svc().logError('[voice-manager] daemon error event', err)
      this.updateStatus({ lastError: err.message })
    })
    child.on('exit', (code, signal) => {
      // Only act if this exit event pertains to the currently tracked child —
      // a late exit from a previously-replaced daemon must not clobber state
      // for a freshly spawned one.
      if (this.daemon !== child) {
        svc().log(`[voice-manager] stale exit event (code=${code} signal=${signal}) — ignoring`)
        return
      }
      const wasGraceful = this.stoppingDaemon
      this.daemon = null
      svc().log(`[voice-manager] daemon exited code=${code} signal=${signal} graceful=${wasGraceful}`)
      if (wasGraceful) {
        this.updateStatus({ daemonState: 'stopped', pid: null, step: 'Stopped' })
        this.stoppingDaemon = false
        return
      }
      this.handleUnexpectedExit(code, signal)
    })

    // Treat "still running after a short grace period" as success — python
    // needs a moment to import pynput / sounddevice before it's listening.
    await new Promise((resolve) => setTimeout(resolve, 500))
    if (this.daemon && !this.daemon.killed) {
      this.updateStatus({
        daemonState: 'running',
        pid: this.daemon.pid ?? null,
        step: 'Running'
      })
      svc().log(`[voice-manager] daemon running pid=${this.daemon.pid}`)
    }
  }

  async stopDaemon(graceful: boolean): Promise<void> {
    // Reuse an in-flight stop instead of racing another SIGTERM/SIGKILL.
    if (this.stopInFlight) return this.stopInFlight
    const child = this.daemon
    if (!child) return
    this.stoppingDaemon = true
    svc().log(`[voice-manager] stopping daemon pid=${child.pid} graceful=${graceful}`)

    this.stopInFlight = (async () => {
      try {
        if (graceful) {
          // Drain path: ask the daemon to stop the hotkey listener and let
          // any in-flight transcribe+paste cycle finish. Bounded by
          // DRAIN_TIMEOUT_MS so a wedged transcriber (e.g. CUDA hang, cold
          // large-v3 model) still tears down eventually.
          const DRAIN_TIMEOUT_MS = 30_000
          let drainRequestSent = false
          try {
            if (child.stdin && !child.stdin.destroyed) {
              child.stdin.write('shutdown\n')
              child.stdin.end()
              drainRequestSent = true
            }
          } catch (err) {
            svc().log(`[voice-manager] stdin shutdown write failed: ${String(err)}`)
          }

          if (drainRequestSent) {
            const drainedCleanly = await new Promise<boolean>((resolve) => {
              if (!child.pid) return resolve(true)
              const t = setTimeout(() => resolve(false), DRAIN_TIMEOUT_MS)
              child.once('exit', () => { clearTimeout(t); resolve(true) })
            })
            if (drainedCleanly) return
            svc().log('[voice-manager] drain timed out — escalating to signal')
          }
        }

        // Escalation path (non-graceful stop, or graceful drain timed out /
        // unavailable). SIGTERM first, then SIGKILL after a short grace.
        try {
          child.kill(graceful ? 'SIGTERM' : 'SIGKILL')
        } catch (err) {
          svc().logError('[voice-manager] kill failed', err)
        }

        await new Promise<void>((resolve) => {
          if (!child.pid) return resolve()
          const t = setTimeout(() => {
            try { child.kill('SIGKILL') } catch { /* ignore */ }
            resolve()
          }, 3000)
          child.once('exit', () => {
            clearTimeout(t)
            resolve()
          })
        })
      } finally {
        this.stopInFlight = null
      }
    })()
    return this.stopInFlight
  }

  private handleUnexpectedExit(code: number | null, signal: NodeJS.Signals | null): void {
    const now = Date.now()
    this.restartTimestamps = this.restartTimestamps.filter((t) => now - t < RESTART_WINDOW_MS)
    this.restartTimestamps.push(now)

    if (this.enabled.size === 0) {
      // No workspace wants it; don't restart.
      this.updateStatus({ daemonState: 'stopped', pid: null, step: 'Stopped (no workspaces)' })
      return
    }

    if (this.restartTimestamps.length > MAX_RESTARTS) {
      this.updateStatus({
        daemonState: 'crashed',
        pid: null,
        lastError: `Daemon crashed ${this.restartTimestamps.length} times in ${RESTART_WINDOW_MS / 1000}s — stopped auto-restart`,
        step: 'Needs attention'
      })
      svc().notify({
        title: 'Voice daemon keeps crashing',
        body: 'The voice hotkey daemon exited repeatedly. Open the Voice window to investigate.',
        projectDir: null,
        level: 'error'
      })
      return
    }

    const delay = Math.min(5000, 500 * Math.pow(2, this.restartTimestamps.length - 1))
    this.updateStatus({
      daemonState: 'crashed',
      pid: null,
      lastError: `Daemon exited (code=${code}, signal=${signal}) — restarting in ${delay}ms`,
      step: 'Restarting'
    })
    setTimeout(() => {
      if (this.enabled.size > 0 && !this.daemon) {
        this.startDaemon().catch((err) => svc().logError('[voice-manager] restart failed', err))
      }
    }, delay)
  }

  /* -------------- config materialization -------------- */

  configPath(): string {
    return path.join(svc().getVoiceDataDir(), 'config.json')
  }

  private materializeConfig(): void {
    const cfg = getVoiceConfig()
    const p = this.configPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    const tmp = p + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8')
    fs.renameSync(tmp, p)
    // Log the fields a user is most likely to blame for "my mic isn't
    // working" so we can tell at a glance whether the renderer's setting
    // actually made it to disk.
    svc().log(
      `[voice-manager] wrote config -> ${p} ` +
      `(input_device=${JSON.stringify(cfg.recording.input_device)} ` +
      `sample_rate=${cfg.recording.sample_rate} channels=${cfg.recording.channels})`
    )
  }

  /* -------------- status plumbing -------------- */

  private updateStatus(patch: Partial<VoiceRuntimeStatus>): void {
    this.status = { ...this.status, ...patch }
    this.emit('status', this.status)
    this.broadcastStatus()
  }

  /** Register the Voice settings window so it receives status + progress events. */
  registerVoiceWindow(windowId: number): void {
    this.voiceWindowIds.add(windowId)
  }

  unregisterVoiceWindow(windowId: number): void {
    this.voiceWindowIds.delete(windowId)
  }

  private broadcastStatus(): void {
    for (const id of this.voiceWindowIds) {
      const win = BrowserWindow.fromId(id)
      if (win && !win.isDestroyed()) {
        win.webContents.send(IPC.VOICE_STATUS_CHANGED, this.status)
      }
    }
  }

  private broadcastProgress(p: VoiceSetupProgress): void {
    for (const id of this.voiceWindowIds) {
      const win = BrowserWindow.fromId(id)
      if (win && !win.isDestroyed()) {
        win.webContents.send(IPC.VOICE_SETUP_PROGRESS, p)
      }
    }
  }

  /** Exposed for IPC / UI to refresh install state after external changes. */
  refreshInstallState(): VoiceInstallState {
    const state: VoiceInstallState = runtimeExists() ? 'installed' : 'missing'
    if (state !== this.status.installState) {
      this.updateStatus({ installState: state })
    }
    return state
  }

  /** Expose intended daemon state for tests / UI introspection. */
  getEnabledProjects(): string[] {
    return Array.from(this.enabled)
  }

  /** Current daemon state string (duplicates status for convenience). */
  getDaemonState(): VoiceDaemonState {
    return this.status.daemonState
  }
}
