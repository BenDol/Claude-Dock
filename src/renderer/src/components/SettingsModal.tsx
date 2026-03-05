import React, { useState } from 'react'
import { useSettingsStore } from '../stores/settings-store'
import { getDockApi } from '../lib/ipc-bridge'
import type { Settings } from '../../../shared/settings-schema'

interface SettingsModalProps {
  onClose: () => void
}

type SettingsTab = 'appearance' | 'terminal' | 'grid' | 'behavior'

const SettingsModal: React.FC<SettingsModalProps> = ({ onClose }) => {
  const [tab, setTab] = useState<SettingsTab>('appearance')
  const settings = useSettingsStore((s) => s.settings)
  const update = useSettingsStore((s) => s.update)
  const [updateCheckStatus, setUpdateCheckStatus] = useState('')
  const [checkingUpdate, setCheckingUpdate] = useState(false)

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

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Settings</h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="settings-tabs">
          {(['appearance', 'terminal', 'grid', 'behavior'] as SettingsTab[]).map((t) => (
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
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={settings.behavior.autoSpawnFirstTerminal}
                    onChange={(e) => updateBehavior({ autoSpawnFirstTerminal: e.target.checked })}
                  />
                  Auto-spawn first terminal
                </label>
                <label>
                  Update Profile
                  <select
                    value={settings.updater?.profile || 'latest'}
                    onChange={(e) => updateUpdater({ profile: e.target.value })}
                  >
                    <option value="latest">Latest (stable)</option>
                    <option value="bleeding-edge">Bleeding Edge</option>
                  </select>
                </label>
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

export default SettingsModal
