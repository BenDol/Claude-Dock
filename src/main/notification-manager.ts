import { BrowserWindow } from 'electron'
import { IPC } from '../shared/ipc-channels'
import type { DockNotification } from '../shared/ci-types'
import { getSetting } from './settings-store'
import { log } from './logger'

let idCounter = 0

export class NotificationManager {
  private static instance: NotificationManager | null = null
  /** Unique IDs seen this session — for uniquePerSession deduplication */
  private sessionSeenIds = new Set<string>()

  static getInstance(): NotificationManager {
    if (!NotificationManager.instance) {
      NotificationManager.instance = new NotificationManager()
    }
    return NotificationManager.instance
  }

  notify(notification: Omit<DockNotification, 'id'>): void {
    // Check if this source is blocked
    if (notification.source) {
      const blocked = getSetting('behavior')?.blockedNotificationSources ?? []
      if (blocked.includes(notification.source)) {
        log('[notification] blocked (source:', notification.source + ')', notification.title)
        return
      }
    }

    // uniquePerSession: drop if already shown this session
    if (notification.uniqueId && notification.uniquePerSession) {
      if (this.sessionSeenIds.has(notification.uniqueId)) {
        log('[notification] blocked (uniquePerSession, already shown):', notification.uniqueId)
        return
      }
      this.sessionSeenIds.add(notification.uniqueId)
    }

    const full: DockNotification = {
      ...notification,
      id: `notif-${++idCounter}-${Date.now()}`,
      timestamp: notification.timestamp ?? Date.now()
    }

    log('[notification]', full.type, full.title, full.message)

    const windows = BrowserWindow.getAllWindows()
    for (const win of windows) {
      if (!win.isDestroyed() && win.webContents) {
        win.webContents.send(IPC.NOTIFICATION_SHOW, full)
      }
    }
  }
}
