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

// Brain icon for toolbar
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
    React.createElement('path', { d: 'M12 2a7 7 0 017 7c0 2.38-1.19 4.47-3 5.74V17a2 2 0 01-2 2h-4a2 2 0 01-2-2v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 017-7z' }),
    React.createElement('line', { x1: 9, y1: 22, x2: 15, y2: 22 }),
    React.createElement('line', { x1: 12, y1: 17, x2: 12, y2: 22 })
  )

registerToolbarAction({
  id: 'memory',
  title: 'Memory Viewer',
  icon: React.createElement(BrainIcon),
  onClick: (projectDir) => getDockApi().memory.open(projectDir),
  order: 55,
  getBadge: async () => {
    try {
      const adapters = await getDockApi().memory.getAdapters()
      const available = adapters.filter(a => a.installed)
      if (available.length === 0) return null
      return available.length
    } catch {
      return null
    }
  },
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
