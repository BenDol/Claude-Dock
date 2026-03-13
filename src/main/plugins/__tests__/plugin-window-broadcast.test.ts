import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSend = vi.fn()

const mockWindows: Array<{ isDestroyed: () => boolean; webContents: { send: typeof mockSend } }> = []

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => mockWindows
  }
}))

import { broadcastPluginWindowState } from '../plugin-window-broadcast'

describe('broadcastPluginWindowState', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockWindows.length = 0
  })

  it('sends state to all non-destroyed windows', () => {
    const send1 = vi.fn()
    const send2 = vi.fn()
    mockWindows.push(
      { isDestroyed: () => false, webContents: { send: send1 } },
      { isDestroyed: () => false, webContents: { send: send2 } }
    )

    broadcastPluginWindowState('git-manager', '/project', true)

    expect(send1).toHaveBeenCalledWith('plugin:windowState', {
      pluginId: 'git-manager',
      projectDir: '/project',
      open: true
    })
    expect(send2).toHaveBeenCalledWith('plugin:windowState', {
      pluginId: 'git-manager',
      projectDir: '/project',
      open: true
    })
  })

  it('skips destroyed windows', () => {
    const send1 = vi.fn()
    const send2 = vi.fn()
    mockWindows.push(
      { isDestroyed: () => true, webContents: { send: send1 } },
      { isDestroyed: () => false, webContents: { send: send2 } }
    )

    broadcastPluginWindowState('my-plugin', '/dir', false)

    expect(send1).not.toHaveBeenCalled()
    expect(send2).toHaveBeenCalledWith('plugin:windowState', {
      pluginId: 'my-plugin',
      projectDir: '/dir',
      open: false
    })
  })

  it('does nothing when no windows exist', () => {
    // mockWindows is empty
    broadcastPluginWindowState('plugin', '/dir', true)
    // No error thrown, no sends called
  })

  it('does nothing when all windows are destroyed', () => {
    const send = vi.fn()
    mockWindows.push(
      { isDestroyed: () => true, webContents: { send } },
      { isDestroyed: () => true, webContents: { send } }
    )

    broadcastPluginWindowState('plugin', '/dir', true)

    expect(send).not.toHaveBeenCalled()
  })
})
