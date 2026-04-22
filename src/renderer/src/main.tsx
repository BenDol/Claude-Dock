import React from 'react'
import ReactDOM from 'react-dom/client'
import './global.css'

// Plugin registrations must run before App import
import './plugins'

import App from './App'

// Forward uncaught renderer errors to the main-process log file.
// Without these, renderer crashes vanish silently — the main process
// only knows about them via webContents 'render-process-gone', which
// doesn't include the JS error message.
window.onerror = (message, source, lineno, colno, error) => {
  const stack = error?.stack || ''
  const text = `[renderer] uncaught error: ${message} at ${source}:${lineno}:${colno}${stack ? '\n' + stack : ''}`
  try { window.dockApi?.debug?.write(text) } catch { /* IPC may be dead */ }

  // Known xterm.js v5 race: Viewport's constructor schedules a fire-and-forget
  // `setTimeout(() => syncScrollArea())` that can fire after the terminal's
  // RenderService has been disposed, making `_renderer.value.dimensions` throw
  // "Cannot read properties of undefined (reading 'dimensions')". Primary
  // mitigation is the deferred `term.dispose()` in useTerminal; this filter
  // keeps any remaining stragglers out of the crash-report stream while still
  // preserving the full entry in the debug log above.
  const isXtermViewportRace =
    typeof message === 'string' &&
    message.includes("reading 'dimensions'") &&
    stack.includes('syncScrollArea')

  if (!isXtermViewportRace) {
    try { window.dockApi?.debug?.reportCrash('uncaughtError', String(message), stack || `${source}:${lineno}:${colno}`) } catch { /* IPC may be dead */ }
  }
  console.error(text)
}

window.onunhandledrejection = (event: PromiseRejectionEvent) => {
  const reason = event.reason
  // Monaco's standalone text model service throws "Model not found" when
  // Go-to-Definition resolves to a file without an editor model (e.g. files
  // beyond the workspace model cap or external deps). This is a benign
  // limitation of standalone Monaco, not an app crash — suppress it.
  if (reason instanceof Error && reason.message === 'Model not found' &&
      reason.stack?.includes('createModelReference')) {
    event.preventDefault()
    return
  }
  const text = `[renderer] unhandled rejection: ${reason instanceof Error ? reason.message + '\n' + reason.stack : String(reason)}`
  try { window.dockApi?.debug?.write(text) } catch { /* IPC may be dead */ }
  try { window.dockApi?.debug?.reportCrash('unhandledRejection', reason instanceof Error ? reason.message : String(reason), reason instanceof Error ? (reason.stack || '') : '') } catch { /* IPC may be dead */ }
  console.error(text)
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
