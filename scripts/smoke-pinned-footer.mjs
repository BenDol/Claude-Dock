#!/usr/bin/env node
/**
 * Standalone smoke test for the row-classification helpers in
 * `src/renderer/src/lib/pinned-footer.ts`. Doesn't depend on node_modules or
 * vitest — duplicates the classifier logic inline so a fresh checkout can
 * verify the fix for the "2-line input falls off the bottom" bug.
 *
 * The real module is TypeScript and imports xterm types, so can't be required
 * directly from node. Instead, this script mirrors the same heuristics the
 * detector uses, keeps them next to the implementation, and exercises the
 * regression cases. If either the implementation or this file drifts, the
 * regression will fire in code review and the vitest file too.
 *
 * Keep in sync with:
 *   - isBlankRow
 *   - isBorderRow
 *   - isBoxInteriorRow
 *   - isSpinnerRow
 *   - the Phase-0/Phase-1 walk in detectInputBoxRows
 */

const H_RULE = '─'

function isBlankRow(s) {
  return s.trim().length === 0
}

const SPINNER_PATTERN = /^.\s[A-Za-z]+…/
function isSpinnerRow(s) {
  const trimmed = s.replace(/^\s+/, '')
  if (trimmed.length < 3) return false
  const first = trimmed[0]
  if (/[\sA-Za-z0-9]/.test(first)) return false
  if (first === '…') return false
  return SPINNER_PATTERN.test(trimmed)
}

function isBoxInteriorRow(s) {
  if (isBlankRow(s)) return true
  const trimmed = s.replace(/^\s+/, '')
  if (trimmed.length === 0) return true
  const c = trimmed[0]
  if (c === '│' || c === '|') return true
  if (c === '>' || c === '›' || c === '❯' || c === '▸' || c === '▶') return true
  if (c === '●' || c === '○' || c === '⎿' || c === '└' || c === 'L') return false
  if (isSpinnerRow(s)) return false
  return true
}

function isBorderRow(s) {
  const trimmed = s.replace(/\s+$/, '')
  if (trimmed.length < 10) return false
  let ruleCount = 0
  for (const ch of trimmed) if (ch === H_RULE) ruleCount++
  if (ruleCount >= 20) return true
  return ruleCount >= 10 && ruleCount / trimmed.length >= 0.4
}

// Mimics the detectInputBoxRows walk over a plain-string row array.
function detectRowCount(rows, maxScan = 24) {
  const termRows = rows.length
  const baseY = 0
  const scan = Math.min(maxScan, termRows)

  let bottomOffset = 0
  for (let off = 0; off < scan; off++) {
    const y = baseY + termRows - 1 - off
    if (y < 0) break
    const line = rows[y]
    if (line == null) continue
    if (!isBlankRow(line)) {
      bottomOffset = off
      break
    }
  }

  let bottomBorderOffset = -1
  for (let off = bottomOffset; off < scan; off++) {
    const y = baseY + termRows - 1 - off
    if (y < 0) break
    const line = rows[y]
    if (line == null) continue
    if (isBorderRow(line)) {
      bottomBorderOffset = off
      break
    }
  }
  if (bottomBorderOffset < 0) return 0

  const maxBoxHeight = 16
  let topBorderOffset = bottomBorderOffset
  for (
    let off = bottomBorderOffset + 1;
    off < scan && off <= bottomBorderOffset + maxBoxHeight;
    off++
  ) {
    const y = baseY + termRows - 1 - off
    if (y < 0) break
    const line = rows[y]
    if (line == null) continue
    if (isBorderRow(line)) {
      topBorderOffset = off
      break
    }
    if (isBoxInteriorRow(line)) continue
    break
  }

  return Math.max(1, topBorderOffset + 1 - bottomOffset)
}

let failures = 0
function assertEq(actual, expected, name) {
  if (actual === expected) {
    console.log(`  ok: ${name} = ${actual}`)
  } else {
    failures++
    console.error(`  FAIL: ${name} — expected ${expected}, got ${actual}`)
  }
}

const RULE = '─'.repeat(80)

console.log('\n[1-line input]')
assertEq(detectRowCount([
  '● Something above',
  'more context',
  RULE,
  '>',
  RULE,
  '⏵⏵ accept edits on (shift+tab to cycle)'
]), 4, 'rowCount')

console.log('\n[2-line input with plain indented wrap — THE BUG FIX]')
assertEq(detectRowCount([
  '● Something above',
  'more context',
  RULE,
  '> first line of user input',
  '  continued text here',
  RULE,
  '⏵⏵ accept edits on (shift+tab to cycle)'
]), 5, 'rowCount')

console.log('\n[3-line input]')
assertEq(detectRowCount([
  'prior prose',
  RULE,
  '> line one',
  '  line two of wrap',
  '  line three of wrap',
  RULE,
  '⏵⏵ accept edits on'
]), 6, 'rowCount')

console.log('\n[previous tool call bullet above — do not walk past top rule]')
assertEq(detectRowCount([
  '● Previous tool call header',
  '  tool output line',
  RULE,
  '> current input',
  '  wrapped part',
  RULE,
  '⏵⏵ hint'
]), 5, 'rowCount')

console.log('\n[spinner above the box — do not over-include]')
assertEq(detectRowCount([
  '✶ Mustering… (4m 21s · ↓ 12k tokens)',
  RULE,
  '> input',
  '  wrap',
  RULE,
  '⏵⏵ hint'
]), 5, 'rowCount')

console.log('\n[legacy │-bar style still works]')
assertEq(detectRowCount([
  'above',
  RULE,
  '│ > first line      │',
  '│ continued line    │',
  RULE,
  '⏵⏵ hint'
]), 5, 'rowCount')

console.log('\n[no bottom rule → no pinned region]')
assertEq(detectRowCount([
  'plain prose line',
  'more prose',
  'no borders here',
  'still prose'
]), 0, 'rowCount')

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
