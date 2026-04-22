// Re-export from the plugin's own directory to maintain isolation.
// All coordinator code lives in src/main/plugins/coordinator/.
import { lazy } from 'react'
import { registerPluginView } from '../../plugin-views'
import '@plugins/coordinator/renderer/register'

// Register the standalone settings window view — loaded when the main process
// opens a BrowserWindow with the `?coordinatorSettings=true` query param.
registerPluginView({
  pluginId: 'coordinator',
  queryParam: 'coordinatorSettings',
  component: lazy(() => import('@plugins/coordinator/renderer/CoordinatorSettingsApp'))
})
