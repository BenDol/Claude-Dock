import { describe, it, expect, vi } from 'vitest'

vi.mock('../services', () => ({
  getServices: () => ({
    log: () => {},
    logInfo: () => {},
    logError: () => {}
  })
}))

import { parsePushLine } from '../git-operations'

describe('parsePushLine', () => {
  describe('percent-based phases', () => {
    it('parses "Counting objects" with percent', () => {
      const p = parsePushLine('Counting objects:  55% (11/20)')
      expect(p).not.toBeNull()
      expect(p!.stage).toBe('count')
      expect(p!.phasePercent).toBe(55)
      expect(p!.remote).toBe(false)
      // count weights: start=5, span=10 -> 5 + 55*10/100 = 10.5 -> 11
      expect(p!.percent).toBe(11)
    })

    it('parses "Compressing objects" with percent', () => {
      const p = parsePushLine('Compressing objects:  40% (8/20), done.')
      expect(p).not.toBeNull()
      expect(p!.stage).toBe('compress')
      expect(p!.phasePercent).toBe(40)
      // compress weights: start=15, span=15 -> 15 + 40*15/100 = 21
      expect(p!.percent).toBe(21)
    })

    it('parses "Writing objects" with percent and throughput', () => {
      const p = parsePushLine('Writing objects:  45% (9/20), 2.00 MiB | 1.50 MiB/s')
      expect(p).not.toBeNull()
      expect(p!.stage).toBe('write')
      expect(p!.phasePercent).toBe(45)
      expect(p!.throughput).toBe('1.50MiB/s')
      // write weights: start=30, span=55 -> 30 + 45*55/100 = 54.75 -> 55
      expect(p!.percent).toBe(55)
    })

    it('extracts throughput in KiB/s and GiB/s', () => {
      const k = parsePushLine('Writing objects:  10% (1/10), 512.00 KiB | 128.00 KiB/s')
      expect(k!.throughput).toBe('128.00KiB/s')
      const g = parsePushLine('Writing objects:  90% (18/20), 3.00 GiB | 1.20 GiB/s')
      expect(g!.throughput).toBe('1.20GiB/s')
    })

    it('only attaches throughput to the write stage', () => {
      // A (hypothetical) count line with a rate shouldn't carry throughput.
      const p = parsePushLine('Counting objects:  55% (11/20), 2.00 MiB | 1.50 MiB/s')
      expect(p!.stage).toBe('count')
      expect(p!.throughput).toBeUndefined()
    })

    it('strips the "remote:" prefix for resolving deltas', () => {
      const p = parsePushLine('remote: Resolving deltas:  50% (15/30)')
      expect(p).not.toBeNull()
      expect(p!.stage).toBe('resolve')
      expect(p!.phasePercent).toBe(50)
      expect(p!.remote).toBe(true)
      expect(p!.phase).toBe('Resolving deltas')
      // resolve weights: start=85, span=15 -> 85 + 50*15/100 = 92.5 -> 93
      expect(p!.percent).toBe(93)
    })

    it('clamps percent to [0, 100]', () => {
      const over = parsePushLine('Writing objects: 150% (150/100)')
      expect(over!.phasePercent).toBe(100)
      const under = parsePushLine('Writing objects:   0% (0/100)')
      expect(under!.phasePercent).toBe(0)
      expect(under!.percent).toBe(30) // write start
    })
  })

  describe('enumerate counter', () => {
    it('parses the counter and holds percent at stage start', () => {
      const p = parsePushLine('Enumerating objects: 12345, done.')
      expect(p).not.toBeNull()
      expect(p!.stage).toBe('enumerate')
      expect(p!.count).toBe(12345)
      expect(p!.phasePercent).toBe(0)
      expect(p!.percent).toBe(0) // enumerate start
    })

    it('parses enumerate mid-counting without "done"', () => {
      const p = parsePushLine('Enumerating objects: 500')
      expect(p!.stage).toBe('enumerate')
      expect(p!.count).toBe(500)
    })
  })

  describe('ignore-list (recognized git noise)', () => {
    it('ignores "Delta compression" info line', () => {
      expect(parsePushLine('Delta compression using up to 8 threads')).toBeNull()
    })

    it('ignores "Total N (delta M)" summary line', () => {
      expect(parsePushLine('Total 42 (delta 3), reused 0 (delta 0), pack-reused 0')).toBeNull()
    })

    it('ignores "To <remote>" target line', () => {
      expect(parsePushLine('To github.com:foo/bar.git')).toBeNull()
    })

    it('ignores "Everything up-to-date"', () => {
      expect(parsePushLine('Everything up-to-date')).toBeNull()
    })

    it('ignores the fast-forward range line', () => {
      expect(parsePushLine('   abc1234..def5678  main -> main')).toBeNull()
    })

    it('ignores "[new branch]" line', () => {
      expect(parsePushLine(' * [new branch]      feature -> feature')).toBeNull()
    })

    it('ignores unrecognized remote: chatter', () => {
      // Server-side banners, MOTDs, and post-receive output should not be
      // mis-classified as a pre-push hook.
      expect(parsePushLine('remote: Welcome to GitHub')).toBeNull()
      expect(parsePushLine('remote: Create a pull request for \'feature\' on GitHub by visiting:')).toBeNull()
    })
  })

  describe('pre-push hook fallback', () => {
    it('treats arbitrary non-remote stderr as hook output', () => {
      const p = parsePushLine('husky - running pre-push hook')
      expect(p).not.toBeNull()
      expect(p!.stage).toBe('hook')
      expect(p!.phase).toBe('Running pre-push hook')
      expect(p!.percent).toBe(0)
      expect(p!.detail).toContain('husky')
    })

    it('captures lint-staged output as hook stage', () => {
      const p = parsePushLine('✔ Running tasks for staged files...')
      expect(p!.stage).toBe('hook')
    })
  })

  describe('overall percent monotonicity', () => {
    it('advances across stage transitions', () => {
      const count = parsePushLine('Counting objects: 100% (20/20), done.')!
      const compress = parsePushLine('Compressing objects:   0% (0/20)')!
      const write = parsePushLine('Writing objects:   0% (0/20)')!
      const resolve = parsePushLine('remote: Resolving deltas:   0% (0/30)')!
      // Each stage start must be >= previous stage end.
      expect(compress.percent).toBeGreaterThanOrEqual(count.percent)
      expect(write.percent).toBeGreaterThanOrEqual(compress.percent)
      expect(resolve.percent).toBeGreaterThanOrEqual(write.percent)
    })

    it('reaches ~100 at resolve completion', () => {
      const p = parsePushLine('remote: Resolving deltas: 100% (30/30), done.')!
      expect(p.percent).toBe(100)
    })
  })
})
