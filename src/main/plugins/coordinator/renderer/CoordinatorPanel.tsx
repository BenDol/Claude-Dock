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
import { useCoordinatorStore, providerNeedsApiKey } from './coordinator-store'
import { getDockApi } from '@dock-renderer/lib/ipc-bridge'

// Per-panel zoom — mirrors workspace plugin. Keeps the coordinator's visual
// density independent of the dock's global zoom so dense chat history stays
// readable without shrinking the rest of the dock.
const ZOOM_KEY = 'coordinator-zoom'
const MIN_ZOOM = 0.6
const MAX_ZOOM = 1.8
const ZOOM_STEP = 0.05

function usePanelZoom(): React.RefObject<HTMLDivElement | null> {
  const panelRootRef = useRef<HTMLDivElement | null>(null)
  const zoomRef = useRef(1)

  // useLayoutEffect (not useEffect) so the saved zoom is applied before the
  // first paint — avoids the one-frame unscaled flash on mount.
  useLayoutEffect(() => {
    const saved = localStorage.getItem(ZOOM_KEY)
    if (saved) {
      const z = parseFloat(saved)
      zoomRef.current = (isNaN(z) || z < MIN_ZOOM || z > MAX_ZOOM) ? 1 : z
    } else {
      const dockZoom = parseFloat(document.documentElement.style.zoom) || 1
      zoomRef.current = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, dockZoom))
    }
    if (panelRootRef.current) panelRootRef.current.style.zoom = String(zoomRef.current)

    const applyZoom = (z: number): void => {
      zoomRef.current = Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z)) * 100) / 100
      if (panelRootRef.current) panelRootRef.current.style.zoom = String(zoomRef.current)
      localStorage.setItem(ZOOM_KEY, String(zoomRef.current))
    }

    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey && !e.metaKey) return
      if (!panelRootRef.current?.contains(e.target as Node)) return
      e.preventDefault()
      e.stopPropagation()
      applyZoom(zoomRef.current + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP))
    }

    const onKeyDown = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey)) return
      if (!panelRootRef.current?.contains(document.activeElement) && !panelRootRef.current?.matches(':hover')) return
      if (e.key === '=' || e.key === '+') { e.preventDefault(); e.stopPropagation(); applyZoom(zoomRef.current + ZOOM_STEP) }
      else if (e.key === '-') { e.preventDefault(); e.stopPropagation(); applyZoom(zoomRef.current - ZOOM_STEP) }
      else if (e.key === '0') { e.preventDefault(); e.stopPropagation(); applyZoom(1) }
    }

    // Capture phase — intercept before the dock's global zoom handler runs.
    window.addEventListener('wheel', onWheel, { passive: false, capture: true })
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => {
      window.removeEventListener('wheel', onWheel, { capture: true } as EventListenerOptions)
      window.removeEventListener('keydown', onKeyDown, { capture: true } as EventListenerOptions)
    }
  }, [])

  return panelRootRef
}

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
  const providers = useCoordinatorStore((s) => s.providers)

  const inputRef = useRef<HTMLTextAreaElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const panelRootRef = usePanelZoom()

  const openSettingsWindow = (): void => {
    // Dedicated settings BrowserWindow (see CoordinatorSettingsWindowManager).
    // Replaces the old in-panel overlay that rendered full-screen due to
    // position: absolute inside an un-positioned panel container.
    void getDockApi().coordinator.openSettings()
  }

  useEffect(() => {
    if (!projectDir) return
    void init(projectDir)
    return () => dispose()
  }, [projectDir, init, dispose])

  // First-run: if the coordinator's selected provider needs an API key and none
  // is set yet, automatically surface the dedicated settings window so the user
  // lands on setup instead of a useless chat pane. Fires once per mount after
  // config *and* providers have loaded — key-less providers (ollama,
  // openai-compat) skip this path.
  const autoOpenedRef = useRef(false)
  useEffect(() => {
    if (!config) return
    if (providers.length === 0) return
    if (autoOpenedRef.current) return
    if (providerNeedsApiKey(providers, config.provider) && config.apiKey.length === 0) {
      autoOpenedRef.current = true
      openSettingsWindow()
    }
  }, [config, providers])

  // Auto-focus on mount and on remote focus-input pings.
  useEffect(() => {
    inputRef.current?.focus()
  }, [projectDir])

  // Scroll to bottom when messages change (streaming or new messages).
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [messages.length, turnActive])

  if (!config) {
    return (
      <div className="coord-root" ref={panelRootRef}>
        <div className="coord-empty">Loading…</div>
      </div>
    )
  }

  const needsSetup =
    providerNeedsApiKey(providers, config.provider) && config.apiKey.length === 0

  if (needsSetup) {
    return (
      <div className="coord-root" ref={panelRootRef}>
        <SetupPlaceholder onOpenSettings={openSettingsWindow} />
      </div>
    )
  }

  return (
    <div className="coord-root" ref={panelRootRef}>
      <StatusRow
        terminals={terminals}
        turnActive={turnActive}
        onOpenSettings={openSettingsWindow}
      />

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
        projectDir={projectDir}
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
  onOpenSettings: () => void
}> = ({ terminals, turnActive, onOpenSettings }) => {
  const idleCount = terminals.filter((t) => t.isIdle).length
  const busyCount = terminals.length - idleCount
  return (
    <div className="coord-status-row">
      <span className="coord-status-pill idle-dot">{idleCount} idle</span>
      {busyCount > 0 && (
        <span className="coord-status-pill running-dot">{busyCount} busy</span>
      )}
      <span className="coord-status-spacer" />
      {turnActive && (
        <span
          className="coord-thinking-spinner"
          role="status"
          aria-label="Thinking"
          title="Thinking…"
        />
      )}
      <button
        className="coord-header-btn"
        onClick={onOpenSettings}
        title="Coordinator settings"
        aria-label="Open coordinator settings"
      >
        <GearIcon />
      </button>
    </div>
  )
}

const SetupPlaceholder: React.FC<{ onOpenSettings: () => void }> = ({ onOpenSettings }) => (
  <div className="coord-empty">
    <h3>Coordinator needs setup</h3>
    <p>
      The coordinator opens in its own window. Pick a provider and enter an API
      key to get started.
    </p>
    <button className="coord-test-btn" onClick={onOpenSettings}>
      Open Coordinator Settings
    </button>
  </div>
)

const GearIcon: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82 1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
)

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

type DictationState = 'idle' | 'recording' | 'transcribing'

const InputBar: React.FC<{
  inputRef: React.RefObject<HTMLTextAreaElement | null>
  projectDir: string
  turnActive: boolean
  onSend: (text: string) => void
  onCancel: () => void
}> = ({ inputRef, projectDir, turnActive, onSend, onCancel }) => {
  const [text, setText] = useState('')
  const [voiceEnabled, setVoiceEnabled] = useState(false)
  const [dictation, setDictation] = useState<DictationState>('idle')
  const dictationRef = useRef<DictationState>('idle')
  const mountedRef = useRef(true)
  const setError = useCoordinatorStore((s) => s.setError)

  // Keep a ref in sync so cleanup effects can inspect the latest state without
  // re-running on every transition.
  useEffect(() => { dictationRef.current = dictation }, [dictation])

  // Guard async handlers against post-unmount state updates (e.g. a slow
  // transcription resumes after the Coordinator is closed).
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // Subscribe to voice plugin enable/disable. Mirrors the pattern used in
  // src/renderer/src/components/Toolbar.tsx — poll once on mount + refetch on
  // the 'plugin-state-changed' window event the plugin manager emits.
  useEffect(() => {
    if (!projectDir) return
    let cancelled = false
    const fetchState = (): void => {
      getDockApi().plugins.getStates(projectDir).then((states) => {
        if (cancelled) return
        setVoiceEnabled(states.voice?.enabled ?? false)
      }).catch(() => { /* ignore — Speak simply stays hidden */ })
    }
    fetchState()
    window.addEventListener('plugin-state-changed', fetchState)
    return () => {
      cancelled = true
      window.removeEventListener('plugin-state-changed', fetchState)
    }
  }, [projectDir])

  // Cancel any in-flight dictation on unmount or project change. Prevents a
  // stale Python child from transcribing into a project the user has left.
  useEffect(() => {
    return () => {
      if (dictationRef.current !== 'idle') {
        getDockApi().voice.dictate.cancel().catch(() => { /* ignore */ })
      }
    }
  }, [projectDir])

  const submit = (): void => {
    const trimmed = text.trim()
    if (!trimmed) return
    onSend(trimmed)
    setText('')
    // Re-focus after send so the user can chain messages.
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  const startDictation = async (): Promise<void> => {
    setError(null)
    setDictation('recording')
    try {
      const res = await getDockApi().voice.dictate.start()
      if (!mountedRef.current) return
      if (res.error) {
        setDictation('idle')
        if (res.error === 'Voice runtime not installed') {
          setError('Voice runtime not installed. Opening Voice settings…')
          getDockApi().voice.open().catch(() => { /* ignore */ })
        } else {
          setError(res.error)
        }
      }
    } catch (err) {
      if (!mountedRef.current) return
      setDictation('idle')
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const stopDictation = async (): Promise<void> => {
    setDictation('transcribing')
    try {
      const res = await getDockApi().voice.dictate.stop()
      if (!mountedRef.current) return
      setDictation('idle')
      if (res.error) {
        // "Dictation cancelled" comes from a kill path — silent.
        if (res.error !== 'Dictation cancelled') setError(res.error)
        return
      }
      const transcribed = (res.text ?? '').trim()
      if (!transcribed) {
        setError('No speech could be transcribed.')
        return
      }
      onSend(transcribed)
      setText('')
      requestAnimationFrame(() => inputRef.current?.focus())
    } catch (err) {
      if (!mountedRef.current) return
      setDictation('idle')
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const cancelDictation = (): void => {
    getDockApi().voice.dictate.cancel().catch(() => { /* ignore */ })
    setDictation('idle')
  }

  // Escape-to-cancel needs to work even though the textarea is disabled during
  // recording (which blurs it and drops its keydown handler). Listen globally
  // only while actively recording so we don't hijack Escape the rest of the time.
  useEffect(() => {
    if (dictation !== 'recording') return
    const onDocKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        cancelDictation()
      }
    }
    document.addEventListener('keydown', onDocKey)
    return () => document.removeEventListener('keydown', onDocKey)
  }, [dictation])

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (turnActive) return
      // Enter on empty input with voice enabled doesn't start dictation —
      // require an explicit click on Speak so a stray Enter can't trip the mic.
      if (dictation !== 'idle') return
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

  const renderButton = (): React.ReactNode => {
    if (turnActive) {
      return (
        <button className="coord-send-btn cancel" onClick={onCancel} title="Cancel">
          Stop
        </button>
      )
    }
    if (dictation === 'transcribing') {
      return (
        <button className="coord-send-btn" disabled title="Transcribing…">
          Transcribing…
        </button>
      )
    }
    if (dictation === 'recording') {
      return (
        <button
          className="coord-send-btn recording"
          onClick={() => void stopDictation()}
          title="Stop & send (Esc to cancel)"
        >
          Stop
        </button>
      )
    }
    const empty = text.trim().length === 0
    if (empty && voiceEnabled) {
      return (
        <button
          className="coord-send-btn speak"
          onClick={() => void startDictation()}
          title="Speak (click again to stop & send)"
        >
          Speak
        </button>
      )
    }
    return (
      <button
        className="coord-send-btn"
        onClick={submit}
        disabled={empty}
        title="Send (Enter)"
      >
        Send
      </button>
    )
  }

  const placeholder = turnActive
    ? 'Working…'
    : dictation === 'recording'
      ? 'Listening… click Stop to send, Esc to cancel'
      : dictation === 'transcribing'
        ? 'Transcribing…'
        : 'Ask the coordinator to dispatch work across your terminals'

  return (
    <div className="coord-input-wrap">
      <div className="coord-input-row">
        <textarea
          ref={textareaRef}
          className="coord-textarea"
          placeholder={placeholder}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          disabled={dictation !== 'idle'}
        />
        {renderButton()}
      </div>
    </div>
  )
}
