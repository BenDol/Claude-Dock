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
  return { mockExecFile: fn, mockExecFileSync: vi.fn().mockReturnValue('gh\n') }
})

vi.mock('child_process', () => ({
  execFile: mockExecFile,
  execFileSync: mockExecFileSync,
  spawn: vi.fn().mockReturnValue({ unref: vi.fn() })
}))

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn()
}))

vi.mock('../../services', () => ({
  getServices: () => ({
    log: vi.fn(),
    logInfo: vi.fn(),
    logError: vi.fn()
  })
}))

import { GitHubIssueProvider } from '../github-issue-provider'

function mockGhOnce(key: string, stdout: string): void {
  mockExecFile.mockImplementationOnce((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
    expect(args.join(' ')).toContain(key)
    cb(null, stdout, '')
    return {} as any
  })
}

/** Match arg sub-strings so tests survive minor argv reshuffles. */
function mockGhCommand(responses: Array<{ match: string; stdout?: string; error?: Error }>): void {
  mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
    const joined = args.join(' ')
    for (const r of responses) {
      if (joined.includes(r.match)) {
        if (r.error) cb(r.error, '', r.error.message)
        else cb(null, r.stdout || '', '')
        return {} as any
      }
    }
    cb(null, '', '')
    return {} as any
  })
}

const SAMPLE_ISSUE = {
  number: 42,
  title: 'Bug: app crashes on launch',
  state: 'OPEN',
  stateReason: null,
  author: { login: 'alice' },
  assignees: [{ login: 'bob' }, { login: 'carol' }],
  labels: [
    { name: 'bug', color: 'd73a4a', description: 'Something is broken' },
    { name: 'priority-high' }
  ],
  milestone: { number: 3, title: 'v1.0', state: 'open', due_on: null },
  comments: [{ body: 'x' }, { body: 'y' }],
  createdAt: '2026-03-01T10:00:00Z',
  updatedAt: '2026-03-05T14:00:00Z',
  closedAt: null,
  url: 'https://github.com/org/repo/issues/42',
  body: 'Here is the description with **markdown**.'
}

describe('GitHubIssueProvider', () => {
  beforeEach(() => {
    mockExecFile.mockReset()
    mockExecFile[Symbol.for('nodejs.util.promisify.custom')] = async (...args: any[]) => {
      return new Promise((resolve, reject) => {
        mockExecFile(...args, (err: any, stdout: string, stderr: string) => {
          if (err) reject(err)
          else resolve({ stdout, stderr })
        })
      })
    }
  })

  describe('listIssues', () => {
    it('normalizes gh issue list JSON into Issue objects', async () => {
      mockGhCommand([{ match: 'issue list', stdout: JSON.stringify([SAMPLE_ISSUE]) }])
      const provider = new GitHubIssueProvider()
      const issues = await provider.listIssues('/repo', 'open')
      expect(issues).toHaveLength(1)
      const i = issues[0]
      expect(i.id).toBe(42)
      expect(i.title).toBe('Bug: app crashes on launch')
      expect(i.state).toBe('open')
      expect(i.author.login).toBe('alice')
      expect(i.assignees.map((a) => a.login)).toEqual(['bob', 'carol'])
      expect(i.labels.map((l) => l.name)).toEqual(['bug', 'priority-high'])
      expect(i.labels[0].color).toBe('d73a4a')
      expect(i.milestone?.title).toBe('v1.0')
      expect(i.commentsCount).toBe(2)
      expect(i.url).toBe('https://github.com/org/repo/issues/42')
      expect(i.body).toContain('markdown')
    })

    it('returns empty array on gh error (never throws)', async () => {
      mockGhCommand([{ match: 'issue list', error: new Error('gh not authed') }])
      const provider = new GitHubIssueProvider()
      const issues = await provider.listIssues('/repo')
      expect(issues).toEqual([])
    })

    it('handles null/empty assignees/labels/milestone gracefully', async () => {
      const sparse = {
        number: 1,
        title: 'Stub',
        state: 'CLOSED',
        stateReason: 'completed',
        author: { login: 'ghost' },
        assignees: [],
        labels: [],
        milestone: null,
        comments: [],
        createdAt: '', updatedAt: '', closedAt: '2026-01-01', url: '', body: ''
      }
      mockGhCommand([{ match: 'issue list', stdout: JSON.stringify([sparse]) }])
      const provider = new GitHubIssueProvider()
      const [issue] = await provider.listIssues('/repo', 'closed')
      expect(issue.state).toBe('closed')
      expect(issue.stateReason).toBe('completed')
      expect(issue.assignees).toEqual([])
      expect(issue.labels).toEqual([])
      expect(issue.milestone).toBeNull()
      expect(issue.commentsCount).toBe(0)
    })
  })

  describe('getIssue', () => {
    it('returns a single normalized issue', async () => {
      mockGhCommand([{ match: 'issue view 42', stdout: JSON.stringify(SAMPLE_ISSUE) }])
      const provider = new GitHubIssueProvider()
      const issue = await provider.getIssue('/repo', 42)
      expect(issue?.id).toBe(42)
      expect(issue?.title).toBe('Bug: app crashes on launch')
    })

    it('returns null on gh error', async () => {
      mockGhCommand([{ match: 'issue view', error: new Error('not found') }])
      const provider = new GitHubIssueProvider()
      const issue = await provider.getIssue('/repo', 42)
      expect(issue).toBeNull()
    })
  })

  describe('listLabels (cached)', () => {
    it('returns label metadata from gh label list', async () => {
      mockGhCommand([{
        match: 'label list',
        stdout: JSON.stringify([
          { name: 'bug', color: 'd73a4a', description: 'broken' },
          { name: 'enhancement', color: 'a2eeef', description: 'new' }
        ])
      }])
      const provider = new GitHubIssueProvider()
      const labels = await provider.listLabels('/repo')
      expect(labels).toHaveLength(2)
      expect(labels[0]).toEqual({ name: 'bug', color: 'd73a4a', description: 'broken' })
    })
  })
})
