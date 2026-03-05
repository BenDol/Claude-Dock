import { dialog } from 'electron'
import { DockWindow } from './dock-window'

let nextId = 1

export class DockManager {
  private static instance: DockManager
  private docks = new Map<string, DockWindow>()

  static getInstance(): DockManager {
    if (!DockManager.instance) {
      DockManager.instance = new DockManager()
    }
    return DockManager.instance
  }

  async createDock(projectDir?: string): Promise<DockWindow | null> {
    let dir = projectDir

    if (!dir) {
      const result = await dialog.showOpenDialog({
        properties: ['openDirectory'],
        title: 'Select Project Directory'
      })
      if (result.canceled || result.filePaths.length === 0) {
        return null
      }
      dir = result.filePaths[0]
    }

    const id = `dock-${nextId++}`
    const dock = new DockWindow(id, dir)

    this.docks.set(id, dock)

    dock.window.on('closed', () => {
      this.docks.delete(id)
    })

    await dock.loadRenderer()
    return dock
  }

  getDock(id: string): DockWindow | undefined {
    return this.docks.get(id)
  }

  getAllDocks(): DockWindow[] {
    return Array.from(this.docks.values())
  }

  shutdownAll(): void {
    for (const dock of this.docks.values()) {
      dock.close()
    }
    this.docks.clear()
  }

  get size(): number {
    return this.docks.size
  }
}
