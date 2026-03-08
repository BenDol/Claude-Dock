import React, { useCallback, useRef, useEffect, useState } from 'react'
import ReactGridLayout from 'react-grid-layout'
import 'react-grid-layout/css/styles.css'
import TerminalCard from './TerminalCard'
import { useDockStore } from '../stores/dock-store'
import { useGridLayout } from '../hooks/useGridLayout'
import { useSettingsStore } from '../stores/settings-store'
import { getDockApi } from '../lib/ipc-bridge'

const DockGrid: React.FC = () => {
  const terminals = useDockStore((s) => s.terminals)
  const focusedTerminalId = useDockStore((s) => s.focusedTerminalId)
  const swapTerminals = useDockStore((s) => s.swapTerminals)
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

  // On drag stop, find which terminal occupies the drop position and swap
  const onDragStop = useCallback(
    (_layout: ReactGridLayout.Layout[], _oldItem: ReactGridLayout.Layout, newItem: ReactGridLayout.Layout) => {
      const draggedId = newItem.i
      const targetItem = layout.find(
        (l) => l.i !== draggedId && l.x === newItem.x && l.y === newItem.y
      )
      if (targetItem) {
        swapTerminals(draggedId, targetItem.i)
        // Persist new order to sessions.json
        const newOrder = useDockStore.getState().terminals.map((t) => t.id)
        getDockApi().terminal.syncOrder(newOrder)
        // Scroll all terminals to bottom after reposition
        setTimeout(() => window.dispatchEvent(new Event('terminals-repositioned')), 100)
      }
    },
    [layout, swapTerminals]
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
        isDraggable={true}
        isResizable={false}
        draggableHandle=".terminal-card-header"
        draggableCancel=".terminal-card-actions"
        onDragStop={onDragStop}
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
