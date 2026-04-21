import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// --- mocks ------------------------------------------------------------------

// vi.mock factories are hoisted above top-level variables, so any shared state
// they reference must live in vi.hoisted().
const UIOHOOK_SHIFT = 42
const UIOHOOK_LEFT_SHIFT = 42
const UIOHOOK_RIGHT_SHIFT = 54
const UIOHOOK_A = 30

const h = vi.hoisted(() => {
  return {
    uiohookOn: vi.fn(),
    uiohookOff: vi.fn(),
    uiohookStart: vi.fn(),
    uiohookStop: vi.fn(),
    uiohookRemoveAll: vi.fn(),
    globalShortcutRegister: vi.fn().mockReturnValue(true),
    globalShortcutUnregister: vi.fn(),
    globalShortcutIsRegistered: vi.fn().mockReturnValue(false),
    getAllDocks: vi.fn().mockReturnValue([]),
    mockConfig: {
      hotkeyEnabled: true,
      hotkeyDoubleTapMs: 350,
      fallbackGlobalShortcut: 'Control+Shift+K',
      floatingWindowByDefault: false
    }
  }
})

vi.mock('../uiohook-loader', () => ({
  loadUiohookModule: () => ({
    uIOhook: {
      on: h.uiohookOn,
      off: h.uiohookOff,
      start: h.uiohookStart,
      stop: h.uiohookStop,
      removeAllListeners: h.uiohookRemoveAll
    },
    UiohookKey: {
      Shift: 42,
      ShiftLeft: 42,
      ShiftRight: 54,
      A: 30
    }
  })
}))

vi.mock('electron', () => ({
  BrowserWindow: { getFocusedWindow: vi.fn().mockReturnValue(null) },
  globalShortcut: {
    register: h.globalShortcutRegister,
    unregister: h.globalShortcutUnregister,
    isRegistered: h.globalShortcutIsRegistered
  }
}))

vi.mock('../../../dock-manager', () => ({
  DockManager: { getInstance: () => ({ getAllDocks: h.getAllDocks }) }
}))

vi.mock('../coordinator-window', () => ({
  CoordinatorWindowManager: {
    getInstance: () => ({
      open: vi.fn().mockResolvedValue(undefined),
      getWindow: vi.fn().mockReturnValue(null),
      isOpen: vi.fn().mockReturnValue(false),
      focus: vi.fn().mockReturnValue(false)
    })
  }
}))

vi.mock('../coordinator-settings-store', () => ({
  getCoordinatorConfig: () => h.mockConfig
}))

vi.mock('../services', () => ({
  getServices: () => ({
    log: vi.fn(),
    logError: vi.fn(),
    focusMainWindow: vi.fn().mockReturnValue(null),
    paths: {},
    listTerminals: vi.fn().mockReturnValue([]),
    spawnTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    promptTerminal: vi.fn(),
    getSettings: () => ({ theme: { mode: 'dark' } }),
    getWindowState: vi.fn(),
    saveWindowState: vi.fn()
  })
}))

// Aliases for readability inside tests.
const {
  uiohookOn,
  uiohookOff,
  uiohookStart,
  uiohookStop,
  uiohookRemoveAll,
  globalShortcutRegister,
  globalShortcutUnregister,
  globalShortcutIsRegistered,
  getAllDocks,
  mockConfig
} = h

import { CoordinatorHotkeyService } from '../coordinator-hotkey'

type Handler = (e: { keycode: number }) => void

function capturedListeners(): { down: Handler; up: Handler } {
  const down = uiohookOn.mock.calls.find((c) => c[0] === 'keydown')?.[1] as Handler
  const up = uiohookOn.mock.calls.find((c) => c[0] === 'keyup')?.[1] as Handler
  if (!down || !up) throw new Error('listeners were not registered')
  return { down, up }
}

describe('CoordinatorHotkeyService — uiohook backend', () => {
  let service: CoordinatorHotkeyService

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'))
    uiohookOn.mockReset()
    uiohookOff.mockReset()
    uiohookStart.mockReset()
    uiohookStop.mockReset()
    uiohookRemoveAll.mockReset()
    getAllDocks.mockReset()
    getAllDocks.mockReturnValue([])
    globalShortcutRegister.mockReset()
    globalShortcutRegister.mockReturnValue(true)
    globalShortcutUnregister.mockReset()
    globalShortcutIsRegistered.mockReset()
    globalShortcutIsRegistered.mockReturnValue(false)
    mockConfig.hotkeyDoubleTapMs = 350
    mockConfig.hotkeyEnabled = true
    mockConfig.floatingWindowByDefault = false

    service = CoordinatorHotkeyService.getInstance()
    // Stop any previous state leaked from earlier tests.
    service.stop()
  })

  afterEach(() => {
    service.stop()
    vi.useRealTimers()
  })

  it('starts in uiohook mode and reports ready', () => {
    service.start()
    const status = service.getStatus()
    expect(status.ready).toBe(true)
    expect(status.using).toBe('uiohook')
    expect(status.error).toBeUndefined()
    expect(uiohookStart).toHaveBeenCalledOnce()
  })

  it('fires on a Shift-up → Shift-down double-tap within the threshold', () => {
    service.start()
    const { down, up } = capturedListeners()

    down({ keycode: UIOHOOK_SHIFT })  // first press — arms
    up({ keycode: UIOHOOK_SHIFT })    // release — sets lastShiftUp
    vi.advanceTimersByTime(100)       // under threshold
    down({ keycode: UIOHOOK_SHIFT })  // second press — should fire

    // fire() → pickTargetProject() → DockManager.getInstance().getAllDocks()
    expect(getAllDocks).toHaveBeenCalled()
  })

  it('does not fire when the gap exceeds hotkeyDoubleTapMs', () => {
    service.start()
    const { down, up } = capturedListeners()

    down({ keycode: UIOHOOK_SHIFT })
    up({ keycode: UIOHOOK_SHIFT })
    vi.advanceTimersByTime(500)       // exceeds 350ms threshold
    down({ keycode: UIOHOOK_SHIFT })

    expect(getAllDocks).not.toHaveBeenCalled()
  })

  it('does not fire when a non-Shift key is pressed between Shift-down and Shift-up (chord)', () => {
    service.start()
    const { down, up } = capturedListeners()

    down({ keycode: UIOHOOK_SHIFT })  // Shift held
    down({ keycode: UIOHOOK_A })      // chord: Shift+A — should disarm
    up({ keycode: UIOHOOK_SHIFT })
    vi.advanceTimersByTime(50)
    down({ keycode: UIOHOOK_SHIFT })

    expect(getAllDocks).not.toHaveBeenCalled()
  })

  it('does not fire when a non-Shift key is pressed between the two Shift presses', () => {
    service.start()
    const { down, up } = capturedListeners()

    down({ keycode: UIOHOOK_SHIFT })
    up({ keycode: UIOHOOK_SHIFT })
    vi.advanceTimersByTime(50)
    down({ keycode: UIOHOOK_A })      // disarms lastShiftUp
    vi.advanceTimersByTime(50)
    down({ keycode: UIOHOOK_SHIFT })

    expect(getAllDocks).not.toHaveBeenCalled()
  })

  it('respects a custom hotkeyDoubleTapMs from config', () => {
    mockConfig.hotkeyDoubleTapMs = 150
    service.start()
    const { down, up } = capturedListeners()

    down({ keycode: UIOHOOK_SHIFT })
    up({ keycode: UIOHOOK_SHIFT })
    vi.advanceTimersByTime(200)       // would pass default 350, but fails 150
    down({ keycode: UIOHOOK_SHIFT })

    expect(getAllDocks).not.toHaveBeenCalled()
  })

  it('treats left and right Shift keycodes as equivalent', () => {
    service.start()
    const { down, up } = capturedListeners()

    down({ keycode: UIOHOOK_LEFT_SHIFT })
    up({ keycode: UIOHOOK_LEFT_SHIFT })
    vi.advanceTimersByTime(100)
    down({ keycode: UIOHOOK_RIGHT_SHIFT })

    expect(getAllDocks).toHaveBeenCalled()
  })

  it('start() is idempotent', () => {
    service.start()
    service.start()
    // Only one pair of listeners should be wired up.
    expect(uiohookStart).toHaveBeenCalledOnce()
  })

  it('stop() releases uiohook resources and reports not-ready', () => {
    service.start()
    service.stop()
    expect(uiohookStop).toHaveBeenCalled()
    const status = service.getStatus()
    expect(status.ready).toBe(false)
    expect(status.using).toBe('none')
  })

  it('stop() is safe to call before start()', () => {
    expect(() => service.stop()).not.toThrow()
  })
})

describe('CoordinatorHotkeyService — globalShortcut fallback', () => {
  beforeEach(() => {
    uiohookOn.mockClear()
    uiohookStart.mockClear()
    uiohookStart.mockImplementation(() => {
      throw new Error('simulated uiohook start failure')
    })
    globalShortcutRegister.mockClear()
    globalShortcutRegister.mockReturnValue(true)
    globalShortcutIsRegistered.mockReturnValue(false)
    mockConfig.fallbackGlobalShortcut = 'Control+Shift+K'
  })

  afterEach(() => {
    uiohookStart.mockReset()
    uiohookStart.mockImplementation(() => undefined)
    CoordinatorHotkeyService.getInstance().stop()
  })

  it('falls back to globalShortcut when uiohook.start() throws', () => {
    const service = CoordinatorHotkeyService.getInstance()
    service.stop()
    service.start()
    const status = service.getStatus()
    expect(status.using).toBe('globalShortcut')
    expect(status.ready).toBe(true)
    expect(globalShortcutRegister).toHaveBeenCalledWith('Control+Shift+K', expect.any(Function))
  })

  it('reports not-ready when both uiohook and globalShortcut fail', () => {
    globalShortcutRegister.mockReturnValue(false)
    const service = CoordinatorHotkeyService.getInstance()
    service.stop()
    service.start()
    const status = service.getStatus()
    expect(status.using).toBe('none')
    expect(status.ready).toBe(false)
    expect(status.error).toBeDefined()
  })

  it('unregisters the accelerator on stop()', () => {
    const service = CoordinatorHotkeyService.getInstance()
    service.stop()
    service.start()
    service.stop()
    expect(globalShortcutUnregister).toHaveBeenCalledWith('Control+Shift+K')
  })
})

describe('CoordinatorHotkeyService — disabled by config', () => {
  afterEach(() => {
    CoordinatorHotkeyService.getInstance().stop()
  })

  it('start() is a no-op when hotkeyEnabled is false', () => {
    uiohookStart.mockClear()
    globalShortcutRegister.mockClear()
    mockConfig.hotkeyEnabled = false

    const service = CoordinatorHotkeyService.getInstance()
    service.stop()
    service.start()

    const status = service.getStatus()
    expect(status.ready).toBe(false)
    expect(status.using).toBe('none')
    expect(uiohookStart).not.toHaveBeenCalled()
    expect(globalShortcutRegister).not.toHaveBeenCalled()

    mockConfig.hotkeyEnabled = true
  })
})
