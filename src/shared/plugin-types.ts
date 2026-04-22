/** Unique identifier for a plugin (e.g. 'git-manager') */
export type PluginId = string

/** Per-project plugin state stored in electron-store */
export interface PluginProjectState {
  enabled: boolean
  settings: Record<string, unknown>
}

/** Plugin metadata exposed to the renderer */
export interface PluginInfo {
  id: PluginId
  name: string
  description: string
  defaultEnabled: boolean
  version: string
  source: 'builtin' | 'external'
  /** Keys of plugin-specific settings for the UI to render */
  settingsSchema?: PluginSettingDef[]
}

export interface PluginSettingDef {
  key: string
  label: string
  /** Help text shown as a tooltip on hover */
  description?: string
  type: 'boolean' | 'string' | 'number' | 'select'
  /** Placeholder text for string/number inputs */
  placeholder?: string
  /** Choices for type: 'select' */
  options?: { value: string; label: string }[]
  defaultValue: unknown
}

/** State for all plugins for a given project */
export type ProjectPluginStates = Record<PluginId, PluginProjectState>

/** Toolbar action exposed by a runtime plugin manifest (serializable for IPC) */
export interface PluginToolbarAction {
  pluginId: string
  title: string
  icon: string // SVG markup
  action: string // IPC channel to invoke with (projectDir)
  order: number
}
