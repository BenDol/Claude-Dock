import { BrowserWindow, Notification } from 'electron'
import { getSettings } from './settings-store'
import { log } from './logger'

interface TerminalState {
  lineCount: number
  idleTimer: ReturnType<typeof setTimeout> | null
}

export class IdleNotifier {
  private terminals = new Map<string, TerminalState>()
  private window: BrowserWindow

  constructor(window: BrowserWindow) {
    this.window = window
  }

  trackData(terminalId: string, data: string): void {
    const { idleNotification, idleNotificationMinLines, idleNotificationDelayMs } =
      getSettings().behavior
    if (!idleNotification) return

    let state = this.terminals.get(terminalId)
    if (!state) {
      state = { lineCount: 0, idleTimer: null }
      this.terminals.set(terminalId, state)
    }

    // Count newlines in the data chunk
    for (let i = 0; i < data.length; i++) {
      if (data.charCodeAt(i) === 10) state.lineCount++
    }

    // Reset idle timer
    if (state.idleTimer) clearTimeout(state.idleTimer)

    const lineSnapshot = state.lineCount
    state.idleTimer = setTimeout(() => {
      this.onIdle(terminalId, lineSnapshot, idleNotificationMinLines)
    }, idleNotificationDelayMs)
  }

  private onIdle(terminalId: string, lineCount: number, minLines: number): void {
    const state = this.terminals.get(terminalId)
    if (state) {
      state.idleTimer = null
      state.lineCount = 0
    }

    if (lineCount < minLines) return
    if (this.window.isDestroyed()) return

    // Only notify when the dock window is NOT focused
    if (this.window.isFocused()) return

    log(`IdleNotifier: terminal ${terminalId} went idle after ${lineCount} lines`)

    // Flash taskbar icon
    this.window.flashFrame(true)

    // Send OS native notification
    if (Notification.isSupported()) {
      const notif = new Notification({
        title: 'Terminal Idle',
        body: `A terminal finished its output (${lineCount} lines).`,
        silent: true
      })
      notif.on('click', () => {
        if (!this.window.isDestroyed()) {
          this.window.show()
          this.window.focus()
          // Stop flashing once the user clicks
          this.window.flashFrame(false)
        }
      })
      notif.show()
    }
  }

  removeTerminal(terminalId: string): void {
    const state = this.terminals.get(terminalId)
    if (state?.idleTimer) clearTimeout(state.idleTimer)
    this.terminals.delete(terminalId)
  }

  dispose(): void {
    for (const state of this.terminals.values()) {
      if (state.idleTimer) clearTimeout(state.idleTimer)
    }
    this.terminals.clear()
  }
}
