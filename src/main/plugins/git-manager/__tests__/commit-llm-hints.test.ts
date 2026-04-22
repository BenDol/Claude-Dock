import { describe, it, expect, vi } from 'vitest'

vi.mock('../services', () => ({
  getServices: () => ({
    log: () => {},
    logInfo: () => {},
    logError: () => {}
  })
}))

import { __testInternals } from '../git-operations'

const {
  extractDiffHints,
  formatHintsBlock,
  isConfidentSummary,
  buildShortDiffSnippet,
  buildPerFileSummaryPrompt,
  filterLowConfidenceBullets,
  computeDiffBudget,
  cleanCommitMessage
} = __testInternals

function makeChunk(path: string, body: string) {
  return { path, status: 'M', body }
}

describe('extractDiffHints', () => {
  it('counts added and removed lines and ignores file headers', () => {
    const body = [
      'diff --git a/foo.ts b/foo.ts',
      'index 1111111..2222222 100644',
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '@@ -1,3 +1,4 @@',
      ' unchanged line',
      '-removed line',
      '+added line one',
      '+added line two'
    ].join('\n')
    const hints = extractDiffHints(makeChunk('foo.ts', body))
    // File header lines (--- / +++) must not be counted as +/- content
    expect(hints.linesAdded).toBe(2)
    expect(hints.linesRemoved).toBe(1)
  })

  it('captures added function / class / const / interface symbols', () => {
    const body = [
      'diff --git a/foo.ts b/foo.ts',
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '@@ -1,0 +1,10 @@',
      '+export function doThing(x: number) {}',
      '+class Widget {}',
      '+const counter = 0',
      '+interface Options { verbose: boolean }'
    ].join('\n')
    const hints = extractDiffHints(makeChunk('foo.ts', body))
    expect(hints.symbolsAdded).toContain('doThing')
    expect(hints.symbolsAdded).toContain('Widget')
    expect(hints.symbolsAdded).toContain('counter')
    expect(hints.symbolsAdded).toContain('Options')
  })

  it('captures removed symbols separately from added ones', () => {
    const body = [
      'diff --git a/foo.ts b/foo.ts',
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '@@ -1,3 +1,3 @@',
      '-function oldThing() {}',
      '+function newThing() {}'
    ].join('\n')
    const hints = extractDiffHints(makeChunk('foo.ts', body))
    expect(hints.symbolsAdded).toEqual(['newThing'])
    expect(hints.symbolsRemoved).toEqual(['oldThing'])
  })

  it('captures import/require paths into importsAdded', () => {
    const body = [
      'diff --git a/foo.ts b/foo.ts',
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '@@ -1,0 +1,3 @@',
      "+import { foo } from 'react'",
      "+const os = require('os')",
      "+import('./lazy-mod')"
    ].join('\n')
    const hints = extractDiffHints(makeChunk('foo.ts', body))
    expect(hints.importsAdded).toContain('react')
    expect(hints.importsAdded).toContain('os')
    expect(hints.importsAdded).toContain('./lazy-mod')
  })

  it('captures hunk contexts from @@ header trailing text', () => {
    const body = [
      'diff --git a/foo.ts b/foo.ts',
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '@@ -42,5 +42,5 @@ function outerFn()',
      ' body unchanged',
      '-old',
      '+new',
      '@@ -80,5 +80,5 @@ class Bar {',
      ' body',
      '-x',
      '+y'
    ].join('\n')
    const hints = extractDiffHints(makeChunk('foo.ts', body))
    expect(hints.hunkContexts).toEqual(['function outerFn()', 'class Bar {'])
  })

  it('dedupes repeated symbols so prompt stays short', () => {
    const body = [
      'diff --git a/foo.ts b/foo.ts',
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '@@ -0,0 +1,3 @@',
      '+function repeat() {}',
      '+function repeat() {}'
    ].join('\n')
    const hints = extractDiffHints(makeChunk('foo.ts', body))
    expect(hints.symbolsAdded).toEqual(['repeat'])
  })

  it('caps symbol list length to prevent prompt flooding', () => {
    const lines = ['diff --git a/foo.ts b/foo.ts', '--- a/foo.ts', '+++ b/foo.ts', '@@ -0,0 +1,50 @@']
    for (let i = 0; i < 50; i++) lines.push(`+function fn${i}() {}`)
    const hints = extractDiffHints(makeChunk('foo.ts', lines.join('\n')))
    expect(hints.symbolsAdded.length).toBeLessThanOrEqual(12)
  })

  it('returns empty lists for diffs with no recognisable symbols', () => {
    const body = [
      'diff --git a/README.md b/README.md',
      '--- a/README.md',
      '+++ b/README.md',
      '@@ -1,1 +1,1 @@',
      '-old text',
      '+new text'
    ].join('\n')
    const hints = extractDiffHints(makeChunk('README.md', body))
    expect(hints.symbolsAdded).toEqual([])
    expect(hints.symbolsRemoved).toEqual([])
    expect(hints.linesAdded).toBe(1)
    expect(hints.linesRemoved).toBe(1)
  })
})

describe('formatHintsBlock', () => {
  it('includes only non-empty sections and the line counter', () => {
    const hints = {
      linesAdded: 3,
      linesRemoved: 1,
      symbolsAdded: ['doThing'],
      symbolsRemoved: [],
      importsAdded: ['react'],
      importsRemoved: [],
      hunkContexts: []
    }
    const block = formatHintsBlock(hints)
    expect(block).toContain('[diff-stats]')
    expect(block).toContain('lines=+3/-1')
    expect(block).toContain('syms_added=doThing')
    expect(block).toContain('imports_added=react')
    expect(block).not.toContain('syms_removed=')
    expect(block).not.toContain('ctx=')
  })

  it('uses key=value format (no prose labels) to discourage model echo', () => {
    const hints = {
      linesAdded: 8,
      linesRemoved: 1,
      symbolsAdded: [],
      symbolsRemoved: [],
      importsAdded: [],
      importsRemoved: [],
      hunkContexts: ['const']
    }
    const block = formatHintsBlock(hints)
    // Old prose-style labels must not appear — those were the ones small
    // models parroted verbatim ("+8 / -1 lines, touched contexts: const").
    expect(block).not.toMatch(/Changes:\s*\+/)
    expect(block).not.toMatch(/Touched contexts:/i)
    expect(block).not.toMatch(/Added symbols:/i)
  })
})

describe('isConfidentSummary', () => {
  it('rejects generic hedging', () => {
    expect(isConfidentSummary('various changes')).toBe(false)
    expect(isConfidentSummary('minor updates')).toBe(false)
    expect(isConfidentSummary('some modifications')).toBe(false)
    expect(isConfidentSummary('misc')).toBe(false)
    expect(isConfidentSummary('refactoring')).toBe(false)
  })

  it('rejects uncertainty phrases', () => {
    expect(isConfidentSummary("not sure what changed here exactly")).toBe(false)
    expect(isConfidentSummary("I cannot determine the intent")).toBe(false)
  })

  it('rejects very short lines', () => {
    expect(isConfidentSummary('ok')).toBe(false)
    expect(isConfidentSummary('done.')).toBe(false)
  })

  it('accepts concrete descriptions', () => {
    expect(isConfidentSummary('add doThing() helper and wire into updateFoo')).toBe(true)
    expect(isConfidentSummary('remove obsolete oldParser class from lexer module')).toBe(true)
  })

  it('rejects lines that echo the current key=value hint block', () => {
    // Small model copied the hint labels verbatim into the "summary".
    expect(isConfidentSummary('lines=+8/-1 ctx=const')).toBe(false)
    expect(isConfidentSummary('syms_added=foo, bar')).toBe(false)
    expect(isConfidentSummary('imports_added=react imports_removed=legacy')).toBe(false)
  })

  it('rejects lines that echo the legacy prose-style hint labels', () => {
    // Defensive: past hint-block format had phrases like
    // "+8 / -1 lines, touched contexts: const" — if a model ever regenerates
    // those labels, still drop the line.
    expect(isConfidentSummary('CoordinatorPanel.tsx: +8 / -1 lines, touched contexts: const')).toBe(false)
    expect(isConfidentSummary('foo.ts: Added symbols: bar, baz')).toBe(false)
    expect(isConfidentSummary('foo.ts: Touched contexts: function outerFn()')).toBe(false)
  })
})

describe('buildShortDiffSnippet', () => {
  it('returns the body unchanged when it fits under the cap', () => {
    const body = '@@ -1,1 +1,1 @@\n-old\n+new'
    expect(buildShortDiffSnippet(body)).toBe(body)
  })

  it('truncates and marks long bodies', () => {
    const long = '@@ -1,1 +1,1 @@\n' + '+x'.repeat(1000)
    const snippet = buildShortDiffSnippet(long)
    expect(snippet.length).toBeLessThan(long.length)
    expect(snippet).toContain('(truncated)')
  })

  it('returns empty string for empty input', () => {
    expect(buildShortDiffSnippet('')).toBe('')
  })
})

describe('buildPerFileSummaryPrompt', () => {
  const info = { status: 'M', path: 'src/foo.ts' }

  it('includes hints and UNSURE instruction, and NOT the raw diff body', () => {
    const hints = {
      linesAdded: 2,
      linesRemoved: 1,
      symbolsAdded: ['bar'],
      symbolsRemoved: [],
      importsAdded: [],
      importsRemoved: [],
      hunkContexts: []
    }
    const prompt = buildPerFileSummaryPrompt(info, hints, '')
    expect(prompt).toContain('[diff-stats]')
    expect(prompt).toContain('syms_added=bar')
    expect(prompt).toContain('UNSURE')
    expect(prompt).not.toContain('Snippet')
  })

  it('forbids copying hint labels in the prompt instructions', () => {
    const hints = {
      linesAdded: 1,
      linesRemoved: 0,
      symbolsAdded: [],
      symbolsRemoved: [],
      importsAdded: [],
      importsRemoved: [],
      hunkContexts: []
    }
    const prompt = buildPerFileSummaryPrompt(info, hints, '')
    // Explicit anti-echo instruction so the model doesn't parrot label names.
    expect(prompt).toMatch(/do\s*not\s+copy\s+the\s+hint\s+labels/i)
  })

  it('includes snippet section only when one is provided', () => {
    const hints = {
      linesAdded: 1,
      linesRemoved: 0,
      symbolsAdded: [],
      symbolsRemoved: [],
      importsAdded: [],
      importsRemoved: [],
      hunkContexts: []
    }
    const prompt = buildPerFileSummaryPrompt(info, hints, '@@ -1,1 +1,1 @@\n+new')
    expect(prompt).toContain('Snippet (first change):')
    expect(prompt).toContain('+new')
  })
})

describe('filterLowConfidenceBullets', () => {
  it('drops hedging bullets but keeps concrete ones', () => {
    const msg = [
      'feat: add new thing',
      '',
      '- add doThing() helper',
      '- various changes',
      '- remove deprecated oldHelper'
    ].join('\n')
    const filtered = filterLowConfidenceBullets(msg)
    expect(filtered).toContain('add doThing() helper')
    expect(filtered).toContain('remove deprecated oldHelper')
    expect(filtered).not.toContain('various changes')
  })

  it('preserves the summary line even if it would fail confidence check', () => {
    // cleanCommitMessage already validates the summary upstream; this filter
    // only targets bullets.
    const msg = 'feat: tweak'
    expect(filterLowConfidenceBullets(msg)).toBe('feat: tweak')
  })

  it('collapses extra blank lines left behind after dropping bullets', () => {
    const msg = [
      'fix: something',
      '',
      '- minor changes',
      '- concrete real fix to parser logic'
    ].join('\n')
    const filtered = filterLowConfidenceBullets(msg)
    // No runs of more than two consecutive newlines
    expect(/\n{3,}/.test(filtered)).toBe(false)
  })
})

describe('cleanCommitMessage', () => {
  it('rejects the observed hint-echo failure case from prod', () => {
    // User reported this output: the model produced a conventional-commit
    // prefix but the body was a verbatim echo of the old hint block labels.
    // cleanCommitMessage must refuse it so the caller retries / errors loudly
    // instead of committing with nonsense.
    const bad = 'feat: cOORDINATOR_PANEL.tsx: +8 / -1 lines, touched contexts: const'
    expect(cleanCommitMessage(bad)).toBe('')
  })

  it('rejects summaries that quote the new key=value hint labels', () => {
    expect(cleanCommitMessage('feat: lines=+3/-1 syms_added=foo')).toBe('')
    expect(cleanCommitMessage('fix: imports_added=react')).toBe('')
  })

  it('accepts a well-formed summary with a description', () => {
    const ok = 'feat: add doThing helper and wire into updateFoo'
    expect(cleanCommitMessage(ok)).toBe('feat: add doThing helper and wire into updateFoo')
  })

  it('still rejects messages without a conventional-commit prefix', () => {
    expect(cleanCommitMessage('did some stuff')).toBe('')
  })
})

describe('computeDiffBudget', () => {
  it('clamps high ctx values to 6000 (hints path handles the rest)', () => {
    expect(computeDiffBudget(100_000)).toBe(6000)
  })

  it('enforces a 2000 char floor for tiny contexts', () => {
    expect(computeDiffBudget(512)).toBe(2000)
  })

  it('scales within the band for mid-range contexts', () => {
    const b = computeDiffBudget(2048) // ~5324 chars
    expect(b).toBeGreaterThanOrEqual(2000)
    expect(b).toBeLessThanOrEqual(6000)
  })
})
