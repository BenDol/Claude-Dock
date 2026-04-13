import React, { useCallback, useRef, useState, useEffect, lazy, Suspense } from 'react'
import { useSettingsStore } from '../stores/settings-store'

const ShellPanel = lazy(() => import('./ShellPanel'))

const MIN_HEIGHT = 80
const MAX_RATIO = 0.8
const MAX_SHELLS = 6

interface ShellInstance {
  id: string
  shellId: string
}

interface ShellColumn {
  id: string
  shells: ShellInstance[]
}

interface NewShellCommand {
  command: string
  submit?: boolean
  shellType?: string | null
  /** 'split' = new column to the right, 'stack' = below in same column. Default: 'stack' */
  layout?: 'split' | 'stack' | null
}

interface ShellAreaProps {
  terminalId: string
  defaultHeight: number
  initialCommand?: string | null
  submitCommand?: boolean
  shellType?: string | null
  /** When set, creates a new shell panel and runs the command in it. Reset after consumed. */
  newShellCommand?: NewShellCommand | null
  onNewShellConsumed?: () => void
  onAllClosed: () => void
}

const ShellArea: React.FC<ShellAreaProps> = ({ terminalId, defaultHeight, initialCommand, submitCommand = true, shellType, newShellCommand, onNewShellConsumed, onAllClosed }) => {
  const nextIdRef = useRef(1)
  const areaRef = useRef<HTMLDivElement>(null)
  const preferredShell = useSettingsStore((s) => s.settings.shellPanel?.preferredShell ?? 'default')
  // Per-column flex ratios (for split/horizontal resize)
  const [columnRatios, setColumnRatios] = useState<Map<string, number>>(new Map())
  // Per-panel flex ratios within columns (for stack/vertical resize)
  const [panelRatios, setPanelRatios] = useState<Map<string, number>>(new Map())
  // Minimized shells — stored as shellId set
  const [minimizedShells, setMinimizedShells] = useState<Set<string>>(new Set())

  const toggleMinimize = useCallback((shellId: string) => {
    setMinimizedShells(prev => {
      const next = new Set(prev)
      if (next.has(shellId)) next.delete(shellId)
      else next.add(shellId)
      return next
    })
    setTimeout(() => window.dispatchEvent(new Event('shell-layout-changed')), 50)
  }, [])

  const makeShell = useCallback((): ShellInstance => {
    const id = String(nextIdRef.current++)
    return { id, shellId: `shell:${terminalId}:${id}` }
  }, [terminalId])

  // First shell always gets id "0" for predictable pending command routing
  const [columns, setColumns] = useState<ShellColumn[]>(() => [
    { id: 'col-0', shells: [{ id: '0', shellId: `shell:${terminalId}:0` }] }
  ])
  const [areaHeight, setAreaHeight] = useState(defaultHeight)

  const totalShells = columns.reduce((sum, col) => sum + col.shells.length, 0)
  const canAdd = totalShells < MAX_SHELLS

  const addShellBelow = useCallback((columnId: string) => {
    if (!canAdd) return
    const shell = makeShell()
    setColumns(prev => prev.map(col =>
      col.id === columnId ? { ...col, shells: [...col.shells, shell] } : col
    ))
  }, [canAdd, makeShell])

  const addShellRight = useCallback((columnId: string) => {
    if (!canAdd) return
    const shell = makeShell()
    const newCol: ShellColumn = { id: `col-${nextIdRef.current}`, shells: [shell] }
    setColumns(prev => {
      const idx = prev.findIndex(c => c.id === columnId)
      const next = [...prev]
      next.splice(idx + 1, 0, newCol)
      return next
    })
  }, [canAdd, makeShell])

  /** Move a shell to its own column (split right) */
  const moveToSplit = useCallback((fromColumnId: string, shellInstanceId: string) => {
    setColumns(prev => {
      const col = prev.find(c => c.id === fromColumnId)
      const shell = col?.shells.find(s => s.id === shellInstanceId)
      if (!col || !shell || col.shells.length < 2) return prev // can't split if only 1 shell in column

      // Remove from current column
      const updated = prev.map(c =>
        c.id === fromColumnId ? { ...c, shells: c.shells.filter(s => s.id !== shellInstanceId) } : c
      )
      // Insert new column after the source
      const idx = updated.findIndex(c => c.id === fromColumnId)
      const newCol: ShellColumn = { id: `col-${Date.now()}`, shells: [shell] }
      updated.splice(idx + 1, 0, newCol)
      return updated
    })
  }, [])

  /** Move a shell into an adjacent column (merge/stack) */
  const moveToStack = useCallback((fromColumnId: string, shellInstanceId: string) => {
    setColumns(prev => {
      if (prev.length < 2) return prev // can't stack if only 1 column
      const colIdx = prev.findIndex(c => c.id === fromColumnId)
      const col = prev[colIdx]
      const shell = col?.shells.find(s => s.id === shellInstanceId)
      if (!col || !shell) return prev

      // Find target: prefer left neighbor, fallback to right
      const targetIdx = colIdx > 0 ? colIdx - 1 : colIdx + 1
      if (targetIdx < 0 || targetIdx >= prev.length) return prev

      // Remove from source, add to target
      const updated = prev.map((c, i) => {
        if (i === targetIdx) return { ...c, shells: [...c.shells, shell] }
        if (c.id === fromColumnId) return { ...c, shells: c.shells.filter(s => s.id !== shellInstanceId) }
        return c
      }).filter(c => c.shells.length > 0)
      return updated
    })
  }, [])

  const removeShell = useCallback((columnId: string, shellId: string) => {
    setColumns(prev => {
      const updated = prev.map(col => {
        if (col.id !== columnId) return col
        return { ...col, shells: col.shells.filter(s => s.id !== shellId) }
      }).filter(col => col.shells.length > 0)

      if (updated.length === 0) {
        // Use setTimeout to avoid updating parent during render
        setTimeout(() => onAllClosed(), 0)
        return prev // return current to avoid flash
      }
      return updated
    })
  }, [onAllClosed])

  // When a new shell command is requested, create a new shell panel with the command
  const [pendingNewShell, setPendingNewShell] = useState<NewShellCommand | null>(null)
  useEffect(() => {
    if (!newShellCommand || !canAdd) return
    const shell = makeShell()
    setPendingNewShell({ ...newShellCommand, _shellId: shell.shellId } as any)
    const useSplit = newShellCommand.layout !== 'stack'
    setColumns(prev => {
      if (useSplit) {
        // New column to the right of the last column
        const newCol: ShellColumn = { id: `col-${nextIdRef.current}`, shells: [shell] }
        return [...prev, newCol]
      } else {
        // Stack below in the last column (default)
        const lastCol = prev[prev.length - 1]
        return prev.map(col =>
          col.id === lastCol.id ? { ...col, shells: [...col.shells, shell] } : col
        )
      }
    })
    onNewShellConsumed?.()
  }, [newShellCommand])

  // Re-fit all shells after layout changes
  useEffect(() => {
    const timer = setTimeout(() => {
      window.dispatchEvent(new Event('shell-layout-changed'))
    }, 50)
    return () => clearTimeout(timer)
  }, [columns])

  // Drag-to-resize the entire shell area
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startHeight = areaHeight
    const splitContainer = areaRef.current?.closest('.terminal-card-split') as HTMLElement | null
    const maxHeight = splitContainer ? splitContainer.clientHeight * MAX_RATIO : 600

    const onMove = (ev: MouseEvent) => {
      const delta = startY - ev.clientY
      setAreaHeight(Math.round(Math.min(maxHeight, Math.max(MIN_HEIGHT, startHeight + delta))))
    }

    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.dispatchEvent(new Event('shell-layout-changed'))
    }

    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [areaHeight])

  // Drag-to-resize between shell columns (horizontal)
  const handleColumnResize = useCallback((leftColId: string, rightColId: string, e: React.MouseEvent) => {
    e.preventDefault()
    let lastX = e.clientX
    const bodyEl = areaRef.current?.querySelector('.shell-area-body') as HTMLElement
    if (!bodyEl) return
    const totalWidth = bodyEl.clientWidth

    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - lastX
      lastX = ev.clientX
      setColumnRatios(prev => {
        const next = new Map(prev)
        const leftR = next.get(leftColId) ?? 1
        const rightR = next.get(rightColId) ?? 1
        const sumR = leftR + rightR
        const deltaR = (delta / totalWidth) * sumR
        next.set(leftColId, Math.max(0.15, leftR + deltaR))
        next.set(rightColId, Math.max(0.15, rightR - deltaR))
        return next
      })
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.dispatchEvent(new Event('shell-layout-changed'))
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [])

  // Drag-to-resize between stacked panels in a column (vertical)
  const handlePanelResize = useCallback((topShellId: string, bottomShellId: string, e: React.MouseEvent) => {
    e.preventDefault()
    let lastY = e.clientY
    const colEl = (e.target as HTMLElement).closest('.shell-column') as HTMLElement
    if (!colEl) return
    const totalHeight = colEl.clientHeight

    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientY - lastY
      lastY = ev.clientY
      setPanelRatios(prev => {
        const next = new Map(prev)
        const topR = next.get(topShellId) ?? 1
        const bottomR = next.get(bottomShellId) ?? 1
        const sumR = topR + bottomR
        const deltaR = (delta / totalHeight) * sumR
        next.set(topShellId, Math.max(0.15, topR + deltaR))
        next.set(bottomShellId, Math.max(0.15, bottomR - deltaR))
        return next
      })
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.dispatchEvent(new Event('shell-layout-changed'))
    }
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [])

  const allMinimized = columns.every(col => col.shells.every(s => minimizedShells.has(s.shellId)))

  return (
    <div className="shell-area" ref={areaRef} style={{ height: allMinimized ? 'auto' : areaHeight }}>
      <div className="shell-area-handle" onMouseDown={handleDragStart}>
        <div className="shell-area-grip" />
      </div>
      <div className="shell-area-body">
        <Suspense fallback={null}>
          {columns.map((col, ci) => (
            <React.Fragment key={col.id}>
              {ci > 0 && (
                <div
                  className="shell-column-divider"
                  onMouseDown={(e) => handleColumnResize(columns[ci - 1].id, col.id, e)}
                />
              )}
              <div className="shell-column" style={{
                flex: col.shells.every(s => minimizedShells.has(s.shellId))
                  ? '0 0 auto'
                  : (columnRatios.get(col.id) ?? 1)
              }}>
                {col.shells.map((shell, si) => {
                  const isFirstShell = si === 0 && ci === 0
                  const newCmd = pendingNewShell && (pendingNewShell as any)._shellId === shell.shellId ? pendingNewShell : null
                  return (
                    <React.Fragment key={shell.id}>
                      {si > 0 && (
                        <div
                          className="shell-panel-divider"
                          onMouseDown={(e) => handlePanelResize(col.shells[si - 1].shellId, shell.shellId, e)}
                        />
                      )}
                      <ShellPanel
                        shellId={shell.shellId}
                        terminalId={terminalId}
                        onClose={() => removeShell(col.id, shell.id)}
                        onSplitRight={canAdd ? () => addShellRight(col.id) : undefined}
                        onStackBelow={canAdd ? () => addShellBelow(col.id) : undefined}
                        onMoveToSplit={col.shells.length > 1 ? () => moveToSplit(col.id, shell.id) : undefined}
                        onMoveToStack={columns.length > 1 && col.shells.length === 1 ? () => moveToStack(col.id, shell.id) : undefined}
                        initialCommand={newCmd ? newCmd.command : (isFirstShell ? initialCommand : undefined)}
                        submitCommand={newCmd ? newCmd.submit : (isFirstShell ? submitCommand : undefined)}
                        shellType={newCmd ? newCmd.shellType : (isFirstShell ? shellType : undefined)}
                        label={totalShells > 1 ? `Shell ${shell.id}` : undefined}
                        flexRatio={minimizedShells.has(shell.shellId) ? undefined : panelRatios.get(shell.shellId)}
                        minimized={minimizedShells.has(shell.shellId)}
                        onToggleMinimize={() => toggleMinimize(shell.shellId)}
                        isInColumn={col.shells.length > 1}
                      />
                    </React.Fragment>
                  )
                })}
              </div>
            </React.Fragment>
          ))}
        </Suspense>
      </div>
    </div>
  )
}

export default React.memo(ShellArea)
