import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
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

  if (payload.header) sections.push({ label: 'Error', value: payload.header })
  if (payload.reason && payload.reason !== payload.header) sections.push({ label: 'Reason', value: payload.reason })
  if (payload.message && payload.message !== payload.header && payload.message !== payload.reason) {
    sections.push({ label: 'Message', value: payload.message })
  }

  if (payload.file || payload.path) {
    let loc = payload.file || payload.path
    if (payload.line) loc += `:${payload.line}`
    if (payload.column || payload.col) loc += `:${payload.column || payload.col}`
    sections.push({ label: 'File', value: loc, mono: true })
  }

  if (payload.stackTrace || payload.stack || payload.stack_trace) {
    const stack = payload.stackTrace || payload.stack || payload.stack_trace
    const stackStr = Array.isArray(stack) ? stack.join('\n') : String(stack)
    sections.push({ label: 'Stack Trace', value: stackStr, mono: true })
  }

  if (payload.lines) {
    const lines = Array.isArray(payload.lines) ? payload.lines.join('\n') : String(payload.lines)
    sections.push({ label: 'Output', value: lines, mono: true })
  }

  if (payload.error && payload.error !== payload.header && payload.error !== payload.reason && payload.error !== payload.message) {
    sections.push({ label: 'Error', value: String(payload.error) })
  }

  const handled = new Set(['header', 'reason', 'message', 'file', 'path', 'line', 'column', 'col', 'stackTrace', 'stack', 'stack_trace', 'lines', 'error', 'hash'])
  for (const [key, val] of Object.entries(payload)) {
    if (handled.has(key) || val == null || val === '') continue
    const valStr = typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val)
    sections.push({ label: key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()), value: valStr })
  }

  return sections
}

const EventTooltip: React.FC<{ event: any; color: string; anchorRect: DOMRect; onMouseEnter: () => void; onMouseLeave: () => void }> = ({ event, color, anchorRect, onMouseEnter, onMouseLeave }) => {
  const ref = useRef<HTMLDivElement>(null)
  const type = event.type
  const label = EVENT_LABELS[type] || type.replace(/_/g, ' ')
  const icon = EVENT_ICONS[type] || '\u25CF'
  const sections = buildTooltipSections(type, event.payload)
  const time = new Date(event.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const shellShort = event.shellId.split(':').pop() || '?'

  const [pos, setPos] = useState<{ left: number; top: number }>({ left: anchorRect.left, top: anchorRect.bottom + 4 })

  useEffect(() => {
    if (!ref.current) return
    const el = ref.current
    const rect = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    let left = anchorRect.left
    let top = anchorRect.bottom + 4

    if (left + rect.width > vw - 4) left = vw - rect.width - 4
    if (left < 4) left = 4
    if (top + rect.height > vh - 4) top = anchorRect.top - rect.height - 4

    setPos({ left, top })
  }, [anchorRect])

  return createPortal(
    <div className="shell-event-tooltip" ref={ref} style={{ left: pos.left, top: pos.top }} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} onClick={(e) => e.stopPropagation()}>
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
    </div>,
    document.body
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
  const [hovered, setHovered] = useState<{ id: string; rect: DOMRect } | null>(null)
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const tooltipHoveredRef = useRef(false)
  // Tracks which event types are hidden (toggled off). Empty = all visible.
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set())

  const visibleEvents = events.filter((e) => {
    if (e.sessionId !== sessionId) return false
    const key = typeof e.payload === 'object' && e.payload?.hash ? `${e.type}:${e.payload.hash}` : e.type
    return !ignoredHashes.includes(key)
  })

  // Build type counts for filter buttons
  const typeCounts = new Map<string, number>()
  for (const e of visibleEvents) {
    typeCounts.set(e.type, (typeCounts.get(e.type) || 0) + 1)
  }

  // Clean stale hidden types when event types disappear
  useEffect(() => {
    if (hiddenTypes.size === 0) return
    const stale = [...hiddenTypes].filter((t) => !typeCounts.has(t))
    if (stale.length > 0) setHiddenTypes((prev) => {
      const next = new Set(prev)
      stale.forEach((t) => next.delete(t))
      return next
    })
  }, [typeCounts, hiddenTypes])

  const filteredEvents = hiddenTypes.size === 0
    ? visibleEvents
    : visibleEvents.filter((e) => !hiddenTypes.has(e.type))

  const toggleFilter = useCallback((type: string) => {
    setHiddenTypes((prev) => {
      const next = new Set(prev)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })
  }, [])

  useEffect(() => {
    if (minimized && visibleEvents.length > prevCountRef.current) {
      setMinimized(false)
    }
    prevCountRef.current = visibleEvents.length
  }, [visibleEvents.length, minimized])

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current)
    }
  }, [])

  const handleMouseEnter = useCallback((id: string, e: React.MouseEvent) => {
    if (dismissTimerRef.current) { clearTimeout(dismissTimerRef.current); dismissTimerRef.current = null }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
    hoverTimerRef.current = setTimeout(() => setHovered({ id, rect }), 400)
  }, [])

  const handleMouseLeave = useCallback(() => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
    hoverTimerRef.current = null
    // Delay dismiss so mouse can move to tooltip
    dismissTimerRef.current = setTimeout(() => {
      if (!tooltipHoveredRef.current) setHovered(null)
    }, 150)
  }, [])

  const handleTooltipEnter = useCallback(() => {
    tooltipHoveredRef.current = true
    if (dismissTimerRef.current) { clearTimeout(dismissTimerRef.current); dismissTimerRef.current = null }
  }, [])

  const handleTooltipLeave = useCallback(() => {
    tooltipHoveredRef.current = false
    setHovered(null)
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
      {typeCounts.size > 1 && (
        <div className="shell-event-filters">
          {[...typeCounts.entries()].map(([type, count]) => {
            const icon = EVENT_ICONS[type] || '\u25CF'
            const color = EVENT_COLORS[type] || '#6b6966'
            const hidden = hiddenTypes.has(type)
            return (
              <button
                key={type}
                className={`shell-event-filter-btn${hidden ? '' : ' shell-event-filter-active'}`}
                style={{ '--filter-color': color } as React.CSSProperties}
                onClick={() => toggleFilter(type)}
                title={`${hidden ? 'Show' : 'Hide'} ${type.replace(/_/g, ' ')}`}
              >
                <span className="shell-event-filter-icon" style={{ color }}>{icon}</span>
                <span className="shell-event-filter-count">{count}</span>
              </button>
            )
          })}
        </div>
      )}
      {filteredEvents.map((event) => {
        const icon = EVENT_ICONS[event.type] || '\u25CF'
        const color = EVENT_COLORS[event.type] || '#6b6966'
        const rawSummary =
          typeof event.payload === 'object'
            ? event.payload.reason ||
              event.payload.header?.slice(0, 80) ||
              null
            : event.payload || null
        // Only show summary if it adds info beyond the type name
        const summary = rawSummary && rawSummary !== event.type ? String(rawSummary).slice(0, 80) : null

        return (
          <div
            key={event.id}
            className="shell-event-card"
            style={{ borderLeftColor: color }}
            onClick={() => handleClick(event)}
            onMouseEnter={(e) => handleMouseEnter(event.id, e)}
            onMouseLeave={handleMouseLeave}
          >
            <span className="shell-event-icon" style={{ color }}>{icon}</span>
            <span className="shell-event-type">{event.type.replace(/_/g, ' ')}</span>
            {summary && <span className="shell-event-summary">{summary}</span>}
            <div className="shell-event-actions">
              <button
                className="shell-event-ignore-btn"
                onClick={(e) => handleIgnore(e, event)}
                title="Ignore this event"
              >{'\u2298'}</button>
              <button
                className="shell-event-close-btn"
                onClick={(e) => handleClose(e, event.id)}
                title="Dismiss"
              >{'\u00D7'}</button>
            </div>
            {hovered?.id === event.id && <EventTooltip event={event} color={color} anchorRect={hovered.rect} onMouseEnter={handleTooltipEnter} onMouseLeave={handleTooltipLeave} />}
          </div>
        )
      })}
    </div>
  )
}

export default ShellEventCards
