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

interface ShellAreaProps {
  terminalId: string
  defaultHeight: number
  initialCommand?: string | null
  onAllClosed: () => void
}

const ShellArea: React.FC<ShellAreaProps> = ({ terminalId, defaultHeight, initialCommand, onAllClosed }) => {
  const nextIdRef = useRef(1)
  const areaRef = useRef<HTMLDivElement>(null)
  const preferredShell = useSettingsStore((s) => s.settings.shellPanel?.preferredShell ?? 'default')

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

  return (
    <div className="shell-area" ref={areaRef} style={{ height: areaHeight }}>
      <div className="shell-area-handle" onMouseDown={handleDragStart}>
        <div className="shell-area-grip" />
      </div>
      <div className="shell-area-body">
        <Suspense fallback={null}>
          {columns.map((col, ci) => (
            <React.Fragment key={col.id}>
              {ci > 0 && <div className="shell-column-divider" />}
              <div className="shell-column">
                {col.shells.map((shell, si) => (
                  <ShellPanel
                    key={shell.id}
                    shellId={shell.shellId}
                    terminalId={terminalId}
                    onClose={() => removeShell(col.id, shell.id)}
                    onSplitRight={canAdd ? () => addShellRight(col.id) : undefined}
                    onStackBelow={canAdd ? () => addShellBelow(col.id) : undefined}
                    initialCommand={si === 0 && ci === 0 ? initialCommand : undefined}
                    label={totalShells > 1 ? `Shell ${shell.id}` : undefined}
                  />
                ))}
              </div>
            </React.Fragment>
          ))}
        </Suspense>
      </div>
    </div>
  )
}

export default React.memo(ShellArea)
