import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockExecFile, mockExecFileSync } = vi.hoisted(() => {
  const fn: any = vi.fn()
  fn[Symbol.for('nodejs.util.promisify.custom')] = async (...args: any[]) => {
    return new Promise((resolve, reject) => {
      fn(...args, (err: any, stdout: string, stderr: string) => {
        if (err) reject(err)
        else resolve({ stdout, stderr })
      })
    })
  }
  return { mockExecFile: fn, mockExecFileSync: vi.fn().mockReturnValue('glab\n') }
})

vi.mock('child_process', () => ({
  execFile: mockExecFile,
  execFileSync: mockExecFileSync,
  spawn: vi.fn().mockReturnValue({ unref: vi.fn() })
}))

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(false)
}))

vi.mock('../../services', () => ({
  getServices: () => ({
    log: vi.fn(),
    logInfo: vi.fn(),
    logError: vi.fn()
  })
}))

import { GitLabMrProvider } from '../gitlab-mr-provider'

function mockGlabCommand(responses: Record<string, { stdout?: string; error?: Error }>): void {
  mockExecFile.mockImplementation((cmd: string, args: string[], _opts: unknown, cb: Function) => {
    const key = args.join(' ')
    for (const [pattern, response] of Object.entries(responses)) {
      if (key.includes(pattern)) {
        if (response.error) cb(response.error, '', response.error.message)
        else cb(null, response.stdout || '', '')
        return {} as any
      }
    }
    cb(null, '', '')
    return {} as any
  })
}

const SAMPLE_MR_JSON = [
  {
    iid: 10,
    title: 'feat: add dashboard',
    state: 'opened',
    source_branch: 'feature/dashboard',
    target_branch: 'main',
    author: { username: 'alice' },
    web_url: 'https://gitlab.com/team/project/-/merge_requests/10',
    created_at: '2026-03-01T10:00:00Z',
    updated_at: '2026-03-02T15:00:00Z',
    draft: false,
    description: 'New dashboard feature',
    labels: ['feature', 'ui']
  },
  {
    iid: 11,
    title: 'Draft: refactor auth',
    state: 'opened',
    source_branch: 'refactor/auth',
    target_branch: 'develop',
    author: { username: 'bob' },
    web_url: 'https://gitlab.com/team/project/-/merge_requests/11',
    created_at: '2026-03-03T08:00:00Z',
    updated_at: '2026-03-03T09:00:00Z',
    draft: true,
    description: '',
    labels: []
  }
]

describe('GitLabMrProvider', () => {
  let provider: GitLabMrProvider

  beforeEach(() => {
    vi.clearAllMocks()
    provider = new GitLabMrProvider()
  })

  describe('isAvailable', () => {
    it('returns true when glab is authenticated and repo exists', async () => {
      mockGlabCommand({
        'auth status': { stdout: 'Logged in' },
        'repo view': { stdout: '{}' }
      })
      expect(await provider.isAvailable('/project')).toBe(true)
    })

    it('returns false when glab auth fails', async () => {
      mockGlabCommand({
        'auth status': { error: new Error('not logged in') }
      })
      expect(await provider.isAvailable('/project')).toBe(false)
    })
  })

  describe('listPrs', () => {
    it('returns parsed MRs from glab mr list', async () => {
      mockGlabCommand({
        'mr list': { stdout: JSON.stringify(SAMPLE_MR_JSON) }
      })

      const prs = await provider.listPrs('/project')
      expect(prs).toHaveLength(2)

      expect(prs[0].id).toBe(10)
      expect(prs[0].title).toBe('feat: add dashboard')
      expect(prs[0].state).toBe('open')
      expect(prs[0].sourceBranch).toBe('feature/dashboard')
      expect(prs[0].targetBranch).toBe('main')
      expect(prs[0].author).toBe('alice')
      expect(prs[0].isDraft).toBe(false)
      expect(prs[0].labels).toEqual(['feature', 'ui'])
      expect(prs[0].url).toBe('https://gitlab.com/team/project/-/merge_requests/10')

      expect(prs[1].id).toBe(11)
      expect(prs[1].isDraft).toBe(true)
    })

    it('uses no extra flag for open filter (default)', async () => {
      mockGlabCommand({
        'mr list': { stdout: '[]' }
      })

      await provider.listPrs('/project', 'open')

      const call = mockExecFile.mock.calls.find(
        (c: any[]) => c[1]?.includes('mr') && c[1]?.includes('list')
      )
      // 'open' is the default, no --closed/--merged/--all flag
      expect(call[1]).not.toContain('--closed')
      expect(call[1]).not.toContain('--merged')
      expect(call[1]).not.toContain('--all')
    })

    it('passes --merged for merged filter', async () => {
      mockGlabCommand({
        'mr list': { stdout: '[]' }
      })

      await provider.listPrs('/project', 'merged')

      const call = mockExecFile.mock.calls.find(
        (c: any[]) => c[1]?.includes('mr') && c[1]?.includes('list')
      )
      expect(call[1]).toContain('--merged')
    })

    it('returns empty array on error', async () => {
      mockGlabCommand({
        'mr list': { error: new Error('failed') }
      })
      expect(await provider.listPrs('/project')).toEqual([])
    })
  })

  describe('getPr', () => {
    it('returns parsed MR', async () => {
      mockGlabCommand({
        'mr view': { stdout: JSON.stringify(SAMPLE_MR_JSON[0]) }
      })
      const pr = await provider.getPr('/project', 10)
      expect(pr).not.toBeNull()
      expect(pr!.id).toBe(10)
      expect(pr!.title).toBe('feat: add dashboard')
    })

    it('returns null on error', async () => {
      mockGlabCommand({
        'mr view': { error: new Error('not found') }
      })
      expect(await provider.getPr('/project', 999)).toBeNull()
    })
  })

  describe('createPr', () => {
    it('creates MR via glab mr create', async () => {
      mockGlabCommand({
        'mr create': { stdout: 'https://gitlab.com/team/project/-/merge_requests/12\n' }
      })

      const result = await provider.createPr('/project', {
        title: 'New MR',
        body: 'Description',
        sourceBranch: 'feature/x',
        targetBranch: 'main'
      })

      expect(result.success).toBe(true)
      expect(result.url).toContain('merge_requests/12')
    })

    it('passes --draft when isDraft is true', async () => {
      mockGlabCommand({
        'mr create': { stdout: 'https://gitlab.com/team/project/-/merge_requests/13\n' }
      })

      await provider.createPr('/project', {
        title: 'Draft MR',
        body: '',
        sourceBranch: 'feature/draft',
        targetBranch: 'main',
        isDraft: true
      })

      const call = mockExecFile.mock.calls.find(
        (c: any[]) => c[1]?.includes('mr') && c[1]?.includes('create')
      )
      expect(call[1]).toContain('--draft')
    })

    it('returns failure with fallback URL on error', async () => {
      mockGlabCommand({
        'mr create': { error: new Error('conflict') },
        'repo view': { stdout: JSON.stringify({ web_url: 'https://gitlab.com/team/project' }) }
      })

      const result = await provider.createPr('/project', {
        title: 'Will fail',
        body: '',
        sourceBranch: 'feature/x',
        targetBranch: 'main'
      })

      expect(result.success).toBe(false)
      expect(result.url).toContain('merge_requests/new')
      expect(result.url).toContain('source_branch')
    })
  })

  describe('getDefaultBranch', () => {
    it('returns default_branch from repo view', async () => {
      mockGlabCommand({
        'repo view': { stdout: JSON.stringify({ default_branch: 'develop' }) }
      })
      expect(await provider.getDefaultBranch('/project')).toBe('develop')
    })

    it('returns "main" as fallback', async () => {
      mockGlabCommand({
        'repo view': { error: new Error('failed') }
      })
      expect(await provider.getDefaultBranch('/project')).toBe('main')
    })
  })

  describe('getNewPrUrl', () => {
    it('constructs GitLab new MR URL', async () => {
      mockGlabCommand({
        'repo view': { stdout: JSON.stringify({ web_url: 'https://gitlab.com/team/project' }) }
      })

      const url = await provider.getNewPrUrl('/project', 'feature/x', 'main')
      expect(url).toContain('gitlab.com/team/project/-/merge_requests/new')
      expect(url).toContain('source_branch')
      expect(url).toContain('target_branch')
    })
  })

  describe('state mapping', () => {
    it('maps "opened" to "open"', async () => {
      mockGlabCommand({
        'mr list': { stdout: JSON.stringify([{ ...SAMPLE_MR_JSON[0], state: 'opened' }]) }
      })
      const prs = await provider.listPrs('/project')
      expect(prs[0].state).toBe('open')
    })

    it('maps "closed" to "closed"', async () => {
      mockGlabCommand({
        'mr list': { stdout: JSON.stringify([{ ...SAMPLE_MR_JSON[0], state: 'closed' }]) }
      })
      const prs = await provider.listPrs('/project')
      expect(prs[0].state).toBe('closed')
    })

    it('maps "merged" to "merged"', async () => {
      mockGlabCommand({
        'mr list': { stdout: JSON.stringify([{ ...SAMPLE_MR_JSON[0], state: 'merged' }]) }
      })
      const prs = await provider.listPrs('/project')
      expect(prs[0].state).toBe('merged')
    })
  })

  describe('draft detection', () => {
    it('detects draft from draft field', async () => {
      mockGlabCommand({
        'mr list': { stdout: JSON.stringify([{ ...SAMPLE_MR_JSON[0], draft: true, title: 'Normal title' }]) }
      })
      const prs = await provider.listPrs('/project')
      expect(prs[0].isDraft).toBe(true)
    })

    it('detects draft from "Draft:" title prefix', async () => {
      mockGlabCommand({
        'mr list': { stdout: JSON.stringify([{ ...SAMPLE_MR_JSON[0], draft: false, title: 'Draft: WIP stuff' }]) }
      })
      const prs = await provider.listPrs('/project')
      expect(prs[0].isDraft).toBe(true)
    })
  })
})
