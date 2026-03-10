import React, { useEffect, useState, useCallback } from 'react'
import { getDockApi } from '../lib/ipc-bridge'
import type { PluginInfo, ProjectPluginStates } from '../../../shared/plugin-types'

interface PluginPanelProps {
  projectDir: string
}

const PluginPanel: React.FC<PluginPanelProps> = ({ projectDir }) => {
  const [plugins, setPlugins] = useState<PluginInfo[]>([])
  const [states, setStates] = useState<ProjectPluginStates>({})
  const [loading, setLoading] = useState(true)
  const [expandedSettings, setExpandedSettings] = useState<Set<string>>(new Set())

  const refresh = useCallback(async () => {
    const api = getDockApi()
    const [list, st] = await Promise.all([
      api.plugins.getList(),
      api.plugins.getStates(projectDir)
    ])
    setPlugins(list)
    setStates(st)
    setLoading(false)
  }, [projectDir])

  useEffect(() => {
    refresh()
  }, [refresh])

  const toggleEnabled = async (pluginId: string, enabled: boolean) => {
    await getDockApi().plugins.setEnabled(projectDir, pluginId, enabled)
    setStates((prev) => ({
      ...prev,
      [pluginId]: { ...prev[pluginId], enabled }
    }))
  }

  const updateSetting = async (pluginId: string, key: string, value: unknown) => {
    await getDockApi().plugins.setSetting(projectDir, pluginId, key, value)
    setStates((prev) => ({
      ...prev,
      [pluginId]: {
        ...prev[pluginId],
        settings: { ...prev[pluginId]?.settings, [key]: value }
      }
    }))
  }

  const toggleSettingsExpanded = (pluginId: string) => {
    setExpandedSettings((prev) => {
      const next = new Set(prev)
      if (next.has(pluginId)) {
        next.delete(pluginId)
      } else {
        next.add(pluginId)
      }
      return next
    })
  }

  if (loading) {
    return <div className="plugin-panel-loading">Loading plugins...</div>
  }

  if (plugins.length === 0) {
    return <div className="plugin-panel-empty">No plugins available.</div>
  }

  return (
    <div className="plugin-panel">
      {plugins.map((plugin) => {
        const state = states[plugin.id] || { enabled: plugin.defaultEnabled, settings: {} }
        const hasSettings = plugin.settingsSchema && plugin.settingsSchema.length > 0
        const isExpanded = expandedSettings.has(plugin.id)

        return (
          <div key={plugin.id} className="plugin-item">
            <div className="plugin-item-header">
              <label className="plugin-toggle">
                <input
                  type="checkbox"
                  checked={state.enabled}
                  onChange={(e) => toggleEnabled(plugin.id, e.target.checked)}
                />
                <span className="plugin-name">{plugin.name}</span>
              </label>
              {hasSettings && state.enabled && (
                <button
                  className="plugin-settings-btn"
                  onClick={() => toggleSettingsExpanded(plugin.id)}
                  title={isExpanded ? 'Hide settings' : 'Show settings'}
                >
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M9.405 1.05c-.413-1.4-2.397-1.4-2.81 0l-.1.34a1.464 1.464 0 01-2.105.872l-.31-.17c-1.283-.698-2.686.705-1.987 1.987l.169.311c.446.82.023 1.841-.872 2.105l-.34.1c-1.4.413-1.4 2.397 0 2.81l.34.1a1.464 1.464 0 01.872 2.105l-.17.31c-.698 1.283.705 2.686 1.987 1.987l.311-.169a1.464 1.464 0 012.105.872l.1.34c.413 1.4 2.397 1.4 2.81 0l.1-.34a1.464 1.464 0 012.105-.872l.31.17c1.283.698 2.686-.705 1.987-1.987l-.169-.311a1.464 1.464 0 01.872-2.105l.34-.1c1.4-.413 1.4-2.397 0-2.81l-.34-.1a1.464 1.464 0 01-.872-2.105l.17-.31c.698-1.283-.705-2.686-1.987-1.987l-.311.169a1.464 1.464 0 01-2.105-.872l-.1-.34zM8 10.93a2.929 2.929 0 110-5.86 2.929 2.929 0 010 5.858z" />
                  </svg>
                </button>
              )}
            </div>
            <div className="plugin-description">{plugin.description}</div>
            {state.enabled && hasSettings && isExpanded && (
              <div className="plugin-settings">
                {plugin.settingsSchema!.map((def) => {
                  const val = state.settings?.[def.key] ?? def.defaultValue
                  if (def.type === 'boolean') {
                    return (
                      <label key={def.key} className="plugin-setting-row checkbox-label">
                        <input
                          type="checkbox"
                          checked={val as boolean}
                          onChange={(e) => updateSetting(plugin.id, def.key, e.target.checked)}
                        />
                        {def.label}
                      </label>
                    )
                  }
                  if (def.type === 'string') {
                    return (
                      <label key={def.key} className="plugin-setting-row">
                        {def.label}
                        <input
                          type="text"
                          value={(val as string) || ''}
                          onChange={(e) => updateSetting(plugin.id, def.key, e.target.value)}
                        />
                      </label>
                    )
                  }
                  if (def.type === 'number') {
                    return (
                      <label key={def.key} className="plugin-setting-row">
                        {def.label}
                        <input
                          type="number"
                          value={(val as number) || 0}
                          onChange={(e) => updateSetting(plugin.id, def.key, parseFloat(e.target.value))}
                        />
                      </label>
                    )
                  }
                  return null
                })}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export default PluginPanel
