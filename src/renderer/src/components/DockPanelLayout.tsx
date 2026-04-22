/**
 * DockPanelLayout — wraps DockGrid to add dockable edge panels.
 *
 * Renders one slot per edge (left / right / top / bottom). Each slot is
 * independent: workspace can sit on the left while the coordinator sits on
 * the right, with their own visibility, size, and active panel.
 *
 * Other plugins register panels via registerPanel() in their renderer index.ts.
 *
 * IMPORTANT: The DockGrid wrapper (`.dock-panel-grid-area`) is always rendered
 * in the same DOM position regardless of which slots are visible — switching
 * Fragment <-> div would unmount the grid and kill all xterm instances.
 */
import React, { useCallback, useEffect, useState, Suspense } from 'react'
import { usePanelStore, PANEL_POSITIONS, type PanelPosition } from '../stores/panel-store'
import { getPanel, type PanelRegistration } from '../panel-registry'
import { useDockStore } from '../stores/dock-store'
import { useEditorStore } from '../stores/editor-store'

const EditorOverlay = React.lazy(() => import('./EditorOverlay'))

const isHorizontalEdge = (pos: PanelPosition): boolean => pos === 'left' || pos === 'right'

interface SlotViewProps {
  position: PanelPosition
  visible: boolean
  registration: PanelRegistration
  projectDir: string
  effectiveSize: number
  onHeaderDragStart: (e: React.DragEvent, panelId: string) => void
  onHeaderDragEnd: () => void
}

const SlotView: React.FC<SlotViewProps> = ({
  position, visible, registration, projectDir, effectiveSize,
  onHeaderDragStart, onHeaderDragEnd
}) => {
  const PanelComponent = registration.component
  const horizontal = isHorizontalEdge(position)
  const panelStyle: React.CSSProperties = horizontal
    ? { width: effectiveSize, minWidth: registration.minSize ?? 150, flexShrink: 0 }
    : { height: effectiveSize, minHeight: registration.minSize ?? 150, flexShrink: 0 }

  return (
    <div
      className={`dock-panel-area dock-panel-area-${position}`}
      style={{ ...panelStyle, display: visible ? undefined : 'none' }}
    >
      <div
        className="dock-panel-header"
        draggable
        onDragStart={(e) => onHeaderDragStart(e, registration.id)}
        onDragEnd={onHeaderDragEnd}
        title="Drag to move panel to a different edge"
      >
        <span className="dock-panel-title">{registration.title}</span>
        {registration.headerActions && (
          <Suspense fallback={null}>
            {React.createElement(registration.headerActions, { projectDir })}
          </Suspense>
        )}
        <span className="dock-panel-drag-hint">&#8942;&#8942;</span>
      </div>
      <div className="dock-panel-body">
        <Suspense fallback={<div className="dock-panel-loading">Loading...</div>}>
          <PanelComponent projectDir={projectDir} />
        </Suspense>
      </div>
    </div>
  )
}

export const DockPanelLayout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const slots = usePanelStore((s) => s.slots)
  const setSizeAt = usePanelStore((s) => s.setSizeAt)
  const setPanelPosition = usePanelStore((s) => s.setPanelPosition)
  const projectDir = useDockStore((s) => s.projectDir)
  const loadFromStorage = usePanelStore((s) => s.loadFromStorage)

  // Local drag size — avoids writing to store on every pixel of drag.
  const [dragSize, setDragSize] = useState<{ position: PanelPosition; size: number } | null>(null)

  // Track which slots have ever been shown — controls deferred mount of heavy
  // panel components.
  const [mounted, setMounted] = useState<Record<PanelPosition, boolean>>(() => ({
    left: slots.left.visible,
    right: slots.right.visible,
    top: slots.top.visible,
    bottom: slots.bottom.visible
  }))
  useEffect(() => {
    setMounted((prev) => {
      let changed = false
      const next = { ...prev }
      for (const pos of PANEL_POSITIONS) {
        if (slots[pos].visible && !prev[pos]) { next[pos] = true; changed = true }
      }
      return changed ? next : prev
    })
  }, [slots])

  // Load persisted panel state when project dir changes.
  useEffect(() => {
    if (projectDir) loadFromStorage(projectDir)
  }, [projectDir, loadFromStorage])

  // Resize handler — uses local state during drag, commits to store on mouseup.
  const handleResizeStart = useCallback((e: React.MouseEvent, position: PanelPosition) => {
    e.preventDefault()
    const startX = e.clientX
    const startY = e.clientY
    const slot = slots[position]
    const startSize = slot.size
    const registration = slot.activePanelId ? getPanel(slot.activePanelId) : null
    const minSize = registration?.minSize ?? 150
    const maxSize = registration?.maxSize ?? 600
    const horizontal = isHorizontalEdge(position)
    const zoom = parseFloat(document.documentElement.style.zoom) || 1

    const onMove = (ev: MouseEvent) => {
      const delta = horizontal
        ? (position === 'left' ? ev.clientX - startX : startX - ev.clientX) / zoom
        : (position === 'top' ? ev.clientY - startY : startY - ev.clientY) / zoom
      setDragSize({ position, size: Math.round(Math.min(maxSize, Math.max(minSize, startSize + delta))) })
    }

    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      setDragSize((final) => {
        if (final != null) setSizeAt(final.position, final.size)
        return null
      })
      window.dispatchEvent(new Event('resize'))
    }

    document.body.style.cursor = horizontal ? 'col-resize' : 'row-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [slots, setSizeAt])

  // Refit terminals when any slot's visibility or position layout changes.
  const visibilitySignature = `${slots.left.visible}|${slots.right.visible}|${slots.top.visible}|${slots.bottom.visible}|${slots.left.activePanelId}|${slots.right.activePanelId}|${slots.top.activePanelId}|${slots.bottom.activePanelId}`
  useEffect(() => {
    const timer = setTimeout(() => window.dispatchEvent(new Event('resize')), 50)
    return () => clearTimeout(timer)
  }, [visibilitySignature])

  const hasEditorTabs = useEditorStore((s) => s.tabs.length > 0)

  // Drag-drop state for moving a panel between edges.
  const [draggingPanelId, setDraggingPanelId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<PanelPosition | null>(null)

  const handleHeaderDragStart = useCallback((e: React.DragEvent, panelId: string) => {
    e.dataTransfer.setData('application/x-dock-panel', panelId)
    e.dataTransfer.effectAllowed = 'move'
    setDraggingPanelId(panelId)
  }, [])

  const handleHeaderDragEnd = useCallback(() => {
    setDraggingPanelId(null)
    setDropTarget(null)
  }, [])

  const makeDropZoneHandlers = useCallback((edge: PanelPosition) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes('application/x-dock-panel')) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      setDropTarget(edge)
    },
    onDragLeave: () => setDropTarget((prev) => prev === edge ? null : prev),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      const panelId = e.dataTransfer.getData('application/x-dock-panel') || draggingPanelId
      setDraggingPanelId(null)
      setDropTarget(null)
      if (panelId) {
        setPanelPosition(panelId, edge)
        setTimeout(() => window.dispatchEvent(new Event('resize')), 50)
      }
    }
  }), [draggingPanelId, setPanelPosition])

  // Build slot views — one per edge, each with its own resize handle.
  const renderSlot = (position: PanelPosition): { panel: React.ReactNode; resize: React.ReactNode } => {
    const slot = slots[position]
    const registration = slot.activePanelId ? getPanel(slot.activePanelId) : null
    if (!registration || !mounted[position]) return { panel: null, resize: null }
    const effectiveSize = dragSize?.position === position ? dragSize.size : slot.size
    const visible = slot.visible
    const horizontal = isHorizontalEdge(position)
    return {
      panel: (
        <SlotView
          key={position}
          position={position}
          visible={visible}
          registration={registration}
          projectDir={projectDir}
          effectiveSize={effectiveSize}
          onHeaderDragStart={handleHeaderDragStart}
          onHeaderDragEnd={handleHeaderDragEnd}
        />
      ),
      resize: visible ? (
        <div
          className={`dock-panel-resize ${horizontal ? 'dock-panel-resize-col' : 'dock-panel-resize-row'}`}
          onMouseDown={(e) => handleResizeStart(e, position)}
        />
      ) : null
    }
  }

  const left = renderSlot('left')
  const right = renderSlot('right')
  const top = renderSlot('top')
  const bottom = renderSlot('bottom')

  return (
    <div className="dock-panel-layout">
      {top.panel}
      {top.resize}
      <div className="dock-panel-layout-middle">
        {left.panel}
        {left.resize}
        <div className="dock-panel-grid-area" style={{ position: 'relative' }}>
          {children}
          {hasEditorTabs && (
            <Suspense fallback={<div className="editor-overlay-loading">Loading editor...</div>}>
              <EditorOverlay />
            </Suspense>
          )}
          {draggingPanelId && (
            <>
              <div className={`dock-panel-dropzone dock-panel-dropzone-left${dropTarget === 'left' ? ' dock-panel-dropzone-active' : ''}`} {...makeDropZoneHandlers('left')} />
              <div className={`dock-panel-dropzone dock-panel-dropzone-right${dropTarget === 'right' ? ' dock-panel-dropzone-active' : ''}`} {...makeDropZoneHandlers('right')} />
              <div className={`dock-panel-dropzone dock-panel-dropzone-top${dropTarget === 'top' ? ' dock-panel-dropzone-active' : ''}`} {...makeDropZoneHandlers('top')} />
              <div className={`dock-panel-dropzone dock-panel-dropzone-bottom${dropTarget === 'bottom' ? ' dock-panel-dropzone-active' : ''}`} {...makeDropZoneHandlers('bottom')} />
            </>
          )}
        </div>
        {right.resize}
        {right.panel}
      </div>
      {bottom.resize}
      {bottom.panel}
    </div>
  )
}
