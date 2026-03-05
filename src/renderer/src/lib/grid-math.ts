import type { Layout } from 'react-grid-layout'

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
