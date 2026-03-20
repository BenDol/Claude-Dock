import { describe, it, expect, vi, beforeEach } from 'vitest'

// Hoisted mock for child_process
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
  return { mockExecFile: fn, mockExecFileSync: vi.fn().mockReturnValue('gh\n') }
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

import { GitHubPrProvider } from '../github-pr-provider'

function mockGhCommand(responses: Record<string, { stdout?: string; error?: Error }>): void {
  mockExecFile.mockImplementation((cmd: string, args: string[], _opts: unknown, cb: Function) => {
    const key = args.slice(0, 3).join(' ')
    for (const [pattern, response] of Object.entries(responses)) {
      if (key.includes(pattern) || args.join(' ').includes(pattern)) {
        if (response.error) cb(response.error, '', response.error.message)
        else cb(null, response.stdout || '', '')
        return {} as any
      }
    }
    cb(null, '', '')
    return {} as any
  })
}

const SAMPLE_PR_JSON = [
  {
    number: 42,
    title: 'feat: add login flow',
    state: 'OPEN',
    headRefName: 'feature/login',
    baseRefName: 'main',
    author: { login: 'alice' },
    url: 'https://github.com/user/repo/pull/42',
    createdAt: '2026-03-01T10:00:00Z',
    updatedAt: '2026-03-02T15:00:00Z',
    isDraft: false,
    body: 'Adds the login flow with OAuth',
    labels: [{ name: 'enhancement' }],
    reviewDecision: 'APPROVED'
  },
  {
    number: 43,
    title: 'WIP: dark mode',
    state: 'OPEN',
    headRefName: 'feature/dark-mode',
    baseRefName: 'main',
    author: { login: 'bob' },
    url: 'https://github.com/user/repo/pull/43',
    createdAt: '2026-03-03T08:00:00Z',
    updatedAt: '2026-03-03T09:00:00Z',
    isDraft: true,
    body: '',
    labels: [],
    reviewDecision: null
  }
]

describe('GitHubPrProvider', () => {
  let provider: GitHubPrProvider

  beforeEach(() => {
    vi.clearAllMocks()
    provider = new GitHubPrProvider()
  })

  describe('isAvailable', () => {
    it('returns true when gh is authenticated and repo exists', async () => {
      mockGhCommand({
        'auth status': { stdout: 'Logged in' },
        'repo view': { stdout: 'my-repo' }
      })
      expect(await provider.isAvailable('/project')).toBe(true)
    })

    it('returns false when gh auth fails', async () => {
      mockGhCommand({
        'auth status': { error: new Error('not logged in') }
      })
      expect(await provider.isAvailable('/project')).toBe(false)
    })

    it('returns false when no GitHub remote', async () => {
      mockGhCommand({
        'auth status': { stdout: 'Logged in' },
        'repo view': { error: new Error('no remote') }
      })
      expect(await provider.isAvailable('/project')).toBe(false)
    })
  })

  describe('listPrs', () => {
    it('returns parsed PRs from gh pr list', async () => {
      mockGhCommand({
        'pr list': { stdout: JSON.stringify(SAMPLE_PR_JSON) }
      })

      const prs = await provider.listPrs('/project')
      expect(prs).toHaveLength(2)

      expect(prs[0].id).toBe(42)
      expect(prs[0].title).toBe('feat: add login flow')
      expect(prs[0].state).toBe('open')
      expect(prs[0].sourceBranch).toBe('feature/login')
      expect(prs[0].targetBranch).toBe('main')
      expect(prs[0].author).toBe('alice')
      expect(prs[0].isDraft).toBe(false)
      expect(prs[0].labels).toEqual(['enhancement'])
      expect(prs[0].reviewDecision).toBe('APPROVED')

      expect(prs[1].id).toBe(43)
      expect(prs[1].isDraft).toBe(true)
      expect(prs[1].reviewDecision).toBeNull()
    })

    it('passes state filter to gh pr list', async () => {
      mockGhCommand({
        'pr list': { stdout: '[]' }
      })

      await provider.listPrs('/project', 'merged')

      const callArgs = mockExecFile.mock.calls.find(
        (c: any[]) => c[1]?.includes('pr') && c[1]?.includes('list')
      )
      expect(callArgs[1]).toContain('--state')
      expect(callArgs[1]).toContain('merged')
    })

    it('returns empty array on error', async () => {
      mockGhCommand({
        'pr list': { error: new Error('gh failed') }
      })

      const prs = await provider.listPrs('/project')
      expect(prs).toEqual([])
    })
  })

  describe('getPr', () => {
    it('returns parsed PR from gh pr view', async () => {
      mockGhCommand({
        'pr view': { stdout: JSON.stringify(SAMPLE_PR_JSON[0]) }
      })

      const pr = await provider.getPr('/project', 42)
      expect(pr).not.toBeNull()
      expect(pr!.id).toBe(42)
      expect(pr!.title).toBe('feat: add login flow')
    })

    it('returns null on error', async () => {
      mockGhCommand({
        'pr view': { error: new Error('not found') }
      })

      const pr = await provider.getPr('/project', 999)
      expect(pr).toBeNull()
    })
  })

  describe('createPr', () => {
    it('creates PR and returns success with URL', async () => {
      mockGhCommand({
        'pr create': { stdout: 'https://github.com/user/repo/pull/44\n' },
        'pr view': { stdout: JSON.stringify({ ...SAMPLE_PR_JSON[0], number: 44 }) }
      })

      const result = await provider.createPr('/project', {
        title: 'New feature',
        body: 'Description',
        sourceBranch: 'feature/new',
        targetBranch: 'main'
      })

      expect(result.success).toBe(true)
      expect(result.url).toBe('https://github.com/user/repo/pull/44')
    })

    it('passes --draft flag when isDraft is true', async () => {
      mockGhCommand({
        'pr create': { stdout: 'https://github.com/user/repo/pull/45\n' },
        'pr view': { error: new Error('not needed') }
      })

      await provider.createPr('/project', {
        title: 'Draft PR',
        body: '',
        sourceBranch: 'feature/draft',
        targetBranch: 'main',
        isDraft: true
      })

      const createCall = mockExecFile.mock.calls.find(
        (c: any[]) => c[1]?.includes('pr') && c[1]?.includes('create')
      )
      expect(createCall[1]).toContain('--draft')
    })

    it('returns failure with fallback URL on error', async () => {
      mockGhCommand({
        'pr create': { error: new Error('branch not pushed') },
        'repo view': { stdout: 'https://github.com/user/repo\n' }
      })

      const result = await provider.createPr('/project', {
        title: 'Will fail',
        body: '',
        sourceBranch: 'feature/x',
        targetBranch: 'main'
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('branch not pushed')
      expect(result.url).toContain('github.com/user/repo/compare')
    })
  })

  describe('getDefaultBranch', () => {
    it('returns default branch from gh repo view', async () => {
      mockGhCommand({
        'repo view': { stdout: 'main\n' }
      })

      const branch = await provider.getDefaultBranch('/project')
      expect(branch).toBe('main')
    })

    it('returns "main" as fallback', async () => {
      mockGhCommand({
        'repo view': { error: new Error('failed') }
      })

      const branch = await provider.getDefaultBranch('/project')
      expect(branch).toBe('main')
    })
  })

  describe('getNewPrUrl', () => {
    it('constructs compare URL from repo URL', async () => {
      mockGhCommand({
        'repo view': { stdout: 'https://github.com/user/repo\n' }
      })

      const url = await provider.getNewPrUrl('/project', 'feature/x', 'main')
      expect(url).toBe('https://github.com/user/repo/compare/main...feature%2Fx?expand=1')
    })
  })

  describe('getSetupStatus', () => {
    it('reports all steps ok when fully configured', async () => {
      mockGhCommand({
        '--version': { stdout: 'gh version 2.40.0' },
        'auth status': { stdout: 'Logged in' },
        'repo view': { stdout: 'my-repo' }
      })

      const status = await provider.getSetupStatus('/project')
      expect(status.ready).toBe(true)
      expect(status.steps).toHaveLength(3)
      expect(status.steps.every((s) => s.status === 'ok')).toBe(true)
    })

    it('reports CLI missing when gh not installed', async () => {
      mockGhCommand({
        '--version': { error: new Error('not found') }
      })

      const status = await provider.getSetupStatus('/project')
      expect(status.ready).toBe(false)
      expect(status.steps[0].status).toBe('missing')
    })
  })

  describe('state mapping', () => {
    it('maps OPEN to open', async () => {
      mockGhCommand({
        'pr list': { stdout: JSON.stringify([{ ...SAMPLE_PR_JSON[0], state: 'OPEN' }]) }
      })
      const prs = await provider.listPrs('/project')
      expect(prs[0].state).toBe('open')
    })

    it('maps CLOSED to closed', async () => {
      mockGhCommand({
        'pr list': { stdout: JSON.stringify([{ ...SAMPLE_PR_JSON[0], state: 'CLOSED' }]) }
      })
      const prs = await provider.listPrs('/project')
      expect(prs[0].state).toBe('closed')
    })

    it('maps MERGED to merged', async () => {
      mockGhCommand({
        'pr list': { stdout: JSON.stringify([{ ...SAMPLE_PR_JSON[0], state: 'MERGED' }]) }
      })
      const prs = await provider.listPrs('/project')
      expect(prs[0].state).toBe('merged')
    })
  })
})
