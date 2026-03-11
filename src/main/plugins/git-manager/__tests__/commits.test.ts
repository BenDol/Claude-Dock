import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../../../logger', () => ({
  log: () => {},
  logInfo: () => {},
  logError: () => {}
}))

import { createTestRepo, commitFile, writeFile, run, type TestRepo } from './setup'
import {
  createCommit,
  resetBranch,
  revertCommit,
  cherryPick,
  getLog,
  stageFiles,
  getStatus,
  checkoutBranch
} from '../git-operations'

describe('createCommit', () => {
  let repo: TestRepo

  beforeEach(() => { repo = createTestRepo() })
  afterEach(() => { repo.cleanup() })

  it('creates a commit with the given message', async () => {
    writeFile(repo.cwd, 'file.txt', 'content')
    await stageFiles(repo.cwd, ['file.txt'])
    const { hash } = await createCommit(repo.cwd, 'my commit message')
    expect(hash).toMatch(/^[0-9a-f]{40}$/)
    const log = await getLog(repo.cwd, { maxCount: 1 })
    expect(log[0].subject).toBe('my commit message')
  })

  it('creates an empty tree commit when staged files exist', async () => {
    writeFile(repo.cwd, 'a.txt', 'a')
    writeFile(repo.cwd, 'b.txt', 'b')
    await stageFiles(repo.cwd, ['a.txt', 'b.txt'])
    const { hash } = await createCommit(repo.cwd, 'two files')
    expect(hash).toBeTruthy()
    const status = await getStatus(repo.cwd)
    expect(status.staged.length).toBe(0)
  })

  it('throws when nothing is staged', async () => {
    await expect(createCommit(repo.cwd, 'empty')).rejects.toThrow()
  })
})

describe('resetBranch', () => {
  let repo: TestRepo

  beforeEach(() => { repo = createTestRepo() })
  afterEach(() => { repo.cleanup() })

  it('soft reset keeps changes staged', async () => {
    const hash1 = commitFile(repo.cwd, 'a.txt', 'a', 'first')
    commitFile(repo.cwd, 'b.txt', 'b', 'second')
    await resetBranch(repo.cwd, hash1, 'soft')
    const status = await getStatus(repo.cwd)
    expect(status.staged.length).toBeGreaterThan(0)
    const head = run(repo.cwd, 'git', ['rev-parse', 'HEAD'])
    expect(head).toBe(hash1)
  })

  it('mixed reset keeps changes unstaged', async () => {
    const hash1 = commitFile(repo.cwd, 'a.txt', 'a', 'first')
    commitFile(repo.cwd, 'b.txt', 'b', 'second')
    await resetBranch(repo.cwd, hash1, 'mixed')
    const status = await getStatus(repo.cwd)
    expect(status.staged.length).toBe(0)
    // b.txt should show as untracked since it was only in the second commit
    expect(status.untracked.length).toBeGreaterThan(0)
  })

  it('hard reset discards all changes', async () => {
    const hash1 = commitFile(repo.cwd, 'a.txt', 'a', 'first')
    commitFile(repo.cwd, 'b.txt', 'b', 'second')
    await resetBranch(repo.cwd, hash1, 'hard')
    const status = await getStatus(repo.cwd)
    expect(status.staged.length).toBe(0)
    expect(status.unstaged.length).toBe(0)
    expect(status.untracked.length).toBe(0)
  })
})

describe('revertCommit', () => {
  let repo: TestRepo

  beforeEach(() => { repo = createTestRepo() })
  afterEach(() => { repo.cleanup() })

  it('creates a revert commit', async () => {
    commitFile(repo.cwd, 'file.txt', 'content', 'add file')
    const log1 = await getLog(repo.cwd, { maxCount: 1 })
    await revertCommit(repo.cwd, log1[0].hash)
    const log2 = await getLog(repo.cwd, { maxCount: 1 })
    expect(log2[0].subject).toContain('Revert')
  })

  it('reverses the changes of the target commit', async () => {
    commitFile(repo.cwd, 'file.txt', 'to-be-reverted', 'add file')
    const log = await getLog(repo.cwd, { maxCount: 1 })
    await revertCommit(repo.cwd, log[0].hash)
    const fs = await import('fs')
    const path = await import('path')
    expect(fs.existsSync(path.join(repo.cwd, 'file.txt'))).toBe(false)
  })
})

describe('cherryPick', () => {
  let repo: TestRepo

  beforeEach(() => { repo = createTestRepo() })
  afterEach(() => { repo.cleanup() })

  it('applies a commit from another branch', async () => {
    commitFile(repo.cwd, 'base.txt', 'base', 'base commit')
    // Create a feature branch and commit there
    run(repo.cwd, 'git', ['checkout', '-b', 'feature'])
    const featureHash = commitFile(repo.cwd, 'feature.txt', 'feature content', 'feature commit')
    // Go back to original branch
    run(repo.cwd, 'git', ['checkout', '-'])
    await cherryPick(repo.cwd, featureHash)
    const log = await getLog(repo.cwd, { maxCount: 1 })
    expect(log[0].subject).toBe('feature commit')
    const fs = await import('fs')
    const path = await import('path')
    expect(fs.readFileSync(path.join(repo.cwd, 'feature.txt'), 'utf-8')).toBe('feature content')
  })

  it('throws on invalid hash', async () => {
    await expect(cherryPick(repo.cwd, 'deadbeef1234567890')).rejects.toThrow()
  })
})
