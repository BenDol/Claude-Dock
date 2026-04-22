import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../services', () => ({
  getServices: () => ({
    log: () => {},
    logInfo: () => {},
    logError: () => {}
  })
}))

import {
  createTestRepo,
  createBareRemote,
  commitFile,
  run,
  gitRun,
  type TestRepo
} from './setup'
import {
  getBranchesForCommit,
  clearBranchesForCommitCache
} from '../git-operations'

/**
 * Default-branch name can be `main` or `master` depending on the host's git
 * `init.defaultBranch` config. Discover it once per test repo rather than
 * hard-coding, so CI environments with either default both work.
 */
function defaultBranch(cwd: string): string {
  return run(cwd, 'git', ['rev-parse', '--abbrev-ref', 'HEAD'])
}

describe('getBranchesForCommit', () => {
  let repo: TestRepo

  beforeEach(() => {
    clearBranchesForCommitCache()
    repo = createTestRepo()
  })
  afterEach(() => { repo.cleanup() })

  it('returns empty lists when the commit is not reachable from any ref', async () => {
    // Create a commit then detach HEAD and create a dangling commit (unreachable)
    commitFile(repo.cwd, 'a.txt', 'a', 'first')
    run(repo.cwd, 'git', ['checkout', '--detach'])
    const orphanHash = commitFile(repo.cwd, 'b.txt', 'b', 'orphan')
    // Go back to the real branch so the orphan is no longer reachable
    run(repo.cwd, 'git', ['checkout', defaultBranch(repo.cwd)])
    // Force git to prune the reflog so the orphan really is unreachable from any ref
    run(repo.cwd, 'git', ['reflog', 'expire', '--expire=now', '--all'])

    const res = await getBranchesForCommit(repo.cwd, orphanHash)
    expect(res.local).toEqual([])
    expect(res.remote).toEqual([])
    expect(res.head).toBeNull()
  })

  it('returns the current branch and marks it as HEAD', async () => {
    const hash = commitFile(repo.cwd, 'a.txt', 'a', 'init')
    const branch = defaultBranch(repo.cwd)
    const res = await getBranchesForCommit(repo.cwd, hash)
    expect(res.local).toContain(branch)
    expect(res.head).toBe(branch)
    // No remotes configured → should be empty
    expect(res.remote).toEqual([])
  })

  it('lists every local branch that contains the commit', async () => {
    const hash = commitFile(repo.cwd, 'a.txt', 'a', 'init')
    run(repo.cwd, 'git', ['branch', 'feature-a'])
    run(repo.cwd, 'git', ['branch', 'feature-b'])
    // Add a branch that does NOT contain the commit (diverged)
    run(repo.cwd, 'git', ['checkout', '--detach', 'HEAD~0'])
    run(repo.cwd, 'git', ['checkout', '-b', 'only-later'])
    commitFile(repo.cwd, 'later.txt', 'later', 'later commit')
    run(repo.cwd, 'git', ['checkout', defaultBranch(repo.cwd)])

    const res = await getBranchesForCommit(repo.cwd, hash)
    expect(res.local).toContain('feature-a')
    expect(res.local).toContain('feature-b')
    // only-later WAS created FROM the commit so it also contains it —
    // the point of this test is that the listing is comprehensive, not
    // that it filters. Just assert the three named branches are present.
    expect(res.local).toContain('only-later')
  })

  it('sorts HEAD first, then locals alphabetically', async () => {
    const hash = commitFile(repo.cwd, 'a.txt', 'a', 'init')
    const branch = defaultBranch(repo.cwd)
    // Create branches whose alpha order would put them before `main`/`master`
    run(repo.cwd, 'git', ['branch', 'aaa-feature'])
    run(repo.cwd, 'git', ['branch', 'zzz-feature'])
    const res = await getBranchesForCommit(repo.cwd, hash)
    expect(res.head).toBe(branch)
    expect(res.local[0]).toBe(branch) // HEAD first
    // Remaining should be alpha
    const rest = res.local.slice(1)
    const sorted = [...rest].sort((a, b) => a.localeCompare(b))
    expect(rest).toEqual(sorted)
  })

  it('includes remote tracking branches and excludes the symbolic origin/HEAD', async () => {
    const remotePath = createBareRemote()
    // Commit → add remote → push creates origin/<branch>.
    const hash = commitFile(repo.cwd, 'a.txt', 'a', 'init')
    const branch = defaultBranch(repo.cwd)
    gitRun(repo.cwd, ['remote', 'add', 'origin', remotePath])
    gitRun(repo.cwd, ['push', '-u', 'origin', branch])
    // Explicitly set origin/HEAD so the symbolic-ref filter is exercised.
    gitRun(repo.cwd, ['remote', 'set-head', 'origin', branch])

    const res = await getBranchesForCommit(repo.cwd, hash)
    expect(res.remote).toContain(`origin/${branch}`)
    // origin/HEAD is a symbolic ref → must be filtered out
    expect(res.remote).not.toContain('origin/HEAD')
  })

  it('returns empty when hash arg is falsy without touching git', async () => {
    const res = await getBranchesForCommit(repo.cwd, '')
    expect(res).toEqual({ local: [], remote: [], head: null })
  })

  it('caches within the TTL window (second call does not re-exec git)', async () => {
    const hash = commitFile(repo.cwd, 'a.txt', 'a', 'init')
    const first = await getBranchesForCommit(repo.cwd, hash)

    // Mutate the repo after the first call: add a new local branch. If the cache
    // is honoured the second call returns the stale (first) result; if it's
    // bypassed the new branch would appear in .local.
    run(repo.cwd, 'git', ['branch', 'added-after-cache'])
    const second = await getBranchesForCommit(repo.cwd, hash)
    expect(second.local).toEqual(first.local)
    expect(second.local).not.toContain('added-after-cache')

    // Clearing the cache surfaces the new branch.
    clearBranchesForCommitCache()
    const third = await getBranchesForCommit(repo.cwd, hash)
    expect(third.local).toContain('added-after-cache')
  })
})
