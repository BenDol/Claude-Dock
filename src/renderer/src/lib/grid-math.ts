import type { Layout } from 'react-grid-layout'

export type Direction = 'up' | 'down' | 'left' | 'right'

/**
 * Find the terminal adjacent to the current one in the given direction.
 * Falls back to the closest terminal in the target row/column if no exact match.
 */
export function findAdjacentTerminal(
  layout: Layout[],
  currentId: string,
  direction: Direction
): string | null {
  const current = layout.find((l) => l.i === currentId)
  if (!current) return null

  let targetX = current.x
  let targetY = current.y

  switch (direction) {
    case 'up':
      targetY--
      break
    case 'down':
      targetY++
      break
    case 'left':
      targetX--
      break
    case 'right':
      targetX++
      break
  }

  // Exact position match
  const exact = layout.find((l) => l.x === targetX && l.y === targetY)
  if (exact) return exact.i

  // For vertical navigation, find closest terminal in target row
  if (direction === 'up' || direction === 'down') {
    const inTargetRow = layout.filter((l) => l.y === targetY)
    if (inTargetRow.length === 0) return null
    inTargetRow.sort((a, b) => Math.abs(a.x - current.x) - Math.abs(b.x - current.x))
    return inTargetRow[0].i
  }

  return null
}

export function computeAutoLayout(
  terminalIds: string[],
  maxCols: number
): { cols: number; layout: Layout[] } {
  const n = terminalIds.length
  if (n === 0) return { cols: maxCols, layout: [] }

  const cols = Math.min(Math.ceil(Math.sqrt(n)), maxCols)
  const rows = Math.ceil(n / cols)

  const layout: Layout[] = terminalIds.map((id, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    // Last row items may need to fill remaining space
    const isLastRow = row === rows - 1
    const itemsInLastRow = n - (rows - 1) * cols
    const w = isLastRow ? Math.floor(cols / itemsInLastRow) : 1
    // Actually, keep it simple: equal width for all
    return {
      i: id,
      x: col,
      y: row,
      w: 1,
      h: 1,
      static: true // no drag in auto mode
    }
  })

  return { cols, layout }
}
