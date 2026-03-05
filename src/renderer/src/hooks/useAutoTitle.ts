import { useEffect, useRef } from 'react'
import { getDockApi } from '../lib/ipc-bridge'
import { useDockStore } from '../stores/dock-store'

// Strip ANSI escape sequences
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
}

// Patterns to skip (startup noise)
const SKIP_PATTERNS = [
  /^\s*$/,
  /^[\$#>]\s*/,
  /^(bash|zsh|sh|cmd|powershell)/i,
  /^Microsoft/i,
  /^Copyright/i,
  /^\(.*\)/,
  /^Last login/i,
  /^Welcome/i
]

export function useAutoTitle(terminalId: string) {
  const detectedRef = useRef(false)
  const bufferRef = useRef('')
  const setTerminalTitle = useDockStore((s) => s.setTerminalTitle)

  useEffect(() => {
    const api = getDockApi()
    const cleanup = api.terminal.onData((id, data) => {
      if (id !== terminalId || detectedRef.current) return

      bufferRef.current += data
      const lines = stripAnsi(bufferRef.current).split('\n')

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        if (SKIP_PATTERNS.some((p) => p.test(trimmed))) continue

        // Found a meaningful line
        const title = trimmed.length > 60 ? trimmed.slice(0, 57) + '...' : trimmed
        setTerminalTitle(terminalId, title)
        detectedRef.current = true
        break
      }

      // Don't buffer forever
      if (bufferRef.current.length > 4096) {
        detectedRef.current = true
      }
    })

    return cleanup
  }, [terminalId, setTerminalTitle])
}
