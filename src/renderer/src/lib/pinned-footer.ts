/**
 * Pinned footer — mirrors the live bottom rows of an xterm.js buffer so that
 * Claude Code's input box stays visible while the user has scrolled up to read
 * history.
 *
 * We build a DOM mirror (one <div> per row, styled <span> runs per cell) rather
 * than sampling pixels from xterm's canvas, because xterm repaints its canvas
 * to show whatever is under the scrolled viewport — not the live bottom rows.
 * Reading directly from `term.buffer.active` is the only way to reflect the
 * live state while the user is scrolled up.
 */
import type { IBufferCell, IBufferLine, Terminal } from '@xterm/xterm'
import type { TerminalColors } from '../../../shared/settings-schema'

const H_RULE = '\u2500' // ─ — Claude Code's input-box border character

export interface PinnedFooterRender {
  rowCount: number
  cursorCol: number | null // column index within pinned rows, or null if cursor is outside
  cursorRow: number | null // row offset within pinned rows, or null if cursor is outside
}

/**
 * Scan the bottom of the live buffer for Claude Code's input box and the
 * "live context" block that sits directly above it — the thinking/status line
 * and the todo list. Returns how many bottom rows to pin, or 0 if no input
 * box was detected.
 *
 * Two phases:
 *   1. Find the topmost ─ border in the bottom `maxScan` rows (the input-box
 *      top border).
 *   2. Walk upward past that border, including contiguous non-blank rows,
 *      until we hit a blank row or the extra-context cap. This captures the
 *      thinking status + todo list which render flush against the input box.
 */
export function detectInputBoxRows(
  term: Terminal,
  maxScan = 24,
  maxContextAbove = 20
): number {
  const buf = term.buffer.active
  const rows = term.rows
  const baseY = buf.baseY
  const scan = Math.min(maxScan, rows)

  // Phase 1: walk from the bottom upward, remembering the highest border.
  let topBorderOffset = -1
  for (let off = 0; off < scan; off++) {
    const y = baseY + rows - 1 - off
    if (y < 0) break
    const line = buf.getLine(y)
    if (!line) continue
    if (isBorderRow(line.translateToString(true))) {
      topBorderOffset = off
    }
  }
  if (topBorderOffset < 0) return 0

  // Phase 2: only extend the pinned region upward when Claude Code is actively
  // running — the ONLY reliable signal is a spinner status line whose first
  // word ends in `…` (e.g. `· Deliberating…`, `* Quantumizing…`). A todo
  // checkbox alone isn't sufficient: `ctrl+t` persistently displays the task
  // list even when Claude is idle, so todos would trigger false positives.
  //
  // When an anchor row is found, we include everything from that row down to
  // the border (blanks are padding between thinking narration and status line).
  // We then walk further upward through live-context continuation rows —
  // glyph-led headers (`● Thinking`), indented sub-bullets (`  L …`), and
  // single-blank gaps — capturing the whole thinking block. Stop at prose, a
  // user prompt (`>`), or two consecutive blanks.
  let anchorOffset = -1
  for (let i = 1; i <= maxContextAbove; i++) {
    const off = topBorderOffset + i
    const y = baseY + rows - 1 - off
    if (y < 0) break
    const line = buf.getLine(y)
    if (!line) break
    const text = line.translateToString(true)
    // Boundary: a user-prompt row or column-0 prose line marks the end of the
    // current turn — anything above belongs to prior history and must never
    // be captured, even if there's a stale spinner further up in scrollback.
    if (isUserPromptRow(text)) break
    if (text.length > 0 && /[A-Za-z0-9]/.test(text[0])) break
    if (isSpinnerRow(text)) anchorOffset = i
  }
  if (anchorOffset < 0) return clampFooterRows(topBorderOffset + 1, rows)

  // Walk from just-above-border up to the anchor, tracking the *last* row that
  // actually contains content. This is the fix for the "footer stays tall after
  // ctrl+t hides the tasks" bug: if the task rows between border and spinner
  // went blank, `extra` stops at the bottom-most non-blank row instead of
  // including all the collapsed empty space.
  let extra = 0
  let consecBlanks = 0
  for (let i = 1; i <= anchorOffset; i++) {
    const off = topBorderOffset + i
    const y = baseY + rows - 1 - off
    if (y < 0) break
    const line = buf.getLine(y)
    if (!line) break
    const text = line.translateToString(true)
    if (isBlankRow(text)) {
      consecBlanks++
      if (consecBlanks >= 3) break
      continue
    }
    consecBlanks = 0
    extra = i
  }

  // Walk further upward from the anchor through live-context continuation rows
  // (`● Thinking` headers, indented sub-bullets, etc). Stop at prose, a `>`
  // user prompt, or two consecutive blanks.
  consecBlanks = 0
  for (let i = anchorOffset + 1; i <= maxContextAbove; i++) {
    const off = topBorderOffset + i
    const y = baseY + rows - 1 - off
    if (y < 0) break
    const line = buf.getLine(y)
    if (!line) break
    const text = line.translateToString(true)
    if (isBlankRow(text)) {
      consecBlanks++
      if (consecBlanks >= 2) break
      extra = i
      continue
    }
    consecBlanks = 0
    if (!isLiveContextContinuation(text)) break
    extra = i
  }

  return clampFooterRows(topBorderOffset + 1 + extra, rows)
}

/** Cap the pinned region at 50% of the terminal viewport so it can never hide
 *  most of the user's scrollback. Also bounded to a minimum of 1 row. */
function clampFooterRows(rowCount: number, termRows: number): number {
  const maxRows = Math.max(1, Math.floor(termRows / 2))
  return Math.min(rowCount, maxRows)
}

function isBlankRow(s: string): boolean {
  return s.trim().length === 0
}

/**
 * Claude Code's spinner status line: a single non-alphanumeric glyph
 * (`·`, `✦`, `✶`, `∗`, `*`, `+`, `×`) followed by a space and a gerund ending
 * in `…`. Example: `· Deliberating…`, `* Quantumizing… (thinking with xhigh
 * effort)`.
 *
 * Must require the gerund word immediately after the leading glyph — NOT just
 * any `…` in the line. Otherwise `… +93 pending` (the "and N more" indicator
 * Claude appends under a task list) matches as a false-positive spinner.
 */
const SPINNER_PATTERN = /^.\s[A-Za-z]+…/
function isSpinnerRow(s: string): boolean {
  const trimmed = s.replace(/^\s+/, '')
  if (trimmed.length < 3) return false
  const first = trimmed[0]
  // Leading glyph must be non-alnum AND not `…` itself (rules out the
  // `… +N pending` false-positive).
  if (/[\sA-Za-z0-9]/.test(first)) return false
  if (first === '\u2026') return false
  return SPINNER_PATTERN.test(trimmed)
}

/**
 * Rows that sit within a live-tasks block alongside a spinner anchor —
 * the `● Thinking` header, indented sub-bullets, blank padding. Anything
 * starting with a letter or a user-prompt chevron is treated as a boundary
 * and terminates the walk.
 */
function isLiveContextContinuation(s: string): boolean {
  if (isBlankRow(s)) return true
  if (isUserPromptRow(s)) return false
  const first = s[0]
  if (first === ' ' || first === '\t') return true
  if (/[A-Za-z0-9]/.test(first)) return false
  return true
}

/**
 * User-prompt row: the chevron Claude Code renders at column 0 for the
 * user's input. Matches ASCII `>` plus the common Unicode variants
 * (`›` U+203A, `❯` U+276F, `▸`, `▶`, `→`) — the exact glyph varies by
 * Claude Code version and font fallback, so we accept all of them.
 */
const USER_PROMPT_CHEVRONS = /^[>\u203A\u276F\u25B8\u25B6\u2192]\s/
function isUserPromptRow(s: string): boolean {
  return USER_PROMPT_CHEVRONS.test(s)
}

/** A row is a border if it contains a long run of ─ or a high density of them. */
function isBorderRow(s: string): boolean {
  const trimmed = s.replace(/\s+$/, '')
  if (trimmed.length < 10) return false
  let ruleCount = 0
  for (const ch of trimmed) if (ch === H_RULE) ruleCount++
  if (ruleCount >= 20) return true
  return ruleCount >= 10 && ruleCount / trimmed.length >= 0.4
}

/**
 * Render `rowCount` bottom rows of the live buffer into `target`. Returns the
 * cursor position (if within the pinned region) so callers can render a cursor
 * element at the correct location.
 */
export function renderPinnedRows(
  term: Terminal,
  rowCount: number,
  theme: TerminalColors,
  target: HTMLElement
): PinnedFooterRender {
  const buf = term.buffer.active
  const rows = term.rows
  const cols = term.cols
  const baseY = buf.baseY
  const startY = baseY + rows - rowCount

  // Cursor in absolute buffer coords
  const cursorAbsY = baseY + buf.cursorY
  let cursorRow: number | null = null
  let cursorCol: number | null = null
  if (cursorAbsY >= startY && cursorAbsY < startY + rowCount) {
    cursorRow = cursorAbsY - startY
    cursorCol = buf.cursorX
  }

  // Reuse a single cell object across all reads — avoids allocating per cell.
  const parts: string[] = []
  let cellBuf: IBufferCell | undefined
  for (let r = 0; r < rowCount; r++) {
    const y = startY + r
    const line = buf.getLine(y)
    if (!line) {
      parts.push('<div class="pinned-row">\u00a0</div>')
      continue
    }
    // Seed the reusable cell on first iteration
    if (!cellBuf) cellBuf = line.getCell(0) ?? undefined
    parts.push(renderRowHtml(line, cols, theme, cellBuf))
  }
  target.innerHTML = parts.join('')

  return { rowCount, cursorRow, cursorCol }
}

function renderRowHtml(
  line: IBufferLine,
  cols: number,
  theme: TerminalColors,
  reusable: IBufferCell | undefined
): string {
  const parts: string[] = ['<div class="pinned-row">']
  let currentStyle = ''
  let currentText = ''

  for (let x = 0; x < cols; x++) {
    const cell = line.getCell(x, reusable)
    if (!cell) continue
    if (cell.getWidth() === 0) continue // trailing half of a wide char — skip

    const style = cellStyle(cell, theme)
    const chars = cell.getChars() || ' '
    if (style === currentStyle) {
      currentText += chars
    } else {
      if (currentText) parts.push(renderSpan(currentStyle, currentText))
      currentStyle = style
      currentText = chars
    }
  }
  if (currentText) parts.push(renderSpan(currentStyle, currentText))
  parts.push('</div>')
  return parts.join('')
}

function renderSpan(style: string, text: string): string {
  const esc = escapeHtml(text)
  if (!style) return esc
  return `<span style="${style}">${esc}</span>`
}

function escapeHtml(s: string): string {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c === 38) out += '&amp;'
    else if (c === 60) out += '&lt;'
    else if (c === 62) out += '&gt;'
    else if (c === 34) out += '&quot;'
    else if (c === 39) out += '&#39;'
    else out += s[i]
  }
  return out
}

function cellStyle(cell: IBufferCell, theme: TerminalColors): string {
  let fg: string | null = null
  let bg: string | null = null

  if (cell.isFgRGB()) fg = rgbToCss(cell.getFgColor())
  else if (cell.isFgPalette()) fg = paletteColor(cell.getFgColor(), theme)

  if (cell.isBgRGB()) bg = rgbToCss(cell.getBgColor())
  else if (cell.isBgPalette()) bg = paletteColor(cell.getBgColor(), theme)

  if (cell.isInverse()) {
    const origFg = fg
    fg = bg ?? theme.background
    bg = origFg ?? theme.foreground
  }

  const parts: string[] = []
  if (fg) parts.push(`color:${fg}`)
  if (bg) parts.push(`background:${bg}`)
  if (cell.isBold()) parts.push('font-weight:bold')
  if (cell.isItalic()) parts.push('font-style:italic')
  if (cell.isDim()) parts.push('opacity:0.6')

  const decos: string[] = []
  if (cell.isUnderline()) decos.push('underline')
  if (cell.isStrikethrough()) decos.push('line-through')
  if (decos.length) parts.push(`text-decoration:${decos.join(' ')}`)

  return parts.join(';')
}

function rgbToCss(v: number): string {
  return `rgb(${(v >>> 16) & 0xff},${(v >>> 8) & 0xff},${v & 0xff})`
}

/** xterm 256-color palette → CSS. 0–15 come from theme, 16–231 from the color
 *  cube, 232–255 from the greyscale ramp. */
function paletteColor(index: number, theme: TerminalColors): string {
  if (index >= 0 && index <= 15) return ANSI_16[index](theme)
  if (index >= 16 && index <= 231) {
    const n = index - 16
    const r = Math.floor(n / 36)
    const g = Math.floor((n / 6) % 6)
    const b = n % 6
    const cv = (v: number) => (v === 0 ? 0 : 55 + v * 40)
    return `rgb(${cv(r)},${cv(g)},${cv(b)})`
  }
  if (index >= 232 && index <= 255) {
    const v = 8 + (index - 232) * 10
    return `rgb(${v},${v},${v})`
  }
  return theme.foreground
}

const ANSI_16: Array<(t: TerminalColors) => string> = [
  (t) => t.black, (t) => t.red, (t) => t.green, (t) => t.yellow,
  (t) => t.blue, (t) => t.magenta, (t) => t.cyan, (t) => t.white,
  (t) => t.brightBlack, (t) => t.brightRed, (t) => t.brightGreen, (t) => t.brightYellow,
  (t) => t.brightBlue, (t) => t.brightMagenta, (t) => t.brightCyan, (t) => t.brightWhite
]
