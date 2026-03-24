import React, { useCallback, useRef, useEffect, useState } from 'react'
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
  label?: string
}

const ShellPanel: React.FC<ShellPanelProps> = ({ shellId, terminalId, onClose, onSplitRight, onStackBelow, initialCommand, label }) => {
  const { initTerminal, fit, focus, termRef } = useShellTerminal({ shellId })
  const commandSentRef = useRef(false)
  const resizeRef = useResizeObserver(fit, 100)
  const [linked, setLinked] = useState(false)
  const [addOpen, setAddOpen] = useState(false)

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

  // Write initial command after shell is ready
  useEffect(() => {
    if (!initialCommand || commandSentRef.current) return
    commandSentRef.current = true
    const timer = setTimeout(() => {
      getDockApi().shell.write(shellId, initialCommand + '\n')
    }, 500)
    return () => clearTimeout(timer)
  }, [initialCommand, shellId])

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
              <div className="shell-add-dropdown">
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
