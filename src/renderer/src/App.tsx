import React, { useEffect, useState, useCallback } from 'react'
import DockGrid from './components/DockGrid'
import Toolbar from './components/Toolbar'
import EmptyState from './components/EmptyState'
import SettingsModal from './components/SettingsModal'
import { useDockStore } from './stores/dock-store'
import { useSettingsStore } from './stores/settings-store'
import { getDockApi } from './lib/ipc-bridge'

let nextTermId = 1

function App() {
  const terminals = useDockStore((s) => s.terminals)
  const projectDir = useDockStore((s) => s.projectDir)
  const setDockInfo = useDockStore((s) => s.setDockInfo)
  const addTerminal = useDockStore((s) => s.addTerminal)
  const setTerminalAlive = useDockStore((s) => s.setTerminalAlive)
  const removeTerminal = useDockStore((s) => s.removeTerminal)
  const focusNextTerminal = useDockStore((s) => s.focusNextTerminal)
  const loadSettings = useSettingsStore((s) => s.load)
  const autoSpawn = useSettingsStore((s) => s.settings.behavior.autoSpawnFirstTerminal)

  const [showSettings, setShowSettings] = useState(false)
  const [initialized, setInitialized] = useState(false)

  // Initialize dock info and settings
  useEffect(() => {
    async function init() {
      const api = getDockApi()
      const info = await api.dock.getInfo()
      if (info) {
        setDockInfo(info.id, info.projectDir)
      }
      await loadSettings()
      setInitialized(true)
    }
    init()
  }, [setDockInfo, loadSettings])

  // Auto-spawn first terminal
  useEffect(() => {
    if (initialized && autoSpawn && terminals.length === 0) {
      handleAddTerminal()
    }
  }, [initialized, autoSpawn])

  // Listen for terminal exits
  useEffect(() => {
    const api = getDockApi()
    const cleanup = api.terminal.onExit((terminalId, _exitCode) => {
      setTerminalAlive(terminalId, false)
    })
    return cleanup
  }, [setTerminalAlive])

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey) {
        switch (e.key) {
          case 't':
            e.preventDefault()
            handleAddTerminal()
            break
          case 'w':
            e.preventDefault()
            handleCloseFocused()
            break
          case ',':
            e.preventDefault()
            setShowSettings(true)
            break
          case 'n':
            e.preventDefault()
            getDockApi().app.newDock()
            break
          case 'Tab':
            e.preventDefault()
            focusNextTerminal()
            break
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [focusNextTerminal])

  const handleAddTerminal = useCallback(() => {
    const id = `term-${nextTermId++}-${Date.now()}`
    addTerminal(id)
  }, [addTerminal])

  const handleCloseFocused = useCallback(() => {
    const state = useDockStore.getState()
    if (state.focusedTerminalId) {
      getDockApi().terminal.kill(state.focusedTerminalId)
      removeTerminal(state.focusedTerminalId)
    }
  }, [removeTerminal])

  if (!initialized) {
    return <div className="loading">Loading...</div>
  }

  return (
    <div className="app">
      <Toolbar
        projectDir={projectDir}
        onAddTerminal={handleAddTerminal}
        onOpenSettings={() => setShowSettings(true)}
      />
      {terminals.length === 0 ? (
        <EmptyState onAddTerminal={handleAddTerminal} projectDir={projectDir} />
      ) : (
        <DockGrid />
      )}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </div>
  )
}

export default App
