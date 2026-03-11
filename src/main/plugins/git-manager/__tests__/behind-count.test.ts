import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'

vi.mock('../../../logger', () => ({
  log: () => {},
  logInfo: () => {},
  logError: () => {}
}))

import { createTestRepo, createBareRemote, commitFile, run, gitRun, writeFile, type TestRepo } from './setup'
import { getBehindCount, getStatus } from '../git-operations'

describe('getBehindCount', () => {
  let repo: TestRepo
  let bareDir: string
  let otherClone: string

  beforeEach(() => {
    repo = createTestRepo()
    bareDir = createBareRemote()
    commitFile(repo.cwd, 'init.txt', 'init', 'initial commit')
    run(repo.cwd, 'git', ['remote', 'add', 'origin', bareDir])
    run(repo.cwd, 'git', ['push', '-u', 'origin', 'master'])
    // Create another clone to push ahead commits from
    const path = require('path')
    otherClone = path.join(repo.cwd, '..', 'behind-other-' + Date.now())
    gitRun(repo.cwd, ['clone', bareDir, otherClone])
    run(otherClone, 'git', ['config', 'user.email', 'other@test.com'])
    run(otherClone, 'git', ['config', 'user.name', 'Other User'])
  })
  afterEach(() => {
    repo.cleanup()
    fs.rmSync(bareDir, { recursive: true, force: true })
    fs.rmSync(otherClone, { recursive: true, force: true })
  })

  it('returns 0 when branch is up to date', async () => {
    const count = await getBehindCount(repo.cwd)
    expect(count).toBe(0)
  })

  it('returns behind count when remote has new commits', async () => {
    // Push commits from the other clone
    writeFile(otherClone, 'remote1.txt', 'remote1')
    run(otherClone, 'git', ['add', '.'])
    run(otherClone, 'git', ['commit', '-m', 'remote commit 1'])
    writeFile(otherClone, 'remote2.txt', 'remote2')
    run(otherClone, 'git', ['add', '.'])
    run(otherClone, 'git', ['commit', '-m', 'remote commit 2'])
    run(otherClone, 'git', ['push'])
    // Fetch so our repo knows about the remote commits
    run(repo.cwd, 'git', ['fetch'])
    const count = await getBehindCount(repo.cwd)
    expect(count).toBe(2)
  })

  it('returns 0 when there is no tracking branch', async () => {
    // Create a new local-only branch
    run(repo.cwd, 'git', ['checkout', '-b', 'local-only'])
    commitFile(repo.cwd, 'local.txt', 'local', 'local commit')
    const count = await getBehindCount(repo.cwd)
    expect(count).toBe(0)
  })

  it('returns 0 for repo with no remote', async () => {
    const localRepo = createTestRepo()
    try {
      commitFile(localRepo.cwd, 'file.txt', 'content', 'init')
      const count = await getBehindCount(localRepo.cwd)
      expect(count).toBe(0)
    } finally {
      localRepo.cleanup()
    }
  })

  it('behind count is consistent with getStatus', async () => {
    writeFile(otherClone, 'ahead.txt', 'ahead')
    run(otherClone, 'git', ['add', '.'])
    run(otherClone, 'git', ['commit', '-m', 'ahead commit'])
    run(otherClone, 'git', ['push'])
    run(repo.cwd, 'git', ['fetch'])
    const behindCount = await getBehindCount(repo.cwd)
    const status = await getStatus(repo.cwd)
    expect(behindCount).toBe(status.behind)
  })

  it('returns correct count with both ahead and behind', async () => {
    // Push from other clone (makes us behind)
    writeFile(otherClone, 'remote.txt', 'remote')
    run(otherClone, 'git', ['add', '.'])
    run(otherClone, 'git', ['commit', '-m', 'remote commit'])
    run(otherClone, 'git', ['push'])
    // Make a local commit (makes us ahead)
    commitFile(repo.cwd, 'local.txt', 'local', 'local commit')
    run(repo.cwd, 'git', ['fetch'])
    const count = await getBehindCount(repo.cwd)
    expect(count).toBe(1)
    const status = await getStatus(repo.cwd)
    expect(status.ahead).toBe(1)
    expect(status.behind).toBe(1)
  })
})
