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

import { GitLabIssueProvider } from '../gitlab-issue-provider'

function mockGlabCommand(responses: Array<{ match: string; stdout?: string; error?: Error }>): void {
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
  iid: 7,
  title: 'Question: how to configure X?',
  state: 'opened',
  description: 'Need help understanding the config.',
  author: { username: 'alice', name: 'Alice' },
  assignees: [{ username: 'bob' }],
  labels: ['question', 'support'],
  milestone: { iid: 2, title: 'Q1', state: 'active', due_date: null },
  user_notes_count: 3,
  created_at: '2026-03-01T10:00:00Z',
  updated_at: '2026-03-04T08:00:00Z',
  closed_at: null,
  web_url: 'https://gitlab.com/group/proj/-/issues/7'
}

describe('GitLabIssueProvider', () => {
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
    it('normalizes glab issue list JSON', async () => {
      mockGlabCommand([{ match: 'issue list', stdout: JSON.stringify([SAMPLE_ISSUE]) }])
      const provider = new GitLabIssueProvider()
      const issues = await provider.listIssues('/repo', 'open')
      expect(issues).toHaveLength(1)
      const i = issues[0]
      expect(i.id).toBe(7) // iid
      expect(i.state).toBe('open') // 'opened' -> 'open'
      expect(i.body).toBe('Need help understanding the config.')
      expect(i.author.login).toBe('alice')
      expect(i.assignees[0].login).toBe('bob')
      expect(i.labels.map((l) => l.name)).toEqual(['question', 'support'])
      expect(i.milestone?.title).toBe('Q1')
      expect(i.commentsCount).toBe(3)
      expect(i.url).toBe('https://gitlab.com/group/proj/-/issues/7')
    })

    it('treats closed state correctly', async () => {
      const closed = { ...SAMPLE_ISSUE, state: 'closed', closed_at: '2026-03-05' }
      mockGlabCommand([{ match: 'issue list', stdout: JSON.stringify([closed]) }])
      const provider = new GitLabIssueProvider()
      const [issue] = await provider.listIssues('/repo', 'closed')
      expect(issue.state).toBe('closed')
      expect(issue.closedAt).toBe('2026-03-05')
    })

    it('handles label objects (not just strings)', async () => {
      const objLabels = {
        ...SAMPLE_ISSUE,
        labels: [{ name: 'bug', color: '#ff0000', description: 'broken' }]
      }
      mockGlabCommand([{ match: 'issue list', stdout: JSON.stringify([objLabels]) }])
      const provider = new GitLabIssueProvider()
      const [issue] = await provider.listIssues('/repo')
      expect(issue.labels[0].name).toBe('bug')
      expect(issue.labels[0].color).toBe('ff0000') // leading # stripped
    })

    it('returns empty array on glab error', async () => {
      mockGlabCommand([{ match: 'issue list', error: new Error('glab not authed') }])
      const provider = new GitLabIssueProvider()
      const issues = await provider.listIssues('/repo')
      expect(issues).toEqual([])
    })
  })

  describe('getIssue', () => {
    it('returns a single normalized issue', async () => {
      mockGlabCommand([{ match: 'issue view 7', stdout: JSON.stringify(SAMPLE_ISSUE) }])
      const provider = new GitLabIssueProvider()
      const issue = await provider.getIssue('/repo', 7)
      expect(issue?.id).toBe(7)
      expect(issue?.title).toBe('Question: how to configure X?')
    })

    it('returns null on error', async () => {
      mockGlabCommand([{ match: 'issue view', error: new Error('not found') }])
      const provider = new GitLabIssueProvider()
      const issue = await provider.getIssue('/repo', 99)
      expect(issue).toBeNull()
    })
  })
})
