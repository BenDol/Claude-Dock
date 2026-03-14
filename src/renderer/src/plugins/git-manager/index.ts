import { lazy } from 'react'
import React from 'react'
import { registerPluginView } from '../../plugin-views'
import { registerToolbarAction } from '../../toolbar-actions'
import { getDockApi } from '../../lib/ipc-bridge'

// Register the git manager view (opens in its own BrowserWindow)
registerPluginView({
  queryParam: 'gitManager',
  component: lazy(() => import('./GitManagerApp'))
})

// Register the toolbar button
const GitBranchIcon = (): React.ReactElement =>
  React.createElement('svg', {
    width: 14,
    height: 14,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2.5,
    strokeLinecap: 'round',
    strokeLinejoin: 'round'
  },
    React.createElement('line', { x1: 6, y1: 3, x2: 6, y2: 15 }),
    React.createElement('circle', { cx: 18, cy: 6, r: 3 }),
    React.createElement('circle', { cx: 6, cy: 18, r: 3 }),
    React.createElement('path', { d: 'M18 9a9 9 0 01-9 9' })
  )

registerToolbarAction({
  id: 'git-manager',
  title: 'Git Manager',
  icon: React.createElement(GitBranchIcon),
  onClick: (projectDir) => getDockApi().gitManager.open(projectDir),
  order: 50,
  getBadge: async (projectDir) => {
    try {
      const api = getDockApi()
      const [status, behind] = await Promise.all([
        api.gitManager.getStatus(projectDir),
        api.gitManager.getBehindCount(projectDir)
      ])
      const localChanges = status.staged.length + status.unstaged.length + status.untracked.length
      if (behind > 0 && localChanges > 0) return `${localChanges}\u2193${behind}`
      if (behind > 0) return `\u2193${behind}`
      if (localChanges > 0) return localChanges
      return null
    } catch {
      return null
    }
  },
  getWarning: async (projectDir) => {
    try {
      const status = await getDockApi().gitManager.getStatus(projectDir)
      return status.conflicts.length > 0
    } catch {
      return false
    }
  }
})
