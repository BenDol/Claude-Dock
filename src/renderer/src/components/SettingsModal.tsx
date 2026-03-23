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

/** Collapsible section header — same visual style as settings-section-header
 *  but clickable to expand/collapse the content below it. */
const SettingsAccordion: React.FC<{
  title: string
  defaultOpen?: boolean
  noDivider?: boolean
  children: React.ReactNode
}> = ({ title, defaultOpen = false, noDivider, children }) => {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <>
      {!noDivider && <div className="settings-divider" />}
      <button className={`settings-section-toggle${open ? ' open' : ''}`} onClick={() => setOpen(!open)}>
        <svg className="settings-section-chevron" width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="2,1 6,4 2,7" />
        </svg>
        {title}
      </button>
      {open && children}
    </>
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
  const [anthropicHasKey, setAnthropicHasKey] = useState<boolean | null>(null)
  const [anthropicKeyBusy, setAnthropicKeyBusy] = useState(false)
  const [anthropicKeyInput, setAnthropicKeyInput] = useState('')
  const [anthropicStatus, setAnthropicStatus] = useState('')

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

  // Check Anthropic API key status when behavior tab is shown
  useEffect(() => {
    if (tab === 'behavior' && anthropicHasKey === null) {
      getDockApi().usage.hasKey().then((r) => setAnthropicHasKey(r.hasKey)).catch(() => {})
    }
  }, [tab, anthropicHasKey])

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
  const updateAnthropic = (partial: Partial<Settings['anthropic']>) => {
    update({ anthropic: { ...settings.anthropic, ...partial } })
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
        <div
          className="settings-tabs"
          role="tablist"
          onKeyDown={(e) => {
            const tabs: SettingsTab[] = ['appearance', 'terminal', 'grid', 'keybindings', 'plugins', 'behavior']
            const idx = tabs.indexOf(tab)
            if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
              e.preventDefault()
              setTab(tabs[(idx + 1) % tabs.length])
            } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
              e.preventDefault()
              setTab(tabs[(idx - 1 + tabs.length) % tabs.length])
            }
          }}
        >
          {(['appearance', 'terminal', 'grid', 'keybindings', 'plugins', 'behavior'] as SettingsTab[]).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              tabIndex={tab === t ? 0 : -1}
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
                <div className="settings-divider" />
                <div className="settings-section-header">Default Permissions</div>
                <div className="settings-description">
                  Pre-approve tools and permission mode for new terminals so Claude doesn&apos;t ask each time. Only applies to newly spawned terminals.
                </div>
                <label>
                  Permission Mode
                  <select
                    value={settings.terminal.defaultPermissionMode ?? 'default'}
                    onChange={(e) => updateTerminal({ defaultPermissionMode: e.target.value as Settings['terminal']['defaultPermissionMode'] })}
                  >
                    <option value="default">Default (ask each time)</option>
                    <option value="acceptEdits">Accept edits</option>
                    <option value="bypassPermissions">Bypass all permissions</option>
                  </select>
                </label>
                <div className="settings-section-header" style={{ fontSize: 11, marginTop: 8 }}>Allowed Tools</div>
                <div className="settings-description">
                  Pre-approve specific tools. Leave all unchecked to use Claude&apos;s defaults.
                </div>
                <div className="tp-perms-tools">
                  {['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep'].map((tool) => {
                    const allowed = settings.terminal.defaultAllowedTools ?? []
                    const isChecked = allowed.includes(tool)
                    return (
                      <label key={tool} className="tp-perms-tool">
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={(e) => {
                            const next = e.target.checked
                              ? [...allowed, tool]
                              : allowed.filter((t: string) => t !== tool)
                            updateTerminal({ defaultAllowedTools: next })
                          }}
                        />
                        {tool}
                      </label>
                    )
                  })}
                </div>
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
                <label>
                  Viewport Mode
                  <select
                    value={settings.grid.viewportMode ?? 'auto'}
                    onChange={(e) =>
                      updateGrid({ viewportMode: e.target.value as Settings['grid']['viewportMode'] })
                    }
                  >
                    <option value="auto">Auto</option>
                    <option value="landscape">Landscape</option>
                    <option value="portrait">Portrait</option>
                  </select>
                </label>
                <div className="settings-description">
                  Auto detects viewport orientation and switches between landscape (side-by-side) and portrait (stacked) layouts.
                </div>
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
                <SettingsAccordion title="General" defaultOpen noDivider>
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
                </SettingsAccordion>

                <SettingsAccordion title="Notifications">
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
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={settings.behavior.idleNotification ?? false}
                    onChange={(e) => updateBehavior({ idleNotification: e.target.checked })}
                  />
                  Notify when terminal goes idle
                </label>
                <div className="settings-description">
                  Send an OS notification and flash the taskbar when a terminal stops producing output after significant activity, while the dock is not focused.
                </div>
                <label className={settings.behavior.idleNotification ? '' : 'disabled'}>
                  Minimum lines of activity
                  <input
                    type="number"
                    min={1}
                    max={1000}
                    value={settings.behavior.idleNotificationMinLines ?? 10}
                    disabled={!settings.behavior.idleNotification}
                    onChange={(e) => updateBehavior({ idleNotificationMinLines: parseInt(e.target.value) || 10 })}
                  />
                </label>
                <label className={settings.behavior.idleNotification ? '' : 'disabled'}>
                  Idle delay (ms)
                  <input
                    type="number"
                    min={1000}
                    max={60000}
                    step={1000}
                    value={settings.behavior.idleNotificationDelayMs ?? 5000}
                    disabled={!settings.behavior.idleNotification}
                    onChange={(e) => updateBehavior({ idleNotificationDelayMs: parseInt(e.target.value) || 5000 })}
                  />
                </label>
                <div className="settings-subsection-header">Block Notifications From</div>
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
                </SettingsAccordion>

                <SettingsAccordion title="Shell Integration">
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
                </SettingsAccordion>

                <SettingsAccordion title="Shell Panel">
                <label>
                  <input
                    type="checkbox"
                    checked={settings.shellPanel?.enabled ?? true}
                    onChange={(e) => update({ shellPanel: { ...settings.shellPanel, enabled: e.target.checked } } as any)}
                  />
                  Enable embedded shell panel in terminals
                </label>
                <div className="settings-description">
                  Adds a toggleable shell panel at the bottom of each Claude terminal. Opens with the button in the terminal header or bottom-left corner.
                </div>
                <label>
                  Preferred Shell
                  <select
                    value={settings.shellPanel?.preferredShell ?? 'default'}
                    onChange={(e) => update({ shellPanel: { ...settings.shellPanel, preferredShell: e.target.value } } as any)}
                  >
                    <option value="default">Default (system shell)</option>
                    <option value="bash">Bash</option>
                    <option value="cmd">Command Prompt (cmd)</option>
                    <option value="powershell">PowerShell</option>
                    <option value="pwsh">PowerShell Core (pwsh)</option>
                  </select>
                </label>
                <label>
                  Default Height (px)
                  <input
                    type="number"
                    min={80}
                    max={600}
                    step={10}
                    value={settings.shellPanel?.defaultHeight ?? 200}
                    onChange={(e) => update({ shellPanel: { ...settings.shellPanel, defaultHeight: parseInt(e.target.value) || 200 } } as any)}
                  />
                </label>
                </SettingsAccordion>

                <SettingsAccordion title="Privacy">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={settings.telemetry?.enabled ?? false}
                    onChange={(e) => {
                      getDockApi().telemetry.setConsent(e.target.checked)
                      update({ telemetry: { ...settings.telemetry, enabled: e.target.checked, consentGiven: true } } as any)
                    }}
                  />
                  Share anonymous usage telemetry
                </label>
                <div className="settings-description">
                  Sends anonymous session stats (duration, crash count, feature usage) to help improve Claude Dock. No personal data, terminal content, or file paths are ever collected.
                </div>
                </SettingsAccordion>

                <SettingsAccordion title="Dock MCP Server">
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
                </SettingsAccordion>

                <SettingsAccordion title="Anthropic API">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={settings.anthropic?.showUsageMeter ?? true}
                    onChange={(e) => updateAnthropic({ showUsageMeter: e.target.checked })}
                  />
                  Show usage meter
                </label>
                <div className="settings-description">
                  Display API spend as a percentage bar in the toolbar.
                </div>
                <label>
                  Spend limit (USD)
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={settings.anthropic?.spendLimitUsd ?? 100}
                    onChange={(e) => {
                      const val = parseFloat(e.target.value)
                      if (!isNaN(val) && val > 0) updateAnthropic({ spendLimitUsd: val })
                    }}
                    style={{ width: 80, marginLeft: 8 }}
                  />
                </label>
                <div className="settings-description">
                  Your monthly budget — the meter shows spend as a percentage of this limit.
                </div>
                <div className="settings-row">
                  <span className="settings-label">
                    API Key: {anthropicHasKey === null ? '...' : anthropicHasKey ? 'Configured' : 'Not configured'}
                  </span>
                  <div className="settings-btn-group">
                    {anthropicHasKey ? (
                      <button
                        className="settings-check-update-btn"
                        disabled={anthropicKeyBusy}
                        onClick={async () => {
                          setAnthropicKeyBusy(true)
                          setAnthropicStatus('')
                          try {
                            const r = await getDockApi().usage.clearKey()
                            if (r.success) {
                              setAnthropicHasKey(false)
                              setAnthropicStatus('API key cleared.')
                            } else {
                              setAnthropicStatus('Failed to clear key.')
                            }
                          } catch {
                            setAnthropicStatus('Operation failed.')
                          }
                          setAnthropicKeyBusy(false)
                        }}
                      >
                        {anthropicKeyBusy ? '...' : 'Clear API Key'}
                      </button>
                    ) : (
                      <>
                        <input
                          type="password"
                          placeholder="Paste API key"
                          value={anthropicKeyInput}
                          onChange={(e) => setAnthropicKeyInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && anthropicKeyInput.trim()) {
                              e.preventDefault()
                              ;(async () => {
                                setAnthropicKeyBusy(true)
                                setAnthropicStatus('')
                                try {
                                  const r = await getDockApi().usage.setKey(anthropicKeyInput.trim())
                                  if (r.success) {
                                    setAnthropicHasKey(true)
                                    setAnthropicKeyInput('')
                                    setAnthropicStatus('API key saved.')
                                  } else {
                                    setAnthropicStatus('Failed to save key.')
                                  }
                                } catch {
                                  setAnthropicStatus('Operation failed.')
                                }
                                setAnthropicKeyBusy(false)
                              })()
                            }
                          }}
                          style={{ width: 140, fontSize: 11, padding: '2px 6px', background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', borderRadius: 3, color: 'var(--text-primary)' }}
                        />
                        <button
                          className="settings-check-update-btn"
                          disabled={anthropicKeyBusy || !anthropicKeyInput.trim()}
                          onClick={async () => {
                            setAnthropicKeyBusy(true)
                            setAnthropicStatus('')
                            try {
                              const r = await getDockApi().usage.setKey(anthropicKeyInput.trim())
                              if (r.success) {
                                setAnthropicHasKey(true)
                                setAnthropicKeyInput('')
                                setAnthropicStatus('API key saved.')
                              } else {
                                setAnthropicStatus('Failed to save key.')
                              }
                            } catch {
                              setAnthropicStatus('Operation failed.')
                            }
                            setAnthropicKeyBusy(false)
                          }}
                        >
                          {anthropicKeyBusy ? '...' : 'Save'}
                        </button>
                      </>
                    )}
                  </div>
                </div>
                {anthropicStatus && <div className="settings-update-status">{anthropicStatus}</div>}
                <div className="settings-description">
                  <button
                    className="usage-setup-link"
                    onClick={() => getDockApi().app.openExternal('https://console.anthropic.com/settings/admin-keys')}
                    style={{ fontSize: 11 }}
                  >
                    Manage API keys on Anthropic Console
                  </button>
                </div>
                </SettingsAccordion>

                <SettingsAccordion title="Updates">
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
                </SettingsAccordion>

                <SettingsAccordion title="Advanced">
                <div>
                  <button
                    className="settings-check-update-btn"
                    onClick={() => getDockApi().debug.openDevTools()}
                  >
                    Open DevTools
                  </button>
                </div>
                <label>
                  Memory Limit (MB)
                  <input
                    type="number"
                    min={256}
                    max={8192}
                    step={256}
                    value={settings.advanced.maxHeapSizeMb}
                    onChange={(e) => update({ advanced: { ...settings.advanced, maxHeapSizeMb: parseInt(e.target.value) || 2048 } })}
                  />
                </label>
                <div className="settings-description">
                  V8 heap size for renderer processes. Increase if the git-manager crashes on large repos. Requires restart.
                </div>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={settings.advanced.livePluginReload}
                    onChange={(e) => update({ advanced: { ...settings.advanced, livePluginReload: e.target.checked } })}
                  />
                  Live Plugin Reload
                </label>
                <div className="settings-description">
                  Watch plugin files for changes and reload automatically. Requires restart.
                </div>
                <div className="settings-subsection-header">Claude CLI</div>
                <div>
                  <button
                    className="settings-check-update-btn"
                    onClick={handleCheckPath}
                    disabled={pathChecking}
                  >
                    {pathChecking ? 'Checking...' : 'Check & Fix PATH'}
                  </button>
                  <div className="settings-description" style={{ marginTop: 6 }}>
                    Check if the Claude CLI is in your shell PATH and fix it if not.
                  </div>
                  {pathCheckStatus && (
                    <div className="settings-update-status">{pathCheckStatus}</div>
                  )}
                </div>
                </SettingsAccordion>
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
