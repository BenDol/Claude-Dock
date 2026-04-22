import { describe, it, expect, vi, beforeEach } from 'vitest'

const getPluginSetting = vi.fn<(projectDir: string, pluginId: string, key: string) => unknown>()

vi.mock('../services', () => ({
  getServices: () => ({
    log: () => {},
    logInfo: () => {},
    logError: () => {},
    getPluginSetting
  })
}))

import { __testInternals } from '../git-operations'

const {
  lookupCommitMsgSettings,
  buildClaudeCommitPrompt,
  CLAUDE_SINGLE_SHOT_DIFF_LIMIT,
  CLAUDE_SINGLE_SHOT_FILE_LIMIT
} = __testInternals

describe('lookupCommitMsgSettings', () => {
  beforeEach(() => {
    getPluginSetting.mockReset()
  })

  it('defaults to local-llm when no setting is configured', () => {
    getPluginSetting.mockReturnValue(undefined)
    const r = lookupCommitMsgSettings('/tmp/proj')
    expect(r.backend).toBe('local-llm')
    expect(r.claudeModel).toBe('haiku')
  })

  it('returns the configured backend when explicitly set', () => {
    getPluginSetting.mockImplementation((_d, _p, key) => {
      if (key === 'commitMsgBackend') return 'claude-cli'
      if (key === 'commitMsgClaudeModel') return 'sonnet'
      return undefined
    })
    const r = lookupCommitMsgSettings('/tmp/proj')
    expect(r.backend).toBe('claude-cli')
    expect(r.claudeModel).toBe('sonnet')
  })

  it('migrates legacy enableClaude=true to claude-cli when backend is unset', () => {
    getPluginSetting.mockImplementation((_d, _p, key) => {
      if (key === 'enableClaude') return true
      return undefined
    })
    const r = lookupCommitMsgSettings('/tmp/proj')
    expect(r.backend).toBe('claude-cli')
    expect(r.claudeModel).toBe('haiku')
  })

  it('ignores legacy enableClaude when explicit backend is already set', () => {
    getPluginSetting.mockImplementation((_d, _p, key) => {
      if (key === 'commitMsgBackend') return 'local-llm'
      if (key === 'enableClaude') return true
      return undefined
    })
    const r = lookupCommitMsgSettings('/tmp/proj')
    expect(r.backend).toBe('local-llm')
  })

  it('walks up parent dirs to find submodule-inherited settings', () => {
    getPluginSetting.mockImplementation((dir, _p, key) => {
      if (key === 'commitMsgBackend' && dir === '/tmp/parent') return 'claude-cli'
      return undefined
    })
    const r = lookupCommitMsgSettings('/tmp/parent/submodule/deeper')
    expect(r.backend).toBe('claude-cli')
    expect(r.settingsDir).toBe('/tmp/parent')
  })

  it('falls back to haiku for an unrecognised model value', () => {
    getPluginSetting.mockImplementation((_d, _p, key) => {
      if (key === 'commitMsgClaudeModel') return ''
      return undefined
    })
    const r = lookupCommitMsgSettings('/tmp/proj')
    expect(r.claudeModel).toBe('haiku')
  })

  it('falls back to local-llm for an unrecognised backend value', () => {
    getPluginSetting.mockImplementation((_d, _p, key) => {
      if (key === 'commitMsgBackend') return 'some-future-backend'
      return undefined
    })
    const r = lookupCommitMsgSettings('/tmp/proj')
    expect(r.backend).toBe('local-llm')
  })
})

describe('buildClaudeCommitPrompt', () => {
  it('includes the full diff without 4 KB truncation', () => {
    const bigDiff = 'x'.repeat(200_000)
    const prompt = buildClaudeCommitPrompt('1 file changed', bigDiff)
    // The Claude path must NOT chop at 4000 chars like buildCommitPrompt.
    expect(prompt.length).toBeGreaterThan(200_000)
    expect(prompt).toContain(bigDiff.slice(-100))
    expect(prompt).not.toContain('(truncated)')
  })

  it('includes both the stat block and the diff body', () => {
    const prompt = buildClaudeCommitPrompt(' foo.ts | 5 +++++', '+hello')
    expect(prompt).toContain('foo.ts | 5 +++++')
    expect(prompt).toContain('+hello')
    expect(prompt).toContain('feat:')
  })
})

describe('Claude single-shot thresholds', () => {
  it('single-shot diff cap is at least 200 KB', () => {
    expect(CLAUDE_SINGLE_SHOT_DIFF_LIMIT).toBeGreaterThanOrEqual(200 * 1024)
  })
  it('single-shot file cap is at least 20', () => {
    expect(CLAUDE_SINGLE_SHOT_FILE_LIMIT).toBeGreaterThanOrEqual(20)
  })
})
