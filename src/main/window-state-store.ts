import Store from 'electron-store'
import { screen } from 'electron'

export interface WindowState {
  x: number
  y: number
  width: number
  height: number
  maximized: boolean
}

interface WindowStateData {
  [normalizedPath: string]: WindowState
}

let store: Store<WindowStateData> | null = null

function getStore(): Store<WindowStateData> {
  if (!store) {
    store = new Store<WindowStateData>({
      name: 'window-state'
    })
  }
  return store
}

function normalizePath(dir: string): string {
  return dir.replace(/\\/g, '/').toLowerCase()
}

export function getWindowState(projectDir: string): WindowState | undefined {
  const key = normalizePath(projectDir)
  const state = getStore().get(key) as WindowState | undefined
  if (!state) return undefined

  // Validate the saved position is visible on a current display
  if (!isVisibleOnAnyDisplay(state)) {
    return undefined
  }

  return state
}

export function saveWindowState(projectDir: string, state: WindowState): void {
  const key = normalizePath(projectDir)
  getStore().set(key, state)
}

function isVisibleOnAnyDisplay(state: WindowState): boolean {
  const displays = screen.getAllDisplays()
  const centerX = state.x + Math.floor(state.width / 2)
  const centerY = state.y + Math.floor(state.height / 2)

  for (const display of displays) {
    const { x, y, width, height } = display.workArea
    if (centerX >= x && centerX < x + width && centerY >= y && centerY < y + height) {
      return true
    }
  }
  return false
}
