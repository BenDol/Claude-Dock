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

const TerminalSearchBar: React.FC<{
  searchAddonRef: React.RefObject<import('@xterm/addon-search').SearchAddon | null>
  onClose: () => void
  onFocusTerminal: () => void
}> = ({ searchAddonRef, onClose, onFocusTerminal }) => {
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [resultInfo, setResultInfo] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [regex, setRegex] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  // Listen for result count changes
  useEffect(() => {
    const addon = searchAddonRef.current
    if (!addon) return
    const disposable = addon.onDidChangeResults((e) => {
      if (e.resultCount === 0) {
        setResultInfo(query ? 'No results' : '')
      } else if (e.resultIndex === -1) {
        setResultInfo(`${e.resultCount}+ results`)
      } else {
        setResultInfo(`${e.resultIndex + 1} of ${e.resultCount}`)
      }
    })
    return () => disposable.dispose()
  }, [searchAddonRef, query])

  const searchOpts = useCallback(() => ({
    caseSensitive,
    regex,
    wholeWord,
    incremental: true,
    decorations: {
      matchBackground: '#fabd2f55',
      matchBorder: '#fabd2f88',
      matchOverviewRuler: '#fabd2f',
      activeMatchBackground: '#fabd2faa',
      activeMatchBorder: '#fabd2f',
      activeMatchColorOverviewRuler: '#fe8019'
    }
  }), [caseSensitive, regex, wholeWord])

  const findNext = useCallback(() => {
    if (!query) return
    searchAddonRef.current?.findNext(query, searchOpts())
  }, [query, searchAddonRef, searchOpts])

  const findPrev = useCallback(() => {
    if (!query) return
    searchAddonRef.current?.findPrevious(query, searchOpts())
  }, [query, searchAddonRef, searchOpts])

  const close = useCallback(() => {
    searchAddonRef.current?.clearDecorations()
    onClose()
    onFocusTerminal()
  }, [searchAddonRef, onClose, onFocusTerminal])

  // Incremental search on query/option change
  useEffect(() => {
    if (query) {
      searchAddonRef.current?.findNext(query, searchOpts())
    } else {
      searchAddonRef.current?.clearDecorations()
      setResultInfo('')
    }
  }, [query, caseSensitive, regex, wholeWord, searchAddonRef, searchOpts])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      close()
    } else if (e.key === 'Enter') {
      e.shiftKey ? findPrev() : findNext()
    }
  }, [close, findNext, findPrev])

  return (
    <div className="terminal-search-bar">
      <input
        ref={inputRef}
        className="terminal-search-input"
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Search..."
        spellCheck={false}
      />
      {resultInfo && <span className="terminal-search-info">{resultInfo}</span>}
      <button
        className={`terminal-search-opt${caseSensitive ? ' active' : ''}`}
        onClick={() => setCaseSensitive(!caseSensitive)}
        title="Match case"
      >Aa</button>
      <button
        className={`terminal-search-opt${wholeWord ? ' active' : ''}`}
        onClick={() => setWholeWord(!wholeWord)}
        title="Match whole word"
      >W</button>
      <button
        className={`terminal-search-opt${regex ? ' active' : ''}`}
        onClick={() => setRegex(!regex)}
        title="Use regex"
      >.*</button>
      <button className="terminal-search-nav" onClick={findPrev} title="Previous (Shift+Enter)">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="1,7 5,3 9,7" /></svg>
      </button>
      <button className="terminal-search-nav" onClick={findNext} title="Next (Enter)">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="1,3 5,7 9,3" /></svg>
      </button>
      <button className="terminal-search-nav" onClick={close} title="Close (Esc)">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><line x1="2" y1="2" x2="8" y2="8" /><line x1="8" y1="2" x2="2" y2="8" /></svg>
      </button>
    </div>
  )
}

const TerminalView: React.FC<TerminalViewProps> = ({ terminalId, isFocused }) => {
  const { initTerminal, fit, forceFit, focus, searchAddonRef, searchOpen, setSearchOpen, gotDataRef, scrolledUp, scrollToBottom, autoScroll, enableAutoScroll, disableAutoScroll } = useTerminal({ terminalId })
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
    const MIN_DISPLAY_MS = isResumed ? 1500 : 800
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

  // Re-fit once when loading dismissed — single fit after layout settles to avoid
  // hammering the PTY with multiple resize events during Claude's TUI init.
  // Uses a ref to run only on the loading→loaded transition, not on every render.
  const loadingDismissedRef = useRef(false)
  useEffect(() => {
    if (!loading && !loadingDismissedRef.current) {
      loadingDismissedRef.current = true
      const timer = setTimeout(() => {
        forceFit()
        scrollToBottom()
      }, 150)
      return () => clearTimeout(timer)
    }
  }, [loading, forceFit, scrollToBottom])

  // Focus terminal when it becomes the active one — but only if focus is in the grid
  const focusRegion = useDockStore((s) => s.focusRegion)
  useEffect(() => {
    if (isFocused && !loading && focusRegion === 'grid') {
      const timer = setTimeout(() => focus(), 50)
      return () => clearTimeout(timer)
    }
  }, [isFocused, loading, focus, focusRegion])

  // Re-focus when returning from toolbar navigation
  useEffect(() => {
    const handler = () => {
      if (useDockStore.getState().focusedTerminalId === terminalId) {
        setTimeout(() => focus(), 50)
      }
    }
    window.addEventListener('refocus-terminal', handler)
    return () => window.removeEventListener('refocus-terminal', handler)
  }, [terminalId, focus])

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
      {searchOpen && (
        <TerminalSearchBar
          searchAddonRef={searchAddonRef}
          onClose={() => setSearchOpen(false)}
          onFocusTerminal={focus}
        />
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
