import { BrowserWindow } from 'electron'
import { IPC } from '../../shared/ipc-channels'

/**
 * Broadcast plugin window open/close state to all BrowserWindows (dock windows).
 * This allows the dock toolbar to show which plugins have open windows.
 */
export function broadcastPluginWindowState(pluginId: string, projectDir: string, open: boolean): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC.PLUGIN_WINDOW_STATE, { pluginId, projectDir, open })
    }
  }
}
