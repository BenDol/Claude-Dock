import { useMemo, useState, useEffect, useCallback, useRef } from 'react'
import { useDockStore } from '../stores/dock-store'
import { useSettingsStore } from '../stores/settings-store'
import { computeAutoLayout, computePortraitLayout, GRID_RESOLUTION } from '../lib/grid-math'
import type { Layout } from 'react-grid-layout'

export type ViewportOrientation = 'landscape' | 'portrait'

/** Detect whether the container should use portrait layout */
function detectOrientation(width: number, height: number): ViewportOrientation {
  // Portrait when height exceeds width, or when width is too narrow for side-by-side
  return height > width || width < 500 ? 'portrait' : 'landscape'
}

export function useGridLayout(): {
  cols: number
  logicalCols: number
  layout: Layout[]
  rowHeight: number
  orientation: ViewportOrientation
  setContainerSize: (width: number, height: number) => void
  /** Column ratios for landscape resize (array length = logicalCols) */
  columnRatios: number[]
  setColumnRatios: (ratios: number[]) => void
  /** Row ratios for portrait resize (array length = terminal count) */
  rowRatios: number[]
  setRowRatios: (ratios: number[]) => void
} {
  const terminals = useDockStore((s) => s.terminals)
  const unlockedTerminals = useDockStore((s) => s.unlockedTerminals)
  const maxColumns = useSettingsStore((s) => s.settings.grid.maxColumns)
  const viewportMode = useSettingsStore((s) => s.settings.grid.viewportMode ?? 'auto')

  const [containerSize, setContainerSizeState] = useState({ width: 800, height: 600 })
  const [columnRatios, setColumnRatios] = useState<number[]>([])
  const [rowRatios, setRowRatios] = useState<number[]>([])

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

  // Reset ratios when terminal count or orientation changes
  const prevKey = useRef('')
  useEffect(() => {
    const key = `${orientation}:${terminals.length}`
    if (key !== prevKey.current) {
      prevKey.current = key
      setColumnRatios([])
      setRowRatios([])
    }
  }, [orientation, terminals.length])

  const result = useMemo(() => {
    const ids = terminals.map((t) => t.id)

    const { cols, logicalCols, layout } = orientation === 'portrait'
      ? computePortraitLayout(ids, rowRatios.length === ids.length ? rowRatios : undefined)
      : computeAutoLayout(ids, maxColumns, columnRatios.length > 0 ? columnRatios : undefined)

    const rows = layout.length > 0 ? Math.max(...layout.map((l) => l.y + l.h)) : 1

    const finalLayout = layout.map((l) => ({
      ...l,
      static: false,
      isDraggable: unlockedTerminals.has(l.i)
    }))

    return { cols, logicalCols, layout: finalLayout, rowHeight: 100, rows }
  }, [terminals, unlockedTerminals, maxColumns, orientation, columnRatios, rowRatios])

  return { ...result, orientation, setContainerSize, columnRatios, setColumnRatios, rowRatios, setRowRatios }
}
