import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockExecFile } = vi.hoisted(() => {
  const fn: any = vi.fn()
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
  execFileSync: vi.fn().mockReturnValue('gh\n'),
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

import { IssueProviderRegistry } from '../issue-provider-registry'
import { GitHubIssueProvider } from '../github-issue-provider'
import { GitLabIssueProvider } from '../gitlab-issue-provider'

function mockGitRemote(url: string): void {
  mockExecFile.mockImplementation((cmd: string, args: string[], _opts: unknown, cb: Function) => {
    if (cmd === 'git' && args.includes('remote')) {
      cb(null, url + '\n', '')
      return {} as any
    }
    cb(null, '', '')
    return {} as any
  })
}

describe('IssueProviderRegistry', () => {
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
    IssueProviderRegistry.getInstance().invalidateAll()
  })

  it('returns GitHubIssueProvider for github.com remotes', async () => {
    mockGitRemote('https://github.com/org/repo.git')
    const provider = await IssueProviderRegistry.getInstance().resolve('/repo1')
    expect(provider).toBeInstanceOf(GitHubIssueProvider)
    expect(provider?.providerKey).toBe('github')
  })

  it('returns GitLabIssueProvider for gitlab.com remotes', async () => {
    mockGitRemote('git@gitlab.com:group/proj.git')
    const provider = await IssueProviderRegistry.getInstance().resolve('/repo2')
    expect(provider).toBeInstanceOf(GitLabIssueProvider)
    expect(provider?.providerKey).toBe('gitlab')
  })

  it('returns null for bitbucket remotes (skipped in v1)', async () => {
    mockGitRemote('git@bitbucket.org:team/proj.git')
    const provider = await IssueProviderRegistry.getInstance().resolve('/repo3')
    expect(provider).toBeNull()
  })

  it('returns null for unsupported remotes', async () => {
    mockGitRemote('git@self-hosted.example.com:foo/bar.git')
    const provider = await IssueProviderRegistry.getInstance().resolve('/repo4')
    // detectProvider falls back to 'generic' for unknown hosts — createProvider returns null
    expect(provider).toBeNull()
  })

  it('caches the resolved provider by projectDir', async () => {
    mockGitRemote('https://github.com/org/repo.git')
    const registry = IssueProviderRegistry.getInstance()
    const first = await registry.resolve('/cached')
    // Change the mock to something else; cache should still return the first
    mockGitRemote('git@gitlab.com:group/proj.git')
    const second = await registry.resolve('/cached')
    expect(second).toBe(first)
  })

  it('invalidate clears the cache for a specific project', async () => {
    mockGitRemote('https://github.com/org/repo.git')
    const registry = IssueProviderRegistry.getInstance()
    await registry.resolve('/proj')
    registry.invalidate('/proj')
    mockGitRemote('git@gitlab.com:group/proj.git')
    const after = await registry.resolve('/proj')
    expect(after).toBeInstanceOf(GitLabIssueProvider)
  })
})
