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

function serverScript(): string {
  return path.join(svc().paths.pythonDir, 'server.py')
}

function killActiveTestRecords(reason: string): void {
  if (activeTestRecords.size === 0) return
  svc().log(`[voice-ipc] killing ${activeTestRecords.size} test-record children (${reason})`)
  for (const child of activeTestRecords) {
    try { child.kill('SIGKILL') } catch { /* ignore */ }
  }
  activeTestRecords.clear()
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
    // Write to disk + restart daemon if running.
    await mgr().applySettings()
    return merged
  })

  ipcMain.handle(IPC.VOICE_RESET_SETTINGS, async () => {
    const def = resetVoiceConfig()
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
import sounddevice as sd
devs = sd.query_devices()
try:
    default = sd.default.device
except Exception:
    default = (None, None)
default_in = default[0] if isinstance(default, (list, tuple)) else default

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
        entries.append({
            'index': i,
            'name': d.get('name', f'device {i}'),
            'hostApi': _host_name(d),
            'maxInputChannels': int(d.get('max_input_channels', 0)),
            'defaultSampleRate': float(d.get('default_samplerate', 0.0) or 0.0),
            'isDefault': i == default_in,
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
    const script = `
import json, sys, os, tempfile
sys.path.insert(0, ${JSON.stringify(svc().paths.pythonDir)})
from src.recorder import VoiceRecorder
from src.transcriber import create_transcriber

cfg = ${JSON.stringify({
      recording: cfg.recording,
      transcriber: cfg.transcriber
    })}

rec = VoiceRecorder(
    sample_rate=cfg['recording']['sample_rate'],
    channels=cfg['recording']['channels'],
    speech_threshold=cfg['recording']['speech_threshold'],
    device=cfg['recording'].get('input_device'),
)
rec.start()
import time; time.sleep(${dur})
audio = rec.stop()
if not audio:
    print(json.dumps({'error': 'No audio captured'}))
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
      child.stderr?.on('data', (b) => (err += b.toString()))
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
  const channels = [
    IPC.VOICE_OPEN,
    IPC.VOICE_CLOSE,
    IPC.VOICE_GET_SETTINGS,
    IPC.VOICE_SET_SETTINGS,
    IPC.VOICE_RESET_SETTINGS,
    IPC.VOICE_GET_STATUS,
    IPC.VOICE_LIST_DEVICES,
    IPC.VOICE_TEST_RECORD,
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

