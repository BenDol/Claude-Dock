import React, { useEffect, useRef, useState, useCallback } from 'react'
import '@xterm/xterm/css/xterm.css'
import { useTerminal } from '../hooks/useTerminal'
import { useResizeObserver } from '../hooks/useResizeObserver'
import { useDockStore } from '../stores/dock-store'
import { useSettingsStore } from '../stores/settings-store'
import { getDockApi } from '../lib/ipc-bridge'

interface TerminalViewProps {
  terminalId: string
  isFocused: boolean
}

const TerminalView: React.FC<TerminalViewProps> = ({ terminalId, isFocused }) => {
  const { initTerminal, fit, focus, gotDataRef, scrolledUp, scrollToBottom, autoScroll, enableAutoScroll, disableAutoScroll } = useTerminal({ terminalId })
  const [loading, setLoading] = useState(true)
  const mountTimeRef = useRef(Date.now())
  const setTerminalLoading = useDockStore((s) => s.setTerminalLoading)
  const isResumed = useDockStore((s) => s.resumedTerminals.has(terminalId))
  const showScrollBtn = useSettingsStore((s) => s.settings.terminal.scrollToBottom)

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

  // Poll gotDataRef until enough data arrives + minimum display time, then dismiss loading.
  // Resumed sessions use a longer minimum to give ConPTY resize pokes time to settle
  // the cursor position (especially needed on Windows 10).
  useEffect(() => {
    if (!loading) return
    const MIN_DISPLAY_MS = isResumed ? 3500 : 800
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
  }, [loading, gotDataRef, isResumed])

  // Re-fit when loading dismissed — single fit after layout settles to avoid
  // hammering the PTY with multiple resize events during Claude's TUI init
  useEffect(() => {
    if (!loading) {
      const timer = setTimeout(() => {
        fit()
        scrollToBottom()
      }, 150)
      return () => clearTimeout(timer)
    }
  }, [loading, fit, scrollToBottom])

  useEffect(() => {
    if (isFocused && !loading) {
      const timer = setTimeout(() => focus(), 50)
      return () => clearTimeout(timer)
    }
  }, [isFocused, loading, focus])

  const handleScrollBtn = useCallback(() => {
    if (autoScroll) {
      disableAutoScroll()
    } else {
      enableAutoScroll()
    }
  }, [autoScroll, enableAutoScroll, disableAutoScroll])

  const showButton = showScrollBtn && scrolledUp && !loading

  return (
    <div className="terminal-view-wrapper">
      {loading && (
        <div className="terminal-loading">
          <div className="terminal-spinner" />
          <span>{isResumed ? 'Resuming session...' : 'Starting claude...'}</span>
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
      {showButton && (
        <button
          className={`scroll-to-bottom-btn${autoScroll ? ' scroll-to-bottom-btn-active' : ''}`}
          onClick={handleScrollBtn}
          title={autoScroll ? 'Auto-scrolling (click to stop)' : 'Scroll to bottom (click to auto-scroll)'}
        >
          <svg width="40" height="12" viewBox="0 0 40 12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="2,2 20,10 38,2" />
          </svg>
        </button>
      )}
    </div>
  )
}

export default React.memo(TerminalView)
