import { ipcMain, shell, clipboard } from 'electron'
import { execFile, spawn, ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { IPC } from '../../../shared/ipc-channels'
import { VoiceServerManager } from './voice-server-manager'
import { VoiceWindowManager } from './voice-window'
import {
  getVoiceConfig,
  setVoiceConfig,
  resetVoiceConfig,
  getVoiceStorePath,
  DeepPartial
} from './voice-settings-store'
import {
  detectSystemPython,
  getVenvPython,
  runtimeExists,
  diagnosticReport
} from './voice-python-runtime'
import {
  getMcpStatus,
  resolveConflict as resolveMcpConflict
} from './voice-mcp-register'
import { getServices } from './services'
import type { VoiceConfig, VoiceMcpConflictAction } from '../../../shared/voice-types'
import { getLogDir } from '../../logger'

const svc = () => getServices()
const mgr = () => VoiceServerManager.getInstance()
const win = () => VoiceWindowManager.getInstance()

// Track active test-record subprocesses so they can be killed if the user
// closes the Voice window mid-recording.
const activeTestRecords = new Set<ChildProcess>()

// Persistent dictation daemon (Coordinator Speak button). Loads the
// faster-whisper model once and reuses it across start/stop cycles — spawning
// a fresh Python each time cost 2-20s of model-load latency.
//
// Protocol is line-JSON over stdin/stdout, defined in dictation_daemon.py.
// Only one command can be in-flight at a time (enforced by inFlight guard).
interface DictationDaemon {
  child: ChildProcess
  // Hash of the recording+transcriber config the daemon was started with.
  // Mismatch triggers a respawn so e.g. switching from base -> large-v3 picks
  // up the new model without requiring an app restart.
  settingsHash: string
  // Ready-line buffer: resolves once the daemon emits {"ready": true}.
  ready: { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void }
  // Zero or one pending request. The child only emits a response per command.
  inFlight: { resolve: (msg: Record<string, unknown>) => void; reject: (e: Error) => void } | null
  // Partial-line buffer — stdout may chunk mid-line.
  stdoutTail: string
  stderr: string
}
let dictationDaemon: DictationDaemon | null = null

function serverScript(): string {
  return path.join(svc().paths.pythonDir, 'server.py')
}

function dictationScript(): string {
  return path.join(svc().paths.pythonDir, 'dictation_daemon.py')
}

function killActiveTestRecords(reason: string): void {
  if (activeTestRecords.size === 0) return
  svc().log(`[voice-ipc] killing ${activeTestRecords.size} test-record children (${reason})`)
  for (const child of activeTestRecords) {
    try { child.kill('SIGKILL') } catch { /* ignore */ }
  }
  activeTestRecords.clear()
}

function hashDictationConfig(cfg: VoiceConfig): string {
  // Only the fields the daemon actually uses. Avoids spurious respawns when
  // unrelated settings change (e.g. hotkey config, auto-paste).
  return JSON.stringify({ recording: cfg.recording, transcriber: cfg.transcriber })
}

function killDictationDaemon(reason: string): void {
  const d = dictationDaemon
  if (!d) return
  svc().log(`[voice-ipc] killing dictation daemon (${reason})`)
  dictationDaemon = null
  // Reject anyone waiting — the daemon is gone.
  const err = new Error(`Dictation daemon killed: ${reason}`)
  if (d.inFlight) { d.inFlight.reject(err); d.inFlight = null }
  d.ready.reject(err)
  try { d.child.stdin?.end() } catch { /* ignore */ }
  try { d.child.kill('SIGKILL') } catch { /* ignore */ }
}

function ensureDictationDaemon(): DictationDaemon {
  const cfg = getVoiceConfig()
  const hash = hashDictationConfig(cfg)
  if (dictationDaemon && !dictationDaemon.child.killed && dictationDaemon.settingsHash === hash) {
    return dictationDaemon
  }
  if (dictationDaemon) {
    killDictationDaemon(dictationDaemon.settingsHash !== hash ? 'config changed' : 'stale daemon')
  }

  const py = getVenvPython()
  const script = dictationScript()
  const cfgB64 = Buffer.from(hash, 'utf8').toString('base64')

  // Log the resolved input_device on every spawn so we can see whether the
  // Coordinator Speak button and the hotkey daemon agree on what device to
  // use. A mismatch between the TS side and the Python side has been the
  // smoking gun for "mic selection is ignored" reports.
  svc().log(
    `[voice-ipc] spawning dictation daemon ` +
    `input_device=${JSON.stringify(cfg.recording.input_device)} ` +
    `sample_rate=${cfg.recording.sample_rate} ` +
    `channels=${cfg.recording.channels}`
  )

  const child = spawn(py, [script, cfgB64], { windowsHide: true })

  let readyResolve!: () => void
  let readyReject!: (e: Error) => void
  const readyPromise = new Promise<void>((res, rej) => { readyResolve = res; readyReject = rej })

  const daemon: DictationDaemon = {
    child,
    settingsHash: hash,
    ready: { promise: readyPromise, resolve: readyResolve, reject: readyReject },
    inFlight: null,
    stdoutTail: '',
    stderr: ''
  }

  child.stdout?.on('data', (buf: Buffer) => {
    daemon.stdoutTail += buf.toString()
    // Consume whole lines; leave partials for the next chunk.
    let newlineIdx: number
    while ((newlineIdx = daemon.stdoutTail.indexOf('\n')) >= 0) {
      const line = daemon.stdoutTail.slice(0, newlineIdx).trim()
      daemon.stdoutTail = daemon.stdoutTail.slice(newlineIdx + 1)
      if (!line) continue
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(line) as Record<string, unknown>
      } catch {
        svc().log(`[voice-ipc] dictation daemon non-JSON line: ${line.slice(0, 200)}`)
        continue
      }
      if (msg.fatal) {
        const err = new Error(`Dictation daemon fatal: ${String(msg.fatal)}`)
        daemon.ready.reject(err)
        if (daemon.inFlight) { daemon.inFlight.reject(err); daemon.inFlight = null }
        continue
      }
      if (msg.ready === true) {
        daemon.ready.resolve()
        continue
      }
      if (daemon.inFlight) {
        const req = daemon.inFlight
        daemon.inFlight = null
        req.resolve(msg)
      } else {
        svc().log(`[voice-ipc] dictation daemon unsolicited: ${line.slice(0, 200)}`)
      }
    }
  })
  child.stderr?.on('data', (buf: Buffer) => {
    const chunk = buf.toString()
    daemon.stderr += chunk
    // Forward daemon stderr to the app log so the user (and us) can see
    // device-resolution details, check_input_settings failures, and
    // silent-capture diagnostics in real time without waiting for exit.
    for (const line of chunk.split('\n')) {
      const trimmed = line.trim()
      if (trimmed) svc().log(`[voice-daemon] ${trimmed}`)
    }
  })
  child.on('error', (err) => {
    svc().logError('[voice-ipc] dictation daemon spawn error', err)
    const e = err instanceof Error ? err : new Error(String(err))
    daemon.ready.reject(e)
    if (daemon.inFlight) { daemon.inFlight.reject(e); daemon.inFlight = null }
    if (dictationDaemon === daemon) dictationDaemon = null
  })
  child.on('close', (code, signal) => {
    svc().log(`[voice-ipc] dictation daemon closed (code=${code} signal=${signal})`)
    const err = new Error(signal === 'SIGKILL' ? 'Dictation daemon killed' : `Dictation daemon exited (${code ?? 'null'})`)
    daemon.ready.reject(err)
    if (daemon.inFlight) { daemon.inFlight.reject(err); daemon.inFlight = null }
    if (dictationDaemon === daemon) dictationDaemon = null
  })

  dictationDaemon = daemon
  svc().log('[voice-ipc] dictation daemon spawned')
  return daemon
}

async function dictationSend(cmd: 'start' | 'stop' | 'cancel'): Promise<Record<string, unknown>> {
  const daemon = ensureDictationDaemon()
  await daemon.ready.promise
  if (daemon.inFlight) {
    throw new Error('Dictation command already in progress')
  }
  const result = new Promise<Record<string, unknown>>((resolve, reject) => {
    daemon.inFlight = { resolve, reject }
  })
  try {
    daemon.child.stdin?.write(cmd + '\n')
  } catch (err) {
    if (daemon.inFlight) { daemon.inFlight = null }
    throw err
  }
  return result
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val)
}

export function registerVoiceIpc(): void {
  ipcMain.handle(IPC.VOICE_OPEN, async () => {
    await win().open()
  })

  ipcMain.handle(IPC.VOICE_CLOSE, async () => {
    killActiveTestRecords('VOICE_CLOSE')
    win().close()
  })

  ipcMain.handle(IPC.VOICE_GET_SETTINGS, async (): Promise<VoiceConfig> => {
    return getVoiceConfig()
  })

  ipcMain.handle(IPC.VOICE_SET_SETTINGS, async (_e, patch: unknown) => {
    if (!isPlainObject(patch)) {
      throw new Error('voice:setSettings: patch must be a plain object')
    }
    const merged = setVoiceConfig(patch as DeepPartial<VoiceConfig>)
    // Write to disk + restart hotkey daemon if running.
    await mgr().applySettings()
    // Also restart the dictation daemon so new recorder/transcriber config
    // (sample rate, model, device, etc.) is actually picked up.
    killDictationDaemon('settings changed')
    return merged
  })

  ipcMain.handle(IPC.VOICE_RESET_SETTINGS, async () => {
    const def = resetVoiceConfig()
    killDictationDaemon('settings reset')
    await mgr().applySettings()
    return def
  })

  ipcMain.handle(IPC.VOICE_GET_STATUS, async () => {
    mgr().refreshInstallState()
    return mgr().getStatus()
  })

  ipcMain.handle(IPC.VOICE_LIST_DEVICES, async () => {
    const py = getVenvPython()
    if (!fs.existsSync(py)) return { devices: [], output: '', error: 'Voice runtime not installed' }
    // Emit both a structured JSON blob (for the device picker) and the raw
    // query_devices() text (for the diagnostic pane). Fenced with sentinels
    // so a stray stderr/log line on stdout can't break parsing.
    const script = `
import json
import platform
import sounddevice as sd
devs = sd.query_devices()
try:
    default = sd.default.device
except Exception:
    default = (None, None)
default_in = default[0] if isinstance(default, (list, tuple)) else default

is_windows = platform.system() == 'Windows'

# On Windows sounddevice surfaces the same physical mic 4x (MME, DirectSound,
# WASAPI, WDM-KS). Only WASAPI reliably supports arbitrary sample rates via
# the Windows APO; MME is legacy + 48 kHz only; DirectSound is deprecated;
# WDM-KS requires exclusive mode and often fails silently. Rank by API so the
# UI can promote the sensible choice and warn against the others.
def _api_rank(host_name):
    if not is_windows:
        return 0
    h = (host_name or '').lower()
    if 'wasapi' in h: return 0
    if 'directsound' in h: return 2
    if 'mme' in h: return 3
    if 'wdm-ks' in h: return 4
    return 5

def _host_name(d):
    h = d.get('hostapi')
    if not isinstance(h, int):
        return ''
    try:
        return sd.query_hostapis(h).get('name', '')
    except Exception:
        return ''

entries = []
for i, d in enumerate(devs):
    # Wrap each device build so one bad entry doesn't break the whole list —
    # sounddevice occasionally returns malformed metadata for virtual devices.
    try:
        if int(d.get('max_input_channels', 0)) <= 0:
            continue
        host_name = _host_name(d)
        rank = _api_rank(host_name)
        entries.append({
            'index': i,
            'name': d.get('name', f'device {i}'),
            'hostApi': host_name,
            'maxInputChannels': int(d.get('max_input_channels', 0)),
            'defaultSampleRate': float(d.get('default_samplerate', 0.0) or 0.0),
            'isDefault': i == default_in,
            'apiRank': rank,
            # On Windows, WASAPI is the recommended pick. Off-Windows all
            # entries are equally fine so we don't nag the user.
            'recommended': (rank == 0) if is_windows else False,
        })
    except Exception:
        continue
print('<<VOICE_JSON>>')
print(json.dumps(entries))
print('<<VOICE_END>>')
print(str(devs))
`
    return new Promise((resolve) => {
      execFile(
        py,
        ['-c', script],
        { timeout: 15000, windowsHide: true },
        (err, stdout, stderr) => {
          if (err) {
            svc().logError('[voice-ipc] list devices failed', err)
            resolve({ devices: [], output: '', error: stderr || String(err) })
            return
          }
          const out = String(stdout)
          const jsonStart = out.indexOf('<<VOICE_JSON>>')
          const jsonEnd = out.indexOf('<<VOICE_END>>')
          if (jsonStart < 0 || jsonEnd < 0 || jsonEnd < jsonStart) {
            resolve({ devices: [], output: out, error: 'Could not parse device list' })
            return
          }
          const jsonBlob = out.slice(jsonStart + '<<VOICE_JSON>>'.length, jsonEnd).trim()
          const tail = out.slice(jsonEnd + '<<VOICE_END>>'.length).trim()
          try {
            const devices = JSON.parse(jsonBlob)
            resolve({ devices, output: tail })
          } catch (parseErr) {
            resolve({ devices: [], output: tail, error: `parse: ${String(parseErr)}` })
          }
        }
      )
    })
  })

  ipcMain.handle(IPC.VOICE_TEST_RECORD, async (_e, seconds: unknown) => {
    const py = getVenvPython()
    if (!fs.existsSync(py)) return { error: 'Voice runtime not installed' }

    const numSeconds = typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : 3
    const cfg = getVoiceConfig()
    const dur = Math.max(1, Math.min(30, Math.floor(numSeconds) || 3))
    // Embed the config as base64-encoded JSON and decode inside Python. Raw
    // `JSON.stringify(obj)` interpolation produces `true`/`false`/`null` tokens
    // that Python can't parse (`NameError: name 'false' is not defined`), and
    // string escapes differ between JSON and Python source. Base64 sidesteps
    // both problems — no quoting, no token translation.
    const cfgJsonB64 = Buffer.from(
      JSON.stringify({ recording: cfg.recording, transcriber: cfg.transcriber }),
      'utf8'
    ).toString('base64')
    const script = `
import json, sys, os, tempfile, base64
sys.path.insert(0, ${JSON.stringify(svc().paths.pythonDir)})
from src.recorder import VoiceRecorder
from src.transcriber import create_transcriber

cfg = json.loads(base64.b64decode(${JSON.stringify(cfgJsonB64)}).decode('utf-8'))

rec = VoiceRecorder(
    sample_rate=cfg['recording']['sample_rate'],
    channels=cfg['recording']['channels'],
    speech_threshold=cfg['recording']['speech_threshold'],
    device=cfg['recording'].get('input_device'),
)
try:
    rec.start()
except Exception as e:
    print(json.dumps({'error': f'Recording failed to start: {e}'}))
    sys.exit(0)
import time; time.sleep(${dur})
audio = rec.stop()
if not audio:
    print(json.dumps({'error': (
        'No audio was captured. The selected microphone produced silence '
        '— try a different device (prefer the WASAPI variant on Windows). '
        'See voice logs for the resolved device details.'
    )}))
    sys.exit(0)
trans = create_transcriber(cfg['transcriber'])
text = trans.transcribe(audio)
try: os.unlink(audio)
except OSError: pass
print(json.dumps({'text': text}))
`

    return new Promise<{ text?: string; error?: string }>((resolve) => {
      const child = spawn(py, ['-c', script], { windowsHide: true })
      activeTestRecords.add(child)
      let out = ''
      let err = ''
      child.stdout?.on('data', (b) => (out += b.toString()))
      child.stderr?.on('data', (b) => {
        const chunk = b.toString()
        err += chunk
        // Forward recorder diagnostics (device info, check_input_settings
        // failures, silent-capture notes) to the app log so we can see why
        // a test record returned silence.
        for (const line of chunk.split('\n')) {
          const trimmed = line.trim()
          if (trimmed) svc().log(`[voice-testrec] ${trimmed}`)
        }
      })
      child.on('error', (spawnErr) => {
        activeTestRecords.delete(child)
        svc().logError('[voice-ipc] testRecord spawn error', spawnErr)
        resolve({ error: String(spawnErr) })
      })
      child.on('close', (code, signal) => {
        activeTestRecords.delete(child)
        if (signal === 'SIGKILL') {
          resolve({ error: 'Test recording cancelled' })
          return
        }
        if (code !== 0) {
          svc().logError(`[voice-ipc] testRecord exited ${code}`, err)
          resolve({ error: err || `exit ${code}` })
          return
        }
        try {
          const line = out.trim().split('\n').filter(Boolean).pop() ?? '{}'
          resolve(JSON.parse(line))
        } catch (parseErr) {
          resolve({ error: `parse: ${String(parseErr)}; raw=${out.slice(0, 200)}` })
        }
      })
    })
  })

  // Manual-stop dictation for UI callers (Coordinator Speak button). Backed by
  // a persistent dictation_daemon.py that keeps the transcriber loaded across
  // start/stop cycles, so the user doesn't pay model-load latency every time.
  ipcMain.handle(IPC.VOICE_DICTATE_START, async (): Promise<{ ok?: true; error?: string }> => {
    if (!fs.existsSync(getVenvPython())) {
      return { error: 'Voice runtime not installed' }
    }
    if (!fs.existsSync(dictationScript())) {
      return { error: 'Dictation daemon script missing' }
    }
    try {
      const resp = await dictationSend('start')
      if (typeof resp.error === 'string') return { error: resp.error }
      if (resp.started !== true) return { error: 'Unexpected daemon response' }
      return { ok: true }
    } catch (err) {
      svc().logError('[voice-ipc] dictation start failed', err)
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(IPC.VOICE_DICTATE_STOP, async (): Promise<{ text?: string; error?: string }> => {
    if (!dictationDaemon) {
      return { error: 'No active dictation' }
    }
    // Guard against a hung transcriber (faster-whisper crash, wedged CUDA,
    // etc.) so the renderer never gets stuck in "Transcribing…".
    const DICTATE_TRANSCRIBE_TIMEOUT_MS = 60_000
    try {
      const resp = await Promise.race([
        dictationSend('stop'),
        new Promise<Record<string, unknown>>((_, reject) =>
          setTimeout(() => reject(new Error('Transcription timed out')), DICTATE_TRANSCRIBE_TIMEOUT_MS))
      ])
      if (typeof resp.error === 'string') return { error: resp.error }
      const text = String(resp.text ?? '').trim()
      if (!text) return { error: 'No speech could be transcribed.' }
      return { text }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg === 'Transcription timed out') {
        // Daemon state is corrupt — the transcriber may still be running. Kill
        // the daemon so the next START spawns a fresh one with a clean model.
        killDictationDaemon('transcribe timeout')
      }
      svc().logError('[voice-ipc] dictation stop failed', err)
      return { error: msg }
    }
  })

  ipcMain.handle(IPC.VOICE_DICTATE_CANCEL, async (): Promise<{ ok: true }> => {
    // Cancel is a protocol-level command against the persistent daemon — it
    // drops the in-progress audio without tearing the model down, so the next
    // START is still fast.
    if (dictationDaemon) {
      try {
        await Promise.race([
          dictationSend('cancel'),
          new Promise<Record<string, unknown>>((_, reject) =>
            setTimeout(() => reject(new Error('cancel timed out')), 5_000))
        ])
      } catch (err) {
        // If cancel can't reach the daemon, fall back to killing it entirely.
        svc().log(`[voice-ipc] dictation cancel fallback to kill: ${String(err)}`)
        killDictationDaemon('cancel fallback')
      }
    }
    return { ok: true }
  })

  ipcMain.handle(IPC.VOICE_SETUP_DETECT, async () => {
    return await detectSystemPython()
  })

  ipcMain.handle(IPC.VOICE_SETUP_INSTALL, async () => {
    try {
      await mgr().ensureSetup()
      // Kick the daemon now that the runtime is ready.
      if (mgr().getEnabledProjects().length > 0) {
        await mgr().startDaemon().catch((err) => svc().logError('[voice-ipc] start after setup failed', err))
      }
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(IPC.VOICE_SETUP_UNINSTALL, async () => {
    await mgr().uninstall()
    return { success: true }
  })

  ipcMain.handle(IPC.VOICE_MCP_STATUS, async () => {
    const py = runtimeExists() ? getVenvPython() : ''
    return getMcpStatus(py, serverScript())
  })

  ipcMain.handle(IPC.VOICE_MCP_RESOLVE_CONFLICT, async (_e, action: unknown) => {
    if (action !== 'overwrite' && action !== 'rename' && action !== 'cancel') {
      throw new Error(`voice:resolveMcpConflict: invalid action "${String(action)}"`)
    }
    if (!runtimeExists()) return { success: false }
    const configPath = path.join(svc().getVoiceDataDir(), 'config.json')
    const result = resolveMcpConflict(action as VoiceMcpConflictAction, getVenvPython(), serverScript(), configPath)
    return { success: !!result, key: result?.key }
  })

  ipcMain.handle(IPC.VOICE_RESTART_DAEMON, async () => {
    try {
      await mgr().stopDaemon(true)
      await mgr().startDaemon()
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(IPC.VOICE_OPEN_LOGS, async () => {
    try {
      await shell.openPath(getLogDir())
    } catch (err) {
      svc().logError('[voice-ipc] openLogs failed', err)
    }
  })

  ipcMain.handle(IPC.VOICE_OPEN_ACCESSIBILITY_SETTINGS, async () => {
    // macOS-only: deep-link to the Accessibility privacy pane. Other OSes
    // don't need this permission so we return early and leave the caller a
    // falsy result to render whatever fallback copy they want.
    if (process.platform !== 'darwin') {
      svc().log(`[voice-ipc] openAccessibilitySettings called on ${process.platform} — no-op`)
      return false
    }
    try {
      await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility')
      return true
    } catch (err) {
      svc().logError('[voice-ipc] openAccessibilitySettings failed', err)
      return false
    }
  })

  ipcMain.handle(IPC.VOICE_COPY_DIAGNOSTICS, async () => {
    const cfg = getVoiceConfig()
    const status = mgr().getStatus()
    const py = runtimeExists() ? getVenvPython() : '(missing)'
    const mcpStatus = getMcpStatus(runtimeExists() ? getVenvPython() : '', serverScript())

    const report = [
      '=== Voice diagnostic report ===',
      `generated: ${new Date().toISOString()}`,
      `os: ${os.platform()} ${os.release()} ${os.arch()}`,
      diagnosticReport(),
      `venvPython: ${py}`,
      `serverScript: ${serverScript()}`,
      `settingsPath: ${getVoiceStorePath()}`,
      '--- status ---',
      JSON.stringify(status, null, 2),
      '--- mcp ---',
      JSON.stringify(mcpStatus, null, 2),
      '--- hotkey config ---',
      JSON.stringify(cfg.hotkey, null, 2)
    ].join('\n')

    try {
      clipboard.writeText(report)
    } catch (err) {
      svc().logError('[voice-ipc] copy diagnostics failed', err)
    }
    return report
  })

  svc().log('[voice] IPC handlers registered')
}

export function disposeVoiceIpc(): void {
  killActiveTestRecords('disposeVoiceIpc')
  killDictationDaemon('disposeVoiceIpc')
  const channels = [
    IPC.VOICE_OPEN,
    IPC.VOICE_CLOSE,
    IPC.VOICE_GET_SETTINGS,
    IPC.VOICE_SET_SETTINGS,
    IPC.VOICE_RESET_SETTINGS,
    IPC.VOICE_GET_STATUS,
    IPC.VOICE_LIST_DEVICES,
    IPC.VOICE_TEST_RECORD,
    IPC.VOICE_DICTATE_START,
    IPC.VOICE_DICTATE_STOP,
    IPC.VOICE_DICTATE_CANCEL,
    IPC.VOICE_SETUP_DETECT,
    IPC.VOICE_SETUP_INSTALL,
    IPC.VOICE_SETUP_UNINSTALL,
    IPC.VOICE_MCP_STATUS,
    IPC.VOICE_MCP_RESOLVE_CONFLICT,
    IPC.VOICE_RESTART_DAEMON,
    IPC.VOICE_OPEN_LOGS,
    IPC.VOICE_COPY_DIAGNOSTICS,
    IPC.VOICE_OPEN_ACCESSIBILITY_SETTINGS
  ]
  for (const ch of channels) {
    try { ipcMain.removeHandler(ch) } catch { /* ignore */ }
  }
  svc().log('[voice] IPC handlers disposed')
}

