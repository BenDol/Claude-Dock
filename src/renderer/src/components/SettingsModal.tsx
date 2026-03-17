import React, { useState, useRef, useCallback, useEffect } from 'react'
import { useSettingsStore } from '../stores/settings-store'
import { useDockStore } from '../stores/dock-store'
import { getDockApi } from '../lib/ipc-bridge'
import type { Settings } from '../../../shared/settings-schema'
import { DEFAULT_SETTINGS, BUILTIN_NOTIFICATION_SOURCES } from '../../../shared/settings-schema'
import PluginPanel from './PluginPanel'

function formatKeybind(e: KeyboardEvent): string | null {
  // Ignore standalone modifier presses
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null

  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl')
  if (e.shiftKey) parts.push('Shift')
  if (e.altKey) parts.push('Alt')
  parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key)
  return parts.join('+')
}

const KeybindInput: React.FC<{
  label: string
  value: string
  defaultValue: string
  onChange: (value: string) => void
}> = ({ label, value, defaultValue, onChange }) => {
  const [listening, setListening] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const isDisabled = value.startsWith('!')
  const displayValue = isDisabled ? value.slice(1) : value

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (!listening) return
      e.preventDefault()
      e.stopPropagation()
      const formatted = formatKeybind(e.nativeEvent)
      if (formatted) {
        onChange(formatted)
        setListening(false)
        inputRef.current?.blur()
      }
    },
    [listening, onChange]
  )

  const toggleEnabled = () => {
    if (isDisabled) {
      onChange(displayValue)
    } else {
      onChange('!' + displayValue)
    }
  }

  const isDefault = value === defaultValue

  return (
    <label>
      {label}
      <div className="keybind-row">
        <input
          type="checkbox"
          checked={!isDisabled}
          onChange={toggleEnabled}
          title={isDisabled ? 'Enable this keybind' : 'Disable this keybind'}
        />
        <input
          ref={inputRef}
          type="text"
          readOnly
          value={listening ? 'Press a key combo...' : displayValue || 'None'}
          className={`keybind-input${listening ? ' listening' : ''}${isDisabled ? ' disabled-bind' : ''}`}
          onClick={() => { if (!isDisabled) setListening(true) }}
          onKeyDown={handleKeyDown}
          onBlur={() => setListening(false)}
        />
        <button
          className="keybind-restore"
          title="Restore default"
          disabled={isDefault}
          onClick={(e) => { e.preventDefault(); onChange(defaultValue) }}
        >
          ↺
        </button>
      </div>
    </label>
  )
}

interface SettingsModalProps {
  onClose: () => void
}

type SettingsTab = 'appearance' | 'terminal' | 'grid' | 'keybindings' | 'plugins' | 'behavior'

const SettingsModal: React.FC<SettingsModalProps> = ({ onClose }) => {
  const [tab, setTab] = useState<SettingsTab>('appearance')
  const projectDir = useDockStore((s) => s.projectDir)
  const settings = useSettingsStore((s) => s.settings)
  const update = useSettingsStore((s) => s.update)
  const [updateCheckStatus, setUpdateCheckStatus] = useState('')
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [mcpInstalled, setMcpInstalled] = useState<boolean | null>(null)
  const [mcpBusy, setMcpBusy] = useState(false)
  const [mcpStatus, setMcpStatus] = useState('')
  const [pathCheckStatus, setPathCheckStatus] = useState('')
  const [pathChecking, setPathChecking] = useState(false)
  const [ctxMenuRegistered, setCtxMenuRegistered] = useState<boolean | null>(null)
  const [ctxMenuBusy, setCtxMenuBusy] = useState(false)
  const [ctxMenuStatus, setCtxMenuStatus] = useState('')

  const [notifSources, setNotifSources] = useState(BUILTIN_NOTIFICATION_SOURCES)

  // Fetch plugins for notification source list when behavior tab is shown
  useEffect(() => {
    if (tab === 'behavior') {
      getDockApi().plugins.getList().then((plugins) => {
        const pluginSources = plugins.map((p) => ({ id: p.id, label: p.name }))
        // Merge builtin + plugin sources, dedup by id
        const seen = new Set(BUILTIN_NOTIFICATION_SOURCES.map((s) => s.id))
        const merged = [...BUILTIN_NOTIFICATION_SOURCES]
        for (const ps of pluginSources) {
          if (!seen.has(ps.id)) {
            merged.push(ps)
            seen.add(ps.id)
          }
        }
        setNotifSources(merged)
      })
    }
  }, [tab])

  // Check MCP install status when behavior tab is shown
  useEffect(() => {
    if (tab === 'behavior' && mcpInstalled === null) {
      getDockApi().linked.checkMcp().then((r) => setMcpInstalled(r.installed))
    }
  }, [tab, mcpInstalled])

  // Check context menu registration status when behavior tab is shown
  useEffect(() => {
    if (tab === 'behavior' && ctxMenuRegistered === null) {
      getDockApi().contextMenu.check().then((r) => setCtxMenuRegistered(r.registered))
    }
  }, [tab, ctxMenuRegistered])

  const updateTheme = (partial: Partial<Settings['theme']>) => {
    update({ theme: { ...settings.theme, ...partial } })
  }
  const updateTerminal = (partial: Partial<Settings['terminal']>) => {
    update({ terminal: { ...settings.terminal, ...partial } })
  }
  const updateGrid = (partial: Partial<Settings['grid']>) => {
    update({ grid: { ...settings.grid, ...partial } })
  }
  const updateBehavior = (partial: Partial<Settings['behavior']>) => {
    update({ behavior: { ...settings.behavior, ...partial } })
  }
  const updateKeybindings = (partial: Partial<Settings['keybindings']>) => {
    update({ keybindings: { ...settings.keybindings, ...partial } })
  }
  const updateLinked = (partial: Partial<Settings['linked']>) => {
    update({ linked: { ...settings.linked, ...partial } })
  }
  const updateUpdater = (partial: Partial<Settings['updater']>) => {
    update({ updater: { ...settings.updater, ...partial } })
  }

  const handleCheckForUpdates = async () => {
    setCheckingUpdate(true)
    setUpdateCheckStatus('Checking...')
    try {
      const profile = settings.updater?.profile || 'latest'
      const info = await getDockApi().updater.check(profile)
      if (info.available) {
        setUpdateCheckStatus(`Update available: ${info.version}. Restart the launcher to update.`)
      } else {
        setUpdateCheckStatus('You are up to date.')
      }
    } catch {
      setUpdateCheckStatus('Failed to check for updates.')
    }
    setCheckingUpdate(false)
  }

  const handleCheckPath = async () => {
    setPathChecking(true)
    setPathCheckStatus('Checking...')
    try {
      const api = getDockApi()
      const status = await api.claude.checkPath()
      if (status.inPath) {
        setPathCheckStatus('Claude CLI is in your shell PATH.')
        // Reset the skip preference since it's now fine
        const s = await api.settings.get()
        if (s.launcher?.skipPathPrompt) {
          await api.settings.set({ launcher: { ...s.launcher, skipPathPrompt: false } })
        }
      } else if (status.claudeDir) {
        const result = await api.claude.fixPath(status.claudeDir)
        if (result.success) {
          setPathCheckStatus(`Added ${status.claudeDir} to PATH${result.file ? ` (${result.file})` : ''}. Restart your terminal for changes to take effect.`)
          const s = await api.settings.get()
          await api.settings.set({ launcher: { ...s.launcher, skipPathPrompt: false } })
        } else {
          setPathCheckStatus(`Failed to fix PATH: ${result.error}`)
        }
      } else {
        setPathCheckStatus('Claude CLI not found. Install it first.')
      }
    } catch {
      setPathCheckStatus('Failed to check PATH.')
    }
    setPathChecking(false)
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Settings</h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="settings-tabs">
          {(['appearance', 'terminal', 'grid', 'keybindings', 'plugins', 'behavior'] as SettingsTab[]).map((t) => (
            <button
              key={t}
              className={`settings-tab ${tab === t ? 'active' : ''}`}
              onClick={() => setTab(t)}
            >
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
        <div className="modal-body">
          <div className="settings-content">
            {tab === 'appearance' && (
              <div className="settings-group">
                <label>
                  Theme Mode
                  <select
                    value={settings.theme.mode}
                    onChange={(e) => updateTheme({ mode: e.target.value as Settings['theme']['mode'] })}
                  >
                    <option value="dark">Dark</option>
                    <option value="light">Light</option>
                    <option value="system">System</option>
                  </select>
                </label>
                <label>
                  Terminal Style
                  <select
                    value={settings.theme.terminalStyle}
                    onChange={(e) => updateTheme({ terminalStyle: e.target.value as Settings['theme']['terminalStyle'] })}
                  >
                    <option value="default">Default</option>
                    <option value="claude-code">Claude Code</option>
                    <option value="standard">Standard Console</option>
                  </select>
                </label>
                <label>
                  Accent Color
                  <input
                    type="color"
                    value={settings.theme.accentColor}
                    onChange={(e) => updateTheme({ accentColor: e.target.value })}
                  />
                </label>
                <div className="settings-divider" />
                <label>
                  Header Bar Size
                  <select
                    value={settings.theme.headerBarSize || 'small'}
                    onChange={(e) => updateTheme({ headerBarSize: e.target.value as Settings['theme']['headerBarSize'] })}
                  >
                    <option value="small">Small</option>
                    <option value="medium">Medium</option>
                    <option value="large">Large</option>
                  </select>
                </label>
                <label>
                  Terminal Header Size
                  <select
                    value={settings.theme.terminalHeaderBarSize || 'small'}
                    onChange={(e) => updateTheme({ terminalHeaderBarSize: e.target.value as Settings['theme']['terminalHeaderBarSize'] })}
                  >
                    <option value="small">Small</option>
                    <option value="medium">Medium</option>
                    <option value="large">Large</option>
                  </select>
                </label>
              </div>
            )}
            {tab === 'terminal' && (
              <div className="settings-group">
                <label>
                  Font Family
                  <input
                    type="text"
                    value={settings.terminal.fontFamily}
                    onChange={(e) => updateTerminal({ fontFamily: e.target.value })}
                  />
                </label>
                <label>
                  Font Size
                  <input
                    type="number"
                    min={8}
                    max={32}
                    value={settings.terminal.fontSize}
                    onChange={(e) => updateTerminal({ fontSize: parseInt(e.target.value) || 14 })}
                  />
                </label>
                <label>
                  Line Height
                  <input
                    type="number"
                    min={1}
                    max={2}
                    step={0.1}
                    value={settings.terminal.lineHeight}
                    onChange={(e) => updateTerminal({ lineHeight: parseFloat(e.target.value) || 1.2 })}
                  />
                </label>
                <label>
                  Cursor Style
                  <select
                    value={settings.terminal.cursorStyle}
                    onChange={(e) =>
                      updateTerminal({ cursorStyle: e.target.value as Settings['terminal']['cursorStyle'] })
                    }
                  >
                    <option value="block">Block</option>
                    <option value="underline">Underline</option>
                    <option value="bar">Bar</option>
                  </select>
                </label>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={settings.terminal.cursorBlink}
                    onChange={(e) => updateTerminal({ cursorBlink: e.target.checked })}
                  />
                  Cursor Blink
                </label>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={settings.terminal.scrollToBottom}
                    onChange={(e) => updateTerminal({ scrollToBottom: e.target.checked })}
                  />
                  Scroll to Bottom Button
                </label>
                <label>
                  Scrollback Lines
                  <input
                    type="number"
                    min={100}
                    max={50000}
                    step={100}
                    value={settings.terminal.scrollback}
                    onChange={(e) => updateTerminal({ scrollback: parseInt(e.target.value) || 5000 })}
                  />
                </label>
              </div>
            )}
            {tab === 'grid' && (
              <div className="settings-group">
                <label>
                  Max Columns
                  <input
                    type="number"
                    min={1}
                    max={8}
                    value={settings.grid.maxColumns}
                    onChange={(e) => updateGrid({ maxColumns: parseInt(e.target.value) || 4 })}
                  />
                </label>
                <label>
                  Gap Size (px)
                  <input
                    type="number"
                    min={0}
                    max={32}
                    value={settings.grid.gapSize}
                    onChange={(e) => { const v = parseInt(e.target.value); updateGrid({ gapSize: isNaN(v) ? 0 : v }) }}
                  />
                </label>
                <label>
                  Default Mode
                  <select
                    value={settings.grid.defaultMode}
                    onChange={(e) =>
                      updateGrid({ defaultMode: e.target.value as Settings['grid']['defaultMode'] })
                    }
                  >
                    <option value="auto">Auto</option>
                    <option value="freeform">Freeform</option>
                  </select>
                </label>
              </div>
            )}
            {tab === 'keybindings' && (
              <div className="settings-group">
                <KeybindInput
                  label="Focus Up"
                  value={settings.keybindings.focusUp}
                  defaultValue={DEFAULT_SETTINGS.keybindings.focusUp}
                  onChange={(v) => updateKeybindings({ focusUp: v })}
                />
                <KeybindInput
                  label="Focus Down"
                  value={settings.keybindings.focusDown}
                  defaultValue={DEFAULT_SETTINGS.keybindings.focusDown}
                  onChange={(v) => updateKeybindings({ focusDown: v })}
                />
                <KeybindInput
                  label="Focus Left"
                  value={settings.keybindings.focusLeft}
                  defaultValue={DEFAULT_SETTINGS.keybindings.focusLeft}
                  onChange={(v) => updateKeybindings({ focusLeft: v })}
                />
                <KeybindInput
                  label="Focus Right"
                  value={settings.keybindings.focusRight}
                  defaultValue={DEFAULT_SETTINGS.keybindings.focusRight}
                  onChange={(v) => updateKeybindings({ focusRight: v })}
                />
                <div className="settings-divider" />
                <KeybindInput
                  label="Undo Input"
                  value={settings.keybindings.undo}
                  defaultValue={DEFAULT_SETTINGS.keybindings.undo}
                  onChange={(v) => updateKeybindings({ undo: v })}
                />
                <KeybindInput
                  label="Redo Input"
                  value={settings.keybindings.redo}
                  defaultValue={DEFAULT_SETTINGS.keybindings.redo}
                  onChange={(v) => updateKeybindings({ redo: v })}
                />
                <KeybindInput
                  label="Select All"
                  value={settings.keybindings.selectAll}
                  defaultValue={DEFAULT_SETTINGS.keybindings.selectAll}
                  onChange={(v) => updateKeybindings({ selectAll: v })}
                />
              </div>
            )}
            {tab === 'plugins' && projectDir && (
              <div className="settings-group">
                <div className="settings-description" style={{ marginBottom: 12 }}>
                  Plugins run when this project directory opens. Enable or disable per-project.
                </div>
                <PluginPanel projectDir={projectDir} />
                <div className="settings-divider" />
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={settings.updater?.autoUpdatePlugins ?? false}
                    onChange={(e) => updateUpdater({ autoUpdatePlugins: e.target.checked })}
                  />
                  Automatically update plugins
                </label>
                <div className="settings-description">
                  When enabled, plugin updates are installed automatically on launch.
                </div>
                <div>
                  <button
                    className="settings-check-update-btn"
                    onClick={() => window.dispatchEvent(new CustomEvent('plugin-update-open'))}
                  >
                    Check for Plugin Updates
                  </button>
                </div>
              </div>
            )}
            {tab === 'behavior' && (
              <div className="settings-group">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={settings.behavior.confirmCloseWithRunning}
                    onChange={(e) => updateBehavior({ confirmCloseWithRunning: e.target.checked })}
                  />
                  Confirm close with running terminals
                </label>
                {settings.behavior.closeAction !== 'ask' && (
                  <div className="settings-inline-row">
                    <span className="settings-description" style={{ margin: 0 }}>
                      Close action remembered: <strong>{settings.behavior.closeAction === 'close' ? 'Close (keep sessions)' : 'Clear sessions & close'}</strong>
                    </span>
                    <button
                      className="settings-reset-btn"
                      onClick={() => updateBehavior({ closeAction: 'ask' })}
                    >
                      Reset
                    </button>
                  </div>
                )}
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={settings.behavior.autoSpawnFirstTerminal}
                    onChange={(e) => updateBehavior({ autoSpawnFirstTerminal: e.target.checked })}
                  />
                  Auto-spawn first terminal
                </label>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={settings.behavior.markNotificationsRead}
                    onChange={(e) => updateBehavior({ markNotificationsRead: e.target.checked })}
                  />
                  Mark all notifications as read
                </label>
                <div className="settings-description">
                  Incoming notifications will not trigger the unread badge.
                </div>
                <div className="settings-divider" />
                <div className="settings-section-header">Block Notifications From</div>
                <div className="settings-description">
                  Mute toast notifications from selected sources.
                </div>
                {notifSources.map((src) => {
                  const blocked = settings.behavior?.blockedNotificationSources ?? []
                  const isBlocked = blocked.includes(src.id)
                  return (
                    <label key={src.id} className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={isBlocked}
                        onChange={(e) => {
                          const next = e.target.checked
                            ? [...blocked, src.id]
                            : blocked.filter((s: string) => s !== src.id)
                          updateBehavior({ blockedNotificationSources: next })
                        }}
                      />
                      {src.label}
                    </label>
                  )
                })}
                <div className="settings-divider" />
                <div className="settings-section-header">Shell Integration</div>
                <div className="settings-row">
                  <span className="settings-label">
                    Context Menu: {ctxMenuRegistered === null ? '...' : ctxMenuRegistered ? 'Registered' : 'Not Registered'}
                  </span>
                  <button
                    className="settings-check-update-btn"
                    disabled={ctxMenuBusy}
                    onClick={async () => {
                      setCtxMenuBusy(true)
                      setCtxMenuStatus('')
                      try {
                        const api = getDockApi()
                        if (ctxMenuRegistered) {
                          const r = await api.contextMenu.unregister()
                          if (r.success) {
                            setCtxMenuRegistered(false)
                            setCtxMenuStatus('Context menu removed.')
                          } else {
                            setCtxMenuStatus(r.error || 'Failed to remove.')
                          }
                        } else {
                          const r = await api.contextMenu.register()
                          if (r.success) {
                            setCtxMenuRegistered(true)
                            setCtxMenuStatus('Context menu registered.')
                          } else {
                            setCtxMenuStatus(r.error || 'Failed to register.')
                          }
                        }
                      } catch {
                        setCtxMenuStatus('Operation failed.')
                      }
                      setCtxMenuBusy(false)
                    }}
                  >
                    {ctxMenuBusy ? '...' : ctxMenuRegistered ? 'Remove' : 'Register'}
                  </button>
                </div>
                <div className="settings-description">
                  Adds &quot;Open with Claude Dock&quot; to your file manager&apos;s right-click context menu.
                </div>
                {ctxMenuStatus && <div className="settings-update-status">{ctxMenuStatus}</div>}
                <div className="settings-divider" />
                <div className="settings-section-header">Dock MCP Server</div>
                <div className="settings-row">
                  <span className="settings-label">
                    Status: {mcpInstalled === null ? '...' : mcpInstalled ? 'Installed' : 'Not Installed'}
                  </span>
                  <div className="settings-btn-group">
                    <button
                      className="settings-check-update-btn"
                      disabled={mcpBusy}
                      onClick={async () => {
                        setMcpBusy(true)
                        setMcpStatus('')
                        try {
                          if (mcpInstalled) {
                            const r = await getDockApi().linked.uninstallMcp()
                            if (r.success) {
                              setMcpInstalled(false)
                              if (settings.linked?.enabled) {
                                updateLinked({ enabled: false })
                                await getDockApi().linked.setEnabled(false)
                              }
                              setMcpStatus('Uninstalled successfully.')
                            } else {
                              setMcpStatus(r.error || 'Uninstall failed.')
                            }
                          } else {
                            const r = await getDockApi().linked.installMcp()
                            if (r.success) {
                              setMcpInstalled(true)
                              setMcpStatus('Installed. Restart dock to activate.')
                            } else {
                              setMcpStatus(r.error || 'Install failed.')
                            }
                          }
                        } catch {
                          setMcpStatus('Operation failed.')
                        }
                        setMcpBusy(false)
                      }}
                    >
                      {mcpBusy ? '...' : mcpInstalled ? 'Uninstall' : 'Install'}
                    </button>
                    <button
                      className="settings-check-update-btn"
                      disabled={!mcpInstalled}
                      onClick={() => getDockApi().dock.restart()}
                      title="Restart dock to apply MCP changes"
                    >
                      Restart Dock
                    </button>
                  </div>
                </div>
                {mcpStatus && <div className="settings-update-status">{mcpStatus}</div>}
                <label className={`checkbox-label${mcpInstalled ? '' : ' disabled'}`}>
                  <input
                    type="checkbox"
                    checked={settings.linked?.enabled ?? false}
                    disabled={!mcpInstalled}
                    onChange={async (e) => {
                      const enabled = e.target.checked
                      updateLinked({ enabled })
                      await getDockApi().linked.setEnabled(enabled)
                    }}
                  />
                  Linked Mode
                  {!mcpInstalled && <span className="settings-hint"> (install MCP first)</span>}
                </label>
                <div className="settings-description">
                  When enabled, Claude sessions can see what other terminals are working on to coordinate tasks.
                </div>
                <label className={`checkbox-label${mcpInstalled && settings.linked?.enabled ? '' : ' disabled'}`} style={{ paddingLeft: 24 }}>
                  <input
                    type="checkbox"
                    checked={settings.linked?.messagingEnabled ?? false}
                    disabled={!mcpInstalled || !settings.linked?.enabled}
                    onChange={async (e) => {
                      const enabled = e.target.checked
                      updateLinked({ messagingEnabled: enabled })
                      await getDockApi().linked.setMessaging(enabled)
                    }}
                  />
                  Inter-terminal Messaging
                  {(!mcpInstalled || !settings.linked?.enabled) && <span className="settings-hint"> (enable Linked Mode first)</span>}
                </label>
                <div className="settings-description" style={{ paddingLeft: 24 }}>
                  Allow Claude sessions to send messages to each other for coordination.
                </div>
                <div className="settings-divider" />
                <label>
                  Update Profile
                  <select
                    value={settings.updater?.profile || 'latest'}
                    onChange={(e) => updateUpdater({ profile: e.target.value })}
                  >
                    <option value="latest" disabled>Latest (stable)</option>
                    <option value="bleeding-edge">Bleeding Edge</option>
                  </select>
                </label>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={__DEV__ ? false : (settings.updater?.autoUpdate ?? false)}
                    onChange={(e) => updateUpdater({ autoUpdate: e.target.checked })}
                    disabled={__DEV__}
                  />
                  Automatically update app
                </label>
                <div className="settings-description">
                  {__DEV__
                    ? 'Automatic updates are disabled in dev builds.'
                    : 'When enabled, app updates are downloaded and installed automatically on launch.'}
                </div>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={settings.updater?.autoUpdatePlugins ?? false}
                    onChange={(e) => updateUpdater({ autoUpdatePlugins: e.target.checked })}
                  />
                  Automatically update plugins
                </label>
                <div className="settings-description">
                  When enabled, plugin updates are installed automatically on launch. A restart notification is shown when complete.
                </div>
                <div>
                  <button
                    className="settings-check-update-btn"
                    onClick={handleCheckForUpdates}
                    disabled={checkingUpdate}
                  >
                    {checkingUpdate ? 'Checking...' : 'Check for Updates'}
                  </button>
                  {updateCheckStatus && (
                    <div className="settings-update-status">{updateCheckStatus}</div>
                  )}
                </div>
                <div>
                  <button
                    className="settings-check-update-btn"
                    onClick={() => getDockApi().debug.openDevTools()}
                  >
                    Open DevTools
                  </button>
                </div>
                <div className="settings-divider" />
                <div className="settings-section-header">Claude CLI</div>
                <div>
                  <button
                    className="settings-check-update-btn"
                    onClick={handleCheckPath}
                    disabled={pathChecking}
                  >
                    {pathChecking ? 'Checking...' : 'Check & Fix PATH'}
                  </button>
                  <div className="settings-description">
                    Check if the Claude CLI is in your shell PATH and fix it if not.
                  </div>
                  {pathCheckStatus && (
                    <div className="settings-update-status">{pathCheckStatus}</div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="modal-footer">
          <span className="modal-footer-left">
            {__BUILD_SHA__} &middot; {__BUILD_DATE__}
          </span>
          <span className="modal-footer-right">
            By{' '}
            <a className="footer-link" onClick={() => getDockApi().app.openExternal('https://github.com/BenDol')}>
              Ben Dol
            </a>
            {' '}&middot;{' '}
            <a className="footer-link footer-sponsor" onClick={() => getDockApi().app.openExternal('https://github.com/sponsors/BenDol')}>
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M4.25 2.5c-1.336 0-2.75 1.164-2.75 3 0 2.15 1.58 4.144 3.365 5.682A20.6 20.6 0 008 13.393a20.6 20.6 0 003.135-2.211C12.92 9.644 14.5 7.65 14.5 5.5c0-1.836-1.414-3-2.75-3-1.373 0-2.609.986-3.029 2.456a.749.749 0 01-1.442 0C6.859 3.486 5.623 2.5 4.25 2.5z" /></svg>
              {' '}Sponsor
            </a>
          </span>
        </div>
      </div>
    </div>
  )
}

declare const __BUILD_SHA__: string
declare const __BUILD_DATE__: string
declare const __DEV__: boolean

export default SettingsModal
