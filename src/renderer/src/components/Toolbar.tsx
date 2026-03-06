import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useDockStore } from '../stores/dock-store'
import { getDockApi } from '../lib/ipc-bridge'

interface ToolbarProps {
  projectDir: string
  onAddTerminal: () => void
  onOpenSettings: () => void
}

const stripAnsi = (str: string): string =>
  str
    .replace(/\x1b\][^\x07]*\x07/g, '') // OSC sequences (e.g. title set)
    .replace(/[\x1b\x9b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nq-uy=><~]/g, '')

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function sendRCCommand(api: ReturnType<typeof getDockApi>, terminalId: string): Promise<void> {
  await api.terminal.write(terminalId, '/remote-control')
  await delay(300)
  await api.terminal.write(terminalId, '\x1b') // dismiss autocomplete
  await delay(100)
  await api.terminal.write(terminalId, '\r') // submit
}

const RemoteControlIcon: React.FC = () => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="12" r="2" />
    <path d="M16.24 7.76a6 6 0 010 8.49m-8.48 0a6 6 0 010-8.49" />
  </svg>
)

const FolderIcon: React.FC = () => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
  </svg>
)

const Toolbar: React.FC<ToolbarProps> = ({ projectDir, onAddTerminal, onOpenSettings }) => {
  const gridMode = useDockStore((s) => s.gridMode)
  const setGridMode = useDockStore((s) => s.setGridMode)
  const terminalCount = useDockStore((s) => s.terminals.length)
  const rcCount = useDockStore((s) => s.rcTerminals.size)
  const hasLoadingTerminals = useDockStore((s) => s.loadingTerminals.size > 0)
  const [toggling, setToggling] = useState(false)
  const rcBufsRef = useRef<Map<string, string>>(new Map())

  // Listen for RC disconnect only while RC terminals exist
  useEffect(() => {
    if (rcCount === 0) {
      rcBufsRef.current.clear()
      return
    }
    const api = getDockApi()
    const cleanup = api.terminal.onData((id, data) => {
      const store = useDockStore.getState()
      if (!store.rcTerminals.has(id)) return
      const stripped = stripAnsi(data)
      const prev = rcBufsRef.current.get(id) || ''
      const buf = prev + stripped
      rcBufsRef.current.set(id, buf.slice(-100))
      const compact = buf.toLowerCase().replace(/\s/g, '')
      if (compact.includes('remotecontroldisconnected')) {
        store.setTerminalRC(id, false)
        rcBufsRef.current.delete(id)
      }
    })
    return cleanup
  }, [rcCount > 0])

  const toggleMode = () => {
    setGridMode(gridMode === 'auto' ? 'freeform' : 'auto')
  }

  const toggleRemoteControl = useCallback(async () => {
    if (toggling) return
    const api = getDockApi()
    const state = useDockStore.getState()
    const alive = state.terminals.filter((t) => t.isAlive)
    if (alive.length === 0) return

    const anyHaveRC = alive.some((t) => state.rcTerminals.has(t.id))

    setToggling(true)

    if (anyHaveRC) {
      // Turn OFF — only stop RC on terminals that have it (parallel)
      const toDisable = alive.filter((t) => state.rcTerminals.has(t.id))
      await Promise.all(toDisable.map(async (terminal) => {
        await sendRCCommand(api, terminal.id)
        await delay(800)
        await api.terminal.write(terminal.id, '\x1b[A') // up arrow
        await delay(100)
        await api.terminal.write(terminal.id, '\x1b[A') // up arrow
        await delay(100)
        await api.terminal.write(terminal.id, '\r') // confirm stop
        useDockStore.getState().setTerminalRC(terminal.id, false)
      }))
    } else {
      // Turn ON — send to all terminals in parallel
      const toEnable = alive.filter((t) => !state.rcTerminals.has(t.id))
      await Promise.all(toEnable.map((terminal) =>
        new Promise<void>(async (resolve) => {
          let resolved = false
          let buf = ''
          const RC_ACTIVE = '/remote-control is active'

          const cleanupData = api.terminal.onData((id, data) => {
            if (id !== terminal.id || resolved) return
            const stripped = stripAnsi(data)
            buf += stripped
            buf = buf.slice(-200)
            if (buf.includes(RC_ACTIVE)) {
              resolved = true
              clearTimeout(timer)
              cleanupData()
              useDockStore.getState().setTerminalRC(terminal.id, true)
              resolve()
            }
          })

          await sendRCCommand(api, terminal.id)

          const timer = setTimeout(() => {
            if (!resolved) {
              resolved = true
              cleanupData()
              // Assume success on timeout
              useDockStore.getState().setTerminalRC(terminal.id, true)
              resolve()
            }
          }, 3000)
        })
      ))
    }

    setToggling(false)
  }, [toggling])

  const api = getDockApi()

  return (
    <div className="toolbar">
      <div className="toolbar-left">
        <span className="toolbar-project" title={projectDir}>
          {projectDir.split(/[/\\]/).pop()}
        </span>
        <span className="toolbar-count">{terminalCount} terminal{terminalCount !== 1 ? 's' : ''}</span>
        <button
          className={`toolbar-btn toolbar-btn-icon${rcCount > 0 ? ' toolbar-btn-active' : ''}`}
          onClick={toggleRemoteControl}
          disabled={toggling || hasLoadingTerminals}
          title={
            rcCount > 0
              ? `Remote Control: ${rcCount}/${terminalCount} (click to stop)`
              : 'Remote Control: OFF (click to start)'
          }
        >
          {toggling ? (
            <span className="toolbar-spinner" />
          ) : (
            <RemoteControlIcon />
          )}
        </button>
      </div>
      <div className="toolbar-center" />
      <div className="toolbar-right">
        <button className="toolbar-btn" onClick={toggleMode} title={`Mode: ${gridMode}`}>
          {gridMode === 'auto' ? 'Auto' : 'Free'}
        </button>
        <button className="toolbar-btn" onClick={onAddTerminal} title="New terminal (Ctrl+T)">
          +
        </button>
        <button
          className="toolbar-btn toolbar-btn-icon"
          onClick={() => api.app.openInExplorer(projectDir)}
          title="Open in file explorer"
        >
          <FolderIcon />
        </button>
        <button className="toolbar-btn" onClick={onOpenSettings} title="Settings (Ctrl+,)">
          &#9881;
        </button>
        <div className="toolbar-separator" />
        <button className="win-btn win-minimize" onClick={() => api.win.minimize()} title="Minimize">
          &#x2015;
        </button>
        <button className="win-btn win-maximize" onClick={() => api.win.maximize()} title="Maximize">
          &#9744;
        </button>
        <button className="win-btn win-close" onClick={() => api.win.close()} title="Close">
          &#10005;
        </button>
      </div>
    </div>
  )
}

export default Toolbar
