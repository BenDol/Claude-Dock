import { describe, it, expect, vi, beforeEach } from 'vitest'

// Hoisted mocks
const { mockGetSetting, mockGetAllWindows, mockLog } = vi.hoisted(() => ({
  mockGetSetting: vi.fn(),
  mockGetAllWindows: vi.fn().mockReturnValue([]),
  mockLog: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: mockGetAllWindows
  }
}))

vi.mock('../settings-store', () => ({
  getSetting: mockGetSetting
}))

vi.mock('../logger', () => ({
  log: mockLog
}))

import { NotificationManager } from '../notification-manager'

describe('NotificationManager', () => {
  let manager: NotificationManager

  beforeEach(() => {
    vi.clearAllMocks()
    // Reset singleton so each test gets a fresh instance
    ;(NotificationManager as any).instance = null
    manager = NotificationManager.getInstance()

    // Default: no blocked sources
    mockGetSetting.mockReturnValue({ blockedNotificationSources: [] })
  })

  describe('source blocking', () => {
    it('blocks notifications from a blocked source', () => {
      mockGetSetting.mockReturnValue({ blockedNotificationSources: ['git-manager'] })

      manager.notify({
        title: 'CI Run Started',
        message: 'Build #1 on main',
        type: 'info',
        source: 'git-manager'
      })

      // Should not send to any windows
      expect(mockGetAllWindows).not.toHaveBeenCalled()
      // Should log the block
      expect(mockLog).toHaveBeenCalledWith(
        '[notification] blocked (source:',
        'git-manager)',
        'CI Run Started'
      )
    })

    it('allows notifications from non-blocked sources', () => {
      mockGetSetting.mockReturnValue({ blockedNotificationSources: ['updater'] })
      const mockWin = { isDestroyed: () => false, webContents: { send: vi.fn() } }
      mockGetAllWindows.mockReturnValue([mockWin])

      manager.notify({
        title: 'CI Run Started',
        message: 'Build #1 on main',
        type: 'info',
        source: 'git-manager'
      })

      expect(mockWin.webContents.send).toHaveBeenCalled()
    })

    it('allows notifications with no source', () => {
      mockGetSetting.mockReturnValue({ blockedNotificationSources: ['git-manager'] })
      const mockWin = { isDestroyed: () => false, webContents: { send: vi.fn() } }
      mockGetAllWindows.mockReturnValue([mockWin])

      manager.notify({
        title: 'Something happened',
        message: 'Details',
        type: 'info'
      })

      expect(mockWin.webContents.send).toHaveBeenCalled()
    })

    it('blocks multiple sources independently', () => {
      mockGetSetting.mockReturnValue({
        blockedNotificationSources: ['updater', 'git-manager']
      })

      manager.notify({
        title: 'Update available',
        message: 'v2.0',
        type: 'info',
        source: 'updater'
      })

      manager.notify({
        title: 'CI Run Failed',
        message: 'Build #5',
        type: 'error',
        source: 'git-manager'
      })

      expect(mockGetAllWindows).not.toHaveBeenCalled()
    })

    it('handles missing blockedNotificationSources gracefully', () => {
      // Simulates older stored settings without the field
      mockGetSetting.mockReturnValue({})
      const mockWin = { isDestroyed: () => false, webContents: { send: vi.fn() } }
      mockGetAllWindows.mockReturnValue([mockWin])

      manager.notify({
        title: 'CI Run Started',
        message: 'Build #1',
        type: 'info',
        source: 'git-manager'
      })

      expect(mockWin.webContents.send).toHaveBeenCalled()
    })

    it('handles getSetting returning undefined', () => {
      mockGetSetting.mockReturnValue(undefined)
      const mockWin = { isDestroyed: () => false, webContents: { send: vi.fn() } }
      mockGetAllWindows.mockReturnValue([mockWin])

      manager.notify({
        title: 'Test',
        message: 'msg',
        type: 'info',
        source: 'git-manager'
      })

      expect(mockWin.webContents.send).toHaveBeenCalled()
    })
  })

  describe('notify delivery', () => {
    it('sends notification to all non-destroyed windows', () => {
      const send1 = vi.fn()
      const send2 = vi.fn()
      mockGetAllWindows.mockReturnValue([
        { isDestroyed: () => false, webContents: { send: send1 } },
        { isDestroyed: () => false, webContents: { send: send2 } }
      ])

      manager.notify({ title: 'Hello', message: 'World', type: 'info' })

      expect(send1).toHaveBeenCalledTimes(1)
      expect(send2).toHaveBeenCalledTimes(1)
    })

    it('skips destroyed windows', () => {
      const sendAlive = vi.fn()
      const sendDead = vi.fn()
      mockGetAllWindows.mockReturnValue([
        { isDestroyed: () => true, webContents: { send: sendDead } },
        { isDestroyed: () => false, webContents: { send: sendAlive } }
      ])

      manager.notify({ title: 'Hello', message: 'World', type: 'info' })

      expect(sendDead).not.toHaveBeenCalled()
      expect(sendAlive).toHaveBeenCalledTimes(1)
    })

    it('assigns unique incrementing ids', () => {
      const sent: any[] = []
      const mockWin = {
        isDestroyed: () => false,
        webContents: { send: vi.fn((_ch: string, notif: any) => sent.push(notif)) }
      }
      mockGetAllWindows.mockReturnValue([mockWin])

      manager.notify({ title: 'A', message: 'a', type: 'info' })
      manager.notify({ title: 'B', message: 'b', type: 'info' })

      expect(sent).toHaveLength(2)
      expect(sent[0].id).not.toBe(sent[1].id)
      expect(sent[0].id).toMatch(/^notif-\d+-\d+$/)
      expect(sent[1].id).toMatch(/^notif-\d+-\d+$/)
    })
  })
})
