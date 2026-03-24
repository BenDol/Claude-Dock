import React, { useCallback, useRef, useEffect, useState, useLayoutEffect } from 'react'
import { useShellTerminal } from '../hooks/useShellTerminal'
import { useResizeObserver } from '../hooks/useResizeObserver'
import { getDockApi } from '../lib/ipc-bridge'

const MAX_LINK_LINES = 100
const MAX_LINK_CHARS = 8000

interface ShellPanelProps {
  shellId: string
  terminalId: string
  onClose: () => void
  onSplitRight?: () => void
  onStackBelow?: () => void
  initialCommand?: string | null
  /** If false, type the command without pressing Enter. Default: true */
  submitCommand?: boolean
  /** Override the shell type (e.g. 'bash', 'cmd', 'powershell'). null = use configured default */
  shellType?: string | null
  label?: string
}

const ShellPanel: React.FC<ShellPanelProps> = ({ shellId, terminalId, onClose, onSplitRight, onStackBelow, initialCommand, submitCommand = true, shellType, label }) => {
  const { initTerminal, fit, focus, termRef } = useShellTerminal({ shellId, shellType: shellType ?? undefined })
  const commandSentRef = useRef(false)
  const resizeRef = useResizeObserver(fit, 100)
  const [linked, setLinked] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const addDropdownRef = useRef<HTMLDivElement>(null)

  const terminalRef = useCallback(
    (el: HTMLDivElement | null) => {
      resizeRef(el)
      if (el) {
        initTerminal(el)
        setTimeout(focus, 100)
      }
    },
    [resizeRef, initTerminal, focus]
  )

  // Write initial command after shell is ready — wait for first data (prompt)
  // before sending, to avoid the command being swallowed by a slow shell startup.
  // Track which command was sent so new commands (from MCP bridge) still fire.
  const lastSentCommandRef = useRef<string | null>(null)
  useEffect(() => {
    if (!initialCommand || lastSentCommandRef.current === initialCommand) return
    const api = getDockApi()
    const payload = submitCommand !== false ? initialCommand + '\r' : initialCommand

    // If the shell is already running (we already received data before),
    // send immediately — no need to wait for first data.
    if (commandSentRef.current) {
      lastSentCommandRef.current = initialCommand
      api.shell.write(shellId, payload)
      return
    }

    // First time: wait for the shell to produce output (prompt ready)
    let sent = false
    const cleanup = api.shell.onData((id, _data) => {
      if (id !== shellId || sent) return
      sent = true
      commandSentRef.current = true
      lastSentCommandRef.current = initialCommand
      setTimeout(() => {
        api.shell.write(shellId, payload)
      }, 100)
    })
    // Safety timeout — send after 3s regardless
    const timer = setTimeout(() => {
      if (!sent) {
        sent = true
        commandSentRef.current = true
        lastSentCommandRef.current = initialCommand
        api.shell.write(shellId, payload)
      }
    }, 3000)
    return () => { cleanup(); clearTimeout(timer) }
  }, [initialCommand, shellId, submitCommand])

  // Re-fit when layout changes (other shells added/removed or area resized)
  useEffect(() => {
    const handler = () => setTimeout(fit, 30)
    window.addEventListener('shell-layout-changed', handler)
    return () => window.removeEventListener('shell-layout-changed', handler)
  }, [fit])

  // Close add dropdown on outside click
  useEffect(() => {
    if (!addOpen) return
    const handler = () => setAddOpen(false)
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [addOpen])

  // Reposition dropdown if it overflows the viewport
  useLayoutEffect(() => {
    if (!addOpen || !addDropdownRef.current) return
    const el = addDropdownRef.current
    const rect = el.getBoundingClientRect()
    // Flip horizontal if overflowing right
    if (rect.right > window.innerWidth - 4) {
      el.style.left = 'auto'
      el.style.right = '0'
    }
    // Flip vertical if overflowing top
    if (rect.top < 4) {
      el.style.bottom = 'auto'
      el.style.top = '100%'
    }
  }, [addOpen])

  // Read shell terminal content and paste it into the Claude terminal as context
  const handleLinkToClaude = useCallback(() => {
    const term = termRef.current
    if (!term) return

    let content: string

    if (term.hasSelection()) {
      content = term.getSelection()
    } else {
      const buf = term.buffer.active
      const totalRows = buf.length
      const startRow = Math.max(0, totalRows - MAX_LINK_LINES)
      const lines: string[] = []
      for (let i = startRow; i < totalRows; i++) {
        const line = buf.getLine(i)
        if (line) lines.push(line.translateToString(true))
      }
      while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop()
      content = lines.join('\n')
    }

    if (!content.trim()) return

    if (content.length > MAX_LINK_CHARS) {
      content = content.slice(-MAX_LINK_CHARS)
      const firstNewline = content.indexOf('\n')
      if (firstNewline > 0) content = content.slice(firstNewline + 1)
      content = '...(truncated)\n' + content
    }

    const wrapped = `Here is the output from my shell terminal:\n\`\`\`\n${content}\n\`\`\`\n`
    getDockApi().terminal.write(terminalId, wrapped)

    setLinked(true)
    setTimeout(() => setLinked(false), 1500)
  }, [termRef, terminalId])

  const canAdd = onSplitRight || onStackBelow

  return (
    <div className="shell-panel">
      <div className="shell-panel-handle">
        <span className="shell-panel-label">{label || 'Shell'}</span>
        {canAdd && (
          <div className="shell-add-wrapper" onMouseDown={(e) => e.stopPropagation()}>
            <button
              className="shell-panel-action"
              onClick={(e) => { e.stopPropagation(); setAddOpen(!addOpen) }}
              title="Add shell panel"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <line x1="5" y1="2" x2="5" y2="8" /><line x1="2" y1="5" x2="8" y2="5" />
              </svg>
            </button>
            {addOpen && (
              <div className="shell-add-dropdown" ref={addDropdownRef}>
                {onStackBelow && (
                  <button className="shell-add-item" onClick={() => { onStackBelow(); setAddOpen(false) }}>
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2">
                      <rect x="1" y="1" width="10" height="4" rx="1" /><rect x="1" y="7" width="10" height="4" rx="1" />
                    </svg>
                    Stack Below
                  </button>
                )}
                {onSplitRight && (
                  <button className="shell-add-item" onClick={() => { onSplitRight(); setAddOpen(false) }}>
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2">
                      <rect x="1" y="1" width="4" height="10" rx="1" /><rect x="7" y="1" width="4" height="10" rx="1" />
                    </svg>
                    Split Right
                  </button>
                )}
              </div>
            )}
          </div>
        )}
        <button
          className={`shell-panel-action${linked ? ' shell-panel-action-linked' : ''}`}
          onClick={(e) => { e.stopPropagation(); handleLinkToClaude() }}
          title="Link shell output to Claude"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
          </svg>
          {linked && <span className="shell-panel-action-flash">Linked</span>}
        </button>
        <button className="shell-panel-close" onClick={onClose} title="Close shell panel">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <line x1="2" y1="2" x2="8" y2="8" /><line x1="8" y1="2" x2="2" y2="8" />
          </svg>
        </button>
      </div>
      <div
        className="shell-panel-terminal"
        ref={terminalRef}
        onClick={(e) => {
          e.stopPropagation()
          focus()
        }}
      />
    </div>
  )
}

export default React.memo(ShellPanel)
