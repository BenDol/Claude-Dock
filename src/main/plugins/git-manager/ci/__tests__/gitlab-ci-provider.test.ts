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

import { GitLabCiProvider } from '../gitlab-ci-provider'

describe('GitLabCiProvider', () => {
  let provider: GitLabCiProvider

  beforeEach(() => {
    vi.clearAllMocks()
    provider = new GitLabCiProvider()
  })

  describe('identity', () => {
    it('has correct name', () => {
      expect(provider.name).toBe('GitLab CI')
    })

    it('has correct providerKey', () => {
      expect(provider.providerKey).toBe('gitlab')
    })
  })

  describe('getWorkflows', () => {
    it('returns a single synthetic "All Pipelines" workflow', async () => {
      const workflows = await provider.getWorkflows('/fake/project')
      expect(workflows).toHaveLength(1)
      expect(workflows[0]).toEqual({
        id: 0,
        name: 'All Pipelines',
        path: '',
        state: 'active'
      })
    })
  })

  describe('parseLogSections', () => {
    it('parses GitLab section_start/section_end markers', () => {
      const log = [
        'section_start:1234567890:prepare_script\r\x1b[0KPrepare Script',
        'Getting source from Git repository',
        'Fetching changes...',
        'section_end:1234567890:prepare_script\r\x1b[0K',
        'section_start:1234567891:build\r\x1b[0KBuild',
        'Running build step...',
        'section_end:1234567891:build\r\x1b[0K'
      ].join('\n')

      const sections = provider.parseLogSections(log)
      expect(sections.length).toBeGreaterThanOrEqual(2)

      const prepSection = sections.find((s) => s.lines.some((l) => l.includes('Getting source')))
      expect(prepSection).toBeDefined()
      expect(prepSection!.collapsed).toBe(true)

      const buildSection = sections.find((s) => s.lines.some((l) => l.includes('Running build')))
      expect(buildSection).toBeDefined()
      expect(buildSection!.collapsed).toBe(true)
    })

    it('falls back to $ command detection for logs without section markers', () => {
      const log = [
        '$ npm ci',
        'added 500 packages',
        '$ npm test',
        'PASS src/test.ts',
        'Tests: 10 passed'
      ].join('\n')

      const sections = provider.parseLogSections(log)
      expect(sections.length).toBeGreaterThanOrEqual(2)

      const npmCiSection = sections.find((s) => s.name === 'npm ci')
      expect(npmCiSection).toBeDefined()

      const npmTestSection = sections.find((s) => s.name === 'npm test')
      expect(npmTestSection).toBeDefined()
    })

    it('handles plain text log without markers', () => {
      const log = 'line 1\nline 2\nline 3'
      const sections = provider.parseLogSections(log)
      expect(sections.length).toBeGreaterThanOrEqual(1)
      const allLines = sections.flatMap((s) => s.lines)
      expect(allLines).toContain('line 1')
      expect(allLines).toContain('line 2')
      expect(allLines).toContain('line 3')
    })

    it('handles empty log', () => {
      const sections = provider.parseLogSections('')
      expect(sections.length).toBeGreaterThanOrEqual(1)
    })

    it('strips ANSI escape codes from content', () => {
      const log = [
        'section_start:123:test\r\x1b[0KTest Section',
        '\x1b[32mPASS\x1b[0m some test',
        'section_end:123:test\r\x1b[0K'
      ].join('\n')

      const sections = provider.parseLogSections(log)
      const testSection = sections.find((s) => s.lines.some((l) => l.includes('PASS')))
      expect(testSection).toBeDefined()
      const passLine = testSection!.lines.find((l) => l.includes('PASS'))
      expect(passLine).not.toContain('\x1b[')
    })

    it('handles unclosed section at end of log', () => {
      const log = [
        'section_start:123:running\r\x1b[0KStill Running',
        'ongoing output...',
        'more output'
      ].join('\n')

      const sections = provider.parseLogSections(log)
      const runningSection = sections.find((s) => s.lines.some((l) => l.includes('ongoing')))
      expect(runningSection).toBeDefined()
    })

    it('handles mixed section markers and $ commands', () => {
      const log = [
        'section_start:123:setup\r\x1b[0KSetup',
        'setting up...',
        'section_end:123:setup\r\x1b[0K',
        '$ echo hello',
        'hello'
      ].join('\n')

      const sections = provider.parseLogSections(log)
      expect(sections.length).toBeGreaterThanOrEqual(2)
    })
  })

  describe('getSetupStatus', () => {
    it('returns steps with expected IDs', async () => {
      const status = await provider.getSetupStatus('/fake/project')
      expect(status.providerName).toBe('GitLab CI')
      expect(status.steps.length).toBe(3)
      expect(status.steps.map((s) => s.id)).toEqual([
        'cli-installed',
        'cli-authenticated',
        'remote-configured'
      ])
    })

    it('marks cli-installed as missing when glab is not found', async () => {
      const status = await provider.getSetupStatus('/fake/project')
      expect(status.steps[0].status).toBe('missing')
      expect(status.ready).toBe(false)
    })

    it('marks all downstream steps as missing when CLI not installed', async () => {
      const status = await provider.getSetupStatus('/fake/project')
      expect(status.steps[1].status).toBe('missing')
      expect(status.steps[2].status).toBe('missing')
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
