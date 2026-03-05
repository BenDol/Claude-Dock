import React, { useCallback, useRef, useEffect, useState } from 'react'
import ReactGridLayout from 'react-grid-layout'
import 'react-grid-layout/css/styles.css'
import TerminalCard from './TerminalCard'
import { useDockStore } from '../stores/dock-store'
import { useGridLayout } from '../hooks/useGridLayout'
import { useSettingsStore } from '../stores/settings-store'

const DockGrid: React.FC = () => {
  const terminals = useDockStore((s) => s.terminals)
  const gridMode = useDockStore((s) => s.gridMode)
  const focusedTerminalId = useDockStore((s) => s.focusedTerminalId)
  const setFreeformLayout = useDockStore((s) => s.setFreeformLayout)
  const gapSize = useSettingsStore((s) => s.settings.grid.gapSize)
  const { cols, layout } = useGridLayout()

  const containerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(800)
  const [containerHeight, setContainerHeight] = useState(600)

  // Track container size
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width)
        setContainerHeight(entry.contentRect.height)
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const rows = Math.max(1, Math.ceil(terminals.length / cols))
  const totalGap = gapSize * (rows - 1)
  const rowHeight = Math.floor((containerHeight - totalGap) / rows)

  const onLayoutChange = useCallback(
    (newLayout: ReactGridLayout.Layout[]) => {
      if (gridMode === 'freeform') {
        setFreeformLayout(newLayout)
      }
    },
    [gridMode, setFreeformLayout]
  )

  if (terminals.length === 0) return null

  return (
    <div className="dock-grid-container" ref={containerRef}>
      <ReactGridLayout
        className="dock-grid"
        layout={layout}
        cols={cols}
        rowHeight={rowHeight}
        width={containerWidth}
        margin={[gapSize, gapSize]}
        containerPadding={[0, 0]}
        isDraggable={gridMode === 'freeform'}
        isResizable={gridMode === 'freeform'}
        draggableHandle=".terminal-card-header"
        onLayoutChange={onLayoutChange}
        compactType="vertical"
        useCSSTransforms
      >
        {terminals.map((t) => (
          <div key={t.id}>
            <TerminalCard
              terminalId={t.id}
              title={t.title}
              isAlive={t.isAlive}
              isFocused={t.id === focusedTerminalId}
            />
          </div>
        ))}
      </ReactGridLayout>
    </div>
  )
}

export default DockGrid
