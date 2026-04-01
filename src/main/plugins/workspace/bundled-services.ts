import { DockManager } from '../../dock-manager'
import { log, logError } from '../../logger'
import type { WorkspaceServices } from './services'

export function createBundledServices(): WorkspaceServices {
  return {
    log,
    logError,
    sendTaskToDock(projectDir: string, channel: string, data: unknown): boolean {
      const docks = DockManager.getInstance().getAllDocks()
      const normalize = (p: string) => p.replace(/\\/g, '/').toLowerCase()
      const normDir = normalize(projectDir)
      let dock = docks.find((d: any) => normalize(d.projectDir) === normDir)
      if (!dock) dock = docks.find((d: any) => normDir.startsWith(normalize(d.projectDir) + '/'))
      if (dock && !dock.window.isDestroyed()) {
        dock.window.webContents.send(channel, data)
        return true
      }
      return false
    }
  }
}
