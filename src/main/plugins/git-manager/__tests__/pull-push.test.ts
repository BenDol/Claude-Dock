import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../services', () => ({
  getServices: () => ({
    log: () => {},
    logInfo: () => {},
    logError: () => {}
  })
}))

import { createTestRepo, createBareRemote, commitFile, run, gitRun, writeFile, type TestRepo } from './setup'
import * as fs from 'fs'
import * as path from 'path'
import {
  push,
  pushForceWithLease,
  pull,
  pullAdvanced,
  getLog
} from '../git-operations'

describe('push', () => {
  let repo: TestRepo
  let bareDir: string

  beforeEach(() => {
    repo = createTestRepo()
    bareDir = createBareRemote()
    commitFile(repo.cwd, 'init.txt', 'init', 'initial commit')
    run(repo.cwd, 'git', ['remote', 'add', 'origin', bareDir])
    run(repo.cwd, 'git', ['push', '-u', 'origin', 'master'])
  })
  afterEach(() => {
    repo.cleanup()
    fs.rmSync(bareDir, { recursive: true, force: true })
  })

  it('pushes commits to the remote', async () => {
    commitFile(repo.cwd, 'pushed.txt', 'pushed content', 'push this')
    const result = await push(repo.cwd)
    expect(typeof result).toBe('string')
    // Verify: clone the bare repo and check the commit is there
    const parentDir = path.dirname(repo.cwd)
    const verifyDir = path.join(parentDir, 'verify-' + Date.now())
    try {
      gitRun(parentDir, ['clone', bareDir, verifyDir])
      const content = fs.readFileSync(path.join(verifyDir, 'pushed.txt'), 'utf-8')
      expect(content).toBe('pushed content')
    } finally {
      fs.rmSync(verifyDir, { recursive: true, force: true })
    }
  })

  it('push returns string output', async () => {
    commitFile(repo.cwd, 'file.txt', 'content', 'new commit')
    const result = await push(repo.cwd)
    expect(typeof result).toBe('string')
  })
})

describe('pull', () => {
  let repo: TestRepo
  let bareDir: string
  let otherClone: string

  beforeEach(() => {
    repo = createTestRepo()
    bareDir = createBareRemote()
    commitFile(repo.cwd, 'init.txt', 'init', 'initial commit')
    run(repo.cwd, 'git', ['remote', 'add', 'origin', bareDir])
    run(repo.cwd, 'git', ['push', '-u', 'origin', 'master'])
    // Create another clone to push changes from
    otherClone = path.join(repo.cwd, '..', 'other-clone-' + Date.now())
    gitRun(repo.cwd, ['clone', bareDir, otherClone])
    run(otherClone, 'git', ['config', 'user.email', 'other@test.com'])
    run(otherClone, 'git', ['config', 'user.name', 'Other User'])
  })
  afterEach(() => {
    repo.cleanup()
    fs.rmSync(bareDir, { recursive: true, force: true })
    fs.rmSync(otherClone, { recursive: true, force: true })
  })

  it('pulls new commits with merge mode', async () => {
    // Push a commit from the other clone
    writeFile(otherClone, 'remote-file.txt', 'from remote')
    run(otherClone, 'git', ['add', '.'])
    run(otherClone, 'git', ['commit', '-m', 'remote commit'])
    run(otherClone, 'git', ['push'])
    // Pull into our repo
    const result = await pull(repo.cwd, 'merge')
    expect(typeof result).toBe('string')
    expect(fs.existsSync(path.join(repo.cwd, 'remote-file.txt'))).toBe(true)
  })

  it('pulls new commits with rebase mode', async () => {
    writeFile(otherClone, 'rebase-file.txt', 'rebase content')
    run(otherClone, 'git', ['add', '.'])
    run(otherClone, 'git', ['commit', '-m', 'rebase commit'])
    run(otherClone, 'git', ['push'])
    const result = await pull(repo.cwd, 'rebase')
    expect(typeof result).toBe('string')
    expect(fs.existsSync(path.join(repo.cwd, 'rebase-file.txt'))).toBe(true)
  })

  it('pull default mode works', async () => {
    writeFile(otherClone, 'default-file.txt', 'default')
    run(otherClone, 'git', ['add', '.'])
    run(otherClone, 'git', ['commit', '-m', 'default pull'])
    run(otherClone, 'git', ['push'])
    const result = await pull(repo.cwd)
    expect(typeof result).toBe('string')
    expect(fs.existsSync(path.join(repo.cwd, 'default-file.txt'))).toBe(true)
  })
})

describe('pullAdvanced', () => {
  let repo: TestRepo
  let bareDir: string
  let otherClone: string

  beforeEach(() => {
    repo = createTestRepo()
    bareDir = createBareRemote()
    commitFile(repo.cwd, 'init.txt', 'init', 'initial commit')
    run(repo.cwd, 'git', ['remote', 'add', 'origin', bareDir])
    run(repo.cwd, 'git', ['push', '-u', 'origin', 'master'])
    otherClone = path.join(repo.cwd, '..', 'adv-other-' + Date.now())
    gitRun(repo.cwd, ['clone', bareDir, otherClone])
    run(otherClone, 'git', ['config', 'user.email', 'other@test.com'])
    run(otherClone, 'git', ['config', 'user.name', 'Other User'])
  })
  afterEach(() => {
    repo.cleanup()
    fs.rmSync(bareDir, { recursive: true, force: true })
    fs.rmSync(otherClone, { recursive: true, force: true })
  })

  it('pulls with rebase and autostash', async () => {
    writeFile(otherClone, 'advanced.txt', 'advanced')
    run(otherClone, 'git', ['add', '.'])
    run(otherClone, 'git', ['commit', '-m', 'advanced commit'])
    run(otherClone, 'git', ['push'])
    const result = await pullAdvanced(repo.cwd, 'origin', 'master', true, true, false, false)
    expect(typeof result).toBe('string')
    expect(fs.existsSync(path.join(repo.cwd, 'advanced.txt'))).toBe(true)
  })

  it('pulls with merge and tags', async () => {
    writeFile(otherClone, 'tagged.txt', 'tagged')
    run(otherClone, 'git', ['add', '.'])
    run(otherClone, 'git', ['commit', '-m', 'tagged commit'])
    run(otherClone, 'git', ['tag', 'v1.0.0'])
    run(otherClone, 'git', ['push', '--tags'])
    run(otherClone, 'git', ['push'])
    const result = await pullAdvanced(repo.cwd, 'origin', 'master', false, false, true, false)
    expect(typeof result).toBe('string')
  })

  it('pulls with prune option', async () => {
    writeFile(otherClone, 'prune.txt', 'prune')
    run(otherClone, 'git', ['add', '.'])
    run(otherClone, 'git', ['commit', '-m', 'prune commit'])
    run(otherClone, 'git', ['push'])
    const result = await pullAdvanced(repo.cwd, 'origin', 'master', false, false, false, true)
    expect(typeof result).toBe('string')
  })
})

describe('push rejected (non-fast-forward)', () => {
  let repo: TestRepo
  let bareDir: string
  let otherClone: string

  beforeEach(() => {
    repo = createTestRepo()
    bareDir = createBareRemote()
    commitFile(repo.cwd, 'init.txt', 'init', 'initial commit')
    run(repo.cwd, 'git', ['remote', 'add', 'origin', bareDir])
    run(repo.cwd, 'git', ['push', '-u', 'origin', 'master'])
    // Create another clone that will push ahead of us
    otherClone = path.join(repo.cwd, '..', 'other-push-' + Date.now())
    gitRun(repo.cwd, ['clone', bareDir, otherClone])
    run(otherClone, 'git', ['config', 'user.email', 'other@test.com'])
    run(otherClone, 'git', ['config', 'user.name', 'Other User'])
  })
  afterEach(() => {
    repo.cleanup()
    fs.rmSync(bareDir, { recursive: true, force: true })
    fs.rmSync(otherClone, { recursive: true, force: true })
  })

  it('push fails when branch is behind remote', async () => {
    // Other clone pushes first
    commitFile(otherClone, 'ahead.txt', 'ahead', 'other pushed ahead')
    run(otherClone, 'git', ['push'])

    // Our repo makes a local commit (diverged)
    commitFile(repo.cwd, 'local.txt', 'local', 'local commit')

    // Push should be rejected
    await expect(push(repo.cwd)).rejects.toThrow(/rejected|non-fast-forward|failed to push|updates were rejected/i)
  })

  it('pull with rebase then push resolves rejection', async () => {
    commitFile(otherClone, 'remote-first.txt', 'remote', 'remote commit')
    run(otherClone, 'git', ['push'])

    commitFile(repo.cwd, 'local-first.txt', 'local', 'local commit')

    // Push should fail
    await expect(push(repo.cwd)).rejects.toThrow()

    // Resolution: pull rebase then push
    const pullResult = await pull(repo.cwd, 'rebase')
    expect(typeof pullResult).toBe('string')

    const pushResult = await push(repo.cwd)
    expect(typeof pushResult).toBe('string')

    // Verify both files exist
    expect(fs.existsSync(path.join(repo.cwd, 'remote-first.txt'))).toBe(true)
    expect(fs.existsSync(path.join(repo.cwd, 'local-first.txt'))).toBe(true)
  })

  it('pull with merge then push resolves rejection', async () => {
    commitFile(otherClone, 'merge-remote.txt', 'remote', 'remote commit')
    run(otherClone, 'git', ['push'])

    commitFile(repo.cwd, 'merge-local.txt', 'local', 'local commit')

    await expect(push(repo.cwd)).rejects.toThrow()

    const pullResult = await pull(repo.cwd, 'merge')
    expect(typeof pullResult).toBe('string')

    const pushResult = await push(repo.cwd)
    expect(typeof pushResult).toBe('string')

    expect(fs.existsSync(path.join(repo.cwd, 'merge-remote.txt'))).toBe(true)
    expect(fs.existsSync(path.join(repo.cwd, 'merge-local.txt'))).toBe(true)
  })
})

describe('pushForceWithLease', () => {
  let repo: TestRepo
  let bareDir: string
  let otherClone: string

  beforeEach(() => {
    repo = createTestRepo()
    bareDir = createBareRemote()
    commitFile(repo.cwd, 'init.txt', 'init', 'initial commit')
    run(repo.cwd, 'git', ['remote', 'add', 'origin', bareDir])
    run(repo.cwd, 'git', ['push', '-u', 'origin', 'master'])
    otherClone = path.join(repo.cwd, '..', 'other-force-' + Date.now())
    gitRun(repo.cwd, ['clone', bareDir, otherClone])
    run(otherClone, 'git', ['config', 'user.email', 'other@test.com'])
    run(otherClone, 'git', ['config', 'user.name', 'Other User'])
  })
  afterEach(() => {
    repo.cleanup()
    fs.rmSync(bareDir, { recursive: true, force: true })
    fs.rmSync(otherClone, { recursive: true, force: true })
  })

  it('force push with lease succeeds when remote matches local tracking ref', async () => {
    // Make a commit, push it, then amend it (creating divergence)
    commitFile(repo.cwd, 'force-file.txt', 'original', 'will amend')
    run(repo.cwd, 'git', ['push'])

    // Amend the commit (rewrites history)
    writeFile(repo.cwd, 'force-file.txt', 'amended content')
    run(repo.cwd, 'git', ['add', '.'])
    run(repo.cwd, 'git', ['commit', '--amend', '-m', 'amended commit'])

    // Normal push should fail
    await expect(push(repo.cwd)).rejects.toThrow()

    // Force push with lease should succeed (no one else pushed)
    const result = await pushForceWithLease(repo.cwd)
    expect(typeof result).toBe('string')

    // Verify the amended content is on the remote
    const verifyDir = path.join(repo.cwd, '..', 'verify-force-' + Date.now())
    try {
      gitRun(repo.cwd, ['clone', bareDir, verifyDir])
      const content = fs.readFileSync(path.join(verifyDir, 'force-file.txt'), 'utf-8')
      expect(content).toBe('amended content')
    } finally {
      fs.rmSync(verifyDir, { recursive: true, force: true })
    }
  })

  it('force push with lease fails when remote has unknown commits', async () => {
    // Other clone pushes a new commit
    commitFile(otherClone, 'other-file.txt', 'other', 'other pushed')
    run(otherClone, 'git', ['push'])

    // Our repo amends its last commit (rewriting history)
    writeFile(repo.cwd, 'init.txt', 'modified')
    run(repo.cwd, 'git', ['add', '.'])
    run(repo.cwd, 'git', ['commit', '--amend', '-m', 'amended locally'])

    // Force push with lease should FAIL because remote has commits we don't know about
    await expect(pushForceWithLease(repo.cwd)).rejects.toThrow(/rejected|stale info|failed/)
  })
})
