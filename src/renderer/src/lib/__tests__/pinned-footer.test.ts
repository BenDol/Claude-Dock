/**
 * Tests for `detectInputBoxRows`. Uses a minimal fake xterm Terminal that
 * only implements the surface the detector reads:
 *   - term.rows / term.cols
 *   - term.buffer.active.baseY
 *   - term.buffer.active.getLine(y).translateToString(true)
 *
 * Every row of the fake buffer is a plain string; `baseY` is 0 so the visible
 * region covers rows[0..rows.length-1].
 *
 * Regression for the "multi-line input falls off the bottom" bug: Claude Code
 * renders its input box with horizontal rules only (no `│` left bar), so a
 * wrapped continuation line like `  continued text` was rejected by the old
 * `isBoxInteriorRow`, collapsing the pinned region to hint+bottom-rule and
 * hiding the input. The fix below accepts plain indented wrap rows.
 */

import { describe, it, expect } from 'vitest'
import { detectInputBoxRows } from '../pinned-footer'

function makeTerm(rows: string[], termRows?: number): any {
  // Default to a realistic 24-row viewport. The detector caps the pinned
  // region at 50% of `term.rows`; using `rows.length` (6–7) would clamp
  // results below the expected values and mask the detection logic.
  const R = termRows ?? Math.max(rows.length, 24)
  return {
    rows: R,
    cols: Math.max(...rows.map((r) => r.length), 1),
    buffer: {
      active: {
        baseY: 0,
        cursorX: 0,
        cursorY: R - 1,
        getLine(y: number) {
          if (y < 0 || y >= rows.length) return null
          const text = rows[y]
          return { translateToString: (_trimRight: boolean) => text }
        }
      }
    }
  }
}

const RULE = '─'.repeat(80)

describe('detectInputBoxRows — Claude Code horizontal-rule input box', () => {
  it('detects 1-line input (hint + bottom rule + chevron + top rule)', () => {
    const term = makeTerm([
      '● Something above',
      'more context',
      RULE,
      '>',
      RULE,
      '⏵⏵ accept edits on (shift+tab to cycle)'
    ])
    const { rowCount } = detectInputBoxRows(term)
    // top rule at offset 3, hint at offset 0 → 4 rows pinned
    expect(rowCount).toBe(4)
  })

  it('detects 2-line input with plain indented continuation (the bug fix)', () => {
    const term = makeTerm([
      '● Something above',
      'more context',
      RULE,
      '> first line of user input',
      '  continued text here',
      RULE,
      '⏵⏵ accept edits on (shift+tab to cycle)'
    ])
    const { rowCount } = detectInputBoxRows(term)
    // top rule at offset 4 → 5 rows pinned (hint, bottom rule, wrap, chevron, top rule)
    expect(rowCount).toBe(5)
  })

  it('detects 3-line input', () => {
    const term = makeTerm([
      'prior prose',
      RULE,
      '> line one',
      '  line two of wrap',
      '  line three of wrap',
      RULE,
      '⏵⏵ accept edits on'
    ])
    const { rowCount } = detectInputBoxRows(term)
    expect(rowCount).toBe(6)
  })

  it('stops at bullet-led row above the box (does not over-include)', () => {
    const term = makeTerm([
      '● Previous tool call header',
      '  tool output line',
      RULE,
      '> current input',
      '  wrapped part',
      RULE,
      '⏵⏵ hint'
    ])
    const { rowCount } = detectInputBoxRows(term)
    // Must find the top rule at offset 4 (NOT walk past it).
    expect(rowCount).toBe(5)
  })

  it('pins spinner row above the box (active-thinking anchor, no over-include)', () => {
    const term = makeTerm([
      '✶ Mustering… (4m 21s · ↓ 12k tokens)',
      RULE,
      '> input',
      '  wrap',
      RULE,
      '⏵⏵ hint'
    ])
    const { rowCount } = detectInputBoxRows(term)
    // Phase 2 anchors on the spinner to keep the active thinking status
    // visible: 5-row box + 1 spinner row = 6. The detector must stop at the
    // spinner and NOT walk further up into prior history.
    expect(rowCount).toBe(6)
  })

  it('still works with legacy │-bar style input boxes', () => {
    const term = makeTerm([
      'above',
      RULE,
      '│ > first line      │',
      '│ continued line    │',
      RULE,
      '⏵⏵ hint'
    ])
    const { rowCount } = detectInputBoxRows(term)
    expect(rowCount).toBe(5)
  })

  it('returns 0 when no bottom rule is found (no active input box)', () => {
    const term = makeTerm([
      'plain prose line',
      'more prose',
      'no borders here',
      'still prose'
    ])
    const { rowCount } = detectInputBoxRows(term)
    expect(rowCount).toBe(0)
  })
})
