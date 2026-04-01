import React, { useEffect, useState, useCallback } from 'react'
import { getDockApi } from '../lib/ipc-bridge'
import type { PluginInfo, PluginSettingDef, ProjectPluginStates } from '../../../shared/plugin-types'

interface PluginPanelProps {
  projectDir: string
}

function formatUpdateDate(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffMin = Math.floor(diffMs / 60_000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.floor(diffHr / 24)
  if (diffDay < 7) return `${diffDay}d ago`
  return d.toLocaleDateString()
}

const HelpIcon: React.FC<{ tooltip: string }> = ({ tooltip }) => (
  <span className="ps-help-icon" title={tooltip}>
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" opacity="0.45">
      <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 12.5a5.5 5.5 0 110-11 5.5 5.5 0 010 11zm-.75-2.5h1.5v1.5h-1.5V11zm.08-6.5c1.46 0 2.42.82 2.42 1.96 0 .88-.52 1.37-1.15 1.76-.5.31-.65.52-.65.9v.38H6.5v-.52c0-.72.33-1.17.93-1.56.5-.32.72-.52.72-.96 0-.5-.35-.8-.95-.8-.56 0-.96.33-1.02.86H4.75C4.83 5.38 5.76 4.5 7.33 4.5z"/>
    </svg>
  </span>
)

const SettingField: React.FC<{
  def: PluginSettingDef
  value: unknown
  onChange: (value: unknown) => void
}> = ({ def, value, onChange }) => {
  const helpIcon = def.description ? <HelpIcon tooltip={def.description} /> : null

  if (def.type === 'boolean') {
    return (
      <label className="ps-row ps-row-toggle">
        <span className="ps-label">{def.label}{helpIcon}</span>
        <input
          type="checkbox"
          checked={value as boolean}
          onChange={(e) => onChange(e.target.checked)}
        />
      </label>
    )
  }

  if (def.type === 'number') {
    return (
      <label className="ps-row">
        <span className="ps-label">{def.label}{helpIcon}</span>
        <input
          className="ps-input ps-input-number"
          type="number"
          value={(value as number) || 0}
          placeholder={def.placeholder}
          onChange={(e) => onChange(parseFloat(e.target.value))}
        />
      </label>
    )
  }

  return (
    <label className="ps-row">
      <span className="ps-label">{def.label}{helpIcon}</span>
      <input
        className="ps-input"
        type="text"
        value={(value as string) || ''}
        placeholder={def.placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  )
}

const PluginPanel: React.FC<PluginPanelProps> = ({ projectDir }) => {
  const [plugins, setPlugins] = useState<PluginInfo[]>([])
  const [states, setStates] = useState<ProjectPluginStates>({})
  const [overrides, setOverrides] = useState<Record<string, { version: string; hash: string; installedAt: number }>>({})
  const [loading, setLoading] = useState(true)
  const [expandedSettings, setExpandedSettings] = useState<Set<string>>(new Set())

  const refresh = useCallback(async () => {
    const api = getDockApi()
    const [list, st, ov] = await Promise.all([
      api.plugins.getList(),
      api.plugins.getStates(projectDir),
      api.plugins.getOverrides()
    ])
    setPlugins(list)
    setStates(st)
    setOverrides(ov)
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
    window.dispatchEvent(new CustomEvent('plugin-state-changed'))
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
      if (next.has(pluginId)) next.delete(pluginId)
      else next.add(pluginId)
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
            <div className="plugin-description">
              <span>{plugin.description}</span>
              {overrides[plugin.id]?.installedAt > 0 && (
                <span className="plugin-updated-at" title={new Date(overrides[plugin.id].installedAt).toLocaleString()}>
                  Updated {formatUpdateDate(overrides[plugin.id].installedAt)}
                </span>
              )}
              {plugin.source === 'external' && (
                <button
                  className="plugin-reset-trust-btn"
                  onClick={async () => {
                    await getDockApi().plugins.resetTrust(plugin.id)
                    window.dispatchEvent(new CustomEvent('plugin-state-changed'))
                  }}
                  title="Reset trust decision — you will be prompted again on next launch"
                >
                  Reset Trust
                </button>
              )}
            </div>
            {state.enabled && hasSettings && isExpanded && (
              <div className="ps-settings">
                {plugin.settingsSchema!.map((def) => (
                  <SettingField
                    key={def.key}
                    def={def}
                    value={state.settings?.[def.key] ?? def.defaultValue}
                    onChange={(v) => updateSetting(plugin.id, def.key, v)}
                  />
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export default PluginPanel
