/**
 * Standalone Coordinator settings window.
 *
 * Hosts the same `CoordinatorSettings` form used by the docked panel, but
 * inside its own BrowserWindow so it no longer depends on the panel container
 * for layout. Loading is via the `?coordinatorSettings=true` query param
 * registered in src/renderer/src/plugins/coordinator/index.ts.
 */
import { useEffect } from 'react'
import './coordinator.css'
import { CoordinatorSettings } from './CoordinatorSettings'
import { useCoordinatorStore } from './coordinator-store'

const CoordinatorSettingsApp: React.FC = () => {
  const config = useCoordinatorStore((s) => s.config)
  const initForSettings = useCoordinatorStore((s) => s.initForSettings)
  // The store is the single source of truth for init errors — it already sets
  // `error` in its catch block and rethrows for us to observe. Reading from
  // the store here means a re-open doesn't carry stale local state.
  const loadError = useCoordinatorStore((s) => (config ? null : s.error))

  useEffect(() => {
    document.title = 'Coordinator Settings'
    // Swallow here — initForSettings has already recorded the error on the
    // store; we just need to avoid the unhandled-rejection warning.
    initForSettings().catch(() => { /* already captured in store.error */ })
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
