import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

vi.mock('../../../logger', () => ({
  log: () => {},
  logInfo: () => {},
  logError: () => {}
}))

import { createTestRepo, commitFile, writeFile, run, type TestRepo } from './setup'
import {
  mergeBranch,
  getMergeState,
  getConflictFileContent,
  resolveConflictFile,
  abortMerge,
  continueMerge,
  createTag,
  getLog,
  getBranches
} from '../git-operations'

describe('mergeBranch', () => {
  let repo: TestRepo

  beforeEach(() => { repo = createTestRepo() })
  afterEach(() => { repo.cleanup() })

  it('performs a fast-forward merge', async () => {
    commitFile(repo.cwd, 'base.txt', 'base', 'base')
    run(repo.cwd, 'git', ['checkout', '-b', 'feature'])
    commitFile(repo.cwd, 'feature.txt', 'feature', 'feature commit')
    run(repo.cwd, 'git', ['checkout', 'master'])
    await mergeBranch(repo.cwd, 'feature')
    expect(fs.existsSync(path.join(repo.cwd, 'feature.txt'))).toBe(true)
  })

  it('performs a 3-way merge', async () => {
    commitFile(repo.cwd, 'base.txt', 'base', 'base')
    run(repo.cwd, 'git', ['checkout', '-b', 'feature'])
    commitFile(repo.cwd, 'feature.txt', 'feature', 'feature commit')
    run(repo.cwd, 'git', ['checkout', 'master'])
    commitFile(repo.cwd, 'master.txt', 'master', 'master commit')
    await mergeBranch(repo.cwd, 'feature')
    expect(fs.existsSync(path.join(repo.cwd, 'feature.txt'))).toBe(true)
    expect(fs.existsSync(path.join(repo.cwd, 'master.txt'))).toBe(true)
  })

  it('throws on merge conflict', async () => {
    commitFile(repo.cwd, 'conflict.txt', 'base content\n', 'base')
    run(repo.cwd, 'git', ['checkout', '-b', 'feature'])
    commitFile(repo.cwd, 'conflict.txt', 'feature content\n', 'feature change')
    run(repo.cwd, 'git', ['checkout', 'master'])
    commitFile(repo.cwd, 'conflict.txt', 'master content\n', 'master change')
    await expect(mergeBranch(repo.cwd, 'feature')).rejects.toThrow()
  })
})

describe('getMergeState', () => {
  let repo: TestRepo

  beforeEach(() => { repo = createTestRepo() })
  afterEach(() => {
    // Abort any in-progress merge before cleanup
    try { run(repo.cwd, 'git', ['merge', '--abort']) } catch { /* ignore */ }
    repo.cleanup()
  })

  it('returns no merge in progress for clean repo', async () => {
    commitFile(repo.cwd, 'file.txt', 'content', 'init')
    const state = await getMergeState(repo.cwd)
    expect(state.inProgress).toBe(false)
    expect(state.type).toBe('none')
    expect(state.conflicts.length).toBe(0)
  })

  it('detects a merge conflict state', async () => {
    commitFile(repo.cwd, 'file.txt', 'base\n', 'base')
    run(repo.cwd, 'git', ['checkout', '-b', 'conflict-branch'])
    commitFile(repo.cwd, 'file.txt', 'theirs\n', 'theirs')
    run(repo.cwd, 'git', ['checkout', 'master'])
    commitFile(repo.cwd, 'file.txt', 'ours\n', 'ours')
    try { run(repo.cwd, 'git', ['merge', 'conflict-branch']) } catch { /* expected */ }
    const state = await getMergeState(repo.cwd)
    expect(state.inProgress).toBe(true)
    expect(state.type).toBe('merge')
    expect(state.conflicts.length).toBeGreaterThan(0)
    expect(state.mergeHead).toBeTruthy()
  })
})

describe('getConflictFileContent', () => {
  let repo: TestRepo

  beforeEach(() => { repo = createTestRepo() })
  afterEach(() => {
    try { run(repo.cwd, 'git', ['merge', '--abort']) } catch { /* ignore */ }
    repo.cleanup()
  })

  it('parses conflict markers into chunks', async () => {
    commitFile(repo.cwd, 'file.txt', 'base\n', 'base')
    run(repo.cwd, 'git', ['checkout', '-b', 'their-branch'])
    commitFile(repo.cwd, 'file.txt', 'their version\n', 'theirs')
    run(repo.cwd, 'git', ['checkout', 'master'])
    commitFile(repo.cwd, 'file.txt', 'our version\n', 'ours')
    try { run(repo.cwd, 'git', ['merge', 'their-branch']) } catch { /* expected */ }

    const content = await getConflictFileContent(repo.cwd, 'file.txt')
    expect(content.path).toBe('file.txt')
    expect(content.raw).toContain('<<<<<<<')
    expect(content.raw).toContain('>>>>>>>')
    const conflictChunks = content.chunks.filter((c) => c.type === 'conflict')
    expect(conflictChunks.length).toBeGreaterThan(0)
    expect(conflictChunks[0].oursLines).toBeDefined()
    expect(conflictChunks[0].theirsLines).toBeDefined()
  })
})

describe('resolveConflictFile', () => {
  let repo: TestRepo

  beforeEach(() => { repo = createTestRepo() })
  afterEach(() => {
    try { run(repo.cwd, 'git', ['merge', '--abort']) } catch { /* ignore */ }
    repo.cleanup()
  })

  function createConflict(): void {
    commitFile(repo.cwd, 'file.txt', 'base\n', 'base')
    run(repo.cwd, 'git', ['checkout', '-b', 'their-branch'])
    commitFile(repo.cwd, 'file.txt', 'their version\n', 'theirs')
    run(repo.cwd, 'git', ['checkout', 'master'])
    commitFile(repo.cwd, 'file.txt', 'our version\n', 'ours')
    try { run(repo.cwd, 'git', ['merge', 'their-branch']) } catch { /* expected */ }
  }

  it('resolves with ours', async () => {
    createConflict()
    await resolveConflictFile(repo.cwd, 'file.txt', 'ours')
    const content = fs.readFileSync(path.join(repo.cwd, 'file.txt'), 'utf-8')
    expect(content).not.toContain('<<<<<<<')
    expect(content).toContain('our version')
    expect(content).not.toContain('their version')
  })

  it('resolves with theirs', async () => {
    createConflict()
    await resolveConflictFile(repo.cwd, 'file.txt', 'theirs')
    const content = fs.readFileSync(path.join(repo.cwd, 'file.txt'), 'utf-8')
    expect(content).not.toContain('<<<<<<<')
    expect(content).toContain('their version')
    expect(content).not.toContain('our version')
  })

  it('resolves with both', async () => {
    createConflict()
    await resolveConflictFile(repo.cwd, 'file.txt', 'both')
    const content = fs.readFileSync(path.join(repo.cwd, 'file.txt'), 'utf-8')
    expect(content).not.toContain('<<<<<<<')
    expect(content).toContain('our version')
    expect(content).toContain('their version')
  })
})

describe('abortMerge', () => {
  let repo: TestRepo

  beforeEach(() => { repo = createTestRepo() })
  afterEach(() => {
    try { run(repo.cwd, 'git', ['merge', '--abort']) } catch { /* ignore */ }
    repo.cleanup()
  })

  it('aborts an in-progress merge', async () => {
    commitFile(repo.cwd, 'file.txt', 'base\n', 'base')
    run(repo.cwd, 'git', ['checkout', '-b', 'conflict-branch'])
    commitFile(repo.cwd, 'file.txt', 'conflict\n', 'conflict')
    run(repo.cwd, 'git', ['checkout', 'master'])
    commitFile(repo.cwd, 'file.txt', 'different\n', 'different')
    try { run(repo.cwd, 'git', ['merge', 'conflict-branch']) } catch { /* expected */ }
    const state1 = await getMergeState(repo.cwd)
    expect(state1.inProgress).toBe(true)
    await abortMerge(repo.cwd)
    const state2 = await getMergeState(repo.cwd)
    expect(state2.inProgress).toBe(false)
  })
})

describe('continueMerge', () => {
  let repo: TestRepo

  beforeEach(() => { repo = createTestRepo() })
  afterEach(() => {
    try { run(repo.cwd, 'git', ['merge', '--abort']) } catch { /* ignore */ }
    repo.cleanup()
  })

  it('continues a merge after resolving conflicts', async () => {
    commitFile(repo.cwd, 'file.txt', 'base\n', 'base')
    run(repo.cwd, 'git', ['checkout', '-b', 'merge-branch'])
    commitFile(repo.cwd, 'file.txt', 'merge content\n', 'merge change')
    run(repo.cwd, 'git', ['checkout', 'master'])
    commitFile(repo.cwd, 'file.txt', 'master content\n', 'master change')
    try { run(repo.cwd, 'git', ['merge', 'merge-branch']) } catch { /* expected */ }
    // Resolve the conflict
    await resolveConflictFile(repo.cwd, 'file.txt', 'ours')
    run(repo.cwd, 'git', ['add', 'file.txt'])
    await continueMerge(repo.cwd)
    const state = await getMergeState(repo.cwd)
    expect(state.inProgress).toBe(false)
  })
})

describe('createTag', () => {
  let repo: TestRepo

  beforeEach(() => { repo = createTestRepo() })
  afterEach(() => { repo.cleanup() })

  it('creates a lightweight tag', async () => {
    const hash = commitFile(repo.cwd, 'file.txt', 'content', 'for tag')
    await createTag(repo.cwd, 'v1.0.0', hash)
    const tagHash = run(repo.cwd, 'git', ['rev-parse', 'v1.0.0'])
    expect(tagHash).toBe(hash)
  })

  it('creates an annotated tag', async () => {
    const hash = commitFile(repo.cwd, 'file.txt', 'content', 'for annotated tag')
    await createTag(repo.cwd, 'v2.0.0', hash, 'Release 2.0.0')
    // Annotated tags have their own hash, but dereference to the commit
    const tagCommitHash = run(repo.cwd, 'git', ['rev-parse', 'v2.0.0^{commit}'])
    expect(tagCommitHash).toBe(hash)
    // Verify tag message
    const tagMessage = run(repo.cwd, 'git', ['tag', '-l', '-n1', 'v2.0.0'])
    expect(tagMessage).toContain('Release 2.0.0')
  })

  it('throws on duplicate tag name', async () => {
    const hash = commitFile(repo.cwd, 'file.txt', 'content', 'for tag')
    await createTag(repo.cwd, 'dup-tag', hash)
    await expect(createTag(repo.cwd, 'dup-tag', hash)).rejects.toThrow()
  })

  it('tag appears in log refs', async () => {
    const hash = commitFile(repo.cwd, 'file.txt', 'content', 'tagged commit')
    await createTag(repo.cwd, 'test-ref-tag', hash)
    const log = await getLog(repo.cwd, { maxCount: 1 })
    expect(log[0].refs.some((r) => r.includes('test-ref-tag'))).toBe(true)
  })
})
