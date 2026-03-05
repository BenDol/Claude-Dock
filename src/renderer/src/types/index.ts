import type { DockApi } from '../../../preload/index'

declare global {
  interface Window {
    dockApi: DockApi
  }
}

export interface TerminalInfo {
  id: string
  title: string
  isAlive: boolean
}

export type GridMode = 'auto' | 'freeform'
