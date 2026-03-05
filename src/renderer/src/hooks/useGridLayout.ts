import { useMemo } from 'react'
import { useDockStore } from '../stores/dock-store'
import { useSettingsStore } from '../stores/settings-store'
import { computeAutoLayout } from '../lib/grid-math'
import type { Layout } from 'react-grid-layout'

export function useGridLayout(): { cols: number; layout: Layout[]; rowHeight: number } {
  const terminals = useDockStore((s) => s.terminals)
  const gridMode = useDockStore((s) => s.gridMode)
  const freeformLayout = useDockStore((s) => s.freeformLayout)
  const maxColumns = useSettingsStore((s) => s.settings.grid.maxColumns)

  return useMemo(() => {
    const ids = terminals.map((t) => t.id)

    if (gridMode === 'auto') {
      const { cols, layout } = computeAutoLayout(ids, maxColumns)
      // Row height will be calculated dynamically based on container height
      return { cols, layout, rowHeight: 100 }
    }

    // Freeform mode: use saved layout, or generate initial layout
    if (freeformLayout.length > 0) {
      const cols = maxColumns
      return { cols, layout: freeformLayout, rowHeight: 100 }
    }

    // Generate initial freeform layout from auto
    const { cols, layout } = computeAutoLayout(ids, maxColumns)
    const freeLayout = layout.map((l) => ({ ...l, static: false }))
    return { cols, layout: freeLayout, rowHeight: 100 }
  }, [terminals, gridMode, freeformLayout, maxColumns])
}
