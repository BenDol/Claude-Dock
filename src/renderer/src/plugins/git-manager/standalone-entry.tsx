/**
 * Self-contained renderer entry point for the git-manager plugin.
 *
 * This file is bundled by esbuild into a standalone IIFE that can run
 * independently of the main app's Vite output. It is used when a
 * renderer override exists in plugin-overrides/git-manager/renderer/.
 *
 * Differences from the main app entry (App.tsx):
 * - No lazy loading — GitManagerApp is imported directly
 * - Minimal ToastContainer that reads projectDir from URL params only
 *   (avoids importing useDockStore and all dock-specific dependencies)
 * - Loads settings and applies theme itself
 * - Includes plugin-update and app-restart event listeners
 * - Includes PluginUpdaterModal
 */

import React, { useEffect, useState, useCallback, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import '../../global.css'
import './git-manager.css'
import GitManagerApp from './GitManagerApp'
import { getDockApi } from '../../lib/ipc-bridge'
import { applyThemeToDocument } from '../../lib/theme'
import type { DockNotification, NotificationAction } from '../../../../shared/ci-types'
import type { GitProvider } from '../../../../shared/remote-url'
import { ProviderIcon } from './ProviderIcons'
import type { PluginUpdateEntry } from '../../../../shared/plugin-update-types'

// ---------------------------------------------------------------------------
// Minimal ToastContainer — reads projectDir from URL params only
// ---------------------------------------------------------------------------

interface ToastEntry extends DockNotification {
  exiting: boolean
}

function handleAction(action: NotificationAction, toast: DockNotification) {
  if (action.url) {
    getDockApi().app.openExternal(action.url)
  }
  if (action.event) {
    window.dispatchEvent(new CustomEvent(action.event, { detail: toast.data }))
  }
}

function typeIcon(type: DockNotification['type']): string {
  switch (type) {
    case 'success': return '\u2713'
    case 'error': return '\u2717'
    case 'warning': return '\u26A0'
    default: return '\u2139'
  }
}

const ClaudeIcon: React.FC = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" style={{ marginRight: 3, verticalAlign: -1 }}>
    <path d="M15.31 3.76l-4.3 15.98a.5.5 0 0 0 .96.26l4.3-15.98a.5.5 0 0 0-.96-.26zM8.71 7.29a.5.5 0 0 0-.71 0l-5 5a.5.5 0 0 0 0 .71l5 5a.5.5 0 0 0 .71-.71L4.41 13l4.3-4.29a.5.5 0 0 0 0-.71zm7 0a.5.5 0 0 1 .71 0l5 5a.5.5 0 0 1 0 .71l-5 5a.5.5 0 0 1-.71-.71L20.01 13l-4.3-4.29a.5.5 0 0 1 0-.71z" />
  </svg>
)

function StandaloneToastContainer() {
  const [toasts, setToasts] = useState<ToastEntry[]>([])
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  // In standalone mode, projectDir always comes from URL params
  const urlProjectDir = new URLSearchParams(window.location.search).get('projectDir')
  const projectDir = urlProjectDir ? decodeURIComponent(urlProjectDir) : ''

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.map((t) => t.id === id ? { ...t, exiting: true } : t))
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
    }, 200)
    const timer = timersRef.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timersRef.current.delete(id)
    }
  }, [])

  useEffect(() => {
    const api = getDockApi()
    const norm = (p: string) => p.replace(/[\\/]/g, '/').toLowerCase()
    const cleanup = api.notifications.onShow((notification) => {
      if (notification.projectDir) {
        if (!projectDir || norm(notification.projectDir) !== norm(projectDir)) return
      }
      const entry: ToastEntry = { ...notification, exiting: false }
      setToasts((prev) => [...prev.slice(-4), entry])

      const timeout = notification.timeout ?? 5000
      if (timeout > 0) {
        const timer = setTimeout(() => removeToast(notification.id), timeout)
        timersRef.current.set(notification.id, timer)
      }
    })

    return () => {
      cleanup()
      for (const timer of timersRef.current.values()) clearTimeout(timer)
      timersRef.current.clear()
    }
  }, [removeToast, projectDir])

  if (toasts.length === 0) return null

  const resolveActions = (toast: DockNotification): NotificationAction[] => {
    if (toast.actions && toast.actions.length > 0) return toast.actions
    if (toast.action) return [toast.action]
    return []
  }

  return (
    <div className="toast-container">
      {toasts.map((toast) => {
        const actions = resolveActions(toast)
        return (
          <div
            key={toast.id}
            className={`toast toast-${toast.type}${toast.exiting ? ' toast-exit' : ''}${toast.data?.runId ? ' toast-clickable' : ''}`}
            onClick={() => {
              if (toast.data?.runId) {
                // Already in git-manager window: dispatch DOM event
                window.dispatchEvent(new CustomEvent('ci-navigate-run', { detail: toast.data.runId }))
              }
              window.dispatchEvent(new CustomEvent('notification-read', { detail: toast.id }))
              removeToast(toast.id)
            }}
          >
            <div className="toast-icon">{typeIcon(toast.type)}</div>
            <div className="toast-body">
              <div className="toast-title">{toast.title}</div>
              <div className="toast-message">{toast.message}</div>
              {actions.length > 0 && (
                <div className="toast-actions">
                  {actions.map((action, i) => (
                    <button
                      key={i}
                      className={`toast-action${action.event ? ' toast-action-primary' : ''}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        handleAction(action, toast)
                        removeToast(toast.id)
                      }}
                    >
                      {action.event === 'ci-fix-with-claude' && <ClaudeIcon />}
                      {action.url && toast.data?.providerKey && <ProviderIcon provider={toast.data.providerKey as GitProvider} />}
                      {action.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button className="toast-close" onClick={() => removeToast(toast.id)}>×</button>
          </div>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// PluginUpdaterModal (inline copy — avoids importing from components/)
// ---------------------------------------------------------------------------

function PluginUpdaterModal({ onClose }: { onClose: () => void }) {
  const [updates, setUpdates] = useState<PluginUpdateEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedChangelogs, setExpandedChangelogs] = useState<Set<string>>(new Set())
  const backdropRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    const api = getDockApi()

    async function load() {
      try {
        const available = await api.pluginUpdater.getAvailable()
        if (!cancelled && available.length > 0) {
          setUpdates(available)
          setLoading(false)
          return
        }
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
    await getDockApi().pluginUpdater.install(pluginId)
  }, [])

  const handleInstallAll = useCallback(async () => {
    await getDockApi().pluginUpdater.installAll()
  }, [])

  const handleDismiss = useCallback(async (pluginId: string, version: string) => {
    await getDockApi().pluginUpdater.dismiss(pluginId, version)
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
                  <button className="plugin-update-all-btn" onClick={handleInstallAll}>
                    Update All ({installableCount})
                  </button>
                </div>
              )}
              <div className="plugin-update-list">
                {updates.map((entry) => {
                  const progressPct = entry.progress && entry.progress.total > 0
                    ? Math.round((entry.progress.downloaded / entry.progress.total) * 100)
                    : 0
                  return (
                    <div key={entry.pluginId} className={`plugin-update-card plugin-update-card--${entry.status}`}>
                      <div className="plugin-update-card-header">
                        <div className="plugin-update-card-info">
                          <span className="plugin-update-card-name">{entry.pluginName}</span>
                          <span className="plugin-update-badge">{entry.source === 'builtin' ? 'Built-in' : 'External'}</span>
                        </div>
                        <div className="plugin-update-card-actions">
                          {entry.status === 'available' && !entry.requiresAppUpdate && (
                            <>
                              <button className="plugin-update-dismiss-btn" onClick={() => handleDismiss(entry.pluginId, entry.newVersion)} title="Dismiss this update">{'\u2715'}</button>
                              <button className="plugin-update-btn" onClick={() => handleInstall(entry.pluginId)}>Update</button>
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
                              <button className="plugin-update-btn plugin-update-retry-btn" onClick={() => handleInstall(entry.pluginId)}>Retry</button>
                            </>
                          )}
                        </div>
                      </div>
                      <div className="plugin-update-version">
                        {entry.currentVersion} {'\u2192'} {entry.newVersion}
                      </div>
                      {entry.status === 'downloading' && (
                        <div className="plugin-update-progress-bar">
                          <div className="plugin-update-progress-fill" style={{ width: `${progressPct}%` }} />
                        </div>
                      )}
                      {entry.changelog && (
                        <div className="plugin-update-changelog-section">
                          <button className="plugin-update-changelog-toggle" onClick={() => toggleChangelog(entry.pluginId)}>
                            {expandedChangelogs.has(entry.pluginId) ? '\u25BC' : '\u25B6'} Changelog
                          </button>
                          {expandedChangelogs.has(entry.pluginId) && (
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
                })}
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

// ---------------------------------------------------------------------------
// Right-click context menu hook (inline — avoids importing from hooks/)
// ---------------------------------------------------------------------------

function setupInputContextMenu(): () => void {
  let menuEl: HTMLDivElement | null = null

  function close() {
    if (menuEl) {
      menuEl.remove()
      menuEl = null
    }
  }

  const TEXT_TYPES = new Set(['text', 'search', 'url', 'email', 'tel', 'number', 'password', ''])

  function isTextInput(el: EventTarget | null): el is HTMLInputElement | HTMLTextAreaElement {
    if (!el || !(el instanceof HTMLElement)) return false
    if (el instanceof HTMLTextAreaElement) return true
    if (el instanceof HTMLInputElement) return TEXT_TYPES.has(el.type.toLowerCase())
    return false
  }

  function handleContextMenu(e: MouseEvent) {
    const target = e.target
    if (!isTextInput(target)) return
    e.preventDefault()
    close()

    const hasSelection = (target.selectionStart ?? 0) !== (target.selectionEnd ?? 0)
    const hasValue = target.value.length > 0
    const isReadOnly = target.readOnly || target.disabled

    const menu = document.createElement('div')
    menu.className = 'input-ctx-menu'

    const items: { label: string; shortcut: string; disabled: boolean; action: () => void }[] = []

    if (!isReadOnly) {
      items.push({ label: 'Cut', shortcut: 'Ctrl+X', disabled: !hasSelection, action: () => { document.execCommand('cut'); close() } })
    }
    items.push({ label: 'Copy', shortcut: 'Ctrl+C', disabled: !hasSelection, action: () => { document.execCommand('copy'); close() } })
    if (!isReadOnly) {
      items.push({
        label: 'Paste', shortcut: 'Ctrl+V', disabled: false,
        action: () => {
          target.focus()
          navigator.clipboard.readText().then((text) => {
            if (!text) return
            if (!document.execCommand('insertText', false, text)) {
              const start = target.selectionStart ?? target.value.length
              const end = target.selectionEnd ?? start
              target.setRangeText(text, start, end, 'end')
              target.dispatchEvent(new Event('input', { bubbles: true }))
            }
          }).catch(() => {})
          close()
        }
      })
    }
    items.push({ label: '---', shortcut: '', disabled: false, action: () => {} })
    items.push({ label: 'Select All', shortcut: 'Ctrl+A', disabled: !hasValue, action: () => { target.focus(); target.select(); close() } })

    for (const item of items) {
      if (item.label === '---') {
        const sep = document.createElement('div')
        sep.className = 'input-ctx-separator'
        menu.appendChild(sep)
        continue
      }
      const row = document.createElement('div')
      row.className = 'input-ctx-item' + (item.disabled ? ' disabled' : '')
      row.innerHTML = `<span>${item.label}</span><span class="input-ctx-shortcut">${item.shortcut}</span>`
      if (!item.disabled) {
        row.addEventListener('mousedown', (ev) => { ev.preventDefault(); item.action() })
      }
      menu.appendChild(row)
    }

    document.body.appendChild(menu)
    menuEl = menu

    const zoom = parseFloat(document.documentElement.style.zoom) || 1
    let x = e.clientX / zoom
    let y = e.clientY / zoom
    const vw = window.innerWidth / zoom
    const vh = window.innerHeight / zoom
    const rect = menu.getBoundingClientRect()
    const mw = rect.width / zoom
    const mh = rect.height / zoom
    if (x + mw > vw) x = vw - mw - 4
    if (y + mh > vh) y = vh - mh - 4
    if (x < 0) x = 4
    if (y < 0) y = 4
    menu.style.left = `${x}px`
    menu.style.top = `${y}px`
  }

  function handleDismiss(e: MouseEvent) {
    if (menuEl && !menuEl.contains(e.target as Node)) close()
  }

  function handleKeyDismiss(e: KeyboardEvent) {
    if (e.key === 'Escape') close()
  }

  function handleScroll() {
    close()
  }

  document.addEventListener('contextmenu', handleContextMenu, true)
  document.addEventListener('mousedown', handleDismiss, true)
  document.addEventListener('keydown', handleKeyDismiss, true)
  window.addEventListener('scroll', handleScroll, true)
  window.addEventListener('blur', close)

  return () => {
    document.removeEventListener('contextmenu', handleContextMenu, true)
    document.removeEventListener('mousedown', handleDismiss, true)
    document.removeEventListener('keydown', handleKeyDismiss, true)
    window.removeEventListener('scroll', handleScroll, true)
    window.removeEventListener('blur', close)
    close()
  }
}

// ---------------------------------------------------------------------------
// Root App component
// ---------------------------------------------------------------------------

function StandaloneApp() {
  const [showPluginUpdater, setShowPluginUpdater] = useState(false)

  // Load settings and apply theme on mount
  useEffect(() => {
    const api = getDockApi()
    api.settings.get().then((settings) => {
      applyThemeToDocument(settings)
    })
    // Listen for settings changes
    api.settings.onChange((settings) => {
      applyThemeToDocument(settings)
    })
  }, [])

  // Set up input context menu
  useEffect(() => {
    return setupInputContextMenu()
  }, [])

  // Plugin-update-open event
  useEffect(() => {
    const handler = () => setShowPluginUpdater(true)
    window.addEventListener('plugin-update-open', handler)
    return () => window.removeEventListener('plugin-update-open', handler)
  }, [])

  // Update All action
  useEffect(() => {
    const handler = async () => {
      try {
        await getDockApi().pluginUpdater.installAll()
      } catch { /* errors shown via state change broadcast */ }
    }
    window.addEventListener('plugin-update-all', handler)
    return () => window.removeEventListener('plugin-update-all', handler)
  }, [])

  // Restart Now action
  useEffect(() => {
    const handler = () => getDockApi().app.restart()
    window.addEventListener('app-restart', handler)
    return () => window.removeEventListener('app-restart', handler)
  }, [])

  // Check for new-override notification
  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search)
    const pluginId = 'git-manager'
    if (!searchParams.has('gitManager')) return

    const timer = setTimeout(async () => {
      const api = getDockApi()
      try {
        const newOverrides = await api.pluginUpdater.getNewOverrides()
        const ov = newOverrides.find((o) => o.pluginId === pluginId)
        if (!ov) return
        const sha = ov.buildSha.slice(0, 7)
        const lines = [`v${ov.version} (${sha})`]
        if (ov.changelog) lines.push(ov.changelog)
        api.notifications.emit({
          id: `plugin-updated-${ov.pluginId}-${ov.hash.slice(0, 8)}`,
          title: `${ov.pluginName} Updated`,
          message: lines.join('\n'),
          type: 'success',
          source: 'plugin-updater',
          timeout: 0
        })
        await api.pluginUpdater.markOverrideSeen(ov.pluginId, ov.hash)
      } catch { /* ignore */ }
    }, 1000)
    return () => clearTimeout(timer)
  }, [])

  return (
    <>
      <GitManagerApp />
      <StandaloneToastContainer />
      {showPluginUpdater && <PluginUpdaterModal onClose={() => setShowPluginUpdater(false)} />}
    </>
  )
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

const root = createRoot(document.getElementById('root')!)
root.render(<StandaloneApp />)
