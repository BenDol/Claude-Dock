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
    icon: string // SVG markup string, or relative path to an .svg file in the plugin directory
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
  updateUrl?: string // URL to update manifest JSON (external plugins set this in plugin.json)
  buildSha?: string // git SHA that produced this version
}
