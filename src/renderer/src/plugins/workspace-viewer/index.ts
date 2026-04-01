import { lazy } from 'react'
import React from 'react'
import { registerPanel } from '../../panel-registry'
import { registerToolbarAction } from '../../toolbar-actions'
import { usePanelStore } from '../../stores/panel-store'

// Register the workspace viewer as a dockable panel
registerPanel({
  id: 'workspace-viewer',
  pluginId: 'workspace-viewer',
  title: 'Files',
  icon: React.createElement(FilesIcon),
  component: lazy(() => import('@plugins/workspace-viewer/renderer/WorkspaceViewerPanel')),
  defaultPosition: 'left',
  defaultSize: 250,
  minSize: 150,
  maxSize: 500
})

// Register the toolbar toggle button
registerToolbarAction({
  id: 'workspace-viewer',
  title: 'Files',
  icon: React.createElement(FilesIcon),
  onClick: () => {
    const store = usePanelStore.getState()
    if (store.activePanelId === 'workspace-viewer' && store.visible) {
      store.setVisible(false)
    } else {
      store.setActivePanel('workspace-viewer')
    }
  },
  order: 40, // Before git-manager (50)
  // Green dot when panel is visible
  getStatusDot: async () => {
    const store = usePanelStore.getState()
    return (store.activePanelId === 'workspace-viewer' && store.visible) ? 'success' : null
  }
})

function FilesIcon(): React.ReactElement {
  return React.createElement('svg', {
    width: 14, height: 14, viewBox: '0 0 24 24',
    fill: 'none', stroke: 'currentColor', strokeWidth: 2.5,
    strokeLinecap: 'round', strokeLinejoin: 'round'
  },
    React.createElement('path', { d: 'M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z' })
  )
}
