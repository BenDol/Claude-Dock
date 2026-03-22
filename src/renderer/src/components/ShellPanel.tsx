import React, { useCallback, useRef, useEffect } from 'react'
import { useShellTerminal } from '../hooks/useShellTerminal'
import { useResizeObserver } from '../hooks/useResizeObserver'

interface ShellPanelProps {
  terminalId: string
  height: number
  onHeightChange: (h: number) => void
  onClose: () => void
}

const MIN_HEIGHT = 80
const MAX_RATIO = 0.8 // max 80% of parent

const ShellPanel: React.FC<ShellPanelProps> = ({ terminalId, height, onHeightChange, onClose }) => {
  const shellId = `shell:${terminalId}`
  const { initTerminal, fit, focus } = useShellTerminal({ shellId })
  const panelRef = useRef<HTMLDivElement>(null)
  const resizeRef = useResizeObserver(fit, 100)

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
    const parent = panelRef.current?.parentElement
    const maxHeight = parent ? parent.clientHeight * MAX_RATIO : 600

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

  return (
    <div className="shell-panel" ref={panelRef} style={{ height }}>
      <div className="shell-panel-handle" onMouseDown={handleDragStart}>
        <div className="shell-panel-grip" />
        <span className="shell-panel-label">Shell</span>
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
