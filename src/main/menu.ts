import { Menu } from 'electron'

export function createAppMenu(): void {
  // Remove the default menu bar entirely
  Menu.setApplicationMenu(null)
}
