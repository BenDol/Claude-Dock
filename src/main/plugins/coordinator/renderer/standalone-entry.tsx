/**
 * Standalone renderer entry for the floating Coordinator window.
 *
 * Bundled by esbuild for plugin-overrides delivery. Loads CoordinatorPanel
 * with the project injected via the `projectDir` query param set by
 * CoordinatorWindowManager.open().
 */

import { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import '@dock-renderer/global.css'
import './coordinator.css'
import CoordinatorPanel from './CoordinatorPanel'
import { getDockApi } from '@dock-renderer/lib/ipc-bridge'
import { applyThemeToDocument } from '@dock-renderer/lib/theme'

const params = new URLSearchParams(window.location.search)
const projectDir = params.get('projectDir') || ''

function StandaloneApp(): React.ReactElement {
  useEffect(() => {
    const api = getDockApi()
    // Apply the user's theme so the floating window matches the dock.
    api.settings?.get?.().then((settings) => applyThemeToDocument(settings)).catch(() => { /* ignore */ })
    const off = api.settings?.onChange?.((settings) => applyThemeToDocument(settings))
    document.title = projectDir
      ? `${projectDir.split(/[\\/]/).pop()} — Coordinator`
      : 'Coordinator'
    return () => { off?.() }
  }, [])

  if (!projectDir) {
    return (
      <div style={{ padding: 20, color: '#f7768e', fontFamily: 'system-ui' }}>
        Coordinator window missing projectDir query parameter.
      </div>
    )
  }
  return <CoordinatorPanel projectDir={projectDir} />
}

const root = createRoot(document.getElementById('root')!)
root.render(<StandaloneApp />)
