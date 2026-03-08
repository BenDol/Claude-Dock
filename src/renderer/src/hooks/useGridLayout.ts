import { useMemo } from 'react'
import { useDockStore } from '../stores/dock-store'
import { useSettingsStore } from '../stores/settings-store'
import { computeAutoLayout } from '../lib/grid-math'
import type { Layout } from 'react-grid-layout'

export function useGridLayout(): { cols: number; layout: Layout[]; rowHeight: number } {
  const terminals = useDockStore((s) => s.terminals)
  const unlockedTerminals = useDockStore((s) => s.unlockedTerminals)
  const maxColumns = useSettingsStore((s) => s.settings.grid.maxColumns)

  return useMemo(() => {
    const ids = terminals.map((t) => t.id)
    const { cols, layout } = computeAutoLayout(ids, maxColumns)

    // Unlocked terminals are draggable, locked ones stay put but can be displaced
    const finalLayout = layout.map((l) => ({
      ...l,
      static: false,
      isDraggable: unlockedTerminals.has(l.i)
    }))

    return { cols, layout: finalLayout, rowHeight: 100 }
  }, [terminals, unlockedTerminals, maxColumns])
}
