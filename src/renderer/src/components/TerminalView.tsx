import React, { useEffect } from 'react'
import '@xterm/xterm/css/xterm.css'
import { useTerminal } from '../hooks/useTerminal'
import { useResizeObserver } from '../hooks/useResizeObserver'
import { useAutoTitle } from '../hooks/useAutoTitle'
import { useDockStore } from '../stores/dock-store'

interface TerminalViewProps {
  terminalId: string
  isFocused: boolean
}

const TerminalView: React.FC<TerminalViewProps> = ({ terminalId, isFocused }) => {
  const { initTerminal, fit, focus } = useTerminal({ terminalId })
  useAutoTitle(terminalId)

  const resizeRef = useResizeObserver(() => {
    fit()
  }, 100)

  // Focus terminal when it becomes the focused one
  useEffect(() => {
    if (isFocused) {
      // Small delay to ensure DOM is ready
      const timer = setTimeout(() => focus(), 50)
      return () => clearTimeout(timer)
    }
  }, [isFocused, focus])

  return (
    <div
      className="terminal-view"
      ref={(el) => {
        resizeRef(el)
        if (el) initTerminal(el)
      }}
      onClick={() => {
        useDockStore.getState().setFocusedTerminal(terminalId)
        focus()
      }}
    />
  )
}

export default React.memo(TerminalView)
