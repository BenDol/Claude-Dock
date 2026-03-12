import React, { useEffect, useState, useCallback, useRef } from 'react'
import { getDockApi } from '../lib/ipc-bridge'
import type { DockNotification } from '../../../shared/ci-types'

interface ToastEntry extends DockNotification {
  exiting: boolean
}

export default function ToastContainer() {
  const [toasts, setToasts] = useState<ToastEntry[]>([])
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

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

  return (
    <div className="toast-container">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`toast toast-${toast.type}${toast.exiting ? ' toast-exit' : ''}`}
        >
          <div className="toast-icon">{typeIcon(toast.type)}</div>
          <div className="toast-body">
            <div className="toast-title">{toast.title}</div>
            <div className="toast-message">{toast.message}</div>
            {toast.action && (
              <button
                className="toast-action"
                onClick={() => {
                  if (toast.action?.url) getDockApi().app.openExternal(toast.action.url)
                  removeToast(toast.id)
                }}
              >
                {toast.action.label}
              </button>
            )}
          </div>
          <button className="toast-close" onClick={() => removeToast(toast.id)}>×</button>
        </div>
      ))}
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
