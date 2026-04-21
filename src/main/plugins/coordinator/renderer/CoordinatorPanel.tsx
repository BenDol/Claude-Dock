/**
 * CoordinatorPanel — chat UI for the Coordinator plugin.
 *
 * Used both as a docked side panel (wired via registerPanel) and as the main
 * content of the detached floating window (wired via standalone-entry).
 */

import './coordinator.css'
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PanelProps } from '@dock-renderer/panel-registry'
import type {
  CoordinatorMessage,
  CoordinatorTerminalSummary
} from '../../../../shared/coordinator-types'
import { useCoordinatorStore } from './coordinator-store'
import { CoordinatorSettings } from './CoordinatorSettings'

const CoordinatorPanel: React.FC<PanelProps> = ({ projectDir }) => {
  const init = useCoordinatorStore((s) => s.init)
  const dispose = useCoordinatorStore((s) => s.dispose)
  const messages = useCoordinatorStore((s) => s.messages)
  const turnActive = useCoordinatorStore((s) => s.turnActive)
  const terminals = useCoordinatorStore((s) => s.terminals)
  const error = useCoordinatorStore((s) => s.error)
  const dismissError = useCoordinatorStore((s) => s.dismissError)
  const sendMessage = useCoordinatorStore((s) => s.sendMessage)
  const cancel = useCoordinatorStore((s) => s.cancel)
  const config = useCoordinatorStore((s) => s.config)
  const settingsOpen = useCoordinatorStore((s) => s.settingsOpen)
  const setSettingsOpen = useCoordinatorStore((s) => s.setSettingsOpen)

  const inputRef = useRef<HTMLTextAreaElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!projectDir) return
    void init(projectDir)
    return () => dispose()
  }, [projectDir, init, dispose])

  // Auto-focus on mount and on remote focus-input pings.
  useEffect(() => {
    inputRef.current?.focus()
  }, [projectDir, settingsOpen])

  // Scroll to bottom when messages change (streaming or new messages).
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [messages.length, turnActive])

  if (!config) {
    return (
      <div className="coord-root">
        <div className="coord-empty">Loading…</div>
      </div>
    )
  }

  return (
    <div className="coord-root">
      {settingsOpen && (
        <CoordinatorSettings onClose={() => setSettingsOpen(false)} />
      )}

      <StatusRow terminals={terminals} turnActive={turnActive} />

      <div className="coord-messages" ref={scrollRef}>
        {messages.length === 0 ? (
          <EmptyState />
        ) : (
          messages.map((m) => <MessageView key={m.id} message={m} />)
        )}
      </div>

      {error && (
        <div className="coord-input-wrap" style={{ borderTop: 'none', paddingBottom: 0 }}>
          <div className="coord-error-bar">
            <span>{error}</span>
            <button className="coord-error-close" onClick={dismissError} title="Dismiss">
              ×
            </button>
          </div>
        </div>
      )}

      <InputBar
        inputRef={inputRef}
        turnActive={turnActive}
        onSend={(text) => void sendMessage(text)}
        onCancel={() => void cancel()}
      />
    </div>
  )
}

export default CoordinatorPanel

/* ── Status row ─────────────────────────────────────────────────────────── */

const StatusRow: React.FC<{
  terminals: CoordinatorTerminalSummary[]
  turnActive: boolean
}> = ({ terminals, turnActive }) => {
  const idleCount = terminals.filter((t) => t.isIdle).length
  const busyCount = terminals.length - idleCount
  return (
    <div className="coord-status-row">
      <span className="coord-status-pill idle-dot">{idleCount} idle</span>
      {busyCount > 0 && (
        <span className="coord-status-pill running-dot">{busyCount} busy</span>
      )}
      <span className="coord-status-spacer" />
      {turnActive && <span className="coord-status-pill busy">Thinking…</span>}
    </div>
  )
}

/* ── Empty state ────────────────────────────────────────────────────────── */

const EmptyState: React.FC = () => (
  <div className="coord-empty">
    <h3>Coordinator</h3>
    <p>
      I can inspect your terminals and dispatch work across them. Every task I
      dispatch runs in a fresh git worktree so parallel work doesn&apos;t collide.
    </p>
    <p>Try:</p>
    <ul>
      <li>&ldquo;List my terminals.&rdquo;</li>
      <li>&ldquo;Split this into two tasks and dispatch them.&rdquo;</li>
      <li>&ldquo;Fix the failing test in terminal #2.&rdquo;</li>
    </ul>
  </div>
)

/* ── Message view ───────────────────────────────────────────────────────── */

const MessageView: React.FC<{ message: CoordinatorMessage }> = ({ message }) => {
  if (message.role === 'system') {
    return null
  }
  if (message.role === 'tool') {
    return (
      <div className={'coord-message ' + (message.isError ? 'tool-error' : 'tool')}>
        <div className={'coord-msg-role ' + (message.isError ? 'tool-error' : 'tool')}>
          <span>{displayToolName(message.toolName)}{message.isError ? ' — error' : ''}</span>
          <span className="coord-msg-time">{formatTime(message.timestamp)}</span>
        </div>
        <div className="coord-msg-body">{formatToolContent(message.content)}</div>
      </div>
    )
  }
  if (message.role === 'user') {
    return (
      <div className="coord-message user">
        <div className="coord-msg-role user">
          <span>You</span>
          <span className="coord-msg-time">{formatTime(message.timestamp)}</span>
        </div>
        <div className="coord-msg-body">{message.content}</div>
      </div>
    )
  }
  // assistant
  return (
    <div className="coord-message assistant">
      <div className="coord-msg-role assistant">
        <span>
          Coordinator
          {message.streaming && <span className="coord-streaming-dot" />}
        </span>
        <span className="coord-msg-time">{formatTime(message.timestamp)}</span>
      </div>
      {message.content && <div className="coord-msg-body">{message.content}</div>}
      {message.toolCalls && message.toolCalls.length > 0 && (
        <div className="coord-toolcall-pill-row">
          {message.toolCalls.map((tc) => (
            <span key={tc.id} className="coord-toolcall-pill" title={`${tc.name}\n${renderArgs(tc.args)}`}>
              → {displayToolName(tc.name)}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function renderArgs(args: unknown): string {
  try {
    return typeof args === 'string' ? args : JSON.stringify(args, null, 2)
  } catch {
    return String(args)
  }
}

/**
 * Strip the `mcp__<serverKey>__` prefix that the SDK backend uses for its
 * MCP-routed tool names so the transcript shows a readable label instead of
 * `mcp__claude-dock-uat__dock_list_terminals`. The raw name is still passed
 * to the tooltip/title for debugging.
 */
function displayToolName(name: string): string {
  if (name.startsWith('mcp__')) {
    const rest = name.slice('mcp__'.length)
    const idx = rest.indexOf('__')
    if (idx >= 0) return rest.slice(idx + 2)
  }
  return name
}

function formatToolContent(content: string): string {
  // Tool results are JSON from the dispatcher; pretty-print when possible.
  try {
    return JSON.stringify(JSON.parse(content), null, 2)
  } catch {
    return content
  }
}

/* ── Input bar ──────────────────────────────────────────────────────────── */

const InputBar: React.FC<{
  inputRef: React.RefObject<HTMLTextAreaElement | null>
  turnActive: boolean
  onSend: (text: string) => void
  onCancel: () => void
}> = ({ inputRef, turnActive, onSend, onCancel }) => {
  const [text, setText] = useState('')

  const submit = (): void => {
    const trimmed = text.trim()
    if (!trimmed) return
    onSend(trimmed)
    setText('')
    // Re-focus after send so the user can chain messages.
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (turnActive) return
      submit()
    }
  }

  // Autoresize up to the CSS max-height.
  const textareaRef = inputRef
  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 160) + 'px'
  }, [text, textareaRef])

  return (
    <div className="coord-input-wrap">
      <div className="coord-input-row">
        <textarea
          ref={textareaRef}
          className="coord-textarea"
          placeholder={turnActive ? 'Working…' : 'Ask the coordinator to dispatch work across your terminals'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          disabled={false}
        />
        {turnActive ? (
          <button className="coord-send-btn cancel" onClick={onCancel} title="Cancel">
            Stop
          </button>
        ) : (
          <button
            className="coord-send-btn"
            onClick={submit}
            disabled={text.trim().length === 0}
            title="Send (Enter)"
          >
            Send
          </button>
        )}
      </div>
    </div>
  )
}
