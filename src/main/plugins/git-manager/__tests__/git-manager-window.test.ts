import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: vi.fn()
}))

vi.mock('../services', () => ({
  getServices: () => ({
    log: vi.fn(),
    logInfo: vi.fn(),
    logError: vi.fn(),
    getSettings: vi.fn().mockReturnValue({ theme: { mode: 'dark' } }),
    getWindowState: vi.fn().mockReturnValue(null),
    saveWindowState: vi.fn(),
    broadcastPluginWindowState: vi.fn(),
    paths: {
      preload: '/mock/preload/index.js',
      rendererHtml: '/mock/renderer/index.html',
      rendererUrl: undefined
    }
  })
}))

import { GitManagerWindowManager } from '../git-manager-window'

function mockWindow(destroyed = false) {
  return {
    isDestroyed: () => destroyed,
    isMinimized: () => false,
    close: vi.fn(),
    destroy: vi.fn(),
    hide: vi.fn(),
    focus: vi.fn(),
    show: vi.fn(),
    restore: vi.fn(),
    maximize: vi.fn(),
    on: vi.fn(),
    loadURL: vi.fn().mockResolvedValue(undefined),
    loadFile: vi.fn().mockResolvedValue(undefined),
    getNormalBounds: vi.fn().mockReturnValue({ x: 0, y: 0, width: 1100, height: 750 }),
    isMaximized: () => false,
    webContents: { send: vi.fn() }
  }
}

describe('GitManagerWindowManager', () => {
  let manager: GitManagerWindowManager

  beforeEach(() => {
    vi.clearAllMocks()
    ;(GitManagerWindowManager as any).instance = undefined
    manager = GitManagerWindowManager.getInstance()
  })

  describe('singleton', () => {
    it('returns the same instance', () => {
      expect(GitManagerWindowManager.getInstance()).toBe(manager)
    })
  })

  describe('isOpen', () => {
    it('returns false when no window exists for the project', () => {
      expect(manager.isOpen('/project')).toBe(false)
    })

    it('returns true when a non-destroyed window exists', () => {
      const windows = (manager as any).windows as Map<string, any>
      windows.set('/project', mockWindow(false))

      expect(manager.isOpen('/project')).toBe(true)
    })

    it('returns false when the window is destroyed', () => {
      const windows = (manager as any).windows as Map<string, any>
      windows.set('/project', mockWindow(true))

      expect(manager.isOpen('/project')).toBe(false)
    })

    it('checks the correct project directory', () => {
      const windows = (manager as any).windows as Map<string, any>
      windows.set('/projectA', mockWindow(false))

      expect(manager.isOpen('/projectA')).toBe(true)
      expect(manager.isOpen('/projectB')).toBe(false)
    })
  })
})
