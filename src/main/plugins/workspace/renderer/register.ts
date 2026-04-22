/**
 * Renderer-side registration for the workspace plugin.
 * Registers the dockable panel and toolbar toggle button.
 *
 * This file lives inside the plugin directory to maintain isolation.
 * It's re-exported from src/renderer/src/plugins/workspace/index.ts
 * for auto-discovery by the renderer plugin glob.
 */
import { lazy } from 'react'
import React from 'react'
import { registerPanel } from '@dock-renderer/panel-registry'
import { registerToolbarAction } from '@dock-renderer/toolbar-actions'
import { usePanelStore } from '@dock-renderer/stores/panel-store'

// Register the workspace viewer as a dockable panel
registerPanel({
  id: 'workspace',
  pluginId: 'workspace',
  title: 'Workspace',
  icon: React.createElement(FilesIcon),
  component: lazy(() => import('./WorkspacePanel')),
  headerActions: lazy(() => import('./HeaderActions')),
  defaultPosition: 'left',
  defaultSize: 250,
  minSize: 150,
  maxSize: 500
})

// Register the toolbar toggle button
registerToolbarAction({
  id: 'workspace',
  title: 'Workspace',
  icon: React.createElement(FilesIcon),
  onClick: () => {
    const store = usePanelStore.getState()
    if (store.isPanelVisible('workspace')) {
      store.hidePanel('workspace')
    } else {
      store.setActivePanel('workspace')
    }
  },
  order: 40
})

function FilesIcon(): React.ReactElement {
  return React.createElement('svg', {
    width: 14, height: 14, viewBox: '0 0 24 24',
    fill: 'none', stroke: 'currentColor', strokeWidth: 2,
    strokeLinecap: 'round', strokeLinejoin: 'round'
  },
    React.createElement('line', { x1: 4, y1: 2, x2: 4, y2: 22 }),
    React.createElement('line', { x1: 4, y1: 6, x2: 9, y2: 6 }),
    React.createElement('rect', { x: 9, y: 3, width: 12, height: 6, rx: 1 }),
    React.createElement('line', { x1: 4, y1: 15, x2: 9, y2: 15 }),
    React.createElement('rect', { x: 9, y: 12, width: 12, height: 6, rx: 1 })
  )
}
