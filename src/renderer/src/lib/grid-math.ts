import type { Layout } from 'react-grid-layout'

export type Direction = 'up' | 'down' | 'left' | 'right'

/** Sentinel returned when navigating up past the top row */
export const TOOLBAR_FOCUS_ID = '__toolbar__'

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
    if (inTargetRow.length === 0) {
      // No terminal in the target row — navigating up past the top goes to toolbar
      if (direction === 'up' && targetY < 0) return TOOLBAR_FOCUS_ID
      return null
    }
    inTargetRow.sort((a, b) => Math.abs(a.x - current.x) - Math.abs(b.x - current.x))
    return inTargetRow[0].i
  }

  return null
}

/**
 * Find the terminal to focus when navigating down from the toolbar.
 * Returns the leftmost terminal in the top row (row 0).
 */
export function findTerminalFromToolbar(layout: Layout[]): string | null {
  if (layout.length === 0) return null
  const topRow = layout.filter((l) => l.y === 0)
  if (topRow.length === 0) return layout[0].i
  topRow.sort((a, b) => a.x - b.x)
  return topRow[0].i
}

/** Resolution multiplier — each logical column/row maps to this many grid units,
 *  allowing fractional sizing via integer sub-units. */
export const GRID_RESOLUTION = 120

export function computeAutoLayout(
  terminalIds: string[],
  maxCols: number,
  columnRatios?: number[]
): { cols: number; logicalCols: number; layout: Layout[] } {
  const n = terminalIds.length
  if (n === 0) return { cols: maxCols * GRID_RESOLUTION, logicalCols: maxCols, layout: [] }

  const logicalCols = Math.min(Math.ceil(Math.sqrt(n)), maxCols)
  const rows = Math.ceil(n / logicalCols)

  // Determine if the last row has empty cells that can be filled by spanning
  const lastRowCount = n % logicalCols || logicalCols
  const hasEmptyCells = lastRowCount < logicalCols && rows > 1

  // Compute sub-column widths from ratios (default: equal)
  const ratios = columnRatios && columnRatios.length === logicalCols ? columnRatios : Array(logicalCols).fill(1)
  const ratioSum = ratios.reduce((a, b) => a + b, 0)
  const totalSubCols = logicalCols * GRID_RESOLUTION
  const subWidths = ratios.map(r => Math.round((r / ratioSum) * totalSubCols))
  // Fix rounding so widths sum exactly to totalSubCols
  const diff = totalSubCols - subWidths.reduce((a, b) => a + b, 0)
  if (diff !== 0) subWidths[subWidths.length - 1] += diff

  const subXs: number[] = []
  let cumX = 0
  for (const w of subWidths) { subXs.push(cumX); cumX += w }

  const layout: Layout[] = terminalIds.map((id, i) => {
    const col = i % logicalCols
    const row = Math.floor(i / logicalCols)

    // Terminal in the row above an empty last-row cell spans down to fill it
    const spansDown = hasEmptyCells && row === rows - 2 && col >= lastRowCount

    return {
      i: id,
      x: subXs[col],
      y: row,
      w: subWidths[col],
      h: spansDown ? 2 : 1,
      static: true // no drag in auto mode
    }
  })

  return { cols: totalSubCols, logicalCols, layout }
}

/** Portrait layout: single column, all terminals stacked vertically.
 *  Uses GRID_RESOLUTION sub-rows for proportional height sizing. */
export function computePortraitLayout(
  terminalIds: string[],
  rowRatios?: number[]
): { cols: number; logicalCols: number; layout: Layout[] } {
  const n = terminalIds.length
  const ratios = rowRatios && rowRatios.length === n ? rowRatios : Array(n).fill(1)
  const ratioSum = ratios.reduce((a, b) => a + b, 0) || 1
  const totalSubRows = n * GRID_RESOLUTION
  const subHeights = ratios.map(r => Math.max(1, Math.round((r / ratioSum) * totalSubRows)))
  const hDiff = totalSubRows - subHeights.reduce((a, b) => a + b, 0)
  if (hDiff !== 0 && subHeights.length > 0) subHeights[subHeights.length - 1] += hDiff

  let cumY = 0
  const layout: Layout[] = terminalIds.map((id, i) => {
    const y = cumY
    cumY += subHeights[i]
    return { i: id, x: 0, y, w: GRID_RESOLUTION, h: subHeights[i], static: true }
  })
  return { cols: GRID_RESOLUTION, logicalCols: 1, layout }
}
