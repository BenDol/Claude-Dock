import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../services', () => ({
  getServices: () => ({
    log: () => {},
    logInfo: () => {},
    logError: () => {}
  })
}))

import { createTestRepo, createBareRemote, commitFile, run, type TestRepo } from './setup'
import * as fs from 'fs'
import {
  getRemotes,
  addRemote,
  removeRemote,
  fetch as gitFetch,
  fetchSimple,
  fetchAll,
  fetchPruneAll
} from '../git-operations'

describe('getRemotes', () => {
  let repo: TestRepo

  beforeEach(() => { repo = createTestRepo() })
  afterEach(() => { repo.cleanup() })

  it('returns empty for repo with no remotes', async () => {
    const remotes = await getRemotes(repo.cwd)
    expect(remotes.length).toBe(0)
  })

  it('returns remotes with fetch and push urls', async () => {
    const bareDir = createBareRemote()
    try {
      run(repo.cwd, 'git', ['remote', 'add', 'origin', bareDir])
      const remotes = await getRemotes(repo.cwd)
      expect(remotes.length).toBe(1)
      expect(remotes[0].name).toBe('origin')
      expect(remotes[0].fetchUrl).toBeTruthy()
      expect(remotes[0].pushUrl).toBeTruthy()
    } finally {
      fs.rmSync(bareDir, { recursive: true, force: true })
    }
  })
})

describe('addRemote', () => {
  let repo: TestRepo

  beforeEach(() => { repo = createTestRepo() })
  afterEach(() => { repo.cleanup() })

  it('adds a new remote', async () => {
    const bareDir = createBareRemote()
    try {
      await addRemote(repo.cwd, 'test-remote', bareDir)
      const remotes = await getRemotes(repo.cwd)
      expect(remotes.find((r) => r.name === 'test-remote')).toBeDefined()
    } finally {
      fs.rmSync(bareDir, { recursive: true, force: true })
    }
  })

  it('throws on duplicate remote name', async () => {
    const bareDir = createBareRemote()
    try {
      await addRemote(repo.cwd, 'dup', bareDir)
      await expect(addRemote(repo.cwd, 'dup', bareDir)).rejects.toThrow()
    } finally {
      fs.rmSync(bareDir, { recursive: true, force: true })
    }
  })
})

describe('removeRemote', () => {
  let repo: TestRepo

  beforeEach(() => { repo = createTestRepo() })
  afterEach(() => { repo.cleanup() })

  it('removes an existing remote', async () => {
    const bareDir = createBareRemote()
    try {
      run(repo.cwd, 'git', ['remote', 'add', 'to-remove', bareDir])
      await removeRemote(repo.cwd, 'to-remove')
      const remotes = await getRemotes(repo.cwd)
      expect(remotes.find((r) => r.name === 'to-remove')).toBeUndefined()
    } finally {
      fs.rmSync(bareDir, { recursive: true, force: true })
    }
  })

  it('throws on nonexistent remote', async () => {
    await expect(removeRemote(repo.cwd, 'nonexistent')).rejects.toThrow()
  })
})

describe('fetch variants', () => {
  let repo: TestRepo
  let bareDir: string

  beforeEach(() => {
    repo = createTestRepo()
    bareDir = createBareRemote()
    commitFile(repo.cwd, 'file.txt', 'content', 'init')
    run(repo.cwd, 'git', ['remote', 'add', 'origin', bareDir])
    run(repo.cwd, 'git', ['push', '-u', 'origin', 'master'])
  })
  afterEach(() => {
    repo.cleanup()
    fs.rmSync(bareDir, { recursive: true, force: true })
  })

  it('fetchSimple does not error', async () => {
    const result = await fetchSimple(repo.cwd)
    expect(typeof result).toBe('string')
  })

  it('fetchAll does not error', async () => {
    const result = await fetchAll(repo.cwd)
    expect(typeof result).toBe('string')
  })

  it('fetchPruneAll does not error', async () => {
    const result = await fetchPruneAll(repo.cwd)
    expect(typeof result).toBe('string')
  })

  it('fetch (--all --prune) does not error', async () => {
    const result = await gitFetch(repo.cwd)
    expect(typeof result).toBe('string')
  })
})
