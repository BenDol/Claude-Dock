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

import { createTestRepo, commitFile, run, writeFile, type TestRepo } from './setup'
import {
  stageFiles,
  unstageFiles,
  discardFiles,
  deleteUntrackedFiles,
  getStatus
} from '../git-operations'

describe('stageFiles', () => {
  let repo: TestRepo

  beforeEach(() => { repo = createTestRepo() })
  afterEach(() => { repo.cleanup() })

  it('stages an untracked file', async () => {
    writeFile(repo.cwd, 'new.txt', 'content')
    await stageFiles(repo.cwd, ['new.txt'])
    const status = await getStatus(repo.cwd)
    expect(status.staged.length).toBe(1)
    expect(status.staged[0].path).toBe('new.txt')
    expect(status.untracked.length).toBe(0)
  })

  it('stages a modified file', async () => {
    commitFile(repo.cwd, 'file.txt', 'original', 'add file')
    writeFile(repo.cwd, 'file.txt', 'modified')
    await stageFiles(repo.cwd, ['file.txt'])
    const status = await getStatus(repo.cwd)
    expect(status.staged.length).toBe(1)
    expect(status.unstaged.length).toBe(0)
  })

  it('stages multiple files at once', async () => {
    writeFile(repo.cwd, 'a.txt', 'a')
    writeFile(repo.cwd, 'b.txt', 'b')
    await stageFiles(repo.cwd, ['a.txt', 'b.txt'])
    const status = await getStatus(repo.cwd)
    expect(status.staged.length).toBe(2)
  })

  it('does nothing with empty paths array', async () => {
    await stageFiles(repo.cwd, [])
    const status = await getStatus(repo.cwd)
    expect(status.staged.length).toBe(0)
  })

  it('stages many files across batches', async () => {
    const count = 75
    const paths: string[] = []
    for (let i = 0; i < count; i++) {
      const name = `file-${String(i).padStart(3, '0')}.txt`
      writeFile(repo.cwd, name, `content-${i}`)
      paths.push(name)
    }
    await stageFiles(repo.cwd, paths)
    const status = await getStatus(repo.cwd)
    expect(status.staged.length).toBe(count)
    expect(status.untracked.length).toBe(0)
  })
})

describe('unstageFiles', () => {
  let repo: TestRepo

  beforeEach(() => { repo = createTestRepo() })
  afterEach(() => { repo.cleanup() })

  it('unstages a staged file', async () => {
    commitFile(repo.cwd, 'file.txt', 'original', 'add file')
    writeFile(repo.cwd, 'file.txt', 'modified')
    await stageFiles(repo.cwd, ['file.txt'])
    await unstageFiles(repo.cwd, ['file.txt'])
    const status = await getStatus(repo.cwd)
    expect(status.staged.length).toBe(0)
    expect(status.unstaged.length).toBe(1)
  })

  it('unstages a newly added untracked file', async () => {
    writeFile(repo.cwd, 'brand-new.txt', 'new content')
    await stageFiles(repo.cwd, ['brand-new.txt'])
    let status = await getStatus(repo.cwd)
    expect(status.staged.length).toBe(1)
    await unstageFiles(repo.cwd, ['brand-new.txt'])
    status = await getStatus(repo.cwd)
    expect(status.staged.length).toBe(0)
    expect(status.untracked.length).toBe(1)
  })

  it('unstages a mix of modified and new files', async () => {
    commitFile(repo.cwd, 'existing.txt', 'original', 'add existing')
    writeFile(repo.cwd, 'existing.txt', 'modified')
    writeFile(repo.cwd, 'new1.txt', 'new1')
    writeFile(repo.cwd, 'new2.txt', 'new2')
    await stageFiles(repo.cwd, ['existing.txt', 'new1.txt', 'new2.txt'])
    let status = await getStatus(repo.cwd)
    expect(status.staged.length).toBe(3)
    await unstageFiles(repo.cwd, ['existing.txt', 'new1.txt', 'new2.txt'])
    status = await getStatus(repo.cwd)
    expect(status.staged.length).toBe(0)
  })

  it('unstages many new untracked files across batches', async () => {
    const count = 75
    const paths: string[] = []
    for (let i = 0; i < count; i++) {
      const name = `new-${String(i).padStart(3, '0')}.txt`
      writeFile(repo.cwd, name, `content-${i}`)
      paths.push(name)
    }
    await stageFiles(repo.cwd, paths)
    let status = await getStatus(repo.cwd)
    expect(status.staged.length).toBe(count)
    await unstageFiles(repo.cwd, paths)
    status = await getStatus(repo.cwd)
    expect(status.staged.length).toBe(0)
    expect(status.untracked.length).toBe(count)
  })

  it('unstages specific files while keeping others staged', async () => {
    commitFile(repo.cwd, 'a.txt', 'a', 'add a')
    commitFile(repo.cwd, 'b.txt', 'b', 'add b')
    writeFile(repo.cwd, 'a.txt', 'a-modified')
    writeFile(repo.cwd, 'b.txt', 'b-modified')
    await stageFiles(repo.cwd, ['a.txt', 'b.txt'])
    await unstageFiles(repo.cwd, ['a.txt'])
    const status = await getStatus(repo.cwd)
    expect(status.staged.length).toBe(1)
    expect(status.staged[0].path).toBe('b.txt')
    expect(status.unstaged.length).toBe(1)
    expect(status.unstaged[0].path).toBe('a.txt')
  })

  it('unstages many files across batches', async () => {
    const count = 75
    const paths: string[] = []
    for (let i = 0; i < count; i++) {
      const name = `file-${String(i).padStart(3, '0')}.txt`
      writeFile(repo.cwd, name, `original-${i}`)
      paths.push(name)
    }
    await stageFiles(repo.cwd, paths)
    run(repo.cwd, 'git', ['commit', '-m', 'add all files'])
    for (let i = 0; i < count; i++) {
      writeFile(repo.cwd, paths[i], `modified-${i}`)
    }
    await stageFiles(repo.cwd, paths)
    let status = await getStatus(repo.cwd)
    expect(status.staged.length).toBe(count)
    await unstageFiles(repo.cwd, paths)
    status = await getStatus(repo.cwd)
    expect(status.staged.length).toBe(0)
    expect(status.unstaged.length).toBe(count)
  }, 60_000)
})

describe('discardFiles', () => {
  let repo: TestRepo

  beforeEach(() => { repo = createTestRepo() })
  afterEach(() => { repo.cleanup() })

  it('restores a modified file to its committed state', async () => {
    commitFile(repo.cwd, 'file.txt', 'original', 'add file')
    writeFile(repo.cwd, 'file.txt', 'modified content')
    await discardFiles(repo.cwd, ['file.txt'])
    const content = fs.readFileSync(path.join(repo.cwd, 'file.txt'), 'utf-8')
    expect(content).toBe('original')
  })

  it('clears unstaged changes from status', async () => {
    commitFile(repo.cwd, 'file.txt', 'original', 'add file')
    writeFile(repo.cwd, 'file.txt', 'modified')
    await discardFiles(repo.cwd, ['file.txt'])
    const status = await getStatus(repo.cwd)
    expect(status.unstaged.length).toBe(0)
  })
})

describe('deleteUntrackedFiles', () => {
  let repo: TestRepo

  beforeEach(() => { repo = createTestRepo() })
  afterEach(() => { repo.cleanup() })

  it('removes untracked files', async () => {
    writeFile(repo.cwd, 'junk.txt', 'junk')
    expect(fs.existsSync(path.join(repo.cwd, 'junk.txt'))).toBe(true)
    await deleteUntrackedFiles(repo.cwd, ['junk.txt'])
    expect(fs.existsSync(path.join(repo.cwd, 'junk.txt'))).toBe(false)
  })

  it('removes untracked directories', async () => {
    writeFile(repo.cwd, 'dir/nested.txt', 'nested')
    await deleteUntrackedFiles(repo.cwd, ['dir'])
    expect(fs.existsSync(path.join(repo.cwd, 'dir'))).toBe(false)
  })

  it('clears untracked from status', async () => {
    writeFile(repo.cwd, 'temp.txt', 'temp')
    let status = await getStatus(repo.cwd)
    expect(status.untracked.length).toBe(1)
    await deleteUntrackedFiles(repo.cwd, ['temp.txt'])
    status = await getStatus(repo.cwd)
    expect(status.untracked.length).toBe(0)
  })
})
