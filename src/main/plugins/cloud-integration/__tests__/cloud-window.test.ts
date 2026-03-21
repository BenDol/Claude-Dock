import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: vi.fn()
}))

vi.mock('../services', () => ({
  getServices: () => ({
    log: vi.fn(),
    logError: vi.fn(),
    getSettings: vi.fn().mockReturnValue({ theme: { mode: 'dark' } }),
    getWindowState: vi.fn().mockReturnValue(null),
    saveWindowState: vi.fn(),
    broadcastPluginWindowState: vi.fn(),
    paths: {
      preload: '/mock/preload/index.js',
      rendererHtml: '/mock/renderer/index.html',
      rendererUrl: undefined,
      rendererOverrideHtml: undefined
    }
  })
}))

vi.mock('../../plugin-renderer-utils', () => ({
  loadPluginWindow: vi.fn().mockResolvedValue(undefined)
}))

import { CloudWindowManager } from '../cloud-window'

function createMockWindow(opts: { destroyed?: boolean; minimized?: boolean } = {}) {
  return {
    isDestroyed: () => opts.destroyed ?? false,
    isMinimized: () => opts.minimized ?? false,
    isMaximized: () => false,
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
    getNormalBounds: vi.fn().mockReturnValue({ x: 0, y: 0, width: 1050, height: 700 }),
    webContents: { send: vi.fn() }
  }
}

describe('CloudWindowManager', () => {
  let manager: CloudWindowManager

  beforeEach(() => {
    vi.clearAllMocks()
    ;(CloudWindowManager as any).instance = undefined
    manager = CloudWindowManager.getInstance()
  })

  it('should be a singleton', () => {
    const instance2 = CloudWindowManager.getInstance()
    expect(manager).toBe(instance2)
  })

  describe('isOpen', () => {
    it('returns false when no window exists', () => {
      expect(manager.isOpen('/project')).toBe(false)
    })

    it('returns true when a non-destroyed window exists', () => {
      const windows = (manager as any).windows as Map<string, any>
      windows.set('/project', createMockWindow())
      expect(manager.isOpen('/project')).toBe(true)
    })

    it('returns false when the window is destroyed', () => {
      const windows = (manager as any).windows as Map<string, any>
      windows.set('/project', createMockWindow({ destroyed: true }))
      expect(manager.isOpen('/project')).toBe(false)
    })
  })

  describe('getWindow', () => {
    it('returns null when no window exists', () => {
      expect(manager.getWindow('/project')).toBeNull()
    })

    it('returns the window when it exists and is not destroyed', () => {
      const windows = (manager as any).windows as Map<string, any>
      const win = createMockWindow()
      windows.set('/project', win)
      expect(manager.getWindow('/project')).toBe(win)
    })

    it('returns null when the window is destroyed', () => {
      const windows = (manager as any).windows as Map<string, any>
      windows.set('/project', createMockWindow({ destroyed: true }))
      expect(manager.getWindow('/project')).toBeNull()
    })
  })

  describe('open', () => {
    it('re-shows existing window instead of creating new one', async () => {
      const windows = (manager as any).windows as Map<string, any>
      const win = createMockWindow()
      windows.set('/project', win)

      await manager.open('/project')

      expect(win.show).toHaveBeenCalled()
      expect(win.focus).toHaveBeenCalled()
    })

    it('restores minimized window on reopen', async () => {
      const windows = (manager as any).windows as Map<string, any>
      const win = createMockWindow({ minimized: true })
      windows.set('/project', win)

      await manager.open('/project')

      expect(win.restore).toHaveBeenCalled()
      expect(win.show).toHaveBeenCalled()
    })
  })

  describe('close', () => {
    it('destroys the window for the given project', () => {
      const windows = (manager as any).windows as Map<string, any>
      const win = createMockWindow()
      windows.set('/project', win)

      manager.close('/project')
      expect(win.destroy).toHaveBeenCalled()
    })

    it('does nothing when no window exists for the project', () => {
      // Should not throw
      manager.close('/nonexistent')
    })

    it('does nothing when window is already destroyed', () => {
      const windows = (manager as any).windows as Map<string, any>
      const win = createMockWindow({ destroyed: true })
      windows.set('/project', win)

      manager.close('/project')
      expect(win.destroy).not.toHaveBeenCalled()
    })
  })

  describe('closeAll', () => {
    it('destroys all windows', () => {
      const windows = (manager as any).windows as Map<string, any>
      const win1 = createMockWindow()
      const win2 = createMockWindow()
      windows.set('/projectA', win1)
      windows.set('/projectB', win2)

      manager.closeAll()

      expect(win1.destroy).toHaveBeenCalled()
      expect(win2.destroy).toHaveBeenCalled()
    })

    it('clears the windows map', () => {
      const windows = (manager as any).windows as Map<string, any>
      windows.set('/project', createMockWindow())

      manager.closeAll()

      expect(windows.size).toBe(0)
    })

    it('skips already-destroyed windows', () => {
      const windows = (manager as any).windows as Map<string, any>
      const alive = createMockWindow()
      const dead = createMockWindow({ destroyed: true })
      windows.set('/alive', alive)
      windows.set('/dead', dead)

      manager.closeAll()

      expect(alive.destroy).toHaveBeenCalled()
      expect(dead.destroy).not.toHaveBeenCalled()
    })
  })
})
