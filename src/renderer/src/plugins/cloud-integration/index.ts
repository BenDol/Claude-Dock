import { lazy } from 'react'
import React from 'react'
import { registerPluginView } from '../../plugin-views'
import { registerToolbarAction } from '../../toolbar-actions'
import { getDockApi } from '../../lib/ipc-bridge'

// Register the cloud integration view (opens in its own BrowserWindow)
registerPluginView({
  pluginId: 'cloud-integration',
  queryParam: 'cloudIntegration',
  component: lazy(() => import('@plugins/cloud-integration/renderer/CloudApp'))
})

// Cloud icon — shows the active provider's icon dynamically via badge/status
const CloudIcon = (): React.ReactElement =>
  React.createElement('svg', {
    width: 14,
    height: 14,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round'
  },
    React.createElement('path', { d: 'M18 10h-1.26A8 8 0 109 20h9a5 5 0 000-10z' })
  )

registerToolbarAction({
  id: 'cloud-integration',
  title: 'Cloud Integration',
  icon: React.createElement(CloudIcon),
  onClick: (projectDir) => getDockApi().cloudIntegration.open(projectDir),
  order: 60,
  getStatusDot: async (projectDir) => {
    try {
      const authenticated = await getDockApi().cloudIntegration.checkAuth(projectDir)
      return authenticated ? 'success' : null
    } catch {
      return null
    }
  }
})
