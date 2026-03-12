import { BrowserWindow } from 'electron'
import { IPC } from '../shared/ipc-channels'
import type { DockNotification } from '../shared/ci-types'
import { log } from './logger'

let idCounter = 0

export class NotificationManager {
  private static instance: NotificationManager | null = null

  static getInstance(): NotificationManager {
    if (!NotificationManager.instance) {
      NotificationManager.instance = new NotificationManager()
    }
    return NotificationManager.instance
  }

  notify(notification: Omit<DockNotification, 'id'>): void {
    const full: DockNotification = {
      ...notification,
      id: `notif-${++idCounter}-${Date.now()}`
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
