/**
 * Settings overlay for the coordinator panel.
 *
 * Allows the user to pick a provider, enter an API key, tune the model/temperature,
 * and test the connection. Provider metadata (default model, whether a key is
 * required, docs URL) comes from the main-process registry so we never have to
 * duplicate provider presets in the renderer.
 */

import React, { useCallback, useMemo } from 'react'
import type { CoordinatorProviderId } from '../../../../shared/coordinator-types'
import { useCoordinatorStore } from './coordinator-store'

export const CoordinatorSettings: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const config = useCoordinatorStore((s) => s.config)
  const providers = useCoordinatorStore((s) => s.providers)
  const testingConnection = useCoordinatorStore((s) => s.testingConnection)
  const testConnectionResult = useCoordinatorStore((s) => s.testConnectionResult)
  const hotkeyStatus = useCoordinatorStore((s) => s.hotkeyStatus)
  const setConfigPatch = useCoordinatorStore((s) => s.setConfigPatch)
  const testConnection = useCoordinatorStore((s) => s.testConnection)
  const resetConfig = useCoordinatorStore((s) => s.resetConfig)

  const selectedPreset = useMemo(
    () => providers.find((p) => p.id === config?.provider),
    [providers, config?.provider]
  )

  const isSdkBackend = config?.provider === 'claude-sdk'

  const onProviderChange = useCallback(
    (providerId: CoordinatorProviderId) => {
      const preset = providers.find((p) => p.id === providerId)
      if (!preset) return
      // Reset model + baseUrl to the preset defaults so switching providers
      // doesn't leave stale values that make the next request fail.
      void setConfigPatch({
        provider: providerId,
        model: preset.defaultModel,
        baseUrl: preset.baseUrl ?? ''
      })
    },
    [providers, setConfigPatch]
  )

  if (!config) return null

  return (
    <div className="coord-settings">
      <div className="coord-settings-header">
        <h3>Coordinator Settings</h3>
        <button className="coord-header-btn" onClick={onClose} title="Close">
          <CloseIcon />
        </button>
      </div>

      <div className="coord-settings-body">
        <div className="coord-field">
          <label htmlFor="coord-provider">Provider</label>
          <select
            id="coord-provider"
            value={config.provider}
            onChange={(e) => onProviderChange(e.target.value as CoordinatorProviderId)}
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          {selectedPreset?.docsUrl && (
            <span className="hint">
              Docs:&nbsp;
              <a
                href={selectedPreset.docsUrl}
                onClick={(e) => {
                  e.preventDefault()
                  void window.dockApi?.app?.openExternal?.(selectedPreset.docsUrl!)
                }}
              >
                {selectedPreset.docsUrl}
              </a>
            </span>
          )}
          {isSdkBackend && (
            <span className="hint">
              Uses your existing Claude Code subscription via the Claude Agent SDK — no API key
              required. The coordinator runs tools internally through the dock MCP server.
            </span>
          )}
        </div>

        {selectedPreset?.requiresApiKey && (
          <div className="coord-field">
            <label htmlFor="coord-api-key">API Key</label>
            <input
              id="coord-api-key"
              type="password"
              value={config.apiKey}
              placeholder="sk-… / gsk_… / …"
              onChange={(e) => void setConfigPatch({ apiKey: e.target.value })}
              autoComplete="off"
              spellCheck={false}
            />
            <span className="hint">
              Stored locally via electron-safe-storage. Never sent anywhere except the provider you pick.
            </span>
          </div>
        )}

        {(config.provider === 'openai-compat' || config.provider === 'ollama') && (
          <div className="coord-field">
            <label htmlFor="coord-base-url">Base URL</label>
            <input
              id="coord-base-url"
              type="text"
              value={config.baseUrl}
              placeholder={selectedPreset?.baseUrl ?? 'https://…/v1'}
              onChange={(e) => void setConfigPatch({ baseUrl: e.target.value })}
              spellCheck={false}
            />
          </div>
        )}

        {!isSdkBackend && (
          <div className="coord-field">
            <label htmlFor="coord-model">Model</label>
            <input
              id="coord-model"
              type="text"
              value={config.model}
              onChange={(e) => void setConfigPatch({ model: e.target.value })}
              spellCheck={false}
            />
            {selectedPreset && (
              <span className="hint">Default for {selectedPreset.label}: {selectedPreset.defaultModel}</span>
            )}
          </div>
        )}

        {!isSdkBackend && (
          <div className="coord-field">
            <label htmlFor="coord-temp">Temperature ({config.temperature.toFixed(2)})</label>
            <input
              id="coord-temp"
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={config.temperature}
              onChange={(e) => void setConfigPatch({ temperature: Number(e.target.value) })}
            />
            <span className="hint">Lower is more deterministic; 0.2 is a good default for orchestration.</span>
          </div>
        )}

        <div className="coord-field-row">
          <button
            className="coord-test-btn"
            onClick={() => void testConnection()}
            disabled={testingConnection}
          >
            {testingConnection ? 'Testing…' : 'Test connection'}
          </button>
          {testConnectionResult && (
            <span className={'coord-test-result ' + (testConnectionResult.ok ? 'ok' : 'fail')}>
              {testConnectionResult.ok
                ? `OK${testConnectionResult.latencyMs ? ` (${testConnectionResult.latencyMs}ms)` : ''}`
                : `Failed: ${testConnectionResult.error}`}
            </span>
          )}
        </div>

        <hr style={{ border: 'none', borderTop: '1px solid var(--border-color)', margin: '4px 0' }} />

        <div className="coord-field">
          <label>Worktree enforcement</label>
          <label className="coord-field-row" style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
            <input
              type="checkbox"
              checked={config.enforceWorktreeInPrompt}
              onChange={(e) => void setConfigPatch({ enforceWorktreeInPrompt: e.target.checked })}
            />
            <span style={{ fontSize: '12px', color: 'var(--text-primary)' }}>
              Instruct the LLM to create a git worktree for every dispatched task.
            </span>
          </label>
        </div>

        <div className="coord-field">
          <label>Hotkey</label>
          <label className="coord-field-row" style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
            <input
              type="checkbox"
              checked={config.hotkeyEnabled}
              onChange={(e) => void setConfigPatch({ hotkeyEnabled: e.target.checked })}
            />
            <span style={{ fontSize: '12px', color: 'var(--text-primary)' }}>
              Open the coordinator with Shift+Shift (double-tap).
            </span>
          </label>
          {hotkeyStatus && (
            <span className="hint">
              Status: {hotkeyStatus.ready ? `active (${hotkeyStatus.using})` : 'not running'}
              {hotkeyStatus.error ? ` — ${hotkeyStatus.error}` : ''}
            </span>
          )}
        </div>

        <div className="coord-field-row" style={{ marginTop: '8px' }}>
          <button
            className="coord-test-btn"
            onClick={() => {
              if (confirm('Reset all coordinator settings to defaults?')) void resetConfig()
            }}
          >
            Reset to defaults
          </button>
        </div>
      </div>
    </div>
  )
}

const CloseIcon: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
)
