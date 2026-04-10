import { describe, it, expect, vi } from 'vitest'

vi.mock('../../services', () => ({
  getServices: () => ({
    log: vi.fn(),
    logInfo: vi.fn(),
    logError: vi.fn()
  })
}))

import {
  classifyIssue,
  describeBehavior,
  getDefaultIssueProfiles,
  parseIssueProfiles,
  serializeIssueProfiles
} from '../issue-type-profiles'
import type { IssueLabel, IssueTypeProfiles } from '../../../../../shared/issue-types'

function lbl(name: string): IssueLabel { return { name } }

describe('issue-type-profiles', () => {
  describe('getDefaultIssueProfiles', () => {
    it('returns a non-empty profile list with a generic fallback', () => {
      const defaults = getDefaultIssueProfiles()
      expect(defaults.profiles.length).toBeGreaterThan(0)
      expect(defaults.defaultBehavior).toBe('generic')
    })

    it('maps "bug" label to fix behavior', () => {
      const defaults = getDefaultIssueProfiles()
      const result = classifyIssue([lbl('bug')], defaults)
      expect(result.behavior).toBe('fix')
      expect(result.source).toBe('label')
    })
  })

  describe('classifyIssue', () => {
    const profiles = getDefaultIssueProfiles()

    it('matches labels case-insensitively', () => {
      expect(classifyIssue([lbl('BUG')], profiles).behavior).toBe('fix')
      expect(classifyIssue([lbl('Bug')], profiles).behavior).toBe('fix')
      expect(classifyIssue([lbl('bUg')], profiles).behavior).toBe('fix')
    })

    it('supports prefix wildcards with *', () => {
      const custom: IssueTypeProfiles = {
        profiles: [{ labelPatterns: ['bug*'], behavior: 'fix' }],
        defaultBehavior: 'generic'
      }
      expect(classifyIssue([lbl('bug')], custom).behavior).toBe('fix')
      expect(classifyIssue([lbl('bugfix')], custom).behavior).toBe('fix')
      expect(classifyIssue([lbl('bug-report')], custom).behavior).toBe('fix')
      expect(classifyIssue([lbl('not-a-bug')], custom).behavior).toBe('generic')
    })

    it('first-match wins across profiles in declaration order', () => {
      const custom: IssueTypeProfiles = {
        profiles: [
          { labelPatterns: ['question'], behavior: 'investigate' },
          { labelPatterns: ['question'], behavior: 'collaborate' }
        ],
        defaultBehavior: 'generic'
      }
      expect(classifyIssue([lbl('question')], custom).behavior).toBe('investigate')
    })

    it('falls back to defaultBehavior when nothing matches', () => {
      const result = classifyIssue([lbl('exotic-label')], profiles)
      expect(result.behavior).toBe('generic')
      expect(result.source).toBe('default')
    })

    it('returns default when no labels at all', () => {
      const result = classifyIssue([], profiles)
      expect(result.source).toBe('default')
    })

    it('includes promptAddendum when the matched profile has one', () => {
      const custom: IssueTypeProfiles = {
        profiles: [{ labelPatterns: ['bug'], behavior: 'fix', promptAddendum: 'Extra guidance' }],
        defaultBehavior: 'generic'
      }
      const result = classifyIssue([lbl('bug')], custom)
      expect(result.promptAddendum).toBe('Extra guidance')
    })

    it('accepts string labels as well as objects', () => {
      expect(classifyIssue(['bug'], profiles).behavior).toBe('fix')
    })
  })

  describe('parseIssueProfiles', () => {
    it('returns defaults for empty string', () => {
      const result = parseIssueProfiles('')
      expect(result.defaultBehavior).toBe('generic')
      expect(result.profiles.length).toBeGreaterThan(0)
    })

    it('returns defaults for null', () => {
      const result = parseIssueProfiles(null)
      expect(result.profiles.length).toBeGreaterThan(0)
    })

    it('returns defaults for invalid JSON', () => {
      const result = parseIssueProfiles('{not json')
      expect(result.defaultBehavior).toBe('generic')
    })

    it('parses valid user overrides', () => {
      const json = JSON.stringify({
        profiles: [{ labelPatterns: ['custom-bug'], behavior: 'fix' }],
        defaultBehavior: 'investigate'
      })
      const result = parseIssueProfiles(json)
      expect(result.profiles).toHaveLength(1)
      expect(result.profiles[0].labelPatterns).toEqual(['custom-bug'])
      expect(result.defaultBehavior).toBe('investigate')
    })

    it('drops profiles with invalid behavior values', () => {
      const json = JSON.stringify({
        profiles: [
          { labelPatterns: ['bad'], behavior: 'not-a-real-behavior' },
          { labelPatterns: ['good'], behavior: 'fix' }
        ],
        defaultBehavior: 'generic'
      })
      const result = parseIssueProfiles(json)
      expect(result.profiles).toHaveLength(1)
      expect(result.profiles[0].labelPatterns).toEqual(['good'])
    })

    it('drops profiles with no label patterns', () => {
      const json = JSON.stringify({
        profiles: [{ labelPatterns: [], behavior: 'fix' }],
        defaultBehavior: 'design'
      })
      const result = parseIssueProfiles(json)
      expect(result.profiles).toHaveLength(0)
      expect(result.defaultBehavior).toBe('design')
    })

    it('coerces invalid defaultBehavior to generic', () => {
      const json = JSON.stringify({
        profiles: [{ labelPatterns: ['bug'], behavior: 'fix' }],
        defaultBehavior: 'bogus'
      })
      const result = parseIssueProfiles(json)
      expect(result.defaultBehavior).toBe('generic')
    })
  })

  describe('serializeIssueProfiles', () => {
    it('produces valid JSON that round-trips', () => {
      const profiles = getDefaultIssueProfiles()
      const json = serializeIssueProfiles(profiles)
      const parsed = parseIssueProfiles(json)
      expect(parsed.defaultBehavior).toBe(profiles.defaultBehavior)
      expect(parsed.profiles).toHaveLength(profiles.profiles.length)
    })
  })

  describe('describeBehavior', () => {
    it('returns a non-empty description for every behavior', () => {
      const behaviors = ['fix', 'investigate', 'design', 'improve', 'cleanup', 'collaborate', 'generic'] as const
      for (const b of behaviors) {
        const desc = describeBehavior(b)
        expect(desc.length).toBeGreaterThan(20)
      }
    })

    it('treats unknown behaviors as generic', () => {
      // TypeScript guards against this, but the implementation should still be safe at runtime.
      const desc = describeBehavior('unknown-behavior' as never)
      expect(desc).toBe(describeBehavior('generic'))
    })
  })
})
