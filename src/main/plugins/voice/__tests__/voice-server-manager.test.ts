import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'

// Mock electron before it's touched. `detectHotkeySupport()` lazy-requires
// `systemPreferences.isTrustedAccessibilityClient` on macOS — tests flip
// `accessibilityState.trusted` per-test without re-mocking. The state object is
// `vi.hoisted()` so it exists when the mock factory runs (factories are hoisted
// above normal top-level declarations).
const { accessibilityState } = vi.hoisted(() => ({
  accessibilityState: { trusted: true }
}))
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => []
  },
  systemPreferences: {
    isTrustedAccessibilityClient: (_prompt: boolean) => accessibilityState.trusted
  }
}))

// Services
const serviceLogs: string[] = []
const notifyCalls: any[] = []
vi.mock('../services', () => ({
  getServices: () => ({
    log: (msg: string) => serviceLogs.push(msg),
    logError: (msg: string) => serviceLogs.push('ERR: ' + msg),
    paths: { pythonDir: '/mock/python' },
    getVoiceDataDir: () => '/mock/voice-data',
    notify: (p: any) => notifyCalls.push(p)
  })
}))

// Settings store — keep it simple
const cfg = {
  hotkey: { enabled: true },
  transcriber: {},
  recording: {}
}
vi.mock('../voice-settings-store', () => ({
  getVoiceConfig: () => cfg
}))

// Runtime — runtimeExists returns false initially so no daemon is spawned during enable
const runtimeState = { exists: false }
vi.mock('../voice-python-runtime', () => ({
  ensureRuntime: vi.fn().mockResolvedValue({ pythonPath: '/mock/py', venvPython: '/mock/venv/py' }),
  getVenvPython: () => '/mock/venv/py',
  runtimeExists: () => runtimeState.exists,
  uninstallRuntime: vi.fn().mockResolvedValue(undefined)
}))

// MCP register — no-op mocks
vi.mock('../voice-mcp-register', () => ({
  ensureMcpEntry: vi.fn().mockReturnValue({ key: 'voice-input' }),
  getMcpStatus: vi.fn().mockReturnValue({ registered: false, conflictsWithExisting: false }),
  removeMcpEntry: vi.fn(),
  VOICE_MCP_KEY: 'voice-input'
}))

// fs — stub mkdir, writeFileSync, existsSync so materializeConfig doesn't explode
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...actual,
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    existsSync: vi.fn((p: string) => {
      if (p.endsWith('requirements.txt')) return true
      if (p === '/mock/venv/py') return runtimeState.exists
      return false
    })
  }
})

// Spawn is used by startDaemon — return a fake process.
const fakeChildren: FakeChild[] = []
class FakeChild extends EventEmitter {
  pid = 12345
  killed = false
  drainedViaStdin = false
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  // stopDaemon's graceful path writes "shutdown\n" here; simulate a prompt
  // clean exit so tests don't wait out the real 30s drain timeout.
  stdin = {
    destroyed: false,
    write: (chunk: string) => {
      if (chunk.includes('shutdown')) this.drainedViaStdin = true
      return true
    },
    end: () => {
      if (this.drainedViaStdin) {
        setTimeout(() => this.emit('exit', 0, null), 5)
      }
      this.stdin.destroyed = true
    }
  }
  kill(sig?: string) {
    this.killed = true
    // simulate async exit
    setTimeout(() => this.emit('exit', sig === 'SIGKILL' ? null : 0, sig ?? null), 5)
    return true
  }
}
vi.mock('child_process', () => ({
  spawn: vi.fn(() => {
    const c = new FakeChild()
    fakeChildren.push(c)
    return c
  })
}))

import { VoiceServerManager } from '../voice-server-manager'

function resetSingleton() {
  // Reset the cached singleton so each test starts fresh
  ;(VoiceServerManager as any).instance = null
}

// startDaemon() consults `detectHotkeySupport()` on every call. Pin
// `process.platform` (and related env vars on Linux) per-test so we can exercise
// the full Windows / macOS-granted / macOS-missing / Linux-X11 / Linux-Wayland
// support matrix without the host OS bleeding in.
const realPlatform = process.platform
const realXdgSession = process.env.XDG_SESSION_TYPE
const realWaylandDisplay = process.env.WAYLAND_DISPLAY
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}
function setLinuxSession(type: 'x11' | 'wayland'): void {
  if (type === 'wayland') {
    process.env.XDG_SESSION_TYPE = 'wayland'
    process.env.WAYLAND_DISPLAY = 'wayland-0'
  } else {
    process.env.XDG_SESSION_TYPE = 'x11'
    delete process.env.WAYLAND_DISPLAY
  }
}
function restoreLinuxSession(): void {
  if (realXdgSession === undefined) delete process.env.XDG_SESSION_TYPE
  else process.env.XDG_SESSION_TYPE = realXdgSession
  if (realWaylandDisplay === undefined) delete process.env.WAYLAND_DISPLAY
  else process.env.WAYLAND_DISPLAY = realWaylandDisplay
}

describe('voice-server-manager', () => {
  beforeEach(() => {
    resetSingleton()
    runtimeState.exists = false
    serviceLogs.length = 0
    notifyCalls.length = 0
    fakeChildren.length = 0
    accessibilityState.trusted = true
    restoreLinuxSession()
    setPlatform('win32')
  })

  afterEach(() => {
    resetSingleton()
    setPlatform(realPlatform)
    restoreLinuxSession()
  })

  it('ignores empty project dir on enable', async () => {
    const mgr = VoiceServerManager.getInstance()
    await mgr.onProjectEnabled('')
    expect(mgr.getEnabledProjects()).toEqual([])
    expect(mgr.getStatus().refCount).toBe(0)
  })

  it('tracks enabled workspaces via refcount', async () => {
    const mgr = VoiceServerManager.getInstance()
    await mgr.onProjectEnabled('/proj/a')
    await mgr.onProjectEnabled('/proj/b')
    expect(mgr.getEnabledProjects().sort()).toEqual(['/proj/a', '/proj/b'])
    expect(mgr.getStatus().refCount).toBe(2)
  })

  it('removes from refcount on disable', async () => {
    const mgr = VoiceServerManager.getInstance()
    await mgr.onProjectEnabled('/proj/a')
    await mgr.onProjectEnabled('/proj/b')
    mgr.onProjectDisabled('/proj/a')
    expect(mgr.getStatus().refCount).toBe(1)
    expect(mgr.getEnabledProjects()).toEqual(['/proj/b'])
  })

  it('disable for unknown project is a no-op', async () => {
    const mgr = VoiceServerManager.getInstance()
    await mgr.onProjectEnabled('/proj/a')
    mgr.onProjectDisabled('/proj/never-enabled')
    expect(mgr.getStatus().refCount).toBe(1)
  })

  it('does not start daemon on enable when runtime is missing', async () => {
    runtimeState.exists = false
    const mgr = VoiceServerManager.getInstance()
    await mgr.onProjectEnabled('/proj/a')
    expect(fakeChildren.length).toBe(0)
  })

  it('spawns daemon on first enable when runtime exists', async () => {
    runtimeState.exists = true
    const mgr = VoiceServerManager.getInstance()
    await mgr.onProjectEnabled('/proj/a')
    // small grace period handled in startDaemon (500ms)
    await new Promise((r) => setTimeout(r, 550))
    expect(fakeChildren.length).toBe(1)
    expect(mgr.getDaemonState()).toBe('running')
  })

  it('does not spawn a second daemon when another workspace enables', async () => {
    runtimeState.exists = true
    const mgr = VoiceServerManager.getInstance()
    await mgr.onProjectEnabled('/proj/a')
    await new Promise((r) => setTimeout(r, 550))
    await mgr.onProjectEnabled('/proj/b')
    await new Promise((r) => setTimeout(r, 50))
    expect(fakeChildren.length).toBe(1)
    expect(mgr.getStatus().refCount).toBe(2)
  })

  it('stops daemon when the last workspace disables', async () => {
    runtimeState.exists = true
    const mgr = VoiceServerManager.getInstance()
    await mgr.onProjectEnabled('/proj/a')
    await new Promise((r) => setTimeout(r, 550))
    mgr.onProjectDisabled('/proj/a')
    await new Promise((r) => setTimeout(r, 50))
    // Graceful stop drains via stdin first (so any in-flight transcription
    // finishes); the kill signal only escalates if the drain times out.
    expect(fakeChildren[0].drainedViaStdin).toBe(true)
    expect(mgr.getDaemonState()).toBe('stopped')
    expect(fakeChildren[0].killed).toBe(false)
  })

  it('does not restart daemon when no workspaces are enabled', async () => {
    runtimeState.exists = true
    const mgr = VoiceServerManager.getInstance()
    await mgr.onProjectEnabled('/proj/a')
    await new Promise((r) => setTimeout(r, 550))
    // Simulate unexpected exit with no workspaces
    mgr.onProjectDisabled('/proj/a')
    await new Promise((r) => setTimeout(r, 50))
    const childCountBefore = fakeChildren.length
    // now force another "unexpected" exit attempt by calling handler via private hack
    ;(mgr as any).handleUnexpectedExit(1, null)
    await new Promise((r) => setTimeout(r, 50))
    expect(fakeChildren.length).toBe(childCountBefore)
    expect(mgr.getDaemonState()).toBe('stopped')
  })

  it('stops auto-restart after exceeding max restart budget', async () => {
    runtimeState.exists = true
    const mgr = VoiceServerManager.getInstance()
    await mgr.onProjectEnabled('/proj/a')
    await new Promise((r) => setTimeout(r, 550))

    // Directly push restart timestamps so the next unexpected exit trips the limit
    const now = Date.now()
    ;(mgr as any).restartTimestamps = [now, now, now]
    ;(mgr as any).handleUnexpectedExit(1, null)

    expect(mgr.getDaemonState()).toBe('crashed')
    expect(mgr.getStatus().lastError).toMatch(/stopped auto-restart/i)
    expect(notifyCalls.some((n) => n.level === 'error' && /keeps crashing/i.test(n.title))).toBe(true)
  })

  it('emits status events to subscribers', async () => {
    const mgr = VoiceServerManager.getInstance()
    const received: any[] = []
    const unsub = mgr.onStatusChange((s) => received.push(s))
    await mgr.onProjectEnabled('/proj/a')
    unsub()
    expect(received.length).toBeGreaterThan(0)
    expect(received[received.length - 1].refCount).toBe(1)
  })

  it('getStatus returns a copy', () => {
    const mgr = VoiceServerManager.getInstance()
    const s1 = mgr.getStatus()
    ;(s1 as any).refCount = 999
    expect(mgr.getStatus().refCount).not.toBe(999)
  })

  it('reports hotkeySupport: supported on Windows', () => {
    setPlatform('win32')
    resetSingleton()
    const mgr = VoiceServerManager.getInstance()
    const s = mgr.getStatus()
    expect(s.hotkeySupport).toBe('supported')
    expect(s.platform).toBe('win32')
  })

  it('spawns daemon on macOS when Accessibility permission is granted', async () => {
    setPlatform('darwin')
    accessibilityState.trusted = true
    runtimeState.exists = true
    resetSingleton()
    const mgr = VoiceServerManager.getInstance()
    await mgr.onProjectEnabled('/proj/a')
    await new Promise((r) => setTimeout(r, 550))
    expect(fakeChildren.length).toBe(1)
    const s = mgr.getStatus()
    expect(s.hotkeySupport).toBe('supported')
    expect(s.daemonState).toBe('running')
    expect(s.platform).toBe('darwin')
  })

  it('refuses to spawn on macOS when Accessibility permission is missing', async () => {
    setPlatform('darwin')
    accessibilityState.trusted = false
    runtimeState.exists = true
    resetSingleton()
    const mgr = VoiceServerManager.getInstance()
    await mgr.onProjectEnabled('/proj/a')
    await new Promise((r) => setTimeout(r, 550))
    expect(fakeChildren.length).toBe(0)
    const s = mgr.getStatus()
    expect(s.daemonState).toBe('disabled')
    expect(s.hotkeySupport).toBe('needs-permission')
    expect(s.platform).toBe('darwin')
    expect(s.lastError).toMatch(/Accessibility/i)
  })

  it('spawns daemon on Linux under X11', async () => {
    setPlatform('linux')
    setLinuxSession('x11')
    runtimeState.exists = true
    resetSingleton()
    const mgr = VoiceServerManager.getInstance()
    await mgr.onProjectEnabled('/proj/a')
    await new Promise((r) => setTimeout(r, 550))
    expect(fakeChildren.length).toBe(1)
    const s = mgr.getStatus()
    expect(s.hotkeySupport).toBe('supported')
    expect(s.daemonState).toBe('running')
    expect(s.platform).toBe('linux')
  })

  it('refuses to spawn on Linux under Wayland', async () => {
    setPlatform('linux')
    setLinuxSession('wayland')
    runtimeState.exists = true
    resetSingleton()
    const mgr = VoiceServerManager.getInstance()
    await mgr.onProjectEnabled('/proj/a')
    await new Promise((r) => setTimeout(r, 550))
    expect(fakeChildren.length).toBe(0)
    const s = mgr.getStatus()
    expect(s.daemonState).toBe('disabled')
    expect(s.hotkeySupport).toBe('wayland')
    expect(s.platform).toBe('linux')
    expect(s.lastError).toMatch(/Wayland/i)
  })
})
