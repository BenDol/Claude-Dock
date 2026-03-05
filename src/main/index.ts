import { app, BrowserWindow } from 'electron'
import { DockManager } from './dock-manager'
import { registerIpcHandlers } from './ipc-handlers'
import { createAppMenu } from './menu'

// Handle creating/removing shortcuts on Windows when installing/uninstalling
if (require('electron-squirrel-startup') === true) {
  app.quit()
}

app.whenReady().then(async () => {
  createAppMenu()
  registerIpcHandlers()

  // Open first dock with directory picker
  const manager = DockManager.getInstance()
  await manager.createDock()

  // macOS: re-create window when dock icon clicked
  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await manager.createDock()
    }
  })
})

// Quit when all windows are closed (except on macOS)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  DockManager.getInstance().shutdownAll()
})
