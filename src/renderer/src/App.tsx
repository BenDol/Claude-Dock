import React, { useEffect, useState, useCallback, Suspense } from 'react'
import DockGrid from './components/DockGrid'
import Toolbar from './components/Toolbar'
import EmptyState from './components/EmptyState'
import SettingsModal from './components/SettingsModal'
import Launcher from './components/Launcher'
import { useDockStore } from './stores/dock-store'
import { useSettingsStore } from './stores/settings-store'
import { getDockApi } from './lib/ipc-bridge'
import { applyThemeToDocument } from './lib/theme'
import { computeAutoLayout, findAdjacentTerminal, type Direction } from './lib/grid-math'
import { getPluginViews } from './plugin-views'

const searchParams = new URLSearchParams(window.location.search)
const isLauncher = searchParams.has('launcher')
const pluginView = getPluginViews().find((v) => searchParams.has(v.queryParam))

function matchesKeybind(e: KeyboardEvent, keybind: string): boolean {
  if (!keybind || keybind.startsWith('!')) return false
  const parts = keybind.split('+').map((p) => p.trim().toLowerCase())
  const needCtrl = parts.includes('ctrl')
  const needShift = parts.includes('shift')
  const needAlt = parts.includes('alt')
  const key = parts.find((p) => !['ctrl', 'shift', 'alt', 'meta'].includes(p))
  if (!key) return false

  if (needCtrl !== (e.ctrlKey || e.metaKey)) return false
  if (needShift !== e.shiftKey) return false
  if (needAlt !== e.altKey) return false
  return e.key.toLowerCase() === key
}

function App() {
  if (pluginView) {
    const PluginComponent = pluginView.component
    return (
      <Suspense fallback={<div className="loading">Loading...</div>}>
        <PluginComponent />
      </Suspense>
    )
  }
  if (isLauncher) {
    return <LauncherApp />
  }
  return <DockApp />
}

function LauncherApp() {
  const loadSettings = useSettingsStore((s) => s.load)

  useEffect(() => {
    loadSettings().then(() => {
      applyThemeToDocument(useSettingsStore.getState().settings)
    })
  }, [loadSettings])

  return <Launcher />
}

let nextTermId = 1

function DockApp() {
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
  const [initialTerminalCount, setInitialTerminalCount] = useState(1)

  // Initialize dock info and settings
  useEffect(() => {
    async function init() {
      const api = getDockApi()
      const info = await api.dock.getInfo()
      if (info) {
        setDockInfo(info.id, info.projectDir)
        if (info.savedSessionCount > 0) {
          setInitialTerminalCount(info.savedSessionCount)
        }
      }
      await loadSettings()
      setInitialized(true)
    }
    init()
  }, [setDockInfo, loadSettings])

  // Auto-spawn terminals (matching saved session count or 1)
  useEffect(() => {
    if (initialized && autoSpawn && terminals.length === 0) {
      for (let i = 0; i < initialTerminalCount; i++) {
        handleAddTerminal()
      }
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

  const DEFAULT_FONT_SIZE = 14

  // Apply zoom: changes font size and scales header height + font
  const applyZoom = useCallback((newSize: number) => {
    const size = Math.max(8, Math.min(32, newSize))
    const settings = useSettingsStore.getState().settings
    if (size === settings.terminal.fontSize) return

    useSettingsStore.getState().update({
      terminal: { ...settings.terminal, fontSize: size }
    })

    const scale = size / DEFAULT_FONT_SIZE
    const headerHeight = Math.round(Math.max(14, 18 * scale))
    const headerFont = Math.round(Math.max(8, 10 * scale))
    document.documentElement.style.setProperty('--term-header-height', `${headerHeight}px`)
    document.documentElement.style.setProperty('--term-header-font', `${headerFont}px`)
  }, [])

  // Directional terminal focus navigation
  const focusDirection = useCallback((direction: Direction) => {
    const state = useDockStore.getState()
    if (!state.focusedTerminalId || state.terminals.length < 2) return
    const maxCols = useSettingsStore.getState().settings.grid.maxColumns
    const { layout } = computeAutoLayout(state.terminals.map((t) => t.id), maxCols)
    const targetId = findAdjacentTerminal(layout, state.focusedTerminalId, direction)
    if (targetId) {
      useDockStore.getState().setFocusedTerminal(targetId)
    }
  }, [])

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Check directional focus keybinds first
      const { keybindings } = useSettingsStore.getState().settings
      const directionMap: [string, Direction][] = [
        [keybindings.focusUp, 'up'],
        [keybindings.focusDown, 'down'],
        [keybindings.focusLeft, 'left'],
        [keybindings.focusRight, 'right']
      ]
      for (const [bind, dir] of directionMap) {
        if (matchesKeybind(e, bind)) {
          e.preventDefault()
          focusDirection(dir)
          return
        }
      }

      if (e.ctrlKey || e.metaKey) {
        const currentSize = useSettingsStore.getState().settings.terminal.fontSize
        switch (e.key) {
          case '=':
          case '+':
            e.preventDefault()
            applyZoom(currentSize + 1)
            return
          case '-':
            e.preventDefault()
            applyZoom(currentSize - 1)
            return
          case '0':
            e.preventDefault()
            applyZoom(DEFAULT_FONT_SIZE)
            return
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
  }, [focusNextTerminal, applyZoom, focusDirection])

  // Ctrl+MouseWheel zoom
  useEffect(() => {
    const handler = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      const currentSize = useSettingsStore.getState().settings.terminal.fontSize
      applyZoom(currentSize + (e.deltaY < 0 ? 1 : -1))
    }
    window.addEventListener('wheel', handler, { passive: false })
    return () => window.removeEventListener('wheel', handler)
  }, [applyZoom])

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
