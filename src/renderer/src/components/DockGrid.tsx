import React, { useCallback, useRef, useEffect, useState } from 'react'
import ReactGridLayout from 'react-grid-layout'
import 'react-grid-layout/css/styles.css'
import TerminalCard from './TerminalCard'
import { useDockStore } from '../stores/dock-store'
import { useGridLayout } from '../hooks/useGridLayout'
import { useSettingsStore } from '../stores/settings-store'
import { getDockApi } from '../lib/ipc-bridge'
import { GRID_RESOLUTION } from '../lib/grid-math'

// Register global shell event listener (once, at grid level)
let shellEventListenerRegistered = false

const DockGrid: React.FC = () => {
  const terminals = useDockStore((s) => s.terminals)
  const focusedTerminalId = useDockStore((s) => s.focusedTerminalId)
  const swapTerminals = useDockStore((s) => s.swapTerminals)
  const gapSize = useSettingsStore((s) => s.settings.grid.gapSize)
  const { cols, logicalCols, layout, orientation, setContainerSize, columnRatios, setColumnRatios, rowRatios, setRowRatios } = useGridLayout()

  const containerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(800)
  const [containerHeight, setContainerHeight] = useState(600)

  // Listen for shell events from the main process (once globally)
  useEffect(() => {
    if (shellEventListenerRegistered) return
    shellEventListenerRegistered = true
    getDockApi().shell.onShellEvent((_e: any, event: any) => {
      useDockStore.getState().addShellEvent(event)
    })
  }, [])

  // Track container size and feed it to the grid layout hook for orientation detection
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect
        setContainerWidth(width)
        setContainerHeight(height)
        setContainerSize(width, height)
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [setContainerSize])

  // When terminals are added/removed, the grid layout changes — dispatch a refit
  // event after the layout settles so all terminals (including new ones) resize properly.
  const prevCountRef = useRef(terminals.length)
  useEffect(() => {
    if (terminals.length !== prevCountRef.current) {
      prevCountRef.current = terminals.length
      // Staggered re-fits: grid layout needs time to settle after adding/removing a cell
      setTimeout(() => window.dispatchEvent(new Event('terminals-repositioned')), 200)
      setTimeout(() => window.dispatchEvent(new Event('terminals-repositioned')), 600)
    }
  }, [terminals.length])

  const rows = layout.length > 0 ? Math.max(...layout.map((l) => l.y + l.h)) : 1
  const totalGap = gapSize * (rows - 1)
  const rowHeight = Math.floor((containerHeight - totalGap) / rows)

  // On drag stop, find which terminal occupies the drop position and swap
  const onDragStop = useCallback(
    (_layout: ReactGridLayout.Layout[], _oldItem: ReactGridLayout.Layout, newItem: ReactGridLayout.Layout) => {
      const draggedId = newItem.i
      const targetItem = layout.find(
        (l) =>
          l.i !== draggedId &&
          newItem.x >= l.x && newItem.x < l.x + l.w &&
          newItem.y >= l.y && newItem.y < l.y + l.h
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

  // --- Resize handles between grid columns (landscape) or rows (portrait) ---

  const handleGridResize = useCallback((index: number, e: React.MouseEvent) => {
    e.preventDefault()
    const isHorizontal = orientation === 'landscape'
    const startPos = isHorizontal ? e.clientX : e.clientY
    const totalSize = isHorizontal ? containerWidth : containerHeight
    const count = isHorizontal ? logicalCols : terminals.length
    const currentRatios = isHorizontal
      ? (columnRatios.length === count ? [...columnRatios] : Array(count).fill(1))
      : (rowRatios.length === count ? [...rowRatios] : Array(count).fill(1))
    const leftRatio = currentRatios[index]
    const rightRatio = currentRatios[index + 1]
    const sumRatio = leftRatio + rightRatio

    const onMove = (ev: MouseEvent) => {
      const pos = isHorizontal ? ev.clientX : ev.clientY
      const delta = pos - startPos
      const deltaRatio = (delta / totalSize) * sumRatio * count
      const newRatios = [...currentRatios]
      newRatios[index] = Math.max(0.15, leftRatio + deltaRatio)
      newRatios[index + 1] = Math.max(0.15, rightRatio - deltaRatio)
      if (isHorizontal) setColumnRatios(newRatios)
      else setRowRatios(newRatios)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      setTimeout(() => window.dispatchEvent(new Event('terminals-repositioned')), 50)
    }
    document.body.style.cursor = isHorizontal ? 'col-resize' : 'row-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [orientation, containerWidth, containerHeight, logicalCols, terminals.length, columnRatios, rowRatios, setColumnRatios, setRowRatios])

  // Compute resize handle positions from the layout
  const resizeHandles: Array<{ index: number; pos: number; isHorizontal: boolean }> = []
  if (orientation === 'landscape' && logicalCols > 1) {
    // Find column boundaries from the layout
    const colWidth = containerWidth / cols
    const seen = new Set<number>()
    for (const l of layout) {
      const rightEdge = l.x + l.w
      if (rightEdge < cols && !seen.has(rightEdge)) {
        seen.add(rightEdge)
        const colIdx = Math.round(rightEdge / GRID_RESOLUTION) - 1
        if (colIdx >= 0 && colIdx < logicalCols - 1) {
          resizeHandles.push({ index: colIdx, pos: rightEdge * colWidth, isHorizontal: true })
        }
      }
    }
  } else if (orientation === 'portrait' && terminals.length > 1) {
    // Row boundaries
    let cumY = 0
    for (const l of layout) {
      if (cumY > 0) {
        const idx = layout.indexOf(l) - 1
        if (idx >= 0) {
          resizeHandles.push({ index: idx, pos: cumY * (rowHeight + gapSize), isHorizontal: false })
        }
      }
      cumY = l.y + l.h
    }
  }

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
      {resizeHandles.map((h) => (
        <div
          key={`resize-${h.index}-${h.isHorizontal ? 'h' : 'v'}`}
          className={`grid-resize-handle ${h.isHorizontal ? 'grid-resize-handle-col' : 'grid-resize-handle-row'}`}
          style={h.isHorizontal
            ? { left: h.pos - 3, top: 0, width: 6, height: '100%' }
            : { top: h.pos - 3, left: 0, height: 6, width: '100%' }
          }
          onMouseDown={(e) => handleGridResize(h.index, e)}
        />
      ))}
    </div>
  )
}

export default DockGrid
