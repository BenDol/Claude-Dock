import { describe, it, expect, vi, beforeEach } from 'vitest'

// Create a mock execFile that works with promisify
const { mockExecFile } = vi.hoisted(() => {
  const fn: any = vi.fn((_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
    if (typeof cb === 'function') cb(new Error('not found'), '', '')
    return {} as any
  })
  fn[Symbol.for('nodejs.util.promisify.custom')] = async (...args: any[]) => {
    return new Promise((resolve, reject) => {
      fn(...args, (err: any, stdout: string, stderr: string) => {
        if (err) reject(err)
        else resolve({ stdout, stderr })
      })
    })
  }
  return { mockExecFile: fn }
})

vi.mock('child_process', () => ({
  execFile: mockExecFile,
  execFileSync: vi.fn().mockImplementation(() => { throw new Error('not found') }),
  spawn: vi.fn().mockReturnValue({ unref: vi.fn() })
}))

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(false)
}))

vi.mock('../../../../logger', () => ({
  log: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn()
}))

import { GitHubActionsProvider } from '../github-actions-provider'

describe('GitHubActionsProvider', () => {
  let provider: GitHubActionsProvider

  beforeEach(() => {
    vi.clearAllMocks()
    // Reset cached gh path
    ;(globalThis as any).__ghPath = null
    provider = new GitHubActionsProvider()
  })

  describe('identity', () => {
    it('has correct name', () => {
      expect(provider.name).toBe('GitHub Actions')
    })

    it('has correct providerKey', () => {
      expect(provider.providerKey).toBe('github')
    })
  })

  describe('parseLogSections', () => {
    it('parses group markers into collapsed sections', () => {
      const log = [
        '##[group]Set up job',
        'Current runner version: 2.300.0',
        'Operating System: Ubuntu 22.04',
        '##[endgroup]',
        '##[group]Run npm test',
        'npm test output line 1',
        'npm test output line 2',
        '##[endgroup]'
      ].join('\n')

      const sections = provider.parseLogSections(log)
      expect(sections).toHaveLength(2)

      expect(sections[0].name).toBe('Set up job')
      expect(sections[0].collapsed).toBe(true)
      expect(sections[0].lines).toEqual([
        'Current runner version: 2.300.0',
        'Operating System: Ubuntu 22.04'
      ])

      expect(sections[1].name).toBe('Run npm test')
      expect(sections[1].collapsed).toBe(true)
      expect(sections[1].lines).toEqual([
        'npm test output line 1',
        'npm test output line 2'
      ])
    })

    it('puts lines outside groups into default section', () => {
      const log = [
        'pre-group line',
        '##[group]Build',
        'building...',
        '##[endgroup]',
        'post-group line'
      ].join('\n')

      const sections = provider.parseLogSections(log)
      expect(sections).toHaveLength(3)

      expect(sections[0].name).toBe('')
      expect(sections[0].collapsed).toBe(false)
      expect(sections[0].lines).toEqual(['pre-group line'])

      expect(sections[1].name).toBe('Build')
      expect(sections[1].lines).toEqual(['building...'])

      expect(sections[2].name).toBe('')
      expect(sections[2].collapsed).toBe(false)
      expect(sections[2].lines).toEqual(['post-group line'])
    })

    it('handles empty log', () => {
      const sections = provider.parseLogSections('')
      expect(sections).toHaveLength(1)
      expect(sections[0].name).toBe('')
      expect(sections[0].lines).toEqual([''])
    })

    it('handles log with no groups', () => {
      const log = 'line 1\nline 2\nline 3'
      const sections = provider.parseLogSections(log)
      expect(sections).toHaveLength(1)
      expect(sections[0].name).toBe('')
      expect(sections[0].collapsed).toBe(false)
      expect(sections[0].lines).toEqual(['line 1', 'line 2', 'line 3'])
    })

    it('handles unclosed group at end of log', () => {
      const log = [
        '##[group]Final step',
        'still running...',
        'more output'
      ].join('\n')

      const sections = provider.parseLogSections(log)
      expect(sections).toHaveLength(1)
      expect(sections[0].name).toBe('Final step')
      expect(sections[0].collapsed).toBe(true)
      expect(sections[0].lines).toEqual(['still running...', 'more output'])
    })

    it('handles consecutive groups without gaps', () => {
      const log = [
        '##[group]Step 1',
        'output 1',
        '##[endgroup]',
        '##[group]Step 2',
        'output 2',
        '##[endgroup]'
      ].join('\n')

      const sections = provider.parseLogSections(log)
      expect(sections).toHaveLength(2)
      expect(sections[0].name).toBe('Step 1')
      expect(sections[1].name).toBe('Step 2')
    })

    it('pushes prior section when a new group starts before endgroup', () => {
      const log = [
        '##[group]Outer',
        'outer line',
        '##[group]Inner',
        'inner line',
        '##[endgroup]'
      ].join('\n')

      const sections = provider.parseLogSections(log)
      expect(sections.length).toBeGreaterThanOrEqual(2)
      expect(sections[0].name).toBe('Outer')
      expect(sections[0].lines).toEqual(['outer line'])
      expect(sections[1].name).toBe('Inner')
      expect(sections[1].lines).toEqual(['inner line'])
    })
  })

  describe('getSetupStatus', () => {
    it('returns steps with expected IDs', async () => {
      const status = await provider.getSetupStatus('/fake/project')
      expect(status.providerName).toBe('GitHub Actions')
      expect(status.steps.length).toBe(3)
      expect(status.steps.map((s) => s.id)).toEqual([
        'cli-installed',
        'cli-authenticated',
        'remote-configured'
      ])
    })

    it('marks cli-installed as missing when gh is not found', async () => {
      const status = await provider.getSetupStatus('/fake/project')
      expect(status.steps[0].status).toBe('missing')
      expect(status.ready).toBe(false)
    })

    it('marks all downstream steps as missing when CLI not installed', async () => {
      const status = await provider.getSetupStatus('/fake/project')
      expect(status.steps[1].status).toBe('missing') // cli-authenticated
      expect(status.steps[2].status).toBe('missing') // remote-configured
    })
  })

  describe('runSetupAction', () => {
    it('returns error for unknown action', async () => {
      const result = await provider.runSetupAction('/fake', 'unknown-action')
      expect(result.success).toBe(false)
      expect(result.error).toBe('Unknown action')
    })
  })
})
