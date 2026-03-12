import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useDockStore } from '../stores/dock-store'
import { getDockApi } from '../lib/ipc-bridge'
import { getToolbarActions } from '../toolbar-actions'
import type { PluginToolbarAction } from '../../../shared/plugin-types'
import type { DockNotification, NotificationAction } from '../../../shared/ci-types'
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
        <span className="toolbar-project" title={projectDir}>
          {projectDir.split(/[/\\]/).pop()}
        </span>
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
        <button className="toolbar-btn" onClick={onAddTerminal} title="New terminal (Ctrl+T)">
          +
        </button>
        {getToolbarActions().filter((a) => enabledPlugins === null || enabledPlugins.has(a.id)).map((action) => (
          <button
            key={action.id}
            className="toolbar-btn toolbar-btn-icon toolbar-btn-badge-wrap"
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
            className="toolbar-btn toolbar-btn-icon"
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
        <button className="toolbar-btn" onClick={onOpenSettings} title="Settings (Ctrl+,)">
          &#9881;
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
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
  </svg>
)

const NOTIF_STORAGE_KEY = 'dock-notifications'
const NOTIF_READ_KEY = 'dock-notifications-read'

function loadStoredNotifications(): DockNotification[] {
  try {
    const raw = localStorage.getItem(NOTIF_STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

function loadStoredReadIds(): Set<string> {
  try {
    const raw = localStorage.getItem(NOTIF_READ_KEY)
    return raw ? new Set(JSON.parse(raw)) : new Set()
  } catch { return new Set() }
}

const NotificationDropdown: React.FC = () => {
  const [open, setOpen] = useState(false)
  const [notifications, setNotifications] = useState<DockNotification[]>(() => loadStoredNotifications())
  const [readIds, setReadIds] = useState<Set<string>>(() => loadStoredReadIds())
  const ref = useRef<HTMLDivElement>(null)
  const projectDir = useDockStore((s) => s.projectDir)

  const unreadCount = notifications.filter((n) => !readIds.has(n.id)).length

  // Persist notifications
  useEffect(() => {
    try { localStorage.setItem(NOTIF_STORAGE_KEY, JSON.stringify(notifications)) } catch { /* ignore */ }
  }, [notifications])

  // Persist read state
  useEffect(() => {
    try { localStorage.setItem(NOTIF_READ_KEY, JSON.stringify([...readIds])) } catch { /* ignore */ }
  }, [readIds])

  useEffect(() => {
    const api = getDockApi()
    const cleanup = api.notifications.onShow((notification) => {
      setNotifications((prev) => [notification, ...prev].slice(0, MAX_NOTIFICATIONS))
    })
    return cleanup
  }, [])

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
    try {
      localStorage.removeItem(NOTIF_STORAGE_KEY)
      localStorage.removeItem(NOTIF_READ_KEY)
    } catch { /* ignore */ }
  }, [])

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <div className="tb-notif-dropdown" ref={ref}>
      <button
        className="toolbar-btn toolbar-btn-icon"
        onMouseDown={(e) => { e.stopPropagation(); setOpen(!open) }}
        title="Notifications"
      >
        <BellIcon />
        {unreadCount > 0 && <span className="toolbar-badge">{unreadCount > 9 ? '9+' : unreadCount}</span>}
      </button>
      {open && (
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
                  className={`tb-notif-item tb-notif-item-${n.type}${n.source === 'ci' && n.data?.runId ? ' tb-notif-item-clickable' : ''}`}
                  onClick={() => {
                    if (n.source === 'ci' && n.data?.runId && projectDir) {
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
                      &#8599;
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
      )}
    </div>
  )
}

export default Toolbar
