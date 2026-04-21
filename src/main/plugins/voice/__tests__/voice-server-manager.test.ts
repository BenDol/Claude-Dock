import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'

// Mock electron before it's touched
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => []
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
  stdout = new EventEmitter()
  stderr = new EventEmitter()
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

// startDaemon() now short-circuits on non-Windows hosts (hotkey is Windows-only).
// Pin `process.platform` to 'win32' for the tests that exercise daemon spawn,
// and restore the host platform afterwards so the suite is OS-agnostic on CI.
const realPlatform = process.platform
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}

describe('voice-server-manager', () => {
  beforeEach(() => {
    resetSingleton()
    runtimeState.exists = false
    serviceLogs.length = 0
    notifyCalls.length = 0
    fakeChildren.length = 0
    setPlatform('win32')
  })

  afterEach(() => {
    resetSingleton()
    setPlatform(realPlatform)
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
    expect(fakeChildren[0].killed).toBe(true)
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

  it('does not spawn daemon on non-Windows hosts', async () => {
    // Hotkey daemon is Windows-only (keyboard lib unsupported elsewhere).
    // On macOS/Linux the manager should short-circuit cleanly and surface
    // a 'disabled' state pointing users at the MCP /voice command.
    setPlatform('darwin')
    runtimeState.exists = true
    resetSingleton()
    const mgr = VoiceServerManager.getInstance()
    await mgr.onProjectEnabled('/proj/a')
    await new Promise((r) => setTimeout(r, 550))
    expect(fakeChildren.length).toBe(0)
    const s = mgr.getStatus()
    expect(s.daemonState).toBe('disabled')
    expect(s.hotkeySupported).toBe(false)
    expect(s.platform).toBe('darwin')
    expect(s.lastError).toMatch(/Windows-only/)
  })

  it('reports hotkeySupported: true on Windows', async () => {
    setPlatform('win32')
    resetSingleton()
    const mgr = VoiceServerManager.getInstance()
    const s = mgr.getStatus()
    expect(s.hotkeySupported).toBe(true)
    expect(s.platform).toBe('win32')
  })
})
