import React, { useEffect, useRef, useState, useCallback } from 'react'
import '@xterm/xterm/css/xterm.css'
import { useTerminal } from '../hooks/useTerminal'
import { useResizeObserver } from '../hooks/useResizeObserver'
import { useDockStore } from '../stores/dock-store'
import { getDockApi } from '../lib/ipc-bridge'

interface TerminalViewProps {
  terminalId: string
  isFocused: boolean
}

const TerminalView: React.FC<TerminalViewProps> = ({ terminalId, isFocused }) => {
  const { initTerminal, fit, focus, gotDataRef } = useTerminal({ terminalId })
  const [loading, setLoading] = useState(true)
  const mountTimeRef = useRef(Date.now())
  const setTerminalLoading = useDockStore((s) => s.setTerminalLoading)

  // Sync loading state to store
  useEffect(() => {
    setTerminalLoading(terminalId, loading)
  }, [terminalId, loading, setTerminalLoading])

  const resizeRef = useResizeObserver(fit, 100)

  const terminalRef = useCallback(
    (el: HTMLDivElement | null) => {
      resizeRef(el)
      if (el) initTerminal(el)
    },
    [resizeRef, initTerminal]
  )

  // Poll gotDataRef until enough data arrives + minimum display time, then dismiss loading
  useEffect(() => {
    if (!loading) return
    const MIN_DISPLAY_MS = 800
    const interval = setInterval(() => {
      const elapsed = Date.now() - mountTimeRef.current
      if (gotDataRef.current && elapsed >= MIN_DISPLAY_MS) {
        setLoading(false)
        clearInterval(interval)
      }
    }, 50)
    // Safety timeout: dismiss after 15s regardless
    const timeout = setTimeout(() => {
      setLoading(false)
      clearInterval(interval)
    }, 15000)
    return () => {
      clearInterval(interval)
      clearTimeout(timeout)
    }
  }, [loading, gotDataRef])

  // Re-fit when loading dismissed — multiple attempts to handle layout settling
  useEffect(() => {
    if (!loading) {
      const timers = [50, 200, 500].map((ms) => setTimeout(() => fit(), ms))
      return () => timers.forEach(clearTimeout)
    }
  }, [loading, fit])

  useEffect(() => {
    if (isFocused && !loading) {
      const timer = setTimeout(() => focus(), 50)
      return () => clearTimeout(timer)
    }
  }, [isFocused, loading, focus])

  return (
    <div className="terminal-view-wrapper">
      {loading && (
        <div className="terminal-loading">
          <div className="terminal-spinner" />
          <span>Starting claude...</span>
        </div>
      )}
      <div
        className="terminal-view"
        style={loading ? { opacity: 0, pointerEvents: 'none' } : undefined}
        ref={terminalRef}
        onClick={() => {
          useDockStore.getState().setFocusedTerminal(terminalId)
          focus()
        }}
      />
    </div>
  )
}

export default React.memo(TerminalView)
