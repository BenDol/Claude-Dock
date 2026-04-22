/**
 * Standalone Coordinator settings window.
 *
 * Hosts the same `CoordinatorSettings` form used by the docked panel, but
 * inside its own BrowserWindow so it no longer depends on the panel container
 * for layout. Loading is via the `?coordinatorSettings=true` query param
 * registered in src/renderer/src/plugins/coordinator/index.ts.
 */
import { useEffect, useState } from 'react'
import './coordinator.css'
import { CoordinatorSettings } from './CoordinatorSettings'
import { useCoordinatorStore } from './coordinator-store'

const CoordinatorSettingsApp: React.FC = () => {
  const config = useCoordinatorStore((s) => s.config)
  const initForSettings = useCoordinatorStore((s) => s.initForSettings)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    document.title = 'Coordinator Settings'
    initForSettings().catch((err) => {
      const msg = (err as Error).message || String(err)
      console.error('[coordinator-settings] init failed:', msg)
      setLoadError(msg)
    })
  }, [initForSettings])

  const handleClose = (): void => {
    // Closing the window is the natural "done" — the renderer can't destroy
    // itself directly, but closing via the chrome button triggers the main
    // process close handler.
    window.close()
  }

  if (loadError) {
    return (
      <div className="coord-settings-window coord-settings-window-error">
        <div className="coord-settings-window-error-body">
          <h3>Couldn't load coordinator settings</h3>
          <pre>{loadError}</pre>
        </div>
      </div>
    )
  }

  if (!config) {
    return (
      <div className="coord-settings-window coord-settings-window-loading">
        <div className="coord-empty">Loading…</div>
      </div>
    )
  }

  return (
    <div className="coord-settings-window">
      <CoordinatorSettings onClose={handleClose} />
    </div>
  )
}

export default CoordinatorSettingsApp
