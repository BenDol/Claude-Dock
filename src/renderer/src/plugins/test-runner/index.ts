import { lazy } from 'react'
import React from 'react'
import { registerPluginView } from '../../plugin-views'
import { registerToolbarAction } from '../../toolbar-actions'
import { getDockApi } from '../../lib/ipc-bridge'

// Register the test runner view (opens in its own BrowserWindow)
registerPluginView({
  pluginId: 'test-runner',
  queryParam: 'testRunner',
  component: lazy(() => import('@plugins/test-runner/renderer/TestRunnerApp'))
})

const TestRunnerIcon = (): React.ReactElement =>
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
    React.createElement('path', { d: 'M9 2v6l-2 4v6a2 2 0 002 2h6a2 2 0 002-2v-6l-2-4V2' }),
    React.createElement('line', { x1: 8, y1: 2, x2: 16, y2: 2 }),
    React.createElement('line', { x1: 10, y1: 12, x2: 14, y2: 12 })
  )

registerToolbarAction({
  id: 'test-runner',
  title: 'Test Runner',
  icon: React.createElement(TestRunnerIcon),
  onClick: (projectDir) => getDockApi().testRunner.open(projectDir),
  order: 60
})
