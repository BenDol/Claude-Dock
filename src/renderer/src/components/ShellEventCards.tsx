import React, { useCallback, useEffect, useRef, useState } from 'react'
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

const EVENT_LABELS: Record<string, string> = {
  server_stopped: 'Server Stopped',
  exception_detected: 'Exception Detected',
  compile_error: 'Compile Error',
  compile_success: 'Compile Success',
  hot_swap_success: 'Hot Swap Success',
  hot_swap_failed: 'Hot Swap Failed',
  server_starting: 'Server Starting',
  svelte_starting: 'Svelte Starting'
}

/** Format a payload into structured tooltip sections */
function buildTooltipSections(type: string, payload: any): Array<{ label: string; value: string; mono?: boolean }> {
  if (!payload) return []
  if (typeof payload === 'string') return [{ label: 'Details', value: payload }]
  if (typeof payload !== 'object') return [{ label: 'Details', value: String(payload) }]

  const sections: Array<{ label: string; value: string; mono?: boolean }> = []

  // Header / reason first
  if (payload.header) sections.push({ label: 'Error', value: payload.header })
  if (payload.reason && payload.reason !== payload.header) sections.push({ label: 'Reason', value: payload.reason })
  if (payload.message && payload.message !== payload.header && payload.message !== payload.reason) {
    sections.push({ label: 'Message', value: payload.message })
  }

  // File / location info
  if (payload.file || payload.path) {
    let loc = payload.file || payload.path
    if (payload.line) loc += `:${payload.line}`
    if (payload.column || payload.col) loc += `:${payload.column || payload.col}`
    sections.push({ label: 'File', value: loc, mono: true })
  }

  // Stack trace
  if (payload.stackTrace || payload.stack || payload.stack_trace) {
    const stack = payload.stackTrace || payload.stack || payload.stack_trace
    const stackStr = Array.isArray(stack) ? stack.join('\n') : String(stack)
    sections.push({ label: 'Stack Trace', value: stackStr, mono: true })
  }

  // Lines (compile error output lines)
  if (payload.lines) {
    const lines = Array.isArray(payload.lines) ? payload.lines.join('\n') : String(payload.lines)
    sections.push({ label: 'Output', value: lines, mono: true })
  }

  // Error details
  if (payload.error && payload.error !== payload.header && payload.error !== payload.reason && payload.error !== payload.message) {
    sections.push({ label: 'Error', value: String(payload.error) })
  }

  // Catch-all: show remaining keys not already handled
  const handled = new Set(['header', 'reason', 'message', 'file', 'path', 'line', 'column', 'col', 'stackTrace', 'stack', 'stack_trace', 'lines', 'error', 'hash'])
  for (const [key, val] of Object.entries(payload)) {
    if (handled.has(key) || val == null || val === '') continue
    const valStr = typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val)
    sections.push({ label: key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()), value: valStr })
  }

  return sections
}

const EventTooltip: React.FC<{ event: any; color: string }> = ({ event, color }) => {
  const ref = useRef<HTMLDivElement>(null)
  const type = event.type
  const label = EVENT_LABELS[type] || type.replace(/_/g, ' ')
  const icon = EVENT_ICONS[type] || '\u25CF'
  const sections = buildTooltipSections(type, event.payload)
  const time = new Date(event.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const shellShort = event.shellId.split(':').pop() || '?'

  // Reposition if overflows viewport
  useEffect(() => {
    if (!ref.current) return
    const el = ref.current
    const rect = el.getBoundingClientRect()
    const zoom = parseFloat(document.documentElement.style.zoom) || 1
    const vw = window.innerWidth / zoom
    const vh = window.innerHeight / zoom

    // Horizontal: if it goes off the right edge, shift left
    if (rect.right / zoom > vw) {
      el.style.left = 'auto'
      el.style.right = '0'
    }
    // Vertical: if it goes off the bottom, show above instead
    if (rect.bottom / zoom > vh) {
      el.style.bottom = '100%'
      el.style.top = 'auto'
      el.style.marginBottom = '4px'
      el.style.marginTop = '0'
    }
  }, [])

  return (
    <div className="shell-event-tooltip" ref={ref}>
      <div className="shell-event-tooltip-header" style={{ borderLeftColor: color }}>
        <span className="shell-event-tooltip-icon" style={{ color }}>{icon}</span>
        <span className="shell-event-tooltip-title">{label}</span>
        <span className="shell-event-tooltip-time">shell:{shellShort} {time}</span>
      </div>
      {sections.length > 0 ? (
        <div className="shell-event-tooltip-body">
          {sections.map((s, i) => (
            <div key={i} className="shell-event-tooltip-section">
              <div className="shell-event-tooltip-label">{s.label}</div>
              <div className={`shell-event-tooltip-value${s.mono ? ' shell-event-tooltip-mono' : ''}`}>{s.value}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="shell-event-tooltip-body">
          <div className="shell-event-tooltip-empty">No additional details</div>
        </div>
      )}
    </div>
  )
}

const ShellEventCards: React.FC<ShellEventCardsProps> = ({ terminalId, sessionId }) => {
  const events = useDockStore((s) => s.shellEvents)
  const ignoredHashes = useDockStore((s) => s.ignoredEventHashes)
  const dismissEvent = useDockStore((s) => s.dismissShellEvent)
  const clearEvents = useDockStore((s) => s.clearShellEvents)
  const ignoreHash = useDockStore((s) => s.ignoreEventHash)
  const [minimized, setMinimized] = useState(false)
  const prevCountRef = useRef(0)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Filter to events for this terminal's session, excluding ignored hashes
  const visibleEvents = events.filter((e) => {
    if (e.sessionId !== sessionId) return false
    const key = typeof e.payload === 'object' && e.payload?.hash ? `${e.type}:${e.payload.hash}` : e.type
    return !ignoredHashes.includes(key)
  })

  // Auto-expand when new events arrive while minimized
  useEffect(() => {
    if (minimized && visibleEvents.length > prevCountRef.current) {
      setMinimized(false)
    }
    prevCountRef.current = visibleEvents.length
  }, [visibleEvents.length, minimized])

  // Cleanup hover timer on unmount
  useEffect(() => {
    return () => { if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current) }
  }, [])

  const handleMouseEnter = useCallback((id: string) => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
    hoverTimerRef.current = setTimeout(() => setHoveredId(id), 400)
  }, [])

  const handleMouseLeave = useCallback(() => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
    hoverTimerRef.current = null
    setHoveredId(null)
  }, [])

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
    (e: React.MouseEvent, event: (typeof events)[0]) => {
      e.stopPropagation()
      const key = typeof event.payload === 'object' && event.payload?.hash
        ? `${event.type}:${event.payload.hash}`
        : event.type
      ignoreHash(key)
    },
    [ignoreHash]
  )

  if (visibleEvents.length === 0) return null

  if (minimized) {
    return (
      <div className="shell-event-cards-minimized" onClick={() => setMinimized(false)} title="Show events">
        <span className="shell-event-minimized-icon">{'\u26A0'}</span>
        <span className="shell-event-minimized-count">{visibleEvents.length}</span>
      </div>
    )
  }

  return (
    <div className="shell-event-cards">
      <div className="shell-event-panel-actions">
        <button className="shell-event-clear-btn" onClick={clearEvents} title="Clear all events">{'\u2716'}</button>
        <button className="shell-event-minimize-btn" onClick={() => setMinimized(true)} title="Minimize events">{'\u2015'}</button>
      </div>
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
            onMouseEnter={() => handleMouseEnter(event.id)}
            onMouseLeave={handleMouseLeave}
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
                  onClick={(e) => handleIgnore(e, event)}
                  title="Ignore this event"
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
            {hoveredId === event.id && <EventTooltip event={event} color={color} />}
          </div>
        )
      })}
    </div>
  )
}

export default ShellEventCards
