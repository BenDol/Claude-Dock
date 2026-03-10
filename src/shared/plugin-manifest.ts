import type { PluginSettingDef } from './plugin-types'

export interface PluginManifest {
  id: string
  name: string
  version: string
  description: string
  defaultEnabled: boolean
  main: string // relative path to main process JS (CommonJS)
  settingsSchema?: PluginSettingDef[]
  toolbar?: {
    title: string
    icon: string // SVG markup string
    action: string // IPC channel to invoke with (projectDir)
    order?: number
  }
  window?: {
    entry: string // relative path to renderer HTML
    width?: number
    height?: number
    minWidth?: number
    minHeight?: number
  }
}
