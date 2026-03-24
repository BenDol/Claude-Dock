import React, { useCallback, useRef, useEffect, useState } from 'react'
import { useShellTerminal } from '../hooks/useShellTerminal'
import { useResizeObserver } from '../hooks/useResizeObserver'
import { getDockApi } from '../lib/ipc-bridge'

const MAX_LINK_LINES = 100
const MAX_LINK_CHARS = 8000

interface ShellPanelProps {
  terminalId: string
  height: number
  onHeightChange: (h: number) => void
  onClose: () => void
  initialCommand?: string | null
}

const MIN_HEIGHT = 80
const MAX_RATIO = 0.8 // max 80% of parent

const ShellPanel: React.FC<ShellPanelProps> = ({ terminalId, height, onHeightChange, onClose, initialCommand }) => {
  const shellId = `shell:${terminalId}`
  const { initTerminal, fit, focus, termRef } = useShellTerminal({ shellId })
  const commandSentRef = useRef(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const resizeRef = useResizeObserver(fit, 100)
  const [linked, setLinked] = useState(false)

  const terminalRef = useCallback(
    (el: HTMLDivElement | null) => {
      resizeRef(el)
      if (el) {
        initTerminal(el)
        // Focus the shell terminal after a short delay
        setTimeout(focus, 100)
      }
    },
    [resizeRef, initTerminal, focus]
  )

  // Write initial command after shell is ready
  useEffect(() => {
    if (!initialCommand || commandSentRef.current) return
    commandSentRef.current = true
    // Give the shell a moment to start before writing the command
    const timer = setTimeout(() => {
      getDockApi().shell.write(shellId, initialCommand + '\n')
    }, 500)
    return () => clearTimeout(timer)
  }, [initialCommand, shellId])

  // Re-fit when height changes
  useEffect(() => {
    const timer = setTimeout(fit, 50)
    return () => clearTimeout(timer)
  }, [height, fit])

  // Drag-to-resize handle
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startHeight = height
    // Walk up to the flex column container (terminal-card-split) for max height,
    // not the immediate wrapper div which has no explicit height
    const splitContainer = panelRef.current?.closest('.terminal-card-split') as HTMLElement | null
    const maxHeight = splitContainer ? splitContainer.clientHeight * MAX_RATIO : 600

    const onMove = (ev: MouseEvent) => {
      const delta = startY - ev.clientY // dragging up increases height
      const newHeight = Math.round(Math.min(maxHeight, Math.max(MIN_HEIGHT, startHeight + delta)))
      onHeightChange(newHeight)
    }

    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      fit()
    }

    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [height, onHeightChange, fit])

  // Read shell terminal content and paste it into the Claude terminal as context
  const handleLinkToClaude = useCallback(() => {
    const term = termRef.current
    if (!term) return

    let content: string

    // Prefer selected text if any
    if (term.hasSelection()) {
      content = term.getSelection()
    } else {
      // Read last N lines from the terminal buffer
      const buf = term.buffer.active
      const totalRows = buf.length
      const startRow = Math.max(0, totalRows - MAX_LINK_LINES)
      const lines: string[] = []
      for (let i = startRow; i < totalRows; i++) {
        const line = buf.getLine(i)
        if (line) lines.push(line.translateToString(true))
      }
      // Trim trailing empty lines
      while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop()
      content = lines.join('\n')
    }

    if (!content.trim()) return

    // Cap content
    if (content.length > MAX_LINK_CHARS) {
      content = content.slice(-MAX_LINK_CHARS)
      const firstNewline = content.indexOf('\n')
      if (firstNewline > 0) content = content.slice(firstNewline + 1)
      content = '...(truncated)\n' + content
    }

    // Write to the Claude terminal as a user message with shell output context
    const wrapped = `Here is the output from my shell terminal:\n\`\`\`\n${content}\n\`\`\`\n`
    getDockApi().terminal.write(terminalId, wrapped)

    // Flash the linked indicator briefly
    setLinked(true)
    setTimeout(() => setLinked(false), 1500)
  }, [termRef, terminalId])

  return (
    <div className="shell-panel" ref={panelRef} style={{ height }}>
      <div className="shell-panel-handle" onMouseDown={handleDragStart}>
        <div className="shell-panel-grip" />
        <span className="shell-panel-label">Shell</span>
        <button
          className={`shell-panel-action${linked ? ' shell-panel-action-linked' : ''}`}
          onClick={(e) => { e.stopPropagation(); handleLinkToClaude() }}
          title="Link shell output to Claude (sends selected text or last 100 lines as context)"
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
          e.stopPropagation() // don't change focused Claude terminal
          focus()
        }}
      />
    </div>
  )
}

export default React.memo(ShellPanel)
