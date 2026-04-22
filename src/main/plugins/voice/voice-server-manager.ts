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
import { getVoiceConfig, setVoiceConfig } from './voice-settings-store'
import {
  ensureRuntime,
  getVenvPython,
  runtimeExists,
  uninstallRuntime,
  detectGpuCapability,
  isGpuRuntimeInstalled,
  installGpuRuntime,
  verifyGpuRuntime,
  invalidateGpuCapability
} from './voice-python-runtime'
import {
  ensureMcpEntry,
  getMcpStatus,
  removeMcpEntry,
  VOICE_MCP_KEY
} from './voice-mcp-register'
import { verifyBundledPythonIntegrity, repairHintForSource } from './bundled-services'
import { IPC } from '../../../shared/ipc-channels'
import {
  UNKNOWN_VOICE_GPU_STATUS,
  type VoiceRuntimeStatus,
  type VoiceSetupProgress,
  type VoiceDaemonState,
  type VoiceInstallState,
  type VoiceHotkeySupport,
  type VoiceGpuStatus,
  type VoiceGpuInstallState
} from '../../../shared/voice-types'

const svc = () => getServices()

const MAX_RESTARTS = 3
const RESTART_WINDOW_MS = 60_000
const SETUP_OVERALL_TIMEOUT_MS = 15 * 60_000

/**
 * Don't auto-retry a failed GPU install more than once per `GPU_RETRY_COOLDOWN_MS`.
 * Keeps a broken environment from hammering pip on every launch, but a user
 * who just fixed their driver / disk space isn't stuck waiting forever.
 */
const GPU_RETRY_COOLDOWN_MS = 24 * 60 * 60 * 1000

/** Sentinel the Python daemon prints on stderr to surface structured warnings. */
const VOICE_WARNING_PREFIX = '__VOICE_WARNING__:'

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
    hotkeySupport: detectHotkeySupport(),
    gpu: { ...UNKNOWN_VOICE_GPU_STATUS },
    gpuWarning: null
  }

  private setupPromise: Promise<void> | null = null
  /** Shared promise guarding in-flight GPU install — prevents concurrent pip calls. */
  private gpuInstallPromise: Promise<{ ok: boolean; error?: string }> | null = null

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
      } else {
        // Runtime already installed — refresh GPU status so the banner is
        // accurate, and kick off a retroactive GPU install if the user's
        // currently on cuda/auto without GPU packages yet. Fire-and-forget:
        // a slow pip install must not block daemon start for dictation use.
        void this.refreshGpuStatus().catch((err) =>
          svc().logError('[voice-manager] refreshGpuStatus failed', err)
        )
        void this.ensureGpuRuntimeIfNeeded().catch((err) =>
          svc().logError('[voice-manager] ensureGpuRuntimeIfNeeded failed', err)
        )
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

    // If the user just picked cuda/auto, make sure the GPU runtime is installed
    // before the daemon respawns. `ensureGpuRuntimeIfNeeded` is idempotent and
    // cheap when packages are already installed + verified.
    const device = getVoiceConfig().transcriber.faster_whisper.device
    if ((device === 'cuda' || device === 'auto') && runtimeExists()) {
      const gpu = await this.ensureGpuRuntimeIfNeeded()
      if (!gpu.ok) {
        // Not fatal — the transcriber will surface a CUDA→CPU fallback warning
        // on first use if the user kept 'cuda'. Log so diagnostics show why.
        svc().log(`[voice-manager] GPU ensure on settings change failed: ${gpu.error}`)
      }
    }

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

      // GPU packages are bundled into initial setup opportunistically: if we
      // detect an NVIDIA GPU, install them now so `device='cuda'` works
      // out-of-the-box the first time the user switches. Failures here are
      // non-fatal — CPU transcription remains available.
      report({ step: 'detect-gpu', pct: 0, message: 'Checking for GPU acceleration…' })
      const gpuCap = await detectGpuCapability(true)
      if (gpuCap.hasNvidiaGpu) {
        report({
          step: 'detect-gpu',
          pct: 100,
          message: `Detected ${gpuCap.gpuName ?? 'NVIDIA GPU'}`,
          detail: `driver=${gpuCap.driverVersion ?? '?'} cuda=${gpuCap.cudaVersion ?? '?'}`
        })
        this.updateGpuStatus({ capability: gpuCap, state: 'installing' })
        const gpuResult = await installGpuRuntime(report)
        if (gpuResult.ok) {
          this.updateGpuStatus({ state: 'verifying' })
          report({ step: 'verify-gpu', pct: 0, message: 'Verifying GPU support…' })
          const verify = await verifyGpuRuntime()
          if (verify.ok) {
            const verifiedAt = new Date().toISOString()
            this.persistGpuRuntimeState({
              installed: true,
              verified: true,
              verifiedAt,
              lastFailedAt: null,
              lastError: null
            })
            this.updateGpuStatus({ state: 'ready', verifiedAt, lastError: null })
            report({ step: 'verify-gpu', pct: 100, message: 'GPU acceleration ready.' })
          } else {
            const failedAt = new Date().toISOString()
            svc().logError(`[voice-manager] GPU verify failed (non-fatal): ${verify.error}`)
            this.persistGpuRuntimeState({
              installed: true,
              verified: false,
              verifiedAt: null,
              lastFailedAt: failedAt,
              lastError: verify.error ?? 'verify failed'
            })
            this.updateGpuStatus({ state: 'error', lastError: verify.error ?? 'verify failed' })
            report({
              step: 'verify-gpu',
              pct: 100,
              message: 'GPU verify failed — using CPU',
              detail: verify.error
            })
          }
        } else {
          const failedAt = new Date().toISOString()
          svc().logError(`[voice-manager] GPU install failed (non-fatal): ${gpuResult.error}`)
          this.persistGpuRuntimeState({
            installed: false,
            verified: false,
            verifiedAt: null,
            lastFailedAt: failedAt,
            lastError: gpuResult.error ?? 'install failed'
          })
          this.updateGpuStatus({ state: 'error', lastError: gpuResult.error ?? 'install failed' })
          report({
            step: 'install-gpu',
            pct: 100,
            message: 'GPU install failed — using CPU',
            detail: gpuResult.error
          })
        }
      } else {
        report({
          step: 'detect-gpu',
          pct: 100,
          message: 'No NVIDIA GPU — using CPU transcription',
          detail: gpuCap.error ?? undefined
        })
        this.updateGpuStatus({ capability: gpuCap, state: 'unavailable' })
      }

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

    // Verify the full python/ tree matches what the TS side expects before we
    // spawn. Historically we only checked hotkey_daemon.py existence here —
    // that caught "install partially wiped" scenarios but missed the more
    // common "bundle is stale relative to the TS bundle" drift (e.g. partial
    // auto-update left an old hotkey_daemon.py in place while the venv was
    // provisioned against the newer pynput requirements). Spawning in that
    // state produced an infinite restart loop with "'keyboard' package not
    // installed — exiting" until the periodic plugin-updater check finally
    // fetched the override (~30 min later). Fail fast instead.
    const integrity = verifyBundledPythonIntegrity()
    const daemonScript = path.join(svc().paths.pythonDir, 'hotkey_daemon.py')
    if (integrity.missing.length > 0) {
      const daemonMissing = integrity.missing.includes('hotkey_daemon.py')
      const headline = daemonMissing
        ? `hotkey_daemon.py missing at ${daemonScript}.`
        : `Voice runtime bundle is stale — missing [${integrity.missing.join(', ')}] in ${integrity.pythonDir}.`
      const msg = `${headline} python source=${integrity.source}. ${repairHintForSource(integrity.source)}`
      svc().logError(`[voice-manager] ${msg}`)
      this.updateStatus({
        daemonState: 'crashed',
        installState: 'missing',
        lastError: msg,
        step: daemonMissing ? 'Hotkey daemon script missing' : 'Voice runtime out of date'
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
      const text = buf.toString('utf8')
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim()
        if (!line) continue
        svc().log(`[voice-daemon:err] ${line}`)
        // Structured warnings (e.g. CUDA→CPU fallback) are surfaced in the UI.
        if (line.includes(VOICE_WARNING_PREFIX)) {
          this.handleDaemonWarningLine(line)
        }
      }
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

  /* -------------- GPU runtime -------------- */

  /**
   * Ensure the CUDA runtime is installed + verified if the current transcriber
   * device is `cuda` or `auto` and an NVIDIA GPU is present. Safe to call
   * repeatedly — idempotent once the venv is in the expected state.
   *
   * Non-blocking in the sense that install/verify failures do NOT throw —
   * they're persisted and surfaced via gpu.state='error' so the UI can retry.
   */
  async ensureGpuRuntimeIfNeeded(options: {
    /** Bypass the cooldown check (user explicitly pressed "Install GPU"). */
    force?: boolean
    /** Progress sink; falls back to broadcasting via VOICE_SETUP_PROGRESS. */
    onProgress?: (p: VoiceSetupProgress) => void
  } = {}): Promise<{ ok: boolean; state: VoiceGpuInstallState; error?: string }> {
    const cfg = getVoiceConfig()
    const device = cfg.transcriber.faster_whisper.device
    // Only auto-install for cuda/auto — `cpu` means the user explicitly opted out.
    if (device !== 'cuda' && device !== 'auto' && !options.force) {
      return { ok: true, state: this.status.gpu.state }
    }

    // Don't hammer pip if setup isn't even done yet.
    if (!runtimeExists()) {
      return { ok: false, state: 'unknown', error: 'voice runtime not installed' }
    }

    // Coalesce concurrent calls — two device changes in quick succession
    // must not kick off two pip installs.
    if (this.gpuInstallPromise) {
      const r = await this.gpuInstallPromise
      return { ok: r.ok, state: this.status.gpu.state, error: r.error }
    }

    // Wrapped in an outer try/catch so any unexpected throw (disposed
    // BrowserWindow during a send, FS transient on setVoiceConfig, etc.)
    // becomes a structured { ok: false } instead of propagating to callers
    // like applySettings — which would fail the IPC handler that triggered
    // the device change and show a confusing error in the renderer.
    const run = async (): Promise<{ ok: boolean; error?: string }> => {
      try {
        const report = (p: VoiceSetupProgress) => {
          options.onProgress?.(p)
          this.broadcastProgress(p)
        }

        // Detection first — respecting the cache on repeat calls.
        let cap = this.status.gpu.capability
        if (cap.hasNvidiaGpu === false && cap.error === null) {
          cap = await detectGpuCapability(false)
        } else if (options.force) {
          invalidateGpuCapability()
          cap = await detectGpuCapability(true)
        }
        if (!cap.hasNvidiaGpu) {
          this.updateGpuStatus({ capability: cap, state: 'unavailable', lastError: cap.error })
          return { ok: false, error: cap.error ?? 'no NVIDIA GPU detected' }
        }
        this.updateGpuStatus({ capability: cap })

        // Already installed + verified? Skip to success.
        const persisted = cfg.gpuRuntime
        if (persisted.verified && persisted.verifiedAt) {
          const reinstalled = await isGpuRuntimeInstalled()
          if (reinstalled) {
            this.updateGpuStatus({ state: 'ready', verifiedAt: persisted.verifiedAt, lastError: null })
            return { ok: true }
          }
          svc().log('[voice-manager] gpuRuntime marked verified but packages missing — reinstalling')
        }

        // Respect cooldown unless forced. Protects against a broken venv / no-disk
        // hammering pip on every launch + device-change round-trip.
        if (!options.force && persisted.lastFailedAt) {
          const last = Date.parse(persisted.lastFailedAt)
          if (Number.isFinite(last) && Date.now() - last < GPU_RETRY_COOLDOWN_MS) {
            const hoursLeft = ((GPU_RETRY_COOLDOWN_MS - (Date.now() - last)) / 3_600_000).toFixed(1)
            svc().log(
              `[voice-manager] skipping GPU auto-install — last failure ${persisted.lastFailedAt} (${hoursLeft}h cooldown remaining)`
            )
            this.updateGpuStatus({ state: 'error', lastError: persisted.lastError })
            return { ok: false, error: persisted.lastError ?? 'recent failure in cooldown' }
          }
        }

        // Install (if not present) + verify.
        let alreadyInstalled = await isGpuRuntimeInstalled()
        if (!alreadyInstalled) {
          this.updateGpuStatus({ state: 'installing' })
          const installResult = await installGpuRuntime(report)
          if (!installResult.ok) {
            const failedAt = new Date().toISOString()
            this.persistGpuRuntimeState({
              installed: false,
              verified: false,
              verifiedAt: null,
              lastFailedAt: failedAt,
              lastError: installResult.error ?? 'install failed'
            })
            this.updateGpuStatus({ state: 'error', lastError: installResult.error })
            return { ok: false, error: installResult.error }
          }
          alreadyInstalled = true
        }

        this.updateGpuStatus({ state: 'verifying' })
        report({ step: 'verify-gpu', pct: 0, message: 'Verifying GPU support…' })
        const verify = await verifyGpuRuntime()
        if (verify.ok) {
          const verifiedAt = new Date().toISOString()
          this.persistGpuRuntimeState({
            installed: true,
            verified: true,
            verifiedAt,
            lastFailedAt: null,
            lastError: null
          })
          this.updateGpuStatus({ state: 'ready', verifiedAt, lastError: null })
          report({ step: 'verify-gpu', pct: 100, message: 'GPU acceleration ready.' })
          return { ok: true }
        }

        const failedAt = new Date().toISOString()
        this.persistGpuRuntimeState({
          installed: alreadyInstalled,
          verified: false,
          verifiedAt: null,
          lastFailedAt: failedAt,
          lastError: verify.error ?? 'verify failed'
        })
        this.updateGpuStatus({ state: 'error', lastError: verify.error })
        report({
          step: 'verify-gpu',
          pct: 100,
          message: 'GPU verify failed — using CPU',
          detail: verify.error
        })
        return { ok: false, error: verify.error }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        svc().logError('[voice-manager] ensureGpuRuntimeIfNeeded threw unexpectedly', err)
        this.updateGpuStatus({ state: 'error', lastError: message })
        return { ok: false, error: message }
      }
    }

    this.gpuInstallPromise = run()
      .finally(() => { this.gpuInstallPromise = null })
    const result = await this.gpuInstallPromise!
    return { ok: result.ok, state: this.status.gpu.state, error: result.error }
  }

  /**
   * Explicit "uninstall GPU runtime" for the UI. Uses `uninstallGpuRuntime`
   * but only proceeds when no pip install is in flight (guarded by the shared
   * promise) so we never uninstall packages out from under a concurrent install.
   */
  async uninstallGpuRuntimeExplicit(): Promise<{ ok: boolean; error?: string }> {
    if (this.gpuInstallPromise) {
      return { ok: false, error: 'GPU install/verify in progress — try again shortly' }
    }
    const { uninstallGpuRuntime } = await import('./voice-python-runtime')
    const result = await uninstallGpuRuntime()
    if (result.ok) {
      this.persistGpuRuntimeState({
        installed: false,
        verified: false,
        verifiedAt: null,
        lastFailedAt: null,
        lastError: null
      })
      this.updateGpuStatus({
        state: this.status.gpu.capability.hasNvidiaGpu ? 'not-installed' : 'unavailable',
        verifiedAt: null,
        lastError: null
      })
    }
    return result
  }

  /**
   * Refresh the GPU status based on current capability + on-disk packages,
   * WITHOUT triggering an install. Called on manager initialization so the UI
   * renders the correct banner even before the user opens the voice window.
   */
  async refreshGpuStatus(): Promise<VoiceGpuStatus> {
    const cap = await detectGpuCapability(false)
    if (!cap.hasNvidiaGpu) {
      this.updateGpuStatus({ capability: cap, state: 'unavailable', lastError: cap.error })
      return this.status.gpu
    }
    const installed = runtimeExists() ? await isGpuRuntimeInstalled() : false
    const persisted = getVoiceConfig().gpuRuntime
    let state: VoiceGpuInstallState
    if (!installed) state = 'not-installed'
    else if (persisted.verified) state = 'ready'
    else if (persisted.lastError) state = 'error'
    else state = 'not-installed' // installed but never verified — treat as not-ready
    this.updateGpuStatus({
      capability: cap,
      state,
      verifiedAt: persisted.verifiedAt,
      lastError: persisted.lastError
    })
    return this.status.gpu
  }

  /** Parse a stderr line from the Python daemon for `__VOICE_WARNING__:` sentinels. */
  private handleDaemonWarningLine(line: string): void {
    const idx = line.indexOf(VOICE_WARNING_PREFIX)
    if (idx < 0) return
    const payload = line.slice(idx + VOICE_WARNING_PREFIX.length).trim()
    let parsed: { kind?: string; message?: string; [k: string]: unknown }
    try {
      parsed = JSON.parse(payload) as typeof parsed
    } catch {
      svc().log(`[voice-manager] malformed voice warning: ${payload.slice(0, 200)}`)
      return
    }
    const message = typeof parsed.message === 'string' ? parsed.message : 'Unknown voice warning'
    if (parsed.kind === 'cuda_fallback') {
      svc().log(`[voice-manager] CUDA fallback reported: ${message}`)
      this.updateStatus({ gpuWarning: message })
      // If GPU was marked verified but failed at runtime, flip it back to
      // error so the next device change triggers a re-verify.
      if (this.status.gpu.state === 'ready') {
        this.persistGpuRuntimeState({
          verified: false,
          lastFailedAt: new Date().toISOString(),
          lastError: message
        })
        this.updateGpuStatus({ state: 'error', lastError: message })
      }
    } else {
      // Unknown kind — still forward so the user can see it.
      this.updateStatus({ gpuWarning: message })
    }
  }

  /** Public accessor so voice-ipc can pipe daemon stderr through the parser. */
  feedDaemonStderr(line: string): void {
    this.handleDaemonWarningLine(line)
  }

  /** Drop the gpuWarning banner once the user has seen it. */
  dismissGpuWarning(): void {
    if (this.status.gpuWarning != null) {
      this.updateStatus({ gpuWarning: null })
    }
  }

  /* -------------- GPU internals -------------- */

  private updateGpuStatus(patch: Partial<VoiceGpuStatus>): void {
    const next: VoiceGpuStatus = { ...this.status.gpu, ...patch }
    // If patching capability only, preserve the current install state.
    if (patch.capability && patch.state === undefined) {
      next.state = this.status.gpu.state
    }
    this.updateStatus({ gpu: next })
  }

  private persistGpuRuntimeState(patch: Partial<{
    installed: boolean
    verified: boolean
    verifiedAt: string | null
    lastFailedAt: string | null
    lastError: string | null
  }>): void {
    setVoiceConfig({ gpuRuntime: patch })
  }
}
