import type { Layout } from 'react-grid-layout'

export type Direction = 'up' | 'down' | 'left' | 'right'

/** Check if a layout item covers a given grid position */
function coversPosition(l: Layout, x: number, y: number): boolean {
  return x >= l.x && x < l.x + l.w && y >= l.y && y < l.y + l.h
}

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
      targetY = current.y + current.h
      break
    case 'left':
      targetX--
      break
    case 'right':
      targetX = current.x + current.w
      break
  }

  // Find terminal covering the target position
  const exact = layout.find((l) => l.i !== currentId && coversPosition(l, targetX, targetY))
  if (exact) return exact.i

  // For vertical navigation, find closest terminal covering the target row
  if (direction === 'up' || direction === 'down') {
    const inTargetRow = layout.filter(
      (l) => l.i !== currentId && targetY >= l.y && targetY < l.y + l.h
    )
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

  // Determine if the last row has empty cells that can be filled by spanning
  const lastRowCount = n % cols || cols
  const hasEmptyCells = lastRowCount < cols && rows > 1

  const layout: Layout[] = terminalIds.map((id, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)

    // Terminal in the row above an empty last-row cell spans down to fill it
    const spansDown = hasEmptyCells && row === rows - 2 && col >= lastRowCount

    return {
      i: id,
      x: col,
      y: row,
      w: 1,
      h: spansDown ? 2 : 1,
      static: true // no drag in auto mode
    }
  })

  return { cols, layout }
}

/** Portrait layout: single column, all terminals stacked vertically */
export function computePortraitLayout(
  terminalIds: string[]
): { cols: number; layout: Layout[] } {
  const layout: Layout[] = terminalIds.map((id, i) => ({
    i: id,
    x: 0,
    y: i,
    w: 1,
    h: 1,
    static: true
  }))
  return { cols: 1, layout }
}
