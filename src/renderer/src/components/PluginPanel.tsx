import React, { useEffect, useMemo, useState, useCallback } from 'react'
import { getDockApi } from '../lib/ipc-bridge'
import type { PluginInfo, PluginSettingDef, ProjectPluginStates } from '../../../shared/plugin-types'

interface PluginPanelProps {
  projectDir: string
  /** Compact single-column list layout for narrow containers (e.g. first-time plugin setup). */
  compact?: boolean
  /** If set, auto-opens the detail view for this plugin on mount (deep link). */
  initialPluginId?: string
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

/** Deterministic-ish hue from a string so each plugin card gets a stable color. */
function hueFromString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h) % 360
}

function pluginInitials(name: string): string {
  const parts = name.split(/[\s_-]+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[1][0]).toUpperCase()
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

/** Avatar with initials on a hue-shifted background. */
const PluginAvatar: React.FC<{ plugin: PluginInfo; size?: number }> = ({ plugin, size = 44 }) => {
  const hue = hueFromString(plugin.id)
  return (
    <div
      className="plugin-hub-avatar"
      style={{
        width: size,
        height: size,
        background: `linear-gradient(135deg, hsl(${hue} 60% 42%), hsl(${(hue + 30) % 360} 55% 32%))`,
        fontSize: Math.round(size * 0.38),
      }}
      aria-hidden="true"
    >
      {pluginInitials(plugin.name)}
    </div>
  )
}

interface PluginCardProps {
  plugin: PluginInfo
  enabled: boolean
  updatedAt?: number
  onToggle: (enabled: boolean) => void
  onOpen: () => void
  compact?: boolean
}

const PluginCompactRow: React.FC<PluginCardProps> = ({ plugin, enabled, onToggle, onOpen }) => {
  const hasSettings = !!plugin.settingsSchema && plugin.settingsSchema.length > 0
  return (
    <button
      type="button"
      className={`plugin-hub-row${enabled ? ' enabled' : ''}`}
      onClick={onOpen}
    >
      <PluginAvatar plugin={plugin} size={36} />
      <div className="plugin-hub-row-text">
        <div className="plugin-hub-row-top">
          <span className="plugin-hub-row-name">{plugin.name}</span>
          <span className="plugin-hub-badge plugin-hub-badge-source">
            {plugin.source === 'builtin' ? 'Built-in' : 'External'}
          </span>
          <span className="plugin-hub-version">v{plugin.version}</span>
        </div>
        <div className="plugin-hub-row-desc">{plugin.description}</div>
      </div>
      <div className="plugin-hub-row-actions">
        {hasSettings && (
          <span className="plugin-hub-row-gear" title="This plugin has configurable settings" aria-hidden="true">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
              <path d="M9.405 1.05c-.413-1.4-2.397-1.4-2.81 0l-.1.34a1.464 1.464 0 01-2.105.872l-.31-.17c-1.283-.698-2.686.705-1.987 1.987l.169.311c.446.82.023 1.841-.872 2.105l-.34.1c-1.4.413-1.4 2.397 0 2.81l.34.1a1.464 1.464 0 01.872 2.105l-.17.31c-.698 1.283.705 2.686 1.987 1.987l.311-.169a1.464 1.464 0 012.105.872l.1.34c.413 1.4 2.397 1.4 2.81 0l.1-.34a1.464 1.464 0 012.105-.872l.31.17c1.283.698 2.686-.705 1.987-1.987l-.169-.311a1.464 1.464 0 01.872-2.105l.34-.1c1.4-.413 1.4-2.397 0-2.81l-.34-.1a1.464 1.464 0 01-.872-2.105l.17-.31c.698-1.283-.705-2.686-1.987-1.987l-.311.169a1.464 1.464 0 01-2.105-.872l-.1-.34zM8 10.93a2.929 2.929 0 110-5.86 2.929 2.929 0 010 5.858z" />
            </svg>
          </span>
        )}
        <label
          className="plugin-hub-toggle"
          onClick={(e) => e.stopPropagation()}
          title={enabled ? 'Disable plugin' : 'Enable plugin'}
        >
          <input type="checkbox" checked={enabled} onChange={(e) => onToggle(e.target.checked)} />
          <span className="plugin-hub-toggle-track" />
        </label>
      </div>
    </button>
  )
}

const PluginCard: React.FC<PluginCardProps> = ({ plugin, enabled, updatedAt, onToggle, onOpen }) => {
  const hasSettings = !!plugin.settingsSchema && plugin.settingsSchema.length > 0
  return (
    <button
      type="button"
      className={`plugin-hub-card${enabled ? ' enabled' : ''}`}
      onClick={onOpen}
    >
      <div className="plugin-hub-card-head">
        <PluginAvatar plugin={plugin} />
        <div className="plugin-hub-card-title">
          <div className="plugin-hub-card-name">{plugin.name}</div>
          <div className="plugin-hub-card-meta">
            <span className="plugin-hub-badge plugin-hub-badge-source">
              {plugin.source === 'builtin' ? 'Built-in' : 'External'}
            </span>
            <span className="plugin-hub-version">v{plugin.version}</span>
          </div>
        </div>
        {/* Direct toggle, clickable without opening details */}
        <label
          className="plugin-hub-toggle"
          onClick={(e) => e.stopPropagation()}
          title={enabled ? 'Disable plugin' : 'Enable plugin'}
        >
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onToggle(e.target.checked)}
          />
          <span className="plugin-hub-toggle-track" />
        </label>
      </div>
      <div className="plugin-hub-card-desc">{plugin.description}</div>
      <div className="plugin-hub-card-foot">
        <span className={`plugin-hub-status${enabled ? ' on' : ''}`}>
          <span className="plugin-hub-status-dot" />
          {enabled ? 'Enabled' : 'Disabled'}
        </span>
        {hasSettings && (
          <span className="plugin-hub-has-settings" title="This plugin has configurable settings">
            <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
              <path d="M9.405 1.05c-.413-1.4-2.397-1.4-2.81 0l-.1.34a1.464 1.464 0 01-2.105.872l-.31-.17c-1.283-.698-2.686.705-1.987 1.987l.169.311c.446.82.023 1.841-.872 2.105l-.34.1c-1.4.413-1.4 2.397 0 2.81l.34.1a1.464 1.464 0 01.872 2.105l-.17.31c-.698 1.283.705 2.686 1.987 1.987l.311-.169a1.464 1.464 0 012.105.872l.1.34c.413 1.4 2.397 1.4 2.81 0l.1-.34a1.464 1.464 0 012.105-.872l.31.17c1.283.698 2.686-.705 1.987-1.987l-.169-.311a1.464 1.464 0 01.872-2.105l.34-.1c1.4-.413 1.4-2.397 0-2.81l-.34-.1a1.464 1.464 0 01-.872-2.105l.17-.31c.698-1.283-.705-2.686-1.987-1.987l-.311.169a1.464 1.464 0 01-2.105-.872l-.1-.34zM8 10.93a2.929 2.929 0 110-5.86 2.929 2.929 0 010 5.858z" />
            </svg>
            Settings
          </span>
        )}
        {updatedAt ? (
          <span className="plugin-hub-updated" title={new Date(updatedAt).toLocaleString()}>
            Updated {formatUpdateDate(updatedAt)}
          </span>
        ) : null}
      </div>
    </button>
  )
}

interface PluginDetailViewProps {
  plugin: PluginInfo
  enabled: boolean
  settings: Record<string, unknown>
  updatedAt?: number
  onBack: () => void
  onToggle: (enabled: boolean) => void
  onSettingChange: (key: string, value: unknown) => void
  onResetTrust: () => void
}

const PluginDetailView: React.FC<PluginDetailViewProps> = ({
  plugin, enabled, settings, updatedAt, onBack, onToggle, onSettingChange, onResetTrust,
}) => {
  const hasSettings = !!plugin.settingsSchema && plugin.settingsSchema.length > 0
  return (
    <div className="plugin-hub-detail">
      <div className="plugin-hub-detail-topbar">
        <button className="plugin-hub-back" onClick={onBack}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="10,3 5,8 10,13" />
          </svg>
          Back
        </button>
        <label
          className="plugin-hub-toggle plugin-hub-toggle-large"
          title={enabled ? 'Disable plugin' : 'Enable plugin'}
        >
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onToggle(e.target.checked)}
          />
          <span className="plugin-hub-toggle-track" />
          <span className="plugin-hub-toggle-label">{enabled ? 'Enabled' : 'Disabled'}</span>
        </label>
      </div>

      <div className="plugin-hub-detail-hero">
        <PluginAvatar plugin={plugin} size={64} />
        <div className="plugin-hub-detail-title">
          <h3>{plugin.name}</h3>
          <div className="plugin-hub-detail-meta">
            <span className="plugin-hub-badge plugin-hub-badge-source">
              {plugin.source === 'builtin' ? 'Built-in' : 'External'}
            </span>
            <span className="plugin-hub-version">v{plugin.version}</span>
            {updatedAt ? (
              <span className="plugin-hub-updated" title={new Date(updatedAt).toLocaleString()}>
                Updated {formatUpdateDate(updatedAt)}
              </span>
            ) : null}
          </div>
        </div>
      </div>

      <p className="plugin-hub-detail-desc">{plugin.description}</p>

      <div className="plugin-hub-section">
        <div className="plugin-hub-section-title">Settings</div>
        {hasSettings ? (
          <div className="plugin-hub-settings">
            {plugin.settingsSchema!.map((def) => (
              <SettingField
                key={def.key}
                def={def}
                value={settings[def.key] ?? def.defaultValue}
                onChange={(v) => onSettingChange(def.key, v)}
              />
            ))}
          </div>
        ) : (
          <div className="plugin-hub-empty-note">This plugin has no configurable settings.</div>
        )}
      </div>

      {plugin.source === 'external' && (
        <div className="plugin-hub-section">
          <div className="plugin-hub-section-title">Trust</div>
          <div className="plugin-hub-detail-row">
            <div>
              <div className="plugin-hub-detail-row-label">Reset trust decision</div>
              <div className="plugin-hub-detail-row-desc">
                You will be prompted again about this plugin on next launch.
              </div>
            </div>
            <button className="plugin-hub-btn plugin-hub-btn-danger" onClick={onResetTrust}>
              Reset Trust
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

const PluginPanel: React.FC<PluginPanelProps> = ({ projectDir, compact = false, initialPluginId }) => {
  const [plugins, setPlugins] = useState<PluginInfo[]>([])
  const [states, setStates] = useState<ProjectPluginStates>({})
  const [overrides, setOverrides] = useState<Record<string, { version: string; hash: string; installedAt: number }>>({})
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(initialPluginId ?? null)

  // If the caller supplies a deep-link target, honor it whenever it changes.
  useEffect(() => {
    if (initialPluginId) setSelectedId(initialPluginId)
  }, [initialPluginId])

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
      [pluginId]: { ...prev[pluginId], enabled, settings: prev[pluginId]?.settings ?? {} }
    }))
    window.dispatchEvent(new CustomEvent('plugin-state-changed'))
  }

  const updateSetting = async (pluginId: string, key: string, value: unknown) => {
    await getDockApi().plugins.setSetting(projectDir, pluginId, key, value)
    setStates((prev) => ({
      ...prev,
      [pluginId]: {
        ...prev[pluginId],
        enabled: prev[pluginId]?.enabled ?? false,
        settings: { ...prev[pluginId]?.settings, [key]: value }
      }
    }))
    window.dispatchEvent(new CustomEvent('plugin-state-changed'))
  }

  const resetTrust = async (pluginId: string) => {
    await getDockApi().plugins.resetTrust(pluginId)
    window.dispatchEvent(new CustomEvent('plugin-state-changed'))
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return plugins
    return plugins.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q)
    )
  }, [plugins, search])

  const enabledCount = useMemo(
    () => plugins.reduce((n, p) => n + (states[p.id]?.enabled ? 1 : 0), 0),
    [plugins, states]
  )

  const selectedPlugin = useMemo(
    () => (selectedId ? plugins.find((p) => p.id === selectedId) ?? null : null),
    [plugins, selectedId]
  )

  // Esc closes the detail view first
  useEffect(() => {
    if (!selectedPlugin) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setSelectedId(null)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [selectedPlugin])

  if (loading) {
    return <div className="plugin-hub-loading">Loading plugins…</div>
  }

  if (plugins.length === 0) {
    return <div className="plugin-hub-empty">No plugins available.</div>
  }

  if (selectedPlugin) {
    const state = states[selectedPlugin.id] || { enabled: selectedPlugin.defaultEnabled, settings: {} }
    const ov = overrides[selectedPlugin.id]
    return (
      <PluginDetailView
        plugin={selectedPlugin}
        enabled={state.enabled}
        settings={state.settings || {}}
        updatedAt={ov?.installedAt}
        onBack={() => setSelectedId(null)}
        onToggle={(en) => toggleEnabled(selectedPlugin.id, en)}
        onSettingChange={(k, v) => updateSetting(selectedPlugin.id, k, v)}
        onResetTrust={() => resetTrust(selectedPlugin.id)}
      />
    )
  }

  return (
    <div className="plugin-hub">
      <div className="plugin-hub-toolbar">
        <div className="plugin-hub-search">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" />
            <line x1="10.5" y1="10.5" x2="14" y2="14" />
          </svg>
          <input
            className="plugin-hub-search-input"
            type="text"
            placeholder="Search plugins…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button
              className="plugin-hub-search-clear"
              onClick={() => setSearch('')}
              aria-label="Clear search"
            >
              ×
            </button>
          )}
        </div>
        <div className="plugin-hub-stats">
          <strong>{enabledCount}</strong> of {plugins.length} enabled
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="plugin-hub-empty">No plugins match &ldquo;{search}&rdquo;.</div>
      ) : compact ? (
        <div className="plugin-hub-list">
          {filtered.map((plugin) => {
            const state = states[plugin.id] || { enabled: plugin.defaultEnabled, settings: {} }
            return (
              <PluginCompactRow
                key={plugin.id}
                plugin={plugin}
                enabled={state.enabled}
                updatedAt={overrides[plugin.id]?.installedAt}
                onToggle={(en) => toggleEnabled(plugin.id, en)}
                onOpen={() => setSelectedId(plugin.id)}
              />
            )
          })}
        </div>
      ) : (
        <div className="plugin-hub-grid">
          {filtered.map((plugin) => {
            const state = states[plugin.id] || { enabled: plugin.defaultEnabled, settings: {} }
            return (
              <PluginCard
                key={plugin.id}
                plugin={plugin}
                enabled={state.enabled}
                updatedAt={overrides[plugin.id]?.installedAt}
                onToggle={(en) => toggleEnabled(plugin.id, en)}
                onOpen={() => setSelectedId(plugin.id)}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

export default PluginPanel
