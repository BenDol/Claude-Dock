import { useMemo, useState, useEffect, useCallback } from 'react'
import { useDockStore } from '../stores/dock-store'
import { useSettingsStore } from '../stores/settings-store'
import { computeAutoLayout, computePortraitLayout } from '../lib/grid-math'
import type { Layout } from 'react-grid-layout'

export type ViewportOrientation = 'landscape' | 'portrait'

/** Detect whether the container should use portrait layout */
function detectOrientation(width: number, height: number): ViewportOrientation {
  // Portrait when height exceeds width, or when width is too narrow for side-by-side
  return height > width || width < 500 ? 'portrait' : 'landscape'
}

export function useGridLayout(): {
  cols: number
  layout: Layout[]
  rowHeight: number
  orientation: ViewportOrientation
  setContainerSize: (width: number, height: number) => void
} {
  const terminals = useDockStore((s) => s.terminals)
  const unlockedTerminals = useDockStore((s) => s.unlockedTerminals)
  const maxColumns = useSettingsStore((s) => s.settings.grid.maxColumns)
  const viewportMode = useSettingsStore((s) => s.settings.grid.viewportMode ?? 'auto')

  const [containerSize, setContainerSizeState] = useState({ width: 800, height: 600 })

  const setContainerSize = useCallback((width: number, height: number) => {
    setContainerSizeState((prev) => {
      if (prev.width === width && prev.height === height) return prev
      return { width, height }
    })
  }, [])

  const orientation: ViewportOrientation = useMemo(() => {
    if (viewportMode === 'landscape') return 'landscape'
    if (viewportMode === 'portrait') return 'portrait'
    return detectOrientation(containerSize.width, containerSize.height)
  }, [viewportMode, containerSize.width, containerSize.height])

  const result = useMemo(() => {
    const ids = terminals.map((t) => t.id)

    const { cols, layout } = orientation === 'portrait'
      ? computePortraitLayout(ids)
      : computeAutoLayout(ids, maxColumns)

    const finalLayout = layout.map((l) => ({
      ...l,
      static: false,
      isDraggable: unlockedTerminals.has(l.i)
    }))

    return { cols, layout: finalLayout, rowHeight: 100 }
  }, [terminals, unlockedTerminals, maxColumns, orientation])

  return { ...result, orientation, setContainerSize }
}
