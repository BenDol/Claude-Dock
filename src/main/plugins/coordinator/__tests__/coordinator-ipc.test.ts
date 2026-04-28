/**
 * Smoke tests for the Coordinator IPC layer.
 *
 * We don't stand up a real Electron main process — that would require
 * booting electron itself. Instead we mock `electron.ipcMain.handle` to
 * capture the per-channel handlers as they register, then invoke them
 * directly as if Electron had dispatched a renderer invoke.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { IPC } from '../../../../shared/ipc-channels'

type Handler = (e: unknown, ...args: unknown[]) => unknown
const handlers = new Map<string, Handler>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => { handlers.set(channel, handler) },
    removeHandler: (channel: string) => { handlers.delete(channel) }
  }
}))

// The hotkey service and window manager both touch electron internals on
// construction — stub them out so registerCoordinatorIpc doesn't crash.
vi.mock('../coordinator-hotkey', () => ({
  CoordinatorHotkeyService: {
    getInstance: () => ({
      restart: vi.fn(),
      getStatus: () => ({ ready: false, using: 'none' })
    })
  }
}))

vi.mock('../coordinator-window', () => ({
  CoordinatorWindowManager: {
    getInstance: () => ({
      open: vi.fn(),
      focus: vi.fn().mockReturnValue(false),
      isOpen: vi.fn().mockReturnValue(false),
      closeAll: vi.fn()
    })
  }
}))

const settingsWindowOpen = vi.fn(async () => {})
const settingsWindowClose = vi.fn()
vi.mock('../coordinator-settings-window', () => ({
  CoordinatorSettingsWindowManager: {
    getInstance: () => ({
      open: settingsWindowOpen,
      close: settingsWindowClose,
      isOpen: () => false
    })
  }
}))

vi.mock('../bundled-services', () => ({
  registerSpawnReplyHandler: vi.fn(),
  unregisterSpawnReplyHandler: vi.fn()
}))

vi.mock('../../../linked-mode', () => ({
  getDataDir: () => 'C:/tmp/dock-link',
  getMcpServerSourcePath: () => 'C:/tmp/claude-dock-mcp.cjs'
}))

vi.mock('electron-store', () => {
  function MockStore(this: any, opts?: any) {
    this.path = '/mock/store.json'
    this.store = opts?.defaults ? { ...opts.defaults } : {}
    this.get = vi.fn((k: string) => this.store[k])
    this.set = vi.fn((k: any, v?: any) => {
      if (typeof k === 'object') this.store = { ...this.store, ...k }
      else this.store[k] = v
    })
    this.delete = vi.fn((k: string) => { delete this.store[k] })
    this.has = vi.fn((k: string) => k in this.store)
    this.clear = vi.fn(() => { this.store = {} })
  }
  return { default: MockStore }
})

vi.mock('fs', () => ({
  existsSync: () => false,
  renameSync: vi.fn()
}))

vi.mock('../../../logger', () => ({
  log: vi.fn(),
  logError: vi.fn()
}))

import { registerCoordinatorIpc, disposeCoordinatorIpc } from '../coordinator-ipc'
import { setServices, __resetCoordinatorServicesForTests } from '../services'
import {
  __resetChatStoreForTests
} from '../coordinator-chat-store'

function installStubServices(): void {
  setServices({
    log: vi.fn(),
    logError: vi.fn(),
    getWindowState: () => undefined,
    saveWindowState: vi.fn(),
    listTerminals: () => [],
    spawnTerminal: async () => 'term-1',
    closeTerminal: vi.fn(),
    writeToTerminal: () => true,
    getWebContentsForProject: () => null,
    getAllCoordinatorWebContents: () => [],
    focusMainWindow: () => null,
    getSettings: () => ({ theme: { mode: 'dark' } }),
    getCoordinatorDataDir: () => 'C:/tmp/coordinator',
    paths: { preload: '', rendererHtml: '', rendererUrl: undefined, rendererOverrideHtml: undefined }
  })
}

beforeEach(() => {
  handlers.clear()
  __resetChatStoreForTests()
  __resetCoordinatorServicesForTests()
  installStubServices()
  registerCoordinatorIpc()
})

describe('coordinator IPC — input validation', () => {
  it('rejects non-string projectDir on getHistory', async () => {
    const h = handlers.get(IPC.COORDINATOR_GET_HISTORY)!
    await expect(h({}, 123)).rejects.toThrow(/projectDir/)
    await expect(h({}, '')).rejects.toThrow(/projectDir/)
    await expect(h({}, null)).rejects.toThrow(/projectDir/)
  })

  it('rejects non-string projectDir on sendMessage', async () => {
    const h = handlers.get(IPC.COORDINATOR_SEND_MESSAGE)!
    await expect(h({}, null, 'hello')).rejects.toThrow(/projectDir/)
    await expect(h({}, '', 'hello')).rejects.toThrow(/projectDir/)
  })

  it('rejects empty userText on sendMessage', async () => {
    const h = handlers.get(IPC.COORDINATOR_SEND_MESSAGE)!
    await expect(h({}, 'C:/Projects/alpha', '')).rejects.toThrow(/non-empty/)
    await expect(h({}, 'C:/Projects/alpha', '   ')).rejects.toThrow(/non-empty/)
  })

  it('rejects non-object patch on setConfig', async () => {
    const h = handlers.get(IPC.COORDINATOR_SET_CONFIG)!
    await expect(h({}, 'string-not-object')).rejects.toThrow(/plain object/)
    await expect(h({}, [])).rejects.toThrow(/plain object/)
    await expect(h({}, null)).rejects.toThrow(/plain object/)
  })
})

describe('coordinator IPC — openSettings', () => {
  it('registers an OPEN_SETTINGS handler', () => {
    expect(handlers.has(IPC.COORDINATOR_OPEN_SETTINGS)).toBe(true)
  })

  it('opens the settings window via the manager', async () => {
    settingsWindowOpen.mockClear()
    const h = handlers.get(IPC.COORDINATOR_OPEN_SETTINGS)!
    await h({})
    expect(settingsWindowOpen).toHaveBeenCalledTimes(1)
  })

  it('rethrows manager failures so the renderer sees them', async () => {
    settingsWindowOpen.mockImplementationOnce(async () => {
      throw new Error('window-open-failed')
    })
    const h = handlers.get(IPC.COORDINATOR_OPEN_SETTINGS)!
    await expect(h({})).rejects.toThrow(/window-open-failed/)
  })
})

describe('coordinator IPC — disposal', () => {
  it('removes every registered handler', () => {
    expect(handlers.size).toBeGreaterThan(0)
    disposeCoordinatorIpc()
    expect(handlers.size).toBe(0)
  })
})
