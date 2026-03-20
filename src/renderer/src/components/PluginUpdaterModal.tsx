import React, { useEffect, useState, useCallback, useRef } from 'react'
import { getDockApi } from '../lib/ipc-bridge'
import type { PluginUpdateEntry } from '../../../shared/plugin-update-types'

interface Props {
  onClose: () => void
}

export default function PluginUpdaterModal({ onClose }: Props) {
  const [updates, setUpdates] = useState<PluginUpdateEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedChangelogs, setExpandedChangelogs] = useState<Set<string>>(new Set())
  const backdropRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    const api = getDockApi()

    async function load() {
      try {
        // Show cached results immediately if any (non-installed ones only)
        const available = await api.pluginUpdater.getAvailable()
        const pending = available.filter((u) => u.status !== 'installed')
        if (!cancelled && pending.length > 0) {
          setUpdates(pending)
          setLoading(false)
        }

        // Always trigger a fresh check so we pick up new updates
        const fresh = await api.pluginUpdater.check()
        if (!cancelled) {
          setUpdates(fresh)
          setLoading(false)
        }
      } catch {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [])

  // Listen for state changes from main process — handles updates arriving
  // from a background check that was already running when the modal opened
  useEffect(() => {
    const api = getDockApi()
    const cleanupState = api.pluginUpdater.onStateChanged((newUpdates) => {
      setUpdates(newUpdates)
      setLoading(false)
    })
    const cleanupProgress = api.pluginUpdater.onProgress((pluginId, downloaded, total) => {
      setUpdates((prev) =>
        prev.map((u) =>
          u.pluginId === pluginId
            ? { ...u, progress: { downloaded, total } }
            : u
        )
      )
    })
    return () => { cleanupState(); cleanupProgress() }
  }, [])

  const handleInstall = useCallback(async (pluginId: string) => {
    const api = getDockApi()
    await api.pluginUpdater.install(pluginId)
  }, [])

  const handleInstallAll = useCallback(async () => {
    const api = getDockApi()
    await api.pluginUpdater.installAll()
  }, [])

  const handleDismiss = useCallback(async (pluginId: string, version: string) => {
    const api = getDockApi()
    await api.pluginUpdater.dismiss(pluginId, version)
    setUpdates((prev) => prev.filter((u) => u.pluginId !== pluginId))
  }, [])

  const toggleChangelog = useCallback((pluginId: string) => {
    setExpandedChangelogs((prev) => {
      const next = new Set(prev)
      if (next.has(pluginId)) next.delete(pluginId)
      else next.add(pluginId)
      return next
    })
  }, [])

  const hasInstalled = updates.some((u) => u.status === 'installed')
  const installableCount = updates.filter(
    (u) => u.status === 'available' && !u.requiresAppUpdate
  ).length

  return (
    <div
      className="modal-overlay"
      ref={backdropRef}
      onClick={(e) => { if (e.target === backdropRef.current) onClose() }}
    >
      <div className="modal plugin-updater-modal">
        <div className="modal-header">
          <h2>Plugin Updates</h2>
          <button className="modal-close" onClick={onClose}>{'\u2715'}</button>
        </div>

        <div className="modal-body">
          {loading && updates.length === 0 ? (
            <div className="plugin-update-loading">Checking for updates...</div>
          ) : updates.length === 0 ? (
            <div className="plugin-update-empty">All plugins are up to date.</div>
          ) : (
            <>
              {installableCount > 1 && (
                <div className="plugin-update-actions">
                  <button
                    className="plugin-update-all-btn"
                    onClick={handleInstallAll}
                  >
                    Update All ({installableCount})
                  </button>
                </div>
              )}

              <div className="plugin-update-list">
                {updates.map((entry) => (
                  <PluginUpdateCard
                    key={entry.pluginId}
                    entry={entry}
                    changelogExpanded={expandedChangelogs.has(entry.pluginId)}
                    onToggleChangelog={() => toggleChangelog(entry.pluginId)}
                    onInstall={() => handleInstall(entry.pluginId)}
                    onDismiss={() => handleDismiss(entry.pluginId, entry.newVersion)}
                  />
                ))}
              </div>
            </>
          )}
        </div>

        {hasInstalled && (
          <div className="modal-footer">
            <span>{'\u2713'} Updates applied</span>
          </div>
        )}
      </div>
    </div>
  )
}

function PluginUpdateCard({
  entry,
  changelogExpanded,
  onToggleChangelog,
  onInstall,
  onDismiss
}: {
  entry: PluginUpdateEntry
  changelogExpanded: boolean
  onToggleChangelog: () => void
  onInstall: () => void
  onDismiss: () => void
}) {
  const progressPct = entry.progress && entry.progress.total > 0
    ? Math.round((entry.progress.downloaded / entry.progress.total) * 100)
    : 0

  return (
    <div className={`plugin-update-card plugin-update-card--${entry.status}`}>
      <div className="plugin-update-card-header">
        <div className="plugin-update-card-info">
          <span className="plugin-update-card-name">{entry.pluginName}</span>
          <span className="plugin-update-badge">{entry.source === 'builtin' ? 'Built-in' : 'External'}</span>
        </div>
        <div className="plugin-update-card-actions">
          {entry.status === 'available' && !entry.requiresAppUpdate && (
            <>
              <button className="plugin-update-dismiss-btn" onClick={onDismiss} title="Dismiss this update">
                {'\u2715'}
              </button>
              <button className="plugin-update-btn" onClick={onInstall}>
                Update
              </button>
            </>
          )}
          {entry.status === 'available' && entry.requiresAppUpdate && (
            <span className="plugin-update-requires-app">Requires app update</span>
          )}
          {entry.status === 'downloading' && (
            <span className="plugin-update-progress-text">{progressPct}%</span>
          )}
          {entry.status === 'installing' && (
            <span className="plugin-update-progress-text">Installing...</span>
          )}
          {entry.status === 'installed' && (
            <span className="plugin-update-installed">{'\u2713'} Updated</span>
          )}
          {entry.status === 'failed' && (
            <>
              <span className="plugin-update-error" title={entry.error}>Failed</span>
              <button className="plugin-update-btn plugin-update-retry-btn" onClick={onInstall}>
                Retry
              </button>
            </>
          )}
        </div>
      </div>

      <div className="plugin-update-version">
        {entry.currentVersion} {'\u2192'} {entry.newVersion}
      </div>

      {(entry.status === 'downloading') && (
        <div className="plugin-update-progress-bar">
          <div className="plugin-update-progress-fill" style={{ width: `${progressPct}%` }} />
        </div>
      )}

      {entry.changelog && (
        <div className="plugin-update-changelog-section">
          <button className="plugin-update-changelog-toggle" onClick={onToggleChangelog}>
            {changelogExpanded ? '\u25BC' : '\u25B6'} Changelog
          </button>
          {changelogExpanded && (
            <div className="plugin-update-changelog">
              {entry.changelog.split('\n').map((line, i) => (
                <div key={i}>{line}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
