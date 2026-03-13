import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: vi.fn()
}))

vi.mock('../../settings-store', () => ({
  getSettings: vi.fn().mockReturnValue({ theme: { mode: 'dark' } })
}))

vi.mock('../../logger', () => ({
  log: vi.fn()
}))

vi.mock('../plugin-window-broadcast', () => ({
  broadcastPluginWindowState: vi.fn()
}))

import { PluginWindowManager } from '../plugin-window-manager'

function mockWindow(destroyed = false) {
  return {
    isDestroyed: () => destroyed,
    close: vi.fn(),
    focus: vi.fn(),
    on: vi.fn(),
    loadFile: vi.fn().mockResolvedValue(undefined),
    webContents: { send: vi.fn() }
  }
}

describe('PluginWindowManager', () => {
  let manager: PluginWindowManager

  beforeEach(() => {
    vi.clearAllMocks()
    ;(PluginWindowManager as any).instance = undefined
    manager = PluginWindowManager.getInstance()
  })

  describe('singleton', () => {
    it('returns the same instance', () => {
      expect(PluginWindowManager.getInstance()).toBe(manager)
    })
  })

  describe('getOpenPluginIds', () => {
    it('returns empty array when no windows are open', () => {
      expect(manager.getOpenPluginIds('/project')).toEqual([])
    })

    it('returns plugin ids for the given project directory', () => {
      const windows = (manager as any).windows as Map<string, any>
      windows.set('pluginA:/project', mockWindow())
      windows.set('pluginB:/project', mockWindow())

      expect(manager.getOpenPluginIds('/project')).toEqual(['pluginA', 'pluginB'])
    })

    it('excludes windows for other project directories', () => {
      const windows = (manager as any).windows as Map<string, any>
      windows.set('pluginA:/project', mockWindow())
      windows.set('pluginB:/other', mockWindow())

      expect(manager.getOpenPluginIds('/project')).toEqual(['pluginA'])
    })

    it('excludes destroyed windows', () => {
      const windows = (manager as any).windows as Map<string, any>
      windows.set('pluginA:/project', mockWindow(false))
      windows.set('pluginB:/project', mockWindow(true))

      expect(manager.getOpenPluginIds('/project')).toEqual(['pluginA'])
    })

    it('handles Windows-style paths with colons', () => {
      const windows = (manager as any).windows as Map<string, any>
      windows.set('git-manager:C:\\Projects\\myapp', mockWindow())

      expect(manager.getOpenPluginIds('C:\\Projects\\myapp')).toEqual(['git-manager'])
    })

    it('does not match partial project directory suffixes', () => {
      const windows = (manager as any).windows as Map<string, any>
      windows.set('pluginA:/home/user/project', mockWindow())

      // '/project' is a suffix of '/home/user/project' but different projectDir
      // The key format requires ':' prefix, so ':project' won't match ':home/user/project'
      // ... but '/project' IS a suffix of '/home/user/project', so let's verify
      // key = 'pluginA:/home/user/project', checking endsWith(':/project')
      // '/home/user/project' does NOT end with ':/project' — it ends with '/project'
      // The colon prefix protects against this
      expect(manager.getOpenPluginIds('/project')).toEqual([])
    })
  })
})
