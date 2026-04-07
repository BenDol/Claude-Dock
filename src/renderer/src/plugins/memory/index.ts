import { lazy } from 'react'
import React from 'react'
import { registerPluginView } from '../../plugin-views'
import { registerToolbarAction } from '../../toolbar-actions'
import { getDockApi } from '../../lib/ipc-bridge'

// Register the memory viewer (opens in its own BrowserWindow)
registerPluginView({
  pluginId: 'memory',
  queryParam: 'memory',
  component: lazy(() => import('@plugins/memory/renderer/MemoryApp'))
})

// Brain icon for toolbar (Lucide brain icon)
const BrainIcon = (): React.ReactElement =>
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
    React.createElement('path', { d: 'M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z' }),
    React.createElement('path', { d: 'M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z' }),
    React.createElement('path', { d: 'M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4' }),
    React.createElement('path', { d: 'M17.599 6.5a3 3 0 0 0 .399-1.375' }),
    React.createElement('path', { d: 'M6.003 5.125A3 3 0 0 0 6.401 6.5' }),
    React.createElement('path', { d: 'M3.477 10.896a4 4 0 0 1 .585-.396' }),
    React.createElement('path', { d: 'M19.938 10.5a4 4 0 0 1 .585.396' }),
    React.createElement('path', { d: 'M6 18a4 4 0 0 1-1.967-.516' }),
    React.createElement('path', { d: 'M19.967 17.484A4 4 0 0 1 18 18' })
  )

registerToolbarAction({
  id: 'memory',
  title: 'Memory',
  icon: React.createElement(BrainIcon),
  onClick: (projectDir) => getDockApi().memory.open(projectDir),
  order: 55,
  getStatusDot: async () => {
    try {
      const adapters = await getDockApi().memory.getAdapters()
      const hasAvailable = adapters.some(a => a.installed && a.enabled)
      return hasAvailable ? 'success' : null
    } catch {
      return null
    }
  }
})
