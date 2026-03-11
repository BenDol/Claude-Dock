import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

vi.mock('../../../logger', () => ({
  log: () => {},
  logInfo: () => {},
  logError: () => {}
}))

import { createTestRepo, createSubmoduleRepo, commitFile, run, type TestRepo } from './setup'
import {
  getSubmodules,
  addSubmodule,
  removeSubmodule
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
