import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

vi.mock('../../../logger', () => ({
  log: () => {},
  logInfo: () => {},
  logError: () => {}
}))

import { createTestRepo, commitFile, writeFile, type TestRepo } from './setup'
import {
  getStashList,
  stashSave,
  stashPop,
  stashApply,
  stashDrop,
  getStatus
} from '../git-operations'

describe('stash operations', () => {
  let repo: TestRepo

  beforeEach(() => { repo = createTestRepo() })
  afterEach(() => { repo.cleanup() })

  it('stashSave creates a stash entry', async () => {
    commitFile(repo.cwd, 'file.txt', 'original', 'add file')
    writeFile(repo.cwd, 'file.txt', 'modified')
    await stashSave(repo.cwd, 'test stash')
    const list = await getStashList(repo.cwd)
    expect(list.length).toBe(1)
    expect(list[0].message).toContain('test stash')
    expect(list[0].index).toBe(0)
  })

  it('stashSave clears working tree changes', async () => {
    commitFile(repo.cwd, 'file.txt', 'original', 'add file')
    writeFile(repo.cwd, 'file.txt', 'modified')
    await stashSave(repo.cwd)
    const status = await getStatus(repo.cwd)
    expect(status.unstaged.length).toBe(0)
    const content = fs.readFileSync(path.join(repo.cwd, 'file.txt'), 'utf-8')
    expect(content).toBe('original')
  })

  it('getStashList returns empty for repo with no stashes', async () => {
    commitFile(repo.cwd, 'file.txt', 'content', 'init')
    const list = await getStashList(repo.cwd)
    expect(list.length).toBe(0)
  })

  it('stashPop applies and removes the stash', async () => {
    commitFile(repo.cwd, 'file.txt', 'original', 'add file')
    writeFile(repo.cwd, 'file.txt', 'stashed-change')
    await stashSave(repo.cwd, 'will pop')
    await stashPop(repo.cwd, 0)
    const content = fs.readFileSync(path.join(repo.cwd, 'file.txt'), 'utf-8')
    expect(content).toBe('stashed-change')
    const list = await getStashList(repo.cwd)
    expect(list.length).toBe(0)
  })

  it('stashApply applies but keeps the stash', async () => {
    commitFile(repo.cwd, 'file.txt', 'original', 'add file')
    writeFile(repo.cwd, 'file.txt', 'stashed-change')
    await stashSave(repo.cwd, 'will apply')
    await stashApply(repo.cwd, 0)
    const content = fs.readFileSync(path.join(repo.cwd, 'file.txt'), 'utf-8')
    expect(content).toBe('stashed-change')
    const list = await getStashList(repo.cwd)
    expect(list.length).toBe(1) // still there
  })

  it('stashDrop removes a specific stash', async () => {
    commitFile(repo.cwd, 'file.txt', 'original', 'add file')
    writeFile(repo.cwd, 'file.txt', 'change1')
    await stashSave(repo.cwd, 'first stash')
    writeFile(repo.cwd, 'file.txt', 'change2')
    await stashSave(repo.cwd, 'second stash')
    let list = await getStashList(repo.cwd)
    expect(list.length).toBe(2)
    await stashDrop(repo.cwd, 0) // drop the most recent (index 0)
    list = await getStashList(repo.cwd)
    expect(list.length).toBe(1)
    expect(list[0].message).toContain('first stash')
  })

  it('multiple stashes maintain correct indices', async () => {
    commitFile(repo.cwd, 'file.txt', 'original', 'add file')
    writeFile(repo.cwd, 'file.txt', 'change-a')
    await stashSave(repo.cwd, 'stash-a')
    writeFile(repo.cwd, 'file.txt', 'change-b')
    await stashSave(repo.cwd, 'stash-b')
    writeFile(repo.cwd, 'file.txt', 'change-c')
    await stashSave(repo.cwd, 'stash-c')
    const list = await getStashList(repo.cwd)
    expect(list.length).toBe(3)
    // Most recent stash is index 0
    expect(list[0].index).toBe(0)
    expect(list[0].message).toContain('stash-c')
    expect(list[1].index).toBe(1)
    expect(list[1].message).toContain('stash-b')
    expect(list[2].index).toBe(2)
    expect(list[2].message).toContain('stash-a')
  })

  it('stash entries have hash and date', async () => {
    commitFile(repo.cwd, 'file.txt', 'original', 'add file')
    writeFile(repo.cwd, 'file.txt', 'changed')
    await stashSave(repo.cwd, 'with metadata')
    const list = await getStashList(repo.cwd)
    expect(list[0].hash).toBeTruthy()
    expect(list[0].date).toBeTruthy()
  })

  it('stashPop throws on invalid index', async () => {
    commitFile(repo.cwd, 'file.txt', 'content', 'init')
    await expect(stashPop(repo.cwd, 99)).rejects.toThrow()
  })
})
