import React, { useCallback } from 'react'
import { useDockStore } from '../stores/dock-store'
import { getDockApi } from '../lib/ipc-bridge'
import './ShellEventCards.css'

interface ShellEventCardsProps {
  terminalId: string
  sessionId: string | null
}

const EVENT_ICONS: Record<string, string> = {
  server_stopped: '\u23F9',
  exception_detected: '\u26A0',
  compile_error: '\u2717',
  compile_success: '\u2713',
  hot_swap_success: '\u21BB',
  hot_swap_failed: '\u21BB',
  server_starting: '\u25B6',
  svelte_starting: '\u25B6'
}

const EVENT_COLORS: Record<string, string> = {
  server_stopped: '#c5392f',
  exception_detected: '#b8860b',
  compile_error: '#c5392f',
  compile_success: '#2d7d5f',
  hot_swap_success: '#2d7d5f',
  hot_swap_failed: '#b8860b',
  server_starting: '#1a3a5c',
  svelte_starting: '#1a3a5c'
}

const ShellEventCards: React.FC<ShellEventCardsProps> = ({ terminalId, sessionId }) => {
  const events = useDockStore((s) => s.shellEvents)
  const ignoredTypes = useDockStore((s) => s.ignoredEventTypes)
  const dismissEvent = useDockStore((s) => s.dismissShellEvent)
  const ignoreType = useDockStore((s) => s.ignoreEventType)

  // Filter to events for this terminal's session, excluding ignored types
  const visibleEvents = events.filter(
    (e) => e.sessionId === sessionId && !ignoredTypes.includes(e.type)
  )

  const handleClick = useCallback(
    (event: (typeof events)[0]) => {
      const payload =
        typeof event.payload === 'object' ? JSON.stringify(event.payload) : event.payload
      const message = `[dock-event] ${event.type}: ${payload}`
      getDockApi().terminal.write(terminalId, message + '\r')
      dismissEvent(event.id)
    },
    [terminalId, dismissEvent]
  )

  const handleClose = useCallback(
    (e: React.MouseEvent, eventId: string) => {
      e.stopPropagation()
      dismissEvent(eventId)
    },
    [dismissEvent]
  )

  const handleIgnore = useCallback(
    (e: React.MouseEvent, eventType: string) => {
      e.stopPropagation()
      ignoreType(eventType)
    },
    [ignoreType]
  )

  if (visibleEvents.length === 0) return null

  return (
    <div className="shell-event-cards">
      {visibleEvents.map((event) => {
        const icon = EVENT_ICONS[event.type] || '\u25CF'
        const color = EVENT_COLORS[event.type] || '#6b6966'
        const shellShort = event.shellId.split(':').pop() || '?'
        const time = new Date(event.timestamp).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit'
        })
        const summary =
          typeof event.payload === 'object'
            ? event.payload.reason ||
              event.payload.header?.slice(0, 80) ||
              event.type
            : event.payload || event.type

        return (
          <div
            key={event.id}
            className="shell-event-card"
            style={{ borderLeftColor: color }}
            onClick={() => handleClick(event)}
            title="Click to submit to Claude"
          >
            <div className="shell-event-card-header">
              <span className="shell-event-icon" style={{ color }}>
                {icon}
              </span>
              <span className="shell-event-type">{event.type.replace(/_/g, ' ')}</span>
              <span className="shell-event-meta">
                shell:{shellShort} {time}
              </span>
              <div className="shell-event-actions">
                <button
                  className="shell-event-ignore-btn"
                  onClick={(e) => handleIgnore(e, event.type)}
                  title={`Ignore all "${event.type}" events`}
                >
                  {'\u2298'}
                </button>
                <button
                  className="shell-event-close-btn"
                  onClick={(e) => handleClose(e, event.id)}
                  title="Dismiss"
                >
                  {'\u00D7'}
                </button>
              </div>
            </div>
            <div className="shell-event-card-body">{String(summary).slice(0, 120)}</div>
          </div>
        )
      })}
    </div>
  )
}

export default ShellEventCards
