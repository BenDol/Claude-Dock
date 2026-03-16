import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../services', () => ({
  getServices: () => ({
    log: () => {},
    logInfo: () => {},
    logError: () => {}
  })
}))

import { createTestRepo, commitFile, run, type TestRepo } from './setup'
import {
  getBranches,
  createBranch,
  deleteBranch,
  renameBranch,
  checkoutBranch
} from '../git-operations'

describe('getBranches', () => {
  let repo: TestRepo

  beforeEach(() => { repo = createTestRepo() })
  afterEach(() => { repo.cleanup() })

  it('lists the current branch', async () => {
    const branches = await getBranches(repo.cwd)
    const current = branches.find((b) => b.current)
    expect(current).toBeDefined()
    expect(current!.remote).toBe(false)
  })

  it('lists multiple local branches', async () => {
    commitFile(repo.cwd, 'a.txt', 'a', 'init')
    run(repo.cwd, 'git', ['branch', 'feature-a'])
    run(repo.cwd, 'git', ['branch', 'feature-b'])
    const branches = await getBranches(repo.cwd)
    const localNames = branches.filter((b) => !b.remote).map((b) => b.name)
    expect(localNames).toContain('feature-a')
    expect(localNames).toContain('feature-b')
  })

  it('identifies which branch is current', async () => {
    commitFile(repo.cwd, 'a.txt', 'a', 'init')
    run(repo.cwd, 'git', ['checkout', '-b', 'new-branch'])
    const branches = await getBranches(repo.cwd)
    const current = branches.find((b) => b.current)
    expect(current!.name).toBe('new-branch')
  })
})

describe('createBranch', () => {
  let repo: TestRepo

  beforeEach(() => { repo = createTestRepo() })
  afterEach(() => { repo.cleanup() })

  it('creates a new branch from HEAD', async () => {
    commitFile(repo.cwd, 'a.txt', 'a', 'init')
    await createBranch(repo.cwd, 'my-feature')
    const branches = await getBranches(repo.cwd)
    const found = branches.find((b) => b.name === 'my-feature')
    expect(found).toBeDefined()
    expect(found!.current).toBe(true) // createBranch uses checkout -b
  })

  it('creates a branch from a specific commit', async () => {
    const hash1 = commitFile(repo.cwd, 'a.txt', 'a', 'first')
    commitFile(repo.cwd, 'b.txt', 'b', 'second')
    // Go back to master/main first
    const currentBranch = run(repo.cwd, 'git', ['rev-parse', '--abbrev-ref', 'HEAD'])
    await createBranch(repo.cwd, 'from-first', hash1)
    const headHash = run(repo.cwd, 'git', ['rev-parse', 'HEAD'])
    expect(headHash).toBe(hash1)
    // Switch back
    await checkoutBranch(repo.cwd, currentBranch)
  })

  it('throws on duplicate branch name', async () => {
    commitFile(repo.cwd, 'a.txt', 'a', 'init')
    await createBranch(repo.cwd, 'dup-branch')
    await checkoutBranch(repo.cwd, 'master').catch(() =>
      checkoutBranch(repo.cwd, run(repo.cwd, 'git', ['branch', '--list']).split('\n').map(b => b.trim().replace('* ', '')).find(b => b !== 'dup-branch')!)
    )
    await expect(createBranch(repo.cwd, 'dup-branch')).rejects.toThrow()
  })
})

describe('deleteBranch', () => {
  let repo: TestRepo

  beforeEach(() => { repo = createTestRepo() })
  afterEach(() => { repo.cleanup() })

  it('deletes a merged branch', async () => {
    commitFile(repo.cwd, 'a.txt', 'a', 'init')
    run(repo.cwd, 'git', ['branch', 'to-delete'])
    await deleteBranch(repo.cwd, 'to-delete')
    const branches = await getBranches(repo.cwd)
    expect(branches.find((b) => b.name === 'to-delete')).toBeUndefined()
  })

  it('force deletes an unmerged branch', async () => {
    commitFile(repo.cwd, 'a.txt', 'a', 'init')
    run(repo.cwd, 'git', ['checkout', '-b', 'unmerged'])
    commitFile(repo.cwd, 'b.txt', 'b', 'unmerged commit')
    const mainBranch = run(repo.cwd, 'git', ['branch', '--list']).split('\n')
      .map(b => b.trim().replace('* ', '')).find(b => b !== 'unmerged')!
    run(repo.cwd, 'git', ['checkout', mainBranch])
    // Normal delete should fail
    await expect(deleteBranch(repo.cwd, 'unmerged')).rejects.toThrow()
    // Force delete should work
    await deleteBranch(repo.cwd, 'unmerged', true)
    const branches = await getBranches(repo.cwd)
    expect(branches.find((b) => b.name === 'unmerged')).toBeUndefined()
  })
})

describe('renameBranch', () => {
  let repo: TestRepo

  beforeEach(() => { repo = createTestRepo() })
  afterEach(() => { repo.cleanup() })

  it('renames a branch', async () => {
    commitFile(repo.cwd, 'a.txt', 'a', 'init')
    run(repo.cwd, 'git', ['branch', 'old-name'])
    await renameBranch(repo.cwd, 'old-name', 'new-name')
    const branches = await getBranches(repo.cwd)
    expect(branches.find((b) => b.name === 'old-name')).toBeUndefined()
    expect(branches.find((b) => b.name === 'new-name')).toBeDefined()
  })
})

describe('checkoutBranch', () => {
  let repo: TestRepo

  beforeEach(() => { repo = createTestRepo() })
  afterEach(() => { repo.cleanup() })

  it('switches to another branch', async () => {
    commitFile(repo.cwd, 'a.txt', 'a', 'init')
    run(repo.cwd, 'git', ['branch', 'other'])
    await checkoutBranch(repo.cwd, 'other')
    const branches = await getBranches(repo.cwd)
    const current = branches.find((b) => b.current)
    expect(current!.name).toBe('other')
  })

  it('throws on nonexistent branch', async () => {
    await expect(checkoutBranch(repo.cwd, 'nonexistent')).rejects.toThrow()
  })
})
