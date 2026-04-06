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
  const text = `[renderer] uncaught error: ${message} at ${source}:${lineno}:${colno}${error?.stack ? '\n' + error.stack : ''}`
  try { window.dockApi?.debug?.write(text) } catch { /* IPC may be dead */ }
  try { window.dockApi?.debug?.reportCrash('uncaughtError', String(message), error?.stack || `${source}:${lineno}:${colno}`) } catch { /* IPC may be dead */ }
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
