import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as path from 'path'

vi.mock('../../../logger', () => ({
  log: () => {},
  logInfo: () => {},
  logError: () => {}
}))

import { createTestRepo, commitFile, writeFile, type TestRepo } from './setup'
import { isGitRepo, getStatus, getLog, getCommitCount } from '../git-operations'

describe('isGitRepo', () => {
  let repo: TestRepo

  beforeEach(() => { repo = createTestRepo() })
  afterEach(() => { repo.cleanup() })

  it('returns true for a git directory', async () => {
    expect(await isGitRepo(repo.cwd)).toBe(true)
  })

  it('returns false for a non-git directory', async () => {
    const os = await import('os')
    const fs = await import('fs')
    // Create a temp dir outside any git repo
    const tmpNonGit = path.join(os.tmpdir(), `not-a-repo-${Date.now()}`)
    fs.mkdirSync(tmpNonGit, { recursive: true })
    try {
      expect(await isGitRepo(tmpNonGit)).toBe(false)
    } finally {
      fs.rmSync(tmpNonGit, { recursive: true, force: true })
    }
  })

  it('returns false for a nonexistent directory', async () => {
    expect(await isGitRepo('/tmp/does-not-exist-' + Date.now())).toBe(false)
  })
})

describe('getStatus', () => {
  let repo: TestRepo

  beforeEach(() => { repo = createTestRepo() })
  afterEach(() => { repo.cleanup() })

  it('returns branch name on clean repo', async () => {
    const status = await getStatus(repo.cwd)
    expect(status.branch).toBeTruthy()
    expect(status.staged).toHaveLength(0)
    expect(status.unstaged).toHaveLength(0)
    expect(status.untracked).toHaveLength(0)
  })

  it('detects untracked files', async () => {
    writeFile(repo.cwd, 'new-file.txt', 'hello')
    const status = await getStatus(repo.cwd)
    expect(status.untracked.length).toBe(1)
    expect(status.untracked[0].path).toBe('new-file.txt')
  })

  it('detects staged files', async () => {
    writeFile(repo.cwd, 'staged.txt', 'content')
    const { execFileSync } = await import('child_process')
    execFileSync('git', ['add', 'staged.txt'], { cwd: repo.cwd })
    const status = await getStatus(repo.cwd)
    expect(status.staged.length).toBe(1)
    expect(status.staged[0].path).toBe('staged.txt')
  })

  it('detects unstaged modifications', async () => {
    commitFile(repo.cwd, 'file.txt', 'original', 'add file')
    writeFile(repo.cwd, 'file.txt', 'modified')
    const status = await getStatus(repo.cwd)
    expect(status.unstaged.length).toBe(1)
    expect(status.unstaged[0].path).toBe('file.txt')
  })
})

describe('getLog', () => {
  let repo: TestRepo

  beforeEach(() => { repo = createTestRepo() })
  afterEach(() => { repo.cleanup() })

  it('returns commits in order', async () => {
    commitFile(repo.cwd, 'a.txt', 'a', 'first commit')
    commitFile(repo.cwd, 'b.txt', 'b', 'second commit')
    const log = await getLog(repo.cwd)
    expect(log.length).toBeGreaterThanOrEqual(2)
    expect(log[0].subject).toBe('second commit')
    expect(log[1].subject).toBe('first commit')
  })

  it('respects maxCount', async () => {
    commitFile(repo.cwd, 'a.txt', 'a', 'c1')
    commitFile(repo.cwd, 'b.txt', 'b', 'c2')
    commitFile(repo.cwd, 'c.txt', 'c', 'c3')
    const log = await getLog(repo.cwd, { maxCount: 2 })
    expect(log.length).toBe(2)
  })

  it('respects skip', async () => {
    commitFile(repo.cwd, 'a.txt', 'a', 'c1')
    commitFile(repo.cwd, 'b.txt', 'b', 'c2')
    commitFile(repo.cwd, 'c.txt', 'c', 'c3')
    const log = await getLog(repo.cwd, { maxCount: 10, skip: 1 })
    expect(log[0].subject).toBe('c2')
  })

  it('respects search (grep)', async () => {
    commitFile(repo.cwd, 'a.txt', 'a', 'fix: bug in parser')
    commitFile(repo.cwd, 'b.txt', 'b', 'feat: new feature')
    const log = await getLog(repo.cwd, { search: 'fix' })
    expect(log.length).toBe(1)
    expect(log[0].subject).toContain('fix')
  })

  it('returns commit metadata fields', async () => {
    commitFile(repo.cwd, 'a.txt', 'a', 'test metadata')
    const log = await getLog(repo.cwd, { maxCount: 1 })
    expect(log[0].hash).toMatch(/^[0-9a-f]{40}$/)
    expect(log[0].shortHash).toBeTruthy()
    expect(log[0].author).toBe('Test User')
    expect(log[0].authorEmail).toBe('test@test.com')
    expect(log[0].date).toBeTruthy()
    expect(log[0].subject).toBe('test metadata')
  })
})

describe('getCommitCount', () => {
  let repo: TestRepo

  beforeEach(() => { repo = createTestRepo() })
  afterEach(() => { repo.cleanup() })

  it('returns correct count for a repo with commits', async () => {
    commitFile(repo.cwd, 'a.txt', 'a', 'first')
    commitFile(repo.cwd, 'b.txt', 'b', 'second')
    commitFile(repo.cwd, 'c.txt', 'c', 'third')
    // createTestRepo makes 1 initial commit + 3 = 4
    const count = await getCommitCount(repo.cwd)
    expect(count).toBe(4)
  })

  it('matches getLog total when loading all commits', async () => {
    for (let i = 0; i < 10; i++) {
      commitFile(repo.cwd, `file-${i}.txt`, `content-${i}`, `commit ${i}`)
    }
    const count = await getCommitCount(repo.cwd)
    const allCommits = await getLog(repo.cwd, { maxCount: 1000 })
    expect(count).toBe(allCommits.length)
  })

  it('matches paginated getLog total', async () => {
    // Create enough commits to span multiple pages
    for (let i = 0; i < 15; i++) {
      commitFile(repo.cwd, `file-${i}.txt`, `content-${i}`, `commit ${i}`)
    }
    const count = await getCommitCount(repo.cwd)
    const PAGE = 5
    let total = 0
    let skip = 0
    while (true) {
      const page = await getLog(repo.cwd, { maxCount: PAGE, skip })
      total += page.length
      if (page.length < PAGE) break
      skip += PAGE
    }
    expect(total).toBe(count)
  })

  it('no commits are lost between paginated pages', async () => {
    for (let i = 0; i < 12; i++) {
      commitFile(repo.cwd, `file-${i}.txt`, `content-${i}`, `commit ${i}`)
    }
    // Load all at once
    const allCommits = await getLog(repo.cwd, { maxCount: 1000 })
    // Load paginated (page size 5)
    const paginatedHashes: string[] = []
    let skip = 0
    while (true) {
      const page = await getLog(repo.cwd, { maxCount: 5, skip })
      for (const c of page) paginatedHashes.push(c.hash)
      if (page.length < 5) break
      skip += 5
    }
    expect(paginatedHashes.length).toBe(allCommits.length)
    // Every commit from full load must appear in paginated load
    for (const c of allCommits) {
      expect(paginatedHashes).toContain(c.hash)
    }
  })
})
