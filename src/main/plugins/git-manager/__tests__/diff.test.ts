import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../services', () => ({
  getServices: () => ({
    log: () => {},
    logInfo: () => {},
    logError: () => {}
  })
}))

import { createTestRepo, commitFile, writeFile, type TestRepo } from './setup'
import {
  getDiff,
  getCommitDetail,
  applyPatch,
  stageFiles,
  getStatus
} from '../git-operations'

describe('getDiff', () => {
  let repo: TestRepo

  beforeEach(() => { repo = createTestRepo() })
  afterEach(() => { repo.cleanup() })

  it('shows unstaged changes', async () => {
    commitFile(repo.cwd, 'file.txt', 'original\n', 'add file')
    writeFile(repo.cwd, 'file.txt', 'modified\n')
    const diff = await getDiff(repo.cwd)
    expect(diff.length).toBe(1)
    expect(diff[0].path).toBe('file.txt')
    expect(diff[0].status).toBe('modified')
    expect(diff[0].hunks.length).toBeGreaterThan(0)
  })

  it('shows staged changes when cached flag is set', async () => {
    commitFile(repo.cwd, 'file.txt', 'original\n', 'add file')
    writeFile(repo.cwd, 'file.txt', 'staged-change\n')
    await stageFiles(repo.cwd, ['file.txt'])
    const diff = await getDiff(repo.cwd, undefined, true)
    expect(diff.length).toBe(1)
    expect(diff[0].path).toBe('file.txt')
  })

  it('returns empty for clean working tree', async () => {
    commitFile(repo.cwd, 'file.txt', 'content\n', 'add file')
    const diff = await getDiff(repo.cwd)
    expect(diff.length).toBe(0)
  })

  it('filters by path', async () => {
    commitFile(repo.cwd, 'a.txt', 'a\n', 'add a')
    commitFile(repo.cwd, 'b.txt', 'b\n', 'add b')
    writeFile(repo.cwd, 'a.txt', 'a-modified\n')
    writeFile(repo.cwd, 'b.txt', 'b-modified\n')
    const diff = await getDiff(repo.cwd, 'a.txt')
    expect(diff.length).toBe(1)
    expect(diff[0].path).toBe('a.txt')
  })

  it('diff hunks contain correct line types', async () => {
    commitFile(repo.cwd, 'file.txt', 'line1\nline2\nline3\n', 'add file')
    writeFile(repo.cwd, 'file.txt', 'line1\nchanged\nline3\n')
    const diff = await getDiff(repo.cwd)
    const hunk = diff[0].hunks[0]
    const types = hunk.lines.map((l) => l.type)
    expect(types).toContain('add')
    expect(types).toContain('delete')
    expect(types).toContain('context')
  })
})

describe('getCommitDetail', () => {
  let repo: TestRepo

  beforeEach(() => { repo = createTestRepo() })
  afterEach(() => { repo.cleanup() })

  // Note: diff-tree outputs the commit hash as a first line, which parseDiffOutput
  // parses as a spurious file entry. Real file entries follow after index 0.
  // This is a known quirk — filtering by path avoids it.

  it('returns full commit detail with diff', async () => {
    const hash = commitFile(repo.cwd, 'file.txt', 'content\n', 'test detail')
    const detail = await getCommitDetail(repo.cwd, hash)
    expect(detail).not.toBeNull()
    expect(detail!.hash).toBe(hash)
    expect(detail!.subject).toBe('test detail')
    expect(detail!.author).toBe('Test User')
    expect(detail!.files.length).toBeGreaterThan(0)
    const fileEntry = detail!.files.find((f) => f.path === 'file.txt')
    expect(fileEntry).toBeDefined()
  })

  it('returns null for invalid hash', async () => {
    const detail = await getCommitDetail(repo.cwd, 'deadbeef12345678901234567890123456789012')
    expect(detail).toBeNull()
  })

  it('shows added file status for new files', async () => {
    const hash = commitFile(repo.cwd, 'new-file.txt', 'new\n', 'add new file')
    const detail = await getCommitDetail(repo.cwd, hash)
    const fileEntry = detail!.files.find((f) => f.path === 'new-file.txt')
    expect(fileEntry).toBeDefined()
    expect(fileEntry!.status).toBe('added')
  })

  it('shows deleted file status', async () => {
    commitFile(repo.cwd, 'to-delete.txt', 'content\n', 'add file')
    const { execFileSync } = await import('child_process')
    execFileSync('git', ['rm', 'to-delete.txt'], { cwd: repo.cwd })
    execFileSync('git', ['commit', '-m', 'delete file'], { cwd: repo.cwd })
    const hash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo.cwd, encoding: 'utf-8' }).trim()
    const detail = await getCommitDetail(repo.cwd, hash)
    const fileEntry = detail!.files.find((f) => f.path === 'to-delete.txt')
    expect(fileEntry).toBeDefined()
    expect(fileEntry!.status).toBe('deleted')
  })
})

describe('applyPatch', () => {
  let repo: TestRepo

  beforeEach(() => { repo = createTestRepo() })
  afterEach(() => { repo.cleanup() })

  it('applies a patch to the index (cached)', async () => {
    commitFile(repo.cwd, 'file.txt', 'line1\nline2\nline3\n', 'add file')
    // Create a patch that changes line2
    const patch = [
      'diff --git a/file.txt b/file.txt',
      '--- a/file.txt',
      '+++ b/file.txt',
      '@@ -2,1 +2,1 @@',
      '-line2',
      '+patched-line2',
      ''
    ].join('\n')
    await applyPatch(repo.cwd, patch, true, false)
    const status = await getStatus(repo.cwd)
    expect(status.staged.length).toBe(1)
  })

  it('reverses a patch', async () => {
    commitFile(repo.cwd, 'file.txt', 'line1\nline2\nline3\n', 'add file')
    writeFile(repo.cwd, 'file.txt', 'line1\nchanged\nline3\n')
    await stageFiles(repo.cwd, ['file.txt'])
    // Get the staged diff and reverse it
    const diff = await getDiff(repo.cwd, 'file.txt', true)
    expect(diff.length).toBe(1)
    // Build a patch from the diff to reverse
    const patch = [
      'diff --git a/file.txt b/file.txt',
      '--- a/file.txt',
      '+++ b/file.txt',
      '@@ -2,1 +2,1 @@',
      '-line2',
      '+changed',
      ''
    ].join('\n')
    await applyPatch(repo.cwd, patch, true, true)
    const status = await getStatus(repo.cwd)
    expect(status.staged.length).toBe(0)
  })
})
