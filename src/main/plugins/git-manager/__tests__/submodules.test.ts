import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

vi.mock('../services', () => ({
  getServices: () => ({
    log: () => {},
    logInfo: () => {},
    logError: () => {}
  })
}))

import { createTestRepo, createSubmoduleRepo, commitFile, run, type TestRepo } from './setup'
import {
  getSubmodules,
  addSubmodule,
  removeSubmodule,
  getBranches,
  checkoutBranch
} from '../git-operations'

describe('submodule operations', () => {
  let repo: TestRepo
  let subRepo: { dir: string; cleanup: () => void }

  beforeEach(() => {
    // Allow file:// protocol for submodule clone operations
    process.env.GIT_CONFIG_COUNT = '1'
    process.env.GIT_CONFIG_KEY_0 = 'protocol.file.allow'
    process.env.GIT_CONFIG_VALUE_0 = 'always'
    repo = createTestRepo()
    subRepo = createSubmoduleRepo()
    commitFile(repo.cwd, 'base.txt', 'base', 'base commit')
  })
  afterEach(() => {
    delete process.env.GIT_CONFIG_COUNT
    delete process.env.GIT_CONFIG_KEY_0
    delete process.env.GIT_CONFIG_VALUE_0
    repo.cleanup()
    subRepo.cleanup()
  })

  it('getSubmodules returns empty when no submodules exist', async () => {
    const subs = await getSubmodules(repo.cwd)
    expect(subs.length).toBe(0)
  })

  it('addSubmodule adds a submodule from local path', async () => {
    await addSubmodule(repo.cwd, subRepo.dir, 'my-sub')
    const subs = await getSubmodules(repo.cwd)
    expect(subs.length).toBe(1)
    expect(subs[0].path).toBe('my-sub')
    expect(subs[0].hash).toBeTruthy()
  })

  it('getSubmodules returns name, path, hash, and status', async () => {
    await addSubmodule(repo.cwd, subRepo.dir, 'test-sub')
    const subs = await getSubmodules(repo.cwd)
    expect(subs[0].name).toBeTruthy()
    expect(subs[0].path).toBe('test-sub')
    expect(subs[0].hash).toMatch(/^[0-9a-f]+$/)
    expect(['current', 'modified', 'uninitialized']).toContain(subs[0].status)
  })

  it('addSubmodule creates the submodule directory', async () => {
    await addSubmodule(repo.cwd, subRepo.dir, 'check-dir')
    expect(fs.existsSync(path.join(repo.cwd, 'check-dir'))).toBe(true)
    expect(fs.existsSync(path.join(repo.cwd, 'check-dir', 'sub-file.txt'))).toBe(true)
  })

  it('removeSubmodule removes the submodule', async () => {
    await addSubmodule(repo.cwd, subRepo.dir, 'to-remove')
    // Commit the submodule addition first
    run(repo.cwd, 'git', ['commit', '-m', 'add submodule'])
    await removeSubmodule(repo.cwd, 'to-remove')
    // After removal, the directory should be gone
    expect(fs.existsSync(path.join(repo.cwd, 'to-remove'))).toBe(false)
  })

  it('removeSubmodule on nonexistent path throws', async () => {
    await expect(removeSubmodule(repo.cwd, 'nonexistent')).rejects.toThrow()
  })

  it('addSubmodule with force option works', async () => {
    await addSubmodule(repo.cwd, subRepo.dir, 'forced-sub', undefined, true)
    const subs = await getSubmodules(repo.cwd)
    expect(subs.find((s) => s.path === 'forced-sub')).toBeDefined()
  })

  it('multiple submodules are listed', async () => {
    const subRepo2 = createSubmoduleRepo()
    try {
      await addSubmodule(repo.cwd, subRepo.dir, 'sub-a')
      run(repo.cwd, 'git', ['commit', '-m', 'add sub-a'])
      await addSubmodule(repo.cwd, subRepo2.dir, 'sub-b')
      const subs = await getSubmodules(repo.cwd)
      expect(subs.length).toBe(2)
      const paths = subs.map((s) => s.path)
      expect(paths).toContain('sub-a')
      expect(paths).toContain('sub-b')
    } finally {
      subRepo2.cleanup()
    }
  })
})

describe('submodule branch switching', () => {
  let repo: TestRepo
  let subRepo: { dir: string; cleanup: () => void }

  beforeEach(() => {
    process.env.GIT_CONFIG_COUNT = '1'
    process.env.GIT_CONFIG_KEY_0 = 'protocol.file.allow'
    process.env.GIT_CONFIG_VALUE_0 = 'always'
    repo = createTestRepo()
    subRepo = createSubmoduleRepo()
    commitFile(repo.cwd, 'base.txt', 'base', 'base commit')
  })
  afterEach(() => {
    delete process.env.GIT_CONFIG_COUNT
    delete process.env.GIT_CONFIG_KEY_0
    delete process.env.GIT_CONFIG_VALUE_0
    repo.cleanup()
    subRepo.cleanup()
  })

  it('getBranches lists branches inside a submodule', async () => {
    // Create a second branch in the source repo before adding as submodule
    run(subRepo.dir, 'git', ['branch', 'feature-branch'])

    await addSubmodule(repo.cwd, subRepo.dir, 'my-sub')
    const subDir = path.join(repo.cwd, 'my-sub')

    const branches = await getBranches(subDir)
    const localNames = branches.filter((b) => !b.remote).map((b) => b.name)
    expect(localNames.length).toBeGreaterThanOrEqual(1)
    // Should have the default branch at minimum
    const current = branches.find((b) => b.current)
    expect(current).toBeDefined()
  })

  it('checkoutBranch switches branch inside a submodule', async () => {
    // Create a feature branch in the source repo
    run(subRepo.dir, 'git', ['branch', 'feature-x'])

    await addSubmodule(repo.cwd, subRepo.dir, 'my-sub')
    const subDir = path.join(repo.cwd, 'my-sub')

    // Create the local branch in the submodule (submodule clones don't copy all local branches)
    run(subDir, 'git', ['branch', 'feature-x', 'origin/feature-x'])

    await checkoutBranch(subDir, 'feature-x')

    const branches = await getBranches(subDir)
    const current = branches.find((b) => b.current)
    expect(current).toBeDefined()
    expect(current!.name).toBe('feature-x')
  })

  it('submodule shows as modified after branch switch', async () => {
    // Create a branch with a different commit in the source repo
    run(subRepo.dir, 'git', ['checkout', '-b', 'diverged'])
    fs.writeFileSync(path.join(subRepo.dir, 'diverged.txt'), 'diverged content')
    run(subRepo.dir, 'git', ['add', '.'])
    run(subRepo.dir, 'git', ['commit', '-m', 'diverged commit'])
    // Go back to original branch for the submodule add
    run(subRepo.dir, 'git', ['checkout', 'master'])

    await addSubmodule(repo.cwd, subRepo.dir, 'my-sub')
    run(repo.cwd, 'git', ['commit', '-m', 'add submodule'])

    const subDir = path.join(repo.cwd, 'my-sub')

    // Switch to the diverged branch (different commit than what parent recorded)
    run(subDir, 'git', ['branch', 'diverged', 'origin/diverged'])
    await checkoutBranch(subDir, 'diverged')

    // Parent repo should see submodule as modified (different commit)
    const subs = await getSubmodules(repo.cwd)
    const sub = subs.find((s) => s.path === 'my-sub')
    expect(sub).toBeDefined()
    expect(sub!.status).toBe('modified')
  })

  it('checkoutBranch in submodule throws for nonexistent branch', async () => {
    await addSubmodule(repo.cwd, subRepo.dir, 'my-sub')
    const subDir = path.join(repo.cwd, 'my-sub')
    await expect(checkoutBranch(subDir, 'nonexistent-branch')).rejects.toThrow()
  })

  it('getBranches lists remote branches in submodule', async () => {
    run(subRepo.dir, 'git', ['branch', 'remote-test'])

    await addSubmodule(repo.cwd, subRepo.dir, 'my-sub')
    const subDir = path.join(repo.cwd, 'my-sub')

    const branches = await getBranches(subDir)
    const remoteNames = branches.filter((b) => b.remote).map((b) => b.name)
    // Submodule clone should have origin/* remote branches
    expect(remoteNames.some((n) => n.includes('origin/'))).toBe(true)
  })
})
