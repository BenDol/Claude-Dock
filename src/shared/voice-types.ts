/**
 * Shared types for the Voice plugin.
 * Used by main (voice-settings-store, IPC handlers) and renderer (Voice window UI).
 */

export type VoiceTranscriberBackend = 'faster_whisper' | 'openai_api'

export interface VoiceFasterWhisperConfig {
  model_size: string           // e.g. 'tiny', 'base', 'small', 'medium', 'large-v3'
  device: 'auto' | 'cpu' | 'cuda'
  compute_type: string         // 'default' | 'int8' | 'int8_float16' | 'float16' | 'float32'
  preload: boolean
  vad_filter: boolean
  beam_size: number
  language: string             // '' for auto-detect, otherwise 2-letter ISO code
  without_timestamps: boolean
  temperature: number
  trim_silence: boolean
  trim_threshold: number
}

export interface VoiceOpenAIApiConfig {
  api_key: string
  model: string                // 'whisper-1' etc.
}

export interface VoiceTranscriberConfig {
  backend: VoiceTranscriberBackend
  faster_whisper: VoiceFasterWhisperConfig
  openai_api: VoiceOpenAIApiConfig
}

export interface VoiceRecordingConfig {
  sample_rate: number
  channels: number
  speech_threshold: number
  auto_stop_on_silence: boolean
  max_seconds: number
  /**
   * Input device for recording. `null` (the default) lets sounddevice pick the
   * system default. A number is an index into `sd.query_devices()`; a string
   * is matched as a substring against the device name.
   */
  input_device: number | string | null
}

export type VoiceHotkeyMode = 'toggle' | 'hold'
export type VoiceHotkeyScope = 'global' | 'focused'

export interface VoiceHotkeyConfig {
  enabled: boolean
  binding: string              // e.g. 'alt+q', 'ctrl+shift+v'
  mode: VoiceHotkeyMode
  auto_paste: boolean
  auto_send_keywords: string[]
  auto_stop_on_keyword: boolean
  undo_enabled: boolean
  undo_phrases: string[]
  scope: VoiceHotkeyScope
  scope_title_patterns: string[]
  scope_process_patterns: string[]
}

export interface VoiceConfig {
  transcriber: VoiceTranscriberConfig
  recording: VoiceRecordingConfig
  hotkey: VoiceHotkeyConfig
  /** Monotonic integer bumped by Dock each time setup is re-run for migration purposes. */
  setupVersion: number
  /** Set to true once initial Python install + MCP registration has completed at least once. */
  setupComplete: boolean
}

/** Default Voice settings. Scope defaults to Claude-focused; user can switch to global. */
export const DEFAULT_VOICE_CONFIG: VoiceConfig = {
  transcriber: {
    backend: 'faster_whisper',
    faster_whisper: {
      model_size: 'base',
      device: 'cpu',
      compute_type: 'int8',
      preload: false,
      vad_filter: true,
      beam_size: 1,
      language: 'en',
      without_timestamps: true,
      temperature: 0.0,
      trim_silence: true,
      trim_threshold: 300
    },
    openai_api: {
      api_key: '',
      model: 'whisper-1'
    }
  },
  recording: {
    sample_rate: 16000,
    channels: 1,
    speech_threshold: 20,
    auto_stop_on_silence: false,
    max_seconds: 300,
    input_device: null
  },
  hotkey: {
    enabled: true,
    binding: 'alt+q',
    mode: 'toggle',
    auto_paste: true,
    auto_send_keywords: ['lets go', 'make it happen', 'go go', 'send it', 'over and out'],
    auto_stop_on_keyword: true,
    undo_enabled: true,
    undo_phrases: ['forget that last part', 'forget that', 'actually forget that'],
    scope: 'focused',
    scope_title_patterns: ['claude', 'claude dock'],
    scope_process_patterns: [
      'cmd.exe',
      'powershell.exe',
      'pwsh.exe',
      'windowsterminal.exe',
      'wt.exe',
      'claude-dock.exe',
      'electron.exe',
      'alacritty.exe',
      'wezterm-gui.exe'
    ]
  },
  setupVersion: 0,
  setupComplete: false
}

/** Runtime / daemon status. Broadcast to the UI via VOICE_STATUS_CHANGED. */
export type VoiceDaemonState = 'stopped' | 'starting' | 'running' | 'crashed' | 'disabled'
export type VoiceInstallState = 'unknown' | 'missing' | 'installing' | 'installed' | 'error'

/**
 * Per-OS capability of the global hotkey daemon. Replaces the old boolean
 * `hotkeySupported` so the UI can show a targeted banner / action per state:
 *   - `supported`        : daemon can run (Windows, Linux/X11, macOS with permission)
 *   - `needs-permission` : macOS without Accessibility permission yet
 *   - `wayland`          : Linux/Wayland — no global hooks available
 *   - `unsupported`      : exotic platform we haven't tested
 */
export type VoiceHotkeySupport = 'supported' | 'needs-permission' | 'wayland' | 'unsupported'

export interface VoiceRuntimeStatus {
  daemonState: VoiceDaemonState
  installState: VoiceInstallState
  /** Number of workspaces that currently have Voice enabled (reference count). */
  refCount: number
  /** PID of the hotkey daemon if running, else null. */
  pid: number | null
  /** Last error message surfaced to the UI, cleared when the daemon stabilises. */
  lastError: string | null
  /** Human-readable step, e.g. 'Daemon ready' / 'Awaiting install'. */
  step: string
  /** Path to the Python interpreter in use (venv or embedded), null before setup. */
  pythonPath: string | null
  /** Absolute path to the registered MCP server entry in ~/.claude.json, null if not registered. */
  mcpRegisteredPath: string | null
  /**
   * Host OS as reported by the main process (`process.platform`). Exposed in
   * the status payload so the renderer can render per-OS copy without an extra
   * IPC round-trip.
   */
  platform: NodeJS.Platform
  /**
   * Capability of the global hotkey daemon on this host. Drives the HotkeyTab
   * banner and the "Enabled" checkbox gating. See `VoiceHotkeySupport`.
   */
  hotkeySupport: VoiceHotkeySupport
}

export interface VoiceSetupProgress {
  /** 'detect' | 'download-python' | 'create-venv' | 'install-deps' | 'verify' | 'register-mcp' | 'done' | 'error' */
  step: string
  pct: number                  // 0–100
  message: string
  detail?: string
  error?: string
}

export interface VoiceMcpStatus {
  registered: boolean
  entry: { command?: string; args?: string[] } | null
  /** Path to ~/.claude.json */
  configPath: string
  /** True if an existing voice-input entry points somewhere else than Dock's bundled server. */
  conflictsWithExisting: boolean
  existingPath?: string
}

export type VoiceMcpConflictAction = 'overwrite' | 'rename' | 'cancel'

/** Single input device entry returned by VOICE_LIST_DEVICES. */
export interface VoiceInputDevice {
  /** Index into sounddevice's device list — stable within a host API boundary. */
  index: number
  name: string
  hostApi: string
  maxInputChannels: number
  defaultSampleRate: number
  /** True when this is the system default input device. */
  isDefault: boolean
}

export interface VoiceListDevicesResult {
  devices: VoiceInputDevice[]
  /** Raw sd.query_devices() text, preserved for the diagnostic pane. */
  output: string
  error?: string
}
