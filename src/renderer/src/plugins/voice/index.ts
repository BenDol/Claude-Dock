import { lazy } from 'react'
import React from 'react'
import { registerPluginView } from '../../plugin-views'
import { registerToolbarAction } from '../../toolbar-actions'
import { getDockApi } from '../../lib/ipc-bridge'

// Register the voice settings/setup viewer (opens in its own BrowserWindow)
registerPluginView({
  pluginId: 'voice',
  queryParam: 'voice',
  component: lazy(() => import('@plugins/voice/renderer/VoiceApp'))
})

// Microphone icon for toolbar (Lucide mic icon)
const MicIcon = (): React.ReactElement =>
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
    React.createElement('path', { d: 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z' }),
    React.createElement('path', { d: 'M19 10v2a7 7 0 0 1-14 0v-2' }),
    React.createElement('line', { x1: 12, y1: 19, x2: 12, y2: 22 })
  )

registerToolbarAction({
  id: 'voice',
  title: 'Voice',
  icon: React.createElement(MicIcon),
  onClick: () => getDockApi().voice.open(),
  order: 56,
  // Red when the voice service can't run (install missing/errored, or daemon
  // crashed/stopped — which also catches "mic not available" since the daemon
  // exits when it can't open an input device). Yellow while installing or
  // starting up. Hidden once the daemon is running (or the user has explicitly
  // disabled the hotkey, which still leaves the MCP server usable).
  getStatusDot: async () => {
    try {
      const s = await getDockApi().voice.getStatus()
      if (s.installState === 'installing' || s.daemonState === 'starting') return 'in_progress'
      if (s.installState === 'missing' || s.installState === 'error' || s.installState === 'unknown') return 'failure'
      if (s.daemonState === 'crashed' || s.daemonState === 'stopped') return 'failure'
      return null
    } catch {
      return null
    }
  }
})
