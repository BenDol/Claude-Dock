import React, { useEffect, useState, useCallback, useRef } from 'react'
import { getDockApi } from '../lib/ipc-bridge'
import { useDockStore } from '../stores/dock-store'
import type { DockNotification, NotificationAction } from '../../../shared/ci-types'
import type { GitProvider } from '../../../shared/remote-url'
import { ProviderIcon } from '../plugins/git-manager/ProviderIcons'

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

export default function ToastContainer() {
  const [toasts, setToasts] = useState<ToastEntry[]>([])
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const projectDir = useDockStore((s) => s.projectDir)

  const removeToast = useCallback((id: string) => {
    // Start exit animation
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
    const cleanup = api.notifications.onShow((notification) => {
      const entry: ToastEntry = { ...notification, exiting: false }
      setToasts((prev) => [...prev.slice(-4), entry]) // keep max 5

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
  }, [removeToast])

  if (toasts.length === 0) return null

  // Resolve actions: prefer `actions` array, fall back to single `action`
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
            className={`toast toast-${toast.type}${toast.exiting ? ' toast-exit' : ''}${toast.source === 'ci' && toast.data?.runId ? ' toast-clickable' : ''}`}
            onClick={() => {
              if (toast.source === 'ci' && toast.data?.runId) {
                if (projectDir) {
                  // Dock window: route through IPC to open/focus git-manager
                  getDockApi().ci.navigateToRun(projectDir, toast.data.runId as number)
                } else {
                  // Already in git-manager window: dispatch DOM event
                  window.dispatchEvent(new CustomEvent('ci-navigate-run', { detail: toast.data.runId }))
                }
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
