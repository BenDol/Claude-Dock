import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useDockStore } from '../stores/dock-store'
import { useSettingsStore } from '../stores/settings-store'
import { getDockApi } from '../lib/ipc-bridge'
import { getToolbarActions } from '../toolbar-actions'
import type { PluginToolbarAction } from '../../../shared/plugin-types'
import type { DockNotification, NotificationAction } from '../../../shared/ci-types'
import type { GitProvider } from '../../../shared/remote-url'
import { ProviderIcon } from '../plugins/git-manager/ProviderIcons'
import { sanitizeSvg } from '../lib/svg-sanitize'

interface ToolbarProps {
  projectDir: string
  onAddTerminal: () => void
  onOpenSettings: () => void
}

const stripAnsi = (str: string): string =>
  str
    .replace(/\x1b\][^\x07]*\x07/g, '') // OSC sequences (e.g. title set)
    .replace(/[\x1b\x9b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nq-uy=><~]/g, '')

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function sendRCCommand(api: ReturnType<typeof getDockApi>, terminalId: string): Promise<void> {
  await api.terminal.write(terminalId, '/remote-control')
  await delay(300)
  await api.terminal.write(terminalId, '\x1b') // dismiss autocomplete
  await delay(100)
  await api.terminal.write(terminalId, '\r') // submit
}

const RemoteControlIcon: React.FC = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="12" r="2" />
    <path d="M16.24 7.76a6 6 0 010 8.49m-8.48 0a6 6 0 010-8.49" />
  </svg>
)

const PlusIcon: React.FC = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
)

const SettingsIcon: React.FC = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
  </svg>
)

const FolderIcon: React.FC = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
  </svg>
)


const Toolbar: React.FC<ToolbarProps> = ({ projectDir, onAddTerminal, onOpenSettings }) => {
  const terminalCount = useDockStore((s) => s.terminals.length)
  const rcCount = useDockStore((s) => s.rcTerminals.size)
  const hasLoadingTerminals = useDockStore((s) => s.loadingTerminals.size > 0)
  const [toggling, setToggling] = useState(false)
  const rcBufsRef = useRef<Map<string, string>>(new Map())
  const [runtimeActions, setRuntimeActions] = useState<PluginToolbarAction[]>([])
  const [badges, setBadges] = useState<Record<string, string | number>>({})
  const [enabledPlugins, setEnabledPlugins] = useState<Set<string> | null>(null)
  const [openPluginWindows, setOpenPluginWindows] = useState<Set<string>>(new Set())

  // Fetch plugin enabled states, re-fetch when toggled via settings
  useEffect(() => {
    if (!projectDir) return
    const fetchStates = () => {
      getDockApi().plugins.getStates(projectDir).then((states) => {
        const enabled = new Set<string>()
        for (const [id, state] of Object.entries(states)) {
          if (state.enabled) enabled.add(id)
        }
        setEnabledPlugins(enabled)
      }).catch(() => {})
    }
    fetchStates()
    window.addEventListener('plugin-state-changed', fetchStates)
    return () => window.removeEventListener('plugin-state-changed', fetchStates)
  }, [projectDir])

  // Track which plugins have open windows
  useEffect(() => {
    if (!projectDir) return
    getDockApi().plugins.getOpenWindows(projectDir).then((ids) => {
      setOpenPluginWindows(new Set(ids))
    }).catch(() => {})
    const cleanup = getDockApi().plugins.onWindowStateChanged(({ pluginId, projectDir: dir, open }) => {
      if (dir.replace(/[\\/]/g, '/').toLowerCase() !== projectDir.replace(/[\\/]/g, '/').toLowerCase()) return
      setOpenPluginWindows((prev) => {
        const next = new Set(prev)
        if (open) next.add(pluginId)
        else next.delete(pluginId)
        return next
      })
    })
    return cleanup
  }, [projectDir])

  // Load runtime plugin toolbar actions on mount, sanitizing SVG icons
  useEffect(() => {
    getDockApi().plugins.getToolbarActions().then((actions) => {
      setRuntimeActions(actions.map((a) => ({ ...a, icon: sanitizeSvg(a.icon) })))
    }).catch(() => {})
  }, [])

  // Poll badges for toolbar actions that provide getBadge
  useEffect(() => {
    if (!projectDir) return
    const actions = getToolbarActions().filter((a) => a.getBadge && (enabledPlugins === null || enabledPlugins.has(a.id)))
    if (actions.length === 0) return

    const poll = () => {
      for (const action of actions) {
        action.getBadge!(projectDir).then((val) => {
          setBadges((prev) => {
            if (val == null) {
              if (!(action.id in prev)) return prev
              const next = { ...prev }
              delete next[action.id]
              return next
            }
            if (prev[action.id] === val) return prev
            return { ...prev, [action.id]: val }
          })
        }).catch(() => {})
      }
    }

    poll()
    const interval = setInterval(poll, 10000)
    return () => clearInterval(interval)
  }, [projectDir, enabledPlugins])

  // Listen for RC disconnect only while RC terminals exist
  useEffect(() => {
    if (rcCount === 0) {
      rcBufsRef.current.clear()
      return
    }
    const api = getDockApi()
    const cleanup = api.terminal.onData((id, data) => {
      const store = useDockStore.getState()
      if (!store.rcTerminals.has(id)) return
      const stripped = stripAnsi(data)
      const prev = rcBufsRef.current.get(id) || ''
      const buf = prev + stripped
      rcBufsRef.current.set(id, buf.slice(-100))
      const compact = buf.toLowerCase().replace(/\s/g, '')
      if (compact.includes('remotecontroldisconnected')) {
        store.setTerminalRC(id, false)
        rcBufsRef.current.delete(id)
      }
    })
    return cleanup
  }, [rcCount > 0])

  const toggleRemoteControl = useCallback(async () => {
    if (toggling) return
    const api = getDockApi()
    const state = useDockStore.getState()
    const alive = state.terminals.filter((t) => t.isAlive)
    if (alive.length === 0) return

    const anyHaveRC = alive.some((t) => state.rcTerminals.has(t.id))

    setToggling(true)

    if (anyHaveRC) {
      // Turn OFF — only stop RC on terminals that have it (parallel)
      const toDisable = alive.filter((t) => state.rcTerminals.has(t.id))
      await Promise.all(toDisable.map(async (terminal) => {
        await sendRCCommand(api, terminal.id)
        await delay(800)
        await api.terminal.write(terminal.id, '\x1b[A') // up arrow
        await delay(100)
        await api.terminal.write(terminal.id, '\x1b[A') // up arrow
        await delay(100)
        await api.terminal.write(terminal.id, '\r') // confirm stop
        useDockStore.getState().setTerminalRC(terminal.id, false)
      }))
    } else {
      // Turn ON — send to all terminals in parallel
      const toEnable = alive.filter((t) => !state.rcTerminals.has(t.id))
      await Promise.all(toEnable.map((terminal) =>
        new Promise<void>(async (resolve) => {
          let resolved = false
          let buf = ''
          const RC_ACTIVE = '/remote-control is active'

          const cleanupData = api.terminal.onData((id, data) => {
            if (id !== terminal.id || resolved) return
            const stripped = stripAnsi(data)
            buf += stripped
            buf = buf.slice(-200)
            if (buf.includes(RC_ACTIVE)) {
              resolved = true
              clearTimeout(timer)
              cleanupData()
              useDockStore.getState().setTerminalRC(terminal.id, true)
              resolve()
            }
          })

          await sendRCCommand(api, terminal.id)

          const timer = setTimeout(() => {
            if (!resolved) {
              resolved = true
              cleanupData()
              // Assume success on timeout
              useDockStore.getState().setTerminalRC(terminal.id, true)
              resolve()
            }
          }, 3000)
        })
      ))
    }

    setToggling(false)
  }, [toggling])

  const api = getDockApi()

  return (
    <div className="toolbar">
      <div className="toolbar-left">
        <WorkspaceDropdown projectDir={projectDir} />
        <span className="toolbar-count">{terminalCount} terminal{terminalCount !== 1 ? 's' : ''}</span>
        <button
          className={`toolbar-btn toolbar-btn-icon${rcCount > 0 ? ' toolbar-btn-active' : ''}`}
          onClick={toggleRemoteControl}
          disabled={toggling || hasLoadingTerminals}
          title={
            rcCount > 0
              ? `Remote Control: ${rcCount}/${terminalCount} (click to stop)`
              : 'Remote Control: OFF (click to start)'
          }
        >
          {toggling ? (
            <span className="toolbar-spinner" />
          ) : (
            <RemoteControlIcon />
          )}
        </button>
      </div>
      <div className="toolbar-center" />
      <div className="toolbar-right">
        <button className="toolbar-btn toolbar-btn-icon" onClick={onAddTerminal} title="New terminal (Ctrl+T)">
          <PlusIcon />
        </button>
        {getToolbarActions().filter((a) => enabledPlugins === null || enabledPlugins.has(a.id)).map((action) => (
          <button
            key={action.id}
            className={`toolbar-btn toolbar-btn-icon toolbar-btn-badge-wrap${openPluginWindows.has(action.id) ? ' toolbar-btn-window-open' : ''}`}
            onClick={() => action.onClick(projectDir)}
            title={action.title}
          >
            {action.icon}
            {badges[action.id] != null && (
              <span className="toolbar-badge">{badges[action.id]}</span>
            )}
          </button>
        ))}
        {runtimeActions.filter((a) => enabledPlugins === null || enabledPlugins.has(a.pluginId)).map((action) => (
          <button
            key={action.pluginId}
            className={`toolbar-btn toolbar-btn-icon${openPluginWindows.has(action.pluginId) ? ' toolbar-btn-window-open' : ''}`}
            onClick={() => getDockApi().plugins.invoke(action.action, projectDir)}
            title={action.title}
          >
            <span dangerouslySetInnerHTML={{ __html: action.icon }} />
          </button>
        ))}
        <button
          className="toolbar-btn toolbar-btn-icon"
          onClick={() => api.app.openInExplorer(projectDir)}
          title="Open in file explorer"
        >
          <FolderIcon />
        </button>
        <button className="toolbar-btn toolbar-btn-icon" onClick={onOpenSettings} title="Settings (Ctrl+,)">
          <SettingsIcon />
        </button>
        <NotificationDropdown />
        <div className="toolbar-separator" />
        <button className="win-btn win-minimize" onClick={() => api.win.minimize()} title="Minimize">
          &#x2015;
        </button>
        <button className="win-btn win-maximize" onClick={() => api.win.maximize()} title="Maximize">
          &#9744;
        </button>
        <button className="win-btn win-close" onClick={() => api.win.close()} title="Close">
          &#10005;
        </button>
      </div>
    </div>
  )
}

// --- Workspace Dropdown ---

type WsAction = 'browse' | 'clone'

const WorkspaceDropdown: React.FC<{ projectDir: string }> = ({ projectDir }) => {
  const [open, setOpen] = useState(false)
  const [recents, setRecents] = useState<{ path: string; name: string; lastOpened: number }[]>([])
  const [cloneMode, setCloneMode] = useState(false)
  const [cloneUrl, setCloneUrl] = useState('')
  const [cloneDest, setCloneDest] = useState('')
  const [cloning, setCloning] = useState(false)
  const [cloneError, setCloneError] = useState('')
  const [promptPath, setPromptPath] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  const api = getDockApi()
  const folderName = projectDir.split(/[/\\]/).pop() || projectDir

  // Load recents when opened
  useEffect(() => {
    if (!open) return
    api.app.getRecentPaths().then(setRecents)
    setCloneMode(false)
    setCloneUrl('')
    setCloneDest('')
    setCloneError('')
  }, [open])

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const openProject = useCallback((path: string) => {
    setPromptPath(path)
  }, [])

  const confirmOpen = useCallback(async (mode: 'this' | 'new') => {
    if (!promptPath) return
    const dir = promptPath
    setPromptPath(null)
    setOpen(false)
    if (mode === 'this') {
      api.dock.switchProject(dir)
    } else {
      api.app.openDockPath(dir)
    }
  }, [promptPath])

  const handleBrowse = useCallback(async () => {
    const dir = await api.app.pickDirectory()
    if (dir) openProject(dir)
  }, [openProject])

  const handleClone = useCallback(async () => {
    if (!cloneUrl.trim() || !cloneDest.trim()) return
    setCloning(true)
    setCloneError('')
    const result = await api.git.clone(cloneUrl.trim(), cloneDest.trim())
    setCloning(false)
    if (result.success && result.clonedPath) {
      openProject(result.clonedPath)
    } else {
      setCloneError(result.error || 'Clone failed')
    }
  }, [cloneUrl, cloneDest, openProject])

  const handleRemoveRecent = useCallback((e: React.MouseEvent, path: string) => {
    e.stopPropagation()
    api.app.removeRecentPath(path)
    setRecents((prev) => prev.filter((r) => r.path !== path))
  }, [])

  const recentItems = recents.filter((r) => r.path.replace(/[\\/]/g, '/').toLowerCase() !== projectDir.replace(/[\\/]/g, '/').toLowerCase())

  return (
    <div className="ws-dropdown" ref={ref}>
      <button
        className={`toolbar-project ws-dropdown-trigger${open ? ' ws-dropdown-trigger-open' : ''}`}
        onMouseDown={(e) => { e.stopPropagation(); setOpen(!open) }}
        title={projectDir}
      >
        {folderName}
        <span className="ws-dropdown-arrow">{'\u25BE'}</span>
      </button>
      {open && !promptPath && (
        <>
          <div className="ws-dropdown-backdrop" onMouseDown={() => setOpen(false)} />
          <div className="ws-dropdown-panel">
            {!cloneMode ? (
              <>
                <div className="ws-dropdown-actions">
                  <button className="ws-dropdown-action" onClick={handleBrowse}>
                    <WsBrowseIcon /> Browse Folder...
                  </button>
                  <button className="ws-dropdown-action" onClick={() => setCloneMode(true)}>
                    <WsCloneIcon /> Git Clone...
                  </button>
                </div>
                {recentItems.length > 0 && (
                  <>
                    <div className="ws-dropdown-divider" />
                    <div className="ws-dropdown-label">Recent Workspaces</div>
                    <div className="ws-dropdown-recents">
                      {recentItems.map((r) => (
                        <div key={r.path} className="ws-dropdown-recent" onClick={() => openProject(r.path)} title={r.path}>
                          <span className="ws-dropdown-recent-name">{r.name}</span>
                          <span className="ws-dropdown-recent-time">{formatTimeAgo(r.lastOpened)}</span>
                          <button className="ws-dropdown-recent-remove" onClick={(e) => handleRemoveRecent(e, r.path)} title="Remove from recents">
                            {'\u2715'}
                          </button>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </>
            ) : (
              <div className="ws-clone-form">
                <div className="ws-clone-back" onClick={() => setCloneMode(false)}>{'\u2190'} Back</div>
                <input
                  className="ws-clone-input"
                  placeholder="Repository URL"
                  value={cloneUrl}
                  onChange={(e) => setCloneUrl(e.target.value)}
                  autoFocus
                  onKeyDown={(e) => { if (e.key === 'Enter' && cloneDest) handleClone() }}
                />
                <div className="ws-clone-dest-row">
                  <input
                    className="ws-clone-input ws-clone-dest"
                    placeholder="Destination folder"
                    value={cloneDest}
                    onChange={(e) => setCloneDest(e.target.value)}
                    readOnly
                  />
                  <button className="ws-clone-browse" onClick={async () => { const d = await api.app.pickDirectory(); if (d) setCloneDest(d) }}>...</button>
                </div>
                {cloneError && <div className="ws-clone-error">{cloneError}</div>}
                <button className="ws-clone-btn" onClick={handleClone} disabled={cloning || !cloneUrl.trim() || !cloneDest.trim()}>
                  {cloning ? <><span className="toolbar-spinner" /> Cloning...</> : 'Clone'}
                </button>
              </div>
            )}
          </div>
        </>
      )}
      {promptPath && (
        <>
          <div className="ws-dropdown-backdrop" onMouseDown={() => setPromptPath(null)} />
          <div className="ws-dropdown-panel ws-prompt-panel">
            <div className="ws-prompt-title">Open in</div>
            <div className="ws-prompt-path" title={promptPath}>{promptPath.split(/[/\\]/).pop()}</div>
            <div className="ws-prompt-buttons">
              <button className="ws-prompt-btn" onClick={() => confirmOpen('this')}>This Window</button>
              <button className="ws-prompt-btn ws-prompt-btn-primary" onClick={() => confirmOpen('new')}>New Window</button>
            </div>
            <button className="ws-prompt-cancel" onClick={() => setPromptPath(null)}>Cancel</button>
          </div>
        </>
      )}
    </div>
  )
}

function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day}d ago`
  return new Date(ts).toLocaleDateString()
}

const WsBrowseIcon: React.FC = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
  </svg>
)

const WsCloneIcon: React.FC = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M16 17l5-5-5-5" /><path d="M21 12H9" /><path d="M9 3H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h5" />
  </svg>
)

const MAX_NOTIFICATIONS = 30

function resolveActions(n: DockNotification): NotificationAction[] {
  if (n.actions && n.actions.length > 0) return n.actions
  if (n.action) return [n.action]
  return []
}

function notifIcon(type: DockNotification['type']): string {
  switch (type) {
    case 'success': return '\u2713'
    case 'error': return '\u2717'
    case 'warning': return '\u26A0'
    default: return '\u2139'
  }
}

const NotifRepairIcon: React.FC = () => (
  <svg className="tb-notif-repair-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
  </svg>
)

const BellIcon: React.FC = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
  </svg>
)

function notifStorageKey(projectDir: string): string {
  return `dock-notifications:${projectDir.replace(/[\\/]/g, '/').toLowerCase()}`
}

function notifReadKey(projectDir: string): string {
  return `dock-notifications-read:${projectDir.replace(/[\\/]/g, '/').toLowerCase()}`
}

function loadStoredNotifications(projectDir: string): DockNotification[] {
  if (!projectDir) return []
  try {
    const raw = localStorage.getItem(notifStorageKey(projectDir))
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

function loadStoredReadIds(projectDir: string): Set<string> {
  if (!projectDir) return new Set()
  try {
    const raw = localStorage.getItem(notifReadKey(projectDir))
    return raw ? new Set(JSON.parse(raw)) : new Set()
  } catch { return new Set() }
}

const NotificationDropdown: React.FC = () => {
  const [open, setOpen] = useState(false)
  const [notifications, setNotifications] = useState<DockNotification[]>([])
  const [readIds, setReadIds] = useState<Set<string>>(new Set())
  const ref = useRef<HTMLDivElement>(null)
  const projectDir = useDockStore((s) => s.projectDir)
  const markAllRead = useSettingsStore((s) => s.settings.behavior?.markNotificationsRead ?? false)

  // Reload stored notifications when projectDir becomes available or changes
  useEffect(() => {
    if (!projectDir) return
    setNotifications(loadStoredNotifications(projectDir))
    setReadIds(loadStoredReadIds(projectDir))
  }, [projectDir])

  const unreadCount = notifications.filter((n) => !readIds.has(n.id)).length

  // Persist notifications (project-scoped)
  useEffect(() => {
    if (!projectDir) return
    try { localStorage.setItem(notifStorageKey(projectDir), JSON.stringify(notifications)) } catch { /* ignore */ }
  }, [notifications, projectDir])

  // Persist read state (project-scoped)
  useEffect(() => {
    if (!projectDir) return
    try { localStorage.setItem(notifReadKey(projectDir), JSON.stringify([...readIds])) } catch { /* ignore */ }
  }, [readIds, projectDir])

  useEffect(() => {
    const api = getDockApi()
    const norm = (p: string) => p.replace(/[\\/]/g, '/').toLowerCase()
    const cleanup = api.notifications.onShow((notification) => {
      // Only show project-scoped notifications in the matching project window
      if (notification.projectDir) {
        if (!projectDir || norm(notification.projectDir) !== norm(projectDir)) return
      }
      setNotifications((prev) => [notification, ...prev].slice(0, MAX_NOTIFICATIONS))
      // Auto-mark as read if the setting is enabled or window is focused
      if (markAllRead || document.hasFocus()) {
        setReadIds((prev) => new Set(prev).add(notification.id))
      }
    })
    return cleanup
  }, [markAllRead, projectDir])

  // Mark all as read when panel opens
  useEffect(() => {
    if (open) setReadIds(new Set(notifications.map((n) => n.id)))
  }, [open])

  // Listen for toast clicks marking individual notifications as read
  useEffect(() => {
    const handler = (e: Event) => {
      const id = (e as CustomEvent).detail as string
      if (id) setReadIds((prev) => new Set(prev).add(id))
    }
    window.addEventListener('notification-read', handler)
    return () => window.removeEventListener('notification-read', handler)
  }, [])

  const removeNotification = useCallback((id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id))
  }, [])

  const clearAll = useCallback(() => {
    setNotifications([])
    setReadIds(new Set())
    if (projectDir) {
      try {
        localStorage.removeItem(notifStorageKey(projectDir))
        localStorage.removeItem(notifReadKey(projectDir))
      } catch { /* ignore */ }
    }
  }, [projectDir])

  return (
    <div className="tb-notif-dropdown" ref={ref}>
      <button
        className="toolbar-btn toolbar-btn-icon toolbar-btn-badge-wrap"
        onMouseDown={(e) => { e.stopPropagation(); setOpen(!open) }}
        title="Notifications"
      >
        <BellIcon />
        {unreadCount > 0 && <span className="toolbar-badge toolbar-badge-notif">{unreadCount > 9 ? '9+' : unreadCount}</span>}
      </button>
      {open && (
        <>
        <div className="ws-dropdown-backdrop" onMouseDown={() => setOpen(false)} />
        <div className="tb-notif-panel" onMouseDown={(e) => e.stopPropagation()}>
          <div className="tb-notif-header">
            <span>Notifications</span>
            {notifications.length > 0 && (
              <button className="tb-notif-clear" onClick={clearAll}>Clear</button>
            )}
          </div>
          <div className="tb-notif-list">
            {notifications.length === 0 ? (
              <div className="tb-notif-empty">No notifications</div>
            ) : (
              notifications.map((n) => (
                <div
                  key={n.id}
                  className={`tb-notif-item tb-notif-item-${n.type}${n.data?.runId ? ' tb-notif-item-clickable' : ''}`}
                  onClick={() => {
                    if (n.data?.runId && projectDir) {
                      getDockApi().ci.navigateToRun(projectDir, n.data.runId as number)
                      setOpen(false)
                    }
                  }}
                >
                  <span className="tb-notif-icon">{notifIcon(n.type)}</span>
                  <div className="tb-notif-body">
                    <div className="tb-notif-title">{n.title}</div>
                    <div className="tb-notif-msg">{n.message}</div>
                    {resolveActions(n).filter((a) => a.event).map((a, i) => (
                      <button
                        key={i}
                        className="tb-notif-event-action"
                        onClick={(e) => {
                          e.stopPropagation()
                          window.dispatchEvent(new CustomEvent(a.event!, { detail: n.data }))
                          setOpen(false)
                        }}
                      >
                        {a.event === 'ci-fix-with-claude' && <NotifRepairIcon />}
                        {a.label}
                      </button>
                    ))}
                  </div>
                  {resolveActions(n).some((a) => a.url) && (
                    <button
                      className="tb-notif-link"
                      onClick={(e) => {
                        e.stopPropagation()
                        const urlAction = resolveActions(n).find((a) => a.url)
                        if (urlAction?.url) getDockApi().app.openExternal(urlAction.url)
                      }}
                      title={resolveActions(n).find((a) => a.url)?.label ?? 'Open'}
                    >
                      {n.data?.providerKey ? <ProviderIcon provider={n.data.providerKey as GitProvider} /> : <>&#8599;</>}
                    </button>
                  )}
                  <button
                    className="tb-notif-dismiss"
                    onClick={(e) => { e.stopPropagation(); removeNotification(n.id) }}
                    title="Dismiss"
                  >
                    &times;
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
        </>
      )}
    </div>
  )
}

export default Toolbar
