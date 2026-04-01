/**
 * DockPanelLayout — wraps DockGrid to add dockable edge panels.
 *
 * Renders an optional panel (from panel-registry) on any edge (left/right/top/bottom)
 * with a resize handle between the panel and the grid. When no panel is visible,
 * the grid takes 100% of space (zero overhead).
 *
 * Other plugins register panels via registerPanel() in their renderer index.ts.
 */
import React, { useCallback, useRef, useEffect, useState, Suspense } from 'react'
import { usePanelStore } from '../stores/panel-store'
import { getPanel } from '../panel-registry'
import { useDockStore } from '../stores/dock-store'

export const DockPanelLayout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { activePanelId, position, size, visible, setSize } = usePanelStore()
  const projectDir = useDockStore((s) => s.projectDir)
  const loadFromStorage = usePanelStore((s) => s.loadFromStorage)
  const panelRef = useRef<HTMLDivElement>(null)
  // Local drag size — avoids writing to store on every pixel of drag
  const [dragSize, setDragSize] = useState<number | null>(null)

  // Load persisted panel state when project dir changes
  useEffect(() => {
    if (projectDir) loadFromStorage(projectDir)
  }, [projectDir, loadFromStorage])

  // Resolve the active panel registration
  const activePanel = activePanelId ? getPanel(activePanelId) : null
  const showPanel = visible && activePanel != null
  const effectiveSize = dragSize ?? size

  // Resize handle — uses local state during drag, commits to store on mouseup
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startY = e.clientY
    const startSize = size
    const isHorizontal = position === 'left' || position === 'right'
    const zoom = parseFloat(document.documentElement.style.zoom) || 1
    const minSize = activePanel?.minSize ?? 150
    const maxSize = activePanel?.maxSize ?? 600

    const onMove = (ev: MouseEvent) => {
      const delta = isHorizontal
        ? (position === 'left' ? ev.clientX - startX : startX - ev.clientX) / zoom
        : (position === 'top' ? ev.clientY - startY : startY - ev.clientY) / zoom
      setDragSize(Math.round(Math.min(maxSize, Math.max(minSize, startSize + delta))))
    }

    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      // Commit final size to store (persists to localStorage)
      setDragSize((final) => {
        if (final != null) setSize(final)
        return null
      })
      // Trigger terminal refit
      window.dispatchEvent(new Event('resize'))
    }

    document.body.style.cursor = isHorizontal ? 'col-resize' : 'row-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [position, size, setSize, activePanel])

  // Trigger terminal refit when panel visibility changes (not on every size change)
  useEffect(() => {
    const timer = setTimeout(() => window.dispatchEvent(new Event('resize')), 50)
    return () => clearTimeout(timer)
  }, [showPanel, position])

  if (!showPanel) {
    return <>{children}</>
  }

  const isHorizontal = position === 'left' || position === 'right'
  const panelStyle: React.CSSProperties = isHorizontal
    ? { width: effectiveSize, minWidth: activePanel?.minSize ?? 150, flexShrink: 0 }
    : { height: effectiveSize, minHeight: activePanel?.minSize ?? 150, flexShrink: 0 }

  const PanelComponent = activePanel!.component

  const panelElement = (
    <div className="dock-panel-area" ref={panelRef} style={panelStyle}>
      <div className="dock-panel-header">
        <span className="dock-panel-title">{activePanel!.title}</span>
      </div>
      <div className="dock-panel-body">
        <Suspense fallback={<div className="dock-panel-loading">Loading...</div>}>
          <PanelComponent projectDir={projectDir} />
        </Suspense>
      </div>
    </div>
  )

  const resizeHandle = (
    <div
      className={`dock-panel-resize ${isHorizontal ? 'dock-panel-resize-col' : 'dock-panel-resize-row'}`}
      onMouseDown={handleResizeStart}
    />
  )

  return (
    <div className={`dock-panel-layout dock-panel-layout-${position}`}>
      {(position === 'left' || position === 'top') && (
        <>{panelElement}{resizeHandle}</>
      )}
      <div className="dock-panel-grid-area">
        {children}
      </div>
      {(position === 'right' || position === 'bottom') && (
        <>{resizeHandle}{panelElement}</>
      )}
    </div>
  )
}
