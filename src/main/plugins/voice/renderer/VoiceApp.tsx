import { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import './voice.css'
import { getDockApi } from '@dock-renderer/lib/ipc-bridge'
import {
  applySavedZoom,
  applyZoom,
  isEditableTarget,
  ZOOM_STEP
} from './voice-zoom'
import type {
  VoiceConfig,
  VoiceRuntimeStatus,
  VoiceSetupProgress,
  VoiceDaemonState,
  VoiceInstallState,
  VoiceInputDevice,
  VoiceHotkeySupport
} from '../../../../shared/voice-types'

type Tab = 'hotkey' | 'recording' | 'transcriber' | 'setup'

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }
type PatchFn = (p: DeepPartial<VoiceConfig>) => Promise<void>

/* --------------------------------- helpers -------------------------------- */

function StatusChip({ state, install }: { state: VoiceDaemonState; install: VoiceInstallState }) {
  const label = install === 'installing'
    ? 'Installing'
    : install === 'missing'
      ? 'Not installed'
      : install === 'error'
        ? 'Error'
        : state.charAt(0).toUpperCase() + state.slice(1)
  const cls = install === 'installing' ? 'installing' : state
  return (
    <span className={`voice-status-chip ${cls}`}>
      <span className="dot" /> {label}
    </span>
  )
}

function TagInput({
  value,
  onChange,
  placeholder
}: {
  value: string[]
  onChange: (next: string[]) => void
  placeholder?: string
}) {
  const [draft, setDraft] = useState('')
  const commit = () => {
    const t = draft.trim()
    if (!t) return
    if (!value.includes(t)) onChange([...value, t])
    setDraft('')
  }
  const addMany = (items: string[]) => {
    const merged = [...value]
    let changed = false
    for (const raw of items) {
      const t = raw.trim()
      if (t && !merged.includes(t)) { merged.push(t); changed = true }
    }
    if (changed) onChange(merged)
    setDraft('')
  }
  return (
    <div className="tag-input">
      {value.map((tag, i) => (
        <span className="tag" key={i}>
          {tag}
          <button
            type="button"
            aria-label={`Remove ${tag}`}
            onClick={() => onChange(value.filter((_, j) => j !== i))}
          >×</button>
        </span>
      ))}
      <input
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault()
            commit()
          } else if (e.key === 'Backspace' && draft === '' && value.length) {
            onChange(value.slice(0, -1))
          }
        }}
        onPaste={(e) => {
          const text = e.clipboardData.getData('text')
          if (/[,\n]/.test(text)) {
            e.preventDefault()
            addMany(text.split(/[,\n]+/))
          }
        }}
        onBlur={commit}
      />
    </div>
  )
}

/* ---------------------------- hotkey-capture widget ---------------------------- */

function HotkeyCapture({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [capturing, setCapturing] = useState(false)
  // Hold onChange in a ref so re-renders of the parent don't re-register the
  // keydown listener every frame — only capturing toggles matter here.
  const onChangeRef = useRef(onChange)
  useEffect(() => { onChangeRef.current = onChange }, [onChange])

  useEffect(() => {
    if (!capturing) return
    const listener = (e: KeyboardEvent) => {
      e.preventDefault()
      if (e.key === 'Escape') {
        setCapturing(false)
        return
      }
      const parts: string[] = []
      if (e.ctrlKey || e.metaKey) parts.push('ctrl')
      if (e.altKey) parts.push('alt')
      if (e.shiftKey) parts.push('shift')
      const key = e.key.toLowerCase()
      if (!['control', 'meta', 'alt', 'shift'].includes(key)) {
        parts.push(key)
        onChangeRef.current(parts.join('+'))
        setCapturing(false)
      }
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [capturing])

  return (
    <div className="voice-row">
      <input
        type="text"
        value={value}
        readOnly
        aria-label="Hotkey binding (read only — use Record to change)"
      />
      <button
        className={`voice-btn ${capturing ? 'primary' : ''}`}
        type="button"
        onClick={() => setCapturing((s) => !s)}
      >
        {capturing ? 'Press a combo… (Esc to cancel)' : 'Record'}
      </button>
    </div>
  )
}

/* --------------------------------- main app -------------------------------- */

export default function VoiceApp() {
  const [tab, setTab] = useState<Tab>('hotkey')
  const [cfg, setCfg] = useState<VoiceConfig | null>(null)
  const [status, setStatus] = useState<VoiceRuntimeStatus | null>(null)
  const [progress, setProgress] = useState<VoiceSetupProgress | null>(null)
  const [setupLog, setSetupLog] = useState<string[]>([])
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<string>('')
  const [devices, setDevices] = useState<VoiceInputDevice[]>([])
  const [devicesLoading, setDevicesLoading] = useState(false)
  const [devicesError, setDevicesError] = useState<string>('')

  const api = useMemo(() => getDockApi(), [])

  const loadAll = useCallback(async () => {
    const [s, st] = await Promise.all([
      api.voice.getSettings(),
      api.voice.getStatus()
    ])
    setCfg(s)
    setStatus(st)
  }, [api])

  useEffect(() => {
    loadAll().catch((err) => console.error('load voice failed', err))

    const offStatus = api.voice.onStatusChanged((next: VoiceRuntimeStatus) => setStatus(next))
    const offProg = api.voice.setup.onProgress((p: VoiceSetupProgress) => {
      setProgress(p)
      setSetupLog((prev) => [...prev, `[${p.step}] ${p.message}${p.detail ? ` – ${p.detail}` : ''}${p.error ? ` — ${p.error}` : ''}`].slice(-100))
    })
    return () => {
      offStatus()
      offProg()
    }
  }, [api, loadAll])

  // Zoom: Ctrl+MouseWheel and Ctrl++/-/0 with per-window persistence. The
  // initial zoom is applied synchronously by the entry (see voice-zoom.ts) so
  // there is no flash of unzoomed content; this effect only re-applies it for
  // the in-app render path and installs the input listeners. Keyboard
  // shortcuts are skipped while typing into inputs/textareas/contenteditable
  // to avoid stealing Ctrl+0/Ctrl+- combos the user expects to act on text.
  useEffect(() => {
    let zoom = applySavedZoom()
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      zoom = applyZoom(zoom + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP))
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.ctrlKey) return
      if (isEditableTarget(e.target)) return
      if (e.key === '=' || e.key === '+') { e.preventDefault(); zoom = applyZoom(zoom + ZOOM_STEP) }
      else if (e.key === '-') { e.preventDefault(); zoom = applyZoom(zoom - ZOOM_STEP) }
      else if (e.key === '0') { e.preventDefault(); zoom = applyZoom(1) }
    }
    window.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('wheel', onWheel)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  const patch: PatchFn = useCallback(async (p) => {
    const merged = await api.voice.setSettings(p)
    setCfg(merged)
  }, [api])

  const setupNeeded = status?.installState === 'missing' || status?.installState === 'error' || status?.installState === 'unknown'

  const runSetup = async () => {
    setSetupLog([])
    setProgress({ step: 'detect', pct: 0, message: 'Starting setup…' })
    const result = await api.voice.setup.install()
    if (!result?.success) {
      setProgress({ step: 'error', pct: 0, message: 'Setup failed', error: result?.error })
    }
  }

  const runTest = async () => {
    setTesting(true)
    setTestResult('')
    try {
      const r = await api.voice.testRecord(3)
      setTestResult(r.text ?? `Error: ${r.error}`)
    } finally {
      setTesting(false)
    }
  }

  const loadDevices = useCallback(async () => {
    setDevicesLoading(true)
    setDevicesError('')
    try {
      const r = await api.voice.listDevices()
      setDevices(r.devices ?? [])
      if (r.error) setDevicesError(r.error)
    } catch (err) {
      setDevicesError(err instanceof Error ? err.message : String(err))
    } finally {
      setDevicesLoading(false)
    }
  }, [api])

  // Populate the device list the first time the Recording tab is visited so
  // the picker has real options instead of just "system default".
  useEffect(() => {
    if (tab === 'recording' && devices.length === 0 && !devicesLoading && !devicesError) {
      loadDevices().catch(() => { /* already surfaced via devicesError */ })
    }
  }, [tab, devices.length, devicesLoading, devicesError, loadDevices])

  if (!cfg || !status) {
    return (
      <div className="voice-root">
        <div className="voice-content">
          <div className="voice-content-inner">Loading…</div>
        </div>
      </div>
    )
  }

  return (
    <div className="voice-root">
      <div className="voice-titlebar" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
        <div className="voice-titlebar-left" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <h1>Voice</h1>
        </div>
        <div className="voice-titlebar-controls" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <button
            className="voice-titlebar-btn voice-titlebar-action"
            onClick={() => api.voice.openLogs()}
            title="Open logs"
          >
            Logs
          </button>
          <div className="voice-titlebar-separator" />
          <button
            className="voice-titlebar-btn"
            onClick={() => api.win.minimize()}
            title="Minimize"
          >&#x2015;</button>
          <button
            className="voice-titlebar-btn"
            onClick={() => api.win.maximize()}
            title="Maximize"
          >&#9744;</button>
          <button
            className="voice-titlebar-btn close"
            onClick={() => api.voice.close()}
            title="Close"
          >&#10005;</button>
        </div>
      </div>

      <div className="voice-header">
        <StatusChip state={status.daemonState} install={status.installState} />
        <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>
          {status.step}{status.refCount > 0 ? ` · ${status.refCount} workspace(s)` : ''}
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button className="voice-btn" onClick={() => api.voice.restartDaemon()}>Restart daemon</button>
          <button className="voice-btn" onClick={() => api.voice.copyDiagnostics()}>Copy diagnostics</button>
        </div>
      </div>

      <div className="voice-tabs" role="tablist" aria-label="Voice settings sections">
        <button role="tab" aria-selected={tab === 'hotkey'} className={`voice-tab ${tab === 'hotkey' ? 'active' : ''}`} onClick={() => setTab('hotkey')}>Hotkey</button>
        <button role="tab" aria-selected={tab === 'recording'} className={`voice-tab ${tab === 'recording' ? 'active' : ''}`} onClick={() => setTab('recording')}>Recording</button>
        <button role="tab" aria-selected={tab === 'transcriber'} className={`voice-tab ${tab === 'transcriber' ? 'active' : ''}`} onClick={() => setTab('transcriber')}>Transcriber</button>
        <button role="tab" aria-selected={tab === 'setup'} className={`voice-tab ${tab === 'setup' ? 'active' : ''}`} onClick={() => setTab('setup')}>Setup</button>
      </div>

      <div className="voice-content">
        <div className="voice-content-inner">
          {status.lastError && (
            <div className="voice-error-card">{status.lastError}</div>
          )}

          {tab === 'hotkey' && <HotkeyTab cfg={cfg} patch={patch} status={status} />}
          {tab === 'recording' && (
            <RecordingTab
              cfg={cfg}
              patch={patch}
              onTest={runTest}
              onRefreshDevices={loadDevices}
              testing={testing}
              testResult={testResult}
              devices={devices}
              devicesLoading={devicesLoading}
              devicesError={devicesError}
            />
          )}
          {tab === 'transcriber' && <TranscriberTab cfg={cfg} patch={patch} />}
          {tab === 'setup' && <SetupTab cfg={cfg} status={status} onRunSetup={runSetup} onUninstall={() => api.voice.setup.uninstall()} />}
        </div>
      </div>

      {(setupNeeded || status.installState === 'installing') && (
        <SetupWizard
          progress={progress}
          setupLog={setupLog}
          onStart={runSetup}
          installState={status.installState}
        />
      )}
    </div>
  )
}

/* --------------------------------- tabs -------------------------------- */

function HotkeySupportBanner({ support, platform }: { support: VoiceHotkeySupport; platform: NodeJS.Platform }) {
  if (support === 'supported') return null

  const [rechecking, setRechecking] = useState(false)
  const amber = { background: 'rgba(180, 140, 0, 0.12)', borderColor: 'rgba(180, 140, 0, 0.6)', color: 'var(--text-primary)' }

  const onOpenSettings = useCallback(async () => {
    try { await getDockApi().voice.openAccessibilitySettings() } catch { /* ignore — best effort */ }
  }, [])

  const onRecheck = useCallback(async () => {
    setRechecking(true)
    try {
      // Re-query status first so the banner updates instantly, then ask the
      // manager to try restarting the daemon. restartDaemon() is a no-op if
      // the permission is still missing.
      await getDockApi().voice.getStatus()
      await getDockApi().voice.restartDaemon()
    } catch { /* ignore */ }
    setRechecking(false)
  }, [])

  if (support === 'needs-permission') {
    return (
      <div className="voice-error-card" style={amber}>
        <strong>Grant Accessibility permission to use the global hotkey.</strong>{' '}
        macOS requires explicit permission for any app that listens for global keystrokes.
        Open <em>System Settings → Privacy &amp; Security → Accessibility</em> and enable <strong>Claude Dock</strong>, then click Re-check.
        The <code>/voice</code> MCP command works now regardless of permission.
        <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
          <button onClick={onOpenSettings}>Open System Settings</button>
          <button onClick={onRecheck} disabled={rechecking}>{rechecking ? 'Re-checking…' : 'Re-check'}</button>
        </div>
      </div>
    )
  }

  if (support === 'wayland') {
    return (
      <div className="voice-error-card" style={amber}>
        <strong>Global hotkey isn't available on Wayland.</strong>{' '}
        No Linux library can reliably hook global keystrokes under Wayland without a compositor-specific portal.
        Use the <code>/voice</code> slash command in Claude — the MCP server works on Wayland.
        The settings below remain editable so they sync to machines running X11 or Windows.
      </div>
    )
  }

  // 'unsupported' fallback
  const osLabel = platform === 'darwin' ? 'macOS' : platform === 'linux' ? 'Linux' : platform
  return (
    <div className="voice-error-card" style={amber}>
      <strong>Global hotkey isn't supported on {osLabel}.</strong>{' '}
      Voice still works through the <code>/voice</code> slash command in Claude — the MCP server is registered globally.
    </div>
  )
}

function HotkeyTab({ cfg, patch, status }: { cfg: VoiceConfig; patch: PatchFn; status: VoiceRuntimeStatus }) {
  type Mode = VoiceConfig['hotkey']['mode']
  type Scope = VoiceConfig['hotkey']['scope']
  // Hotkey capability varies by OS — see `VoiceHotkeySupport`. The editor
  // always renders so users can configure bindings that sync to other
  // machines, but the "Enabled" toggle and banner adapt to this host's state.
  const hotkeySupport = status.hotkeySupport
  const hotkeySupported = hotkeySupport === 'supported'
  return (
    <>
      <HotkeySupportBanner support={hotkeySupport} platform={status.platform} />
      <div className="voice-section">
        <h3>Hotkey</h3>
        <div className="voice-field">
          <label>Enabled</label>
          <input
            type="checkbox"
            checked={cfg.hotkey.enabled}
            onChange={(e) => patch({ hotkey: { enabled: e.target.checked } })}
            disabled={!hotkeySupported}
          />
        </div>
        <div className="voice-field">
          <label>Binding</label>
          <HotkeyCapture value={cfg.hotkey.binding} onChange={(v) => patch({ hotkey: { binding: v } })} />
        </div>
        <div className="voice-field">
          <label>Mode</label>
          <select value={cfg.hotkey.mode} onChange={(e) => patch({ hotkey: { mode: e.target.value as Mode } })}>
            <option value="toggle">Toggle (press to start, again to stop)</option>
            <option value="hold">Hold (record while held)</option>
          </select>
        </div>
        <div className="voice-field">
          <label>Auto-paste transcription</label>
          <input
            type="checkbox"
            checked={cfg.hotkey.auto_paste}
            onChange={(e) => patch({ hotkey: { auto_paste: e.target.checked } })}
          />
        </div>
        <div className="voice-field">
          <label>Auto-stop on keyword</label>
          <input
            type="checkbox"
            checked={cfg.hotkey.auto_stop_on_keyword}
            onChange={(e) => patch({ hotkey: { auto_stop_on_keyword: e.target.checked } })}
          />
        </div>
      </div>

      <div className="voice-section">
        <h3>Scope</h3>
        <div className="voice-field">
          <label>Where does it fire?</label>
          <select value={cfg.hotkey.scope} onChange={(e) => patch({ hotkey: { scope: e.target.value as Scope } })}>
            <option value="focused">Only in Claude / Dock windows (recommended)</option>
            <option value="global">Anywhere</option>
          </select>
        </div>
        {cfg.hotkey.scope === 'focused' && (
          <>
            <div className="voice-field">
              <label>Window title contains</label>
              <TagInput
                value={cfg.hotkey.scope_title_patterns}
                onChange={(next) => patch({ hotkey: { scope_title_patterns: next } })}
                placeholder="claude"
              />
            </div>
            <div className="voice-field">
              <label>Process name matches</label>
              <TagInput
                value={cfg.hotkey.scope_process_patterns}
                onChange={(next) => patch({ hotkey: { scope_process_patterns: next } })}
                placeholder="claude-dock.exe"
              />
            </div>
          </>
        )}
      </div>

      <div className="voice-section">
        <h3>Keywords</h3>
        <div className="voice-field">
          <label>Auto-send keywords</label>
          <TagInput
            value={cfg.hotkey.auto_send_keywords}
            onChange={(next) => patch({ hotkey: { auto_send_keywords: next } })}
            placeholder="send it"
          />
        </div>
        <div className="voice-field">
          <label>Undo phrases</label>
          <TagInput
            value={cfg.hotkey.undo_phrases}
            onChange={(next) => patch({ hotkey: { undo_phrases: next } })}
            placeholder="forget that"
          />
        </div>
        <div className="voice-field">
          <label>Undo enabled</label>
          <input
            type="checkbox"
            checked={cfg.hotkey.undo_enabled}
            onChange={(e) => patch({ hotkey: { undo_enabled: e.target.checked } })}
          />
        </div>
      </div>
    </>
  )
}

function RecordingTab({
  cfg, patch, onTest, onRefreshDevices, testing, testResult, devices, devicesLoading, devicesError
}: {
  cfg: VoiceConfig
  patch: PatchFn
  onTest: () => void
  onRefreshDevices: () => void
  testing: boolean
  testResult: string
  devices: VoiceInputDevice[]
  devicesLoading: boolean
  devicesError: string
}) {
  // The select's <option> values are strings; map "" back to null for the
  // stored config so the Python side sees "system default" as absent rather
  // than an empty-string device name.
  const selectedValue = cfg.recording.input_device == null
    ? ''
    : String(cfg.recording.input_device)

  const handleDeviceChange = (raw: string) => {
    if (raw === '') {
      patch({ recording: { input_device: null } })
      return
    }
    const asNum = Number(raw)
    patch({ recording: { input_device: Number.isFinite(asNum) ? asNum : raw } })
  }

  // Render the stored device even if the detected list doesn't include it
  // (saved index may have shifted after a reboot / USB mic reconnect).
  const selectedNotInList = cfg.recording.input_device != null
    && !devices.some((d) => String(d.index) === selectedValue)

  return (
    <>
      <div className="voice-section">
        <h3>Input device</h3>
        <div className="voice-field">
          <label>Microphone</label>
          <div className="voice-row" style={{ flex: 1, minWidth: 0, flexWrap: 'wrap' }}>
            <select
              value={selectedValue}
              onChange={(e) => handleDeviceChange(e.target.value)}
              style={{ flex: '1 1 200px', minWidth: 0 }}
            >
              <option value="">System default</option>
              {devices.map((d) => (
                <option key={d.index} value={d.index}>
                  {d.isDefault ? '★ ' : ''}{d.name}{d.hostApi ? ` (${d.hostApi})` : ''}
                </option>
              ))}
              {selectedNotInList && (
                <option value={selectedValue}>
                  {typeof cfg.recording.input_device === 'string'
                    ? `${cfg.recording.input_device} (not detected)`
                    : `Device #${String(cfg.recording.input_device)} (not detected)`}
                </option>
              )}
            </select>
            <button
              className="voice-btn"
              onClick={onRefreshDevices}
              disabled={devicesLoading}
              title="Rescan input devices"
            >
              {devicesLoading ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        </div>
        <div className="voice-field">
          <span />
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            "System default" follows the OS default microphone. Pick a specific device to pin it across reboots.
          </span>
        </div>
        {devicesError && <div className="voice-error-card">{devicesError}</div>}
      </div>

      <div className="voice-section">
        <h3>Recording</h3>
        <div className="voice-field">
          <label>Sample rate (Hz)</label>
          <input
            type="number"
            value={cfg.recording.sample_rate}
            onChange={(e) => patch({ recording: { sample_rate: Number(e.target.value) || 16000 } })}
          />
        </div>
        <div className="voice-field">
          <label>Channels</label>
          <input
            type="number"
            value={cfg.recording.channels}
            min={1} max={2}
            onChange={(e) => patch({ recording: { channels: Number(e.target.value) || 1 } })}
          />
        </div>
        <div className="voice-field">
          <label>Speech threshold</label>
          <input
            type="number"
            value={cfg.recording.speech_threshold}
            onChange={(e) => patch({ recording: { speech_threshold: Number(e.target.value) || 20 } })}
          />
        </div>
        <div className="voice-field">
          <label>Auto-stop on silence</label>
          <input
            type="checkbox"
            checked={cfg.recording.auto_stop_on_silence}
            onChange={(e) => patch({ recording: { auto_stop_on_silence: e.target.checked } })}
          />
        </div>
        <div className="voice-field">
          <label>Max seconds</label>
          <input
            type="number"
            value={cfg.recording.max_seconds}
            onChange={(e) => patch({ recording: { max_seconds: Number(e.target.value) || 300 } })}
          />
        </div>
      </div>

      <div className="voice-section">
        <h3>Test</h3>
        <div className="voice-row">
          <button className="voice-btn primary" onClick={onTest} disabled={testing}>
            {testing ? 'Recording 3 s…' : 'Test recording'}
          </button>
        </div>
        {testResult && (
          <div style={{ marginTop: 10, background: 'var(--bg-tertiary)', padding: 10, borderRadius: 4 }}>
            <strong>Result:</strong> {testResult}
          </div>
        )}
      </div>
    </>
  )
}

function TranscriberTab({ cfg, patch }: { cfg: VoiceConfig; patch: PatchFn }) {
  const isLocal = cfg.transcriber.backend === 'faster_whisper'
  return (
    <>
      <div className="voice-section">
        <h3>Backend</h3>
        <div className="voice-field">
          <label>Transcriber</label>
          <select
            value={cfg.transcriber.backend}
            onChange={(e) => patch({ transcriber: { backend: e.target.value as VoiceConfig['transcriber']['backend'] } })}
          >
            <option value="faster_whisper">Local — faster-whisper (recommended)</option>
            <option value="openai_api">OpenAI Whisper API</option>
          </select>
        </div>
      </div>

      {isLocal ? (
        <div className="voice-section">
          <h3>faster-whisper</h3>
          <div className="voice-field">
            <label>Model size</label>
            <select
              value={cfg.transcriber.faster_whisper.model_size}
              onChange={(e) => patch({ transcriber: { faster_whisper: { model_size: e.target.value } } })}
            >
              {['tiny', 'base', 'small', 'medium', 'large-v3'].map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </div>
          <div className="voice-field">
            <label>Device</label>
            <select
              value={cfg.transcriber.faster_whisper.device}
              onChange={(e) => patch({ transcriber: { faster_whisper: { device: e.target.value as VoiceConfig['transcriber']['faster_whisper']['device'] } } })}
            >
              <option value="auto">auto</option>
              <option value="cpu">cpu</option>
              <option value="cuda">cuda</option>
            </select>
          </div>
          <div className="voice-field">
            <label>Compute type</label>
            <select
              value={cfg.transcriber.faster_whisper.compute_type}
              onChange={(e) => patch({ transcriber: { faster_whisper: { compute_type: e.target.value } } })}
            >
              {['default', 'int8', 'int8_float16', 'float16', 'float32'].map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </div>
          <div className="voice-field">
            <label>Language (2-letter code, empty = auto)</label>
            <input
              type="text"
              value={cfg.transcriber.faster_whisper.language}
              onChange={(e) => patch({ transcriber: { faster_whisper: { language: e.target.value } } })}
            />
          </div>
          <div className="voice-field">
            <label>VAD filter</label>
            <input
              type="checkbox"
              checked={cfg.transcriber.faster_whisper.vad_filter}
              onChange={(e) => patch({ transcriber: { faster_whisper: { vad_filter: e.target.checked } } })}
            />
          </div>
          <div className="voice-field">
            <label>Trim silence</label>
            <input
              type="checkbox"
              checked={cfg.transcriber.faster_whisper.trim_silence}
              onChange={(e) => patch({ transcriber: { faster_whisper: { trim_silence: e.target.checked } } })}
            />
          </div>
          <div className="voice-field">
            <label>Preload on daemon start</label>
            <input
              type="checkbox"
              checked={cfg.transcriber.faster_whisper.preload}
              onChange={(e) => patch({ transcriber: { faster_whisper: { preload: e.target.checked } } })}
            />
          </div>
        </div>
      ) : (
        <div className="voice-section">
          <h3>OpenAI Whisper API</h3>
          <div className="voice-field">
            <label>API key</label>
            <input
              type="password"
              value={cfg.transcriber.openai_api.api_key}
              onChange={(e) => patch({ transcriber: { openai_api: { api_key: e.target.value } } })}
            />
          </div>
          <div className="voice-field">
            <label>Model</label>
            <input
              type="text"
              value={cfg.transcriber.openai_api.model}
              onChange={(e) => patch({ transcriber: { openai_api: { model: e.target.value } } })}
            />
          </div>
        </div>
      )}
    </>
  )
}

function SetupTab({
  status,
  onRunSetup,
  onUninstall
}: {
  cfg: VoiceConfig
  status: VoiceRuntimeStatus
  onRunSetup: () => void
  onUninstall: () => void
}) {
  // Once install has finished, surface any per-OS hotkey capability issue here
  // too (e.g. macOS permission, Linux/Wayland). This completes the setup story:
  // install deps -> grant permission -> done.
  const showHotkeyBanner = status.installState === 'installed' && status.hotkeySupport !== 'supported'
  return (
    <>
      <div className="voice-section">
        <h3>Install state</h3>
        <div className="voice-field"><label>State</label><span>{status.installState}</span></div>
        <div className="voice-field"><label>Python</label><span>{status.pythonPath ?? 'not set'}</span></div>
        <div className="voice-field"><label>MCP entry</label><span>{status.mcpRegisteredPath ?? 'not registered'}</span></div>
        <div className="voice-field"><label>Hotkey support</label><span>{status.hotkeySupport}</span></div>
        <div className="voice-row" style={{ marginTop: 10 }}>
          <button className="voice-btn primary" onClick={onRunSetup}>
            {status.installState === 'installed' ? 'Reinstall' : 'Run setup'}
          </button>
          {status.installState === 'installed' && (
            <button className="voice-btn danger" onClick={onUninstall}>Uninstall</button>
          )}
        </div>
      </div>
      {showHotkeyBanner && (
        <div className="voice-section">
          <h3>Hotkey permission</h3>
          <HotkeySupportBanner support={status.hotkeySupport} platform={status.platform} />
        </div>
      )}
    </>
  )
}

function SetupWizard({
  progress,
  setupLog,
  onStart,
  installState
}: {
  progress: VoiceSetupProgress | null
  setupLog: string[]
  onStart: () => void
  installState: VoiceInstallState
}) {
  const pct = useMemo(() => (progress?.pct ?? 0), [progress])
  const isInstalling = installState === 'installing'
  const cardRef = useRef<HTMLDivElement>(null)
  const primaryBtnRef = useRef<HTMLButtonElement>(null)

  // Focus the primary button on mount so keyboard users can act immediately.
  useEffect(() => {
    primaryBtnRef.current?.focus()
  }, [])

  // Simple focus trap: confine Tab navigation to the modal card.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const card = cardRef.current
      if (!card) return
      const focusable = card.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      )
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement as HTMLElement | null
      if (e.shiftKey && active === first) {
        e.preventDefault(); last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault(); first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div
      className="voice-setup-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="voice-setup-title"
    >
      <div className="voice-setup-card" ref={cardRef}>
        <h2 id="voice-setup-title">Voice setup</h2>
        <p className="sub">
          Voice needs a small Python runtime for transcription and the global hotkey. We'll use a system Python if available, or install an isolated one if not.
        </p>

        {progress && (
          <>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              <strong>{progress.step}</strong> — {progress.message}
            </div>
            <div className="voice-progress">
              <div style={{ width: `${pct}%` }} />
            </div>
            {progress.detail && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{progress.detail}</div>}
            {progress.error && <div className="voice-error-card">{progress.error}</div>}
          </>
        )}

        {setupLog.length > 0 && (
          <pre className="voice-setup-log">{setupLog.join('\n')}</pre>
        )}

        <div className="voice-row" style={{ justifyContent: 'flex-end', marginTop: 16, gap: 8 }}>
          <button
            ref={primaryBtnRef}
            className="voice-btn primary"
            onClick={onStart}
            disabled={isInstalling}
          >
            {isInstalling ? 'Installing…' : installState === 'error' ? 'Retry' : 'Start setup'}
          </button>
        </div>
      </div>
    </div>
  )
}
