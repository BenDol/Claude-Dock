/**
 * Renderer-side registration for the coordinator plugin.
 *
 * Lives inside the plugin directory; re-exported from
 * src/renderer/src/plugins/coordinator/index.ts for auto-discovery.
 *
 * Wires three things:
 *  1. A dockable panel on the right edge (CoordinatorPanel).
 *  2. A toolbar action that toggles the panel (order 50, between git and voice).
 *  3. Global IPC listeners — the main process asks the dock window to
 *     spawn a terminal (via onSpawnTerminalRequest) or open the coordinator
 *     (via onOpenRequest, fired by the Shift+Shift hotkey). Both need to be
 *     bound from the dock window's renderer because only that renderer owns
 *     the dock-store and can mint terminal IDs.
 */
import { lazy } from 'react'
import React from 'react'
import { registerPanel } from '@dock-renderer/panel-registry'
import { registerToolbarAction } from '@dock-renderer/toolbar-actions'
import { usePanelStore } from '@dock-renderer/stores/panel-store'
import { useDockStore } from '@dock-renderer/stores/dock-store'
import { getDockApi } from '@dock-renderer/lib/ipc-bridge'

registerPanel({
  id: 'coordinator',
  pluginId: 'coordinator',
  title: 'Coordinator',
  icon: React.createElement(ChatIcon),
  component: lazy(() => import('./CoordinatorPanel')),
  defaultPosition: 'right',
  defaultSize: 400,
  minSize: 320,
  maxSize: 720
})

registerToolbarAction({
  id: 'coordinator',
  title: 'Coordinator',
  icon: React.createElement(ChatIcon),
  onClick: () => {
    const store = usePanelStore.getState()
    if (store.activePanelId === 'coordinator' && store.visible) {
      store.setVisible(false)
    } else {
      store.setActivePanel('coordinator')
    }
  },
  order: 50
})

// Monotonic suffix so back-to-back spawn replies don't collide when the
// orchestrator spawns several terminals in the same millisecond.
let coordSpawnSeq = 0

// Bind IPC listeners once per renderer. Guarded because this module runs in
// the dock window, the launcher, and any detached plugin windows — only the
// dock window has a dockApi.coordinator surface populated with these hooks.
const api = getDockApi()
if (api?.coordinator) {
  api.coordinator.onSpawnTerminalRequest((req) => {
    try {
      coordSpawnSeq++
      const id = `term-coord-${Date.now()}-${coordSpawnSeq}`
      useDockStore.getState().addTerminal(id)
      api.coordinator.replySpawnTerminal(req.correlationId, id)
    } catch (err) {
      api.coordinator.replySpawnTerminal(req.correlationId, null, (err as Error).message)
    }
  })

  // Shift+Shift (main) asks the dock window to surface the coordinator.
  api.coordinator.onOpenRequest(() => {
    usePanelStore.getState().setActivePanel('coordinator')
  })
}

function ChatIcon(): React.ReactElement {
  return React.createElement(
    'svg',
    {
      width: 14,
      height: 14,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 2,
      strokeLinecap: 'round',
      strokeLinejoin: 'round'
    },
    React.createElement('path', {
      d: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z'
    }),
    React.createElement('line', { x1: 8, y1: 10, x2: 16, y2: 10 }),
    React.createElement('line', { x1: 8, y1: 14, x2: 13, y2: 14 })
  )
}
