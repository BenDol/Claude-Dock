import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../services', () => ({
  getServices: () => ({
    log: () => {},
    logInfo: () => {},
    logError: () => {}
  })
}))

import { createTestRepo, createBareRemote, commitFile, writeFile, run, type TestRepo } from './setup'
import {
  checkoutBranch,
  createBranch,
  deleteBranch,
  stashSave,
  stashPop,
  getStashList,
  getStatus,
  cherryPick,
  revertCommit,
  mergeBranch,
  pull,
  push,
  resetBranch,
  createCommit,
  stageFiles,
  removeLockFile
} from '../git-operations'

import * as fs from 'fs'
import * as path from 'path'

// ============================================================
// Error message pattern tests
// These verify that git operations produce recognizable error
// messages that the UI error parser can match against.
// ============================================================

describe('checkout errors', () => {
  let repo: TestRepo

  beforeEach(() => { repo = createTestRepo() })
  afterEach(() => { repo.cleanup() })

  it('fails with dirty working tree message when files would be overwritten', async () => {
    commitFile(repo.cwd, 'file.txt', 'original', 'add file')
    run(repo.cwd, 'git', ['branch', 'other'])
    // Modify file on other branch
    run(repo.cwd, 'git', ['checkout', 'other'])
    commitFile(repo.cwd, 'file.txt', 'changed on other', 'change on other')
    run(repo.cwd, 'git', ['checkout', 'master'])
    // Create a dirty working tree
    writeFile(repo.cwd, 'file.txt', 'dirty changes')

    try {
      await checkoutBranch(repo.cwd, 'other')
      expect.unreachable('should have thrown')
    } catch (err: any) {
      const msg = err.message || String(err)
      // Git should mention local changes or overwritten
      expect(msg).toMatch(/local changes|overwritten|stash|commit your changes/i)
    }
  })

  it('fails when branch does not exist', async () => {
    try {
      await checkoutBranch(repo.cwd, 'nonexistent-branch')
      expect.unreachable('should have thrown')
    } catch (err: any) {
      const msg = err.message || String(err)
      expect(msg).toMatch(/did not match|pathspec|not found|invalid reference/i)
    }
  })
})

describe('stash with flags', () => {
  let repo: TestRepo

  beforeEach(() => { repo = createTestRepo() })
  afterEach(() => { repo.cleanup() })

  it('stashSave basic stash works', async () => {
    commitFile(repo.cwd, 'file.txt', 'original', 'add file')
    writeFile(repo.cwd, 'file.txt', 'modified')

    await stashSave(repo.cwd, 'test stash')
    const list = await getStashList(repo.cwd)
    expect(list.length).toBe(1)
    expect(list[0].message).toContain('test stash')

    // Working tree should be clean
    const content = fs.readFileSync(path.join(repo.cwd, 'file.txt'), 'utf-8')
    expect(content).toBe('original')
  })

  it('stashSave with --keep-index keeps staged files', async () => {
    commitFile(repo.cwd, 'file.txt', 'original', 'add file')
    commitFile(repo.cwd, 'other.txt', 'original-other', 'add other')

    // Stage a change to file.txt
    writeFile(repo.cwd, 'file.txt', 'staged-change')
    run(repo.cwd, 'git', ['add', 'file.txt'])
    // Create an unstaged change to other.txt
    writeFile(repo.cwd, 'other.txt', 'dirty')

    await stashSave(repo.cwd, 'keep-index stash', '--keep-index')
    const list = await getStashList(repo.cwd)
    expect(list.length).toBe(1)

    // Staged file should still be staged (in index)
    const status = await getStatus(repo.cwd)
    const stagedPaths = status.staged.map(f => f.path)
    expect(stagedPaths).toContain('file.txt')
  })

  it('stashSave with --include-untracked stashes untracked files', async () => {
    commitFile(repo.cwd, 'file.txt', 'original', 'add file')
    // Create an untracked file
    writeFile(repo.cwd, 'untracked.txt', 'new file')

    await stashSave(repo.cwd, 'include-untracked stash', '--include-untracked')
    const list = await getStashList(repo.cwd)
    expect(list.length).toBe(1)

    // Untracked file should be gone
    expect(fs.existsSync(path.join(repo.cwd, 'untracked.txt'))).toBe(false)
  })

  it('stash then checkout works (the resolution flow)', async () => {
    commitFile(repo.cwd, 'file.txt', 'original', 'add file')
    run(repo.cwd, 'git', ['branch', 'feature'])
    // Make a change on feature
    run(repo.cwd, 'git', ['checkout', 'feature'])
    commitFile(repo.cwd, 'file.txt', 'feature-change', 'change on feature')
    run(repo.cwd, 'git', ['checkout', 'master'])
    // Create dirty working tree
    writeFile(repo.cwd, 'file.txt', 'dirty local changes')

    // Checkout should fail
    try {
      await checkoutBranch(repo.cwd, 'feature')
      expect.unreachable('should have thrown')
    } catch {
      // expected
    }

    // Stash should work
    await stashSave(repo.cwd, 'Auto-stash before checkout')
    const list = await getStashList(repo.cwd)
    expect(list.length).toBe(1)

    // Now checkout should succeed
    await checkoutBranch(repo.cwd, 'feature')
    const content = fs.readFileSync(path.join(repo.cwd, 'file.txt'), 'utf-8')
    expect(content).toBe('feature-change')
  })
})

describe('branch delete errors', () => {
  let repo: TestRepo

  beforeEach(() => { repo = createTestRepo() })
  afterEach(() => { repo.cleanup() })

  it('fails to delete current branch', async () => {
    commitFile(repo.cwd, 'file.txt', 'content', 'init')
    const currentBranch = run(repo.cwd, 'git', ['branch', '--show-current'])

    try {
      await deleteBranch(repo.cwd, currentBranch)
      expect.unreachable('should have thrown')
    } catch (err: any) {
      const msg = err.message || String(err)
      expect(msg).toMatch(/cannot delete|checked out/i)
    }
  })

  it('fails to delete non-existent branch', async () => {
    try {
      await deleteBranch(repo.cwd, 'nonexistent')
      expect.unreachable('should have thrown')
    } catch (err: any) {
      const msg = err.message || String(err)
      expect(msg).toMatch(/not found|error/i)
    }
  })
})

describe('create branch errors', () => {
  let repo: TestRepo

  beforeEach(() => { repo = createTestRepo() })
  afterEach(() => { repo.cleanup() })

  it('fails when branch already exists', async () => {
    commitFile(repo.cwd, 'file.txt', 'content', 'init')
    run(repo.cwd, 'git', ['branch', 'existing'])

    try {
      await createBranch(repo.cwd, 'existing')
      expect.unreachable('should have thrown')
    } catch (err: any) {
      const msg = err.message || String(err)
      expect(msg).toMatch(/already exists/i)
    }
  })
})

describe('merge errors', () => {
  let repo: TestRepo

  beforeEach(() => { repo = createTestRepo() })
  afterEach(() => { repo.cleanup() })

  it('fails with conflict message when merge has conflicts', async () => {
    commitFile(repo.cwd, 'file.txt', 'base', 'base')
    run(repo.cwd, 'git', ['branch', 'feature'])

    // Diverge: change file on master
    commitFile(repo.cwd, 'file.txt', 'master-change', 'master change')

    // Change same file on feature
    run(repo.cwd, 'git', ['checkout', 'feature'])
    commitFile(repo.cwd, 'file.txt', 'feature-change', 'feature change')
    run(repo.cwd, 'git', ['checkout', 'master'])

    try {
      await mergeBranch(repo.cwd, 'feature')
      expect.unreachable('should have thrown')
    } catch (err: any) {
      const msg = err.message || String(err)
      expect(msg).toMatch(/conflict|merge|CONFLICT/i)
    }

    // Cleanup merge state
    run(repo.cwd, 'git', ['merge', '--abort'])
  })
})

describe('cherry-pick errors', () => {
  let repo: TestRepo

  beforeEach(() => { repo = createTestRepo() })
  afterEach(() => { repo.cleanup() })

  it('fails with conflict message when cherry-pick has conflicts', async () => {
    commitFile(repo.cwd, 'file.txt', 'base', 'base')
    run(repo.cwd, 'git', ['branch', 'feature'])

    // Diverge
    commitFile(repo.cwd, 'file.txt', 'master-v2', 'master change')

    run(repo.cwd, 'git', ['checkout', 'feature'])
    const featureHash = commitFile(repo.cwd, 'file.txt', 'feature-v2', 'feature change')
    run(repo.cwd, 'git', ['checkout', 'master'])

    try {
      await cherryPick(repo.cwd, featureHash)
      expect.unreachable('should have thrown')
    } catch (err: any) {
      const msg = err.message || String(err)
      expect(msg).toMatch(/conflict|could not apply|CONFLICT/i)
    }

    // Cleanup
    run(repo.cwd, 'git', ['cherry-pick', '--abort'])
  })
})

describe('revert errors', () => {
  let repo: TestRepo

  beforeEach(() => { repo = createTestRepo() })
  afterEach(() => { repo.cleanup() })

  it('fails with conflict message when revert has conflicts', async () => {
    const h1 = commitFile(repo.cwd, 'file.txt', 'version1', 'v1')
    commitFile(repo.cwd, 'file.txt', 'version2', 'v2')
    commitFile(repo.cwd, 'file.txt', 'version3', 'v3')

    // Reverting v1 (which introduced the file) should conflict with v2/v3 changes
    try {
      await revertCommit(repo.cwd, h1)
      // Might succeed or fail depending on content — if it fails, check message
    } catch (err: any) {
      const msg = err.message || String(err)
      expect(msg).toMatch(/conflict|could not revert|CONFLICT/i)
      run(repo.cwd, 'git', ['revert', '--abort'])
    }
  })
})

describe('reset errors', () => {
  let repo: TestRepo

  beforeEach(() => { repo = createTestRepo() })
  afterEach(() => { repo.cleanup() })

  it('reset keep fails with dirty working tree when file changed', async () => {
    const h1 = commitFile(repo.cwd, 'file.txt', 'v1', 'v1')
    commitFile(repo.cwd, 'file.txt', 'v2', 'v2')
    // Dirty the working tree
    writeFile(repo.cwd, 'file.txt', 'dirty')

    try {
      await resetBranch(repo.cwd, h1, 'keep')
      expect.unreachable('should have thrown')
    } catch (err: any) {
      const msg = err.message || String(err)
      // Git should mention local changes
      expect(msg).toMatch(/local.*change|entry.*not.*uptodate|cannot.*keep/i)
    }
  })
})

describe('push errors', () => {
  let repo: TestRepo
  let bareDir: string

  beforeEach(() => {
    repo = createTestRepo()
    bareDir = createBareRemote()
  })
  afterEach(() => {
    repo.cleanup()
    try { fs.rmSync(bareDir, { recursive: true, force: true }) } catch { /* ok */ }
  })

  it('push rejected non-fast-forward', async () => {
    commitFile(repo.cwd, 'file.txt', 'content', 'init')
    run(repo.cwd, 'git', ['remote', 'add', 'origin', bareDir])
    run(repo.cwd, 'git', ['push', '-u', 'origin', 'master'])

    // Clone a second copy and push a conflicting commit
    const tmpDir2 = path.join(require('os').tmpdir(), `git-mgr-clone-${Date.now()}`)
    run(require('os').tmpdir(), 'git', ['clone', bareDir, tmpDir2])
    run(tmpDir2, 'git', ['config', 'user.email', 'other@test.com'])
    run(tmpDir2, 'git', ['config', 'user.name', 'Other'])
    commitFile(tmpDir2, 'file.txt', 'other-change', 'other commit')
    run(tmpDir2, 'git', ['push', 'origin', 'master'])

    // Now commit locally and try to push — should fail
    commitFile(repo.cwd, 'file.txt', 'local-change', 'local commit')

    try {
      await push(repo.cwd)
      expect.unreachable('should have thrown')
    } catch (err: any) {
      const msg = err.message || String(err)
      expect(msg).toMatch(/rejected|non-fast-forward|fetch first|failed to push/i)
    }

    // Cleanup
    try { fs.rmSync(tmpDir2, { recursive: true, force: true }) } catch { /* ok */ }
  })
})

describe('commit errors', () => {
  let repo: TestRepo

  beforeEach(() => { repo = createTestRepo() })
  afterEach(() => { repo.cleanup() })

  it('commit with nothing staged fails', async () => {
    commitFile(repo.cwd, 'file.txt', 'content', 'init')

    try {
      await createCommit(repo.cwd, 'empty commit')
      expect.unreachable('should have thrown')
    } catch (err: any) {
      // Git puts "nothing to commit" in stdout, which may not be in err.message
      const msg = (err.message || '') + (err.stderr || '') + (err.stdout || '')
      expect(msg).toMatch(/nothing to commit|no changes|command failed/i)
    }
  })

  it('commit with empty message fails', async () => {
    commitFile(repo.cwd, 'file.txt', 'content', 'init')
    writeFile(repo.cwd, 'file.txt', 'changed')
    await stageFiles(repo.cwd, ['file.txt'])

    try {
      await createCommit(repo.cwd, '')
      expect.unreachable('should have thrown')
    } catch (err: any) {
      const msg = err.message || String(err)
      expect(msg).toMatch(/empty.*message|aborting/i)
    }
  })
})

// ============================================================
// Error pattern matching tests
// These test that the parseGitError patterns match real git
// error messages and produce the correct resolution types.
// ============================================================

describe('error message pattern matching', () => {
  // These test the regex patterns used in parseGitError
  const dirtyTreePatterns = [
    'error: Your local changes to the following files would be overwritten by checkout:\n\tfile.txt\nPlease commit your changes or stash them before you switch branches.\nAborting',
    'error: Your local changes to the following files would be overwritten by merge:\n\tpackage.json\nPlease commit your changes or stash them before you merge.',
    'error: cannot pull with rebase: You have unstaged changes.\nerror: please commit or stash them.',
    'error: cannot checkout branch -- uncommitted changes would be overwritten',
    'error: Your local changes would be overwritten by pull. Commit or stash them.'
  ]

  const pushRejectedPatterns = [
    'error: failed to push some refs to \'origin\'\nhint: Updates were rejected because the remote contains work that you do\nhint: not have locally.',
    'To https://github.com/user/repo.git\n ! [rejected]        main -> main (non-fast-forward)',
    '! [rejected]        master -> master (fetch first)',
    'error: failed to push some refs'
  ]

  const conflictPatterns = [
    'CONFLICT (content): Merge conflict in file.txt\nAutomatic merge failed; fix conflicts and then commit the result.',
    'error: could not apply abc1234... some commit\nhint: Resolve all conflicts manually',
    'CONFLICT (modify/delete): file.txt deleted in HEAD and modified in feature.',
    'Automatic merge failed; fix conflicts and then commit the result.'
  ]

  const branchExistsPatterns = [
    'fatal: A branch named \'feature\' already exists.',
    'fatal: a branch named \'main\' already exists'
  ]

  const deleteCurrentBranchPatterns = [
    'error: Cannot delete branch \'main\' checked out at \'/path/to/repo\'',
    'error: cannot delete branch \'feature\' currently on it'
  ]

  const unmergedPatterns = [
    'error: you need to resolve your current index first\nfatal: unmerged entries exist',
    'error: Committing is not possible because you have unmerged files.',
    'hint: Fix them up in the work tree, and then use \'git add/rm <file>\'\nhint: as appropriate to mark resolution and make a commit.'
  ]

  // Dirty working tree pattern
  const dirtyTreeRegex = /local changes.*would be overwritten|uncommitted changes|unstaged changes|please.*(stash|commit)|cannot.*checkout.*with.*uncommitted|your local changes/i

  it.each(dirtyTreePatterns)('matches dirty tree pattern: %s', (msg) => {
    expect(dirtyTreeRegex.test(msg)).toBe(true)
  })

  // Push rejected pattern
  const pushRejectedRegex = /non-fast-forward|rejected.*fetch first|failed to push|updates were rejected/i

  it.each(pushRejectedPatterns)('matches push rejected pattern: %s', (msg) => {
    expect(pushRejectedRegex.test(msg)).toBe(true)
  })

  // Conflict pattern
  const conflictRegex = /conflict|merge.*failed|automatic merge failed|could not apply/i
  const nonFfRegex = /non-fast-forward/i

  it.each(conflictPatterns)('matches conflict pattern: %s', (msg) => {
    expect(conflictRegex.test(msg) && !nonFfRegex.test(msg)).toBe(true)
  })

  // Branch exists pattern
  const branchExistsRegex = /already exists|branch.*already/i

  it.each(branchExistsPatterns)('matches branch exists pattern: %s', (msg) => {
    expect(branchExistsRegex.test(msg)).toBe(true)
  })

  // Delete current branch pattern
  const deleteCurrentRegex = /cannot delete.*checked out|cannot delete branch.*currently on/i

  it.each(deleteCurrentBranchPatterns)('matches delete current branch pattern: %s', (msg) => {
    expect(deleteCurrentRegex.test(msg)).toBe(true)
  })

  // Unmerged paths pattern
  const unmergedRegex = /unmerged|fix conflicts and run|fix them up/i

  it.each(unmergedPatterns)('matches unmerged pattern: %s', (msg) => {
    expect(unmergedRegex.test(msg)).toBe(true)
  })

  // Lock file pattern
  const lockFilePatterns = [
    "error: Unable to create 'C:/Projects/repo/.git/index.lock': File exists.\nAnother git process seems to be running in this repository",
    "fatal: Unable to create '/home/user/repo/.git/index.lock': File exists.",
    "Another git process seems to be running in this repository, e.g. an editor opened by 'git commit'."
  ]

  const lockFileRegex = /index\.lock.*file exists|unable to create.*index\.lock|another git process/i

  it.each(lockFilePatterns)('matches lock file pattern: %s', (msg) => {
    expect(lockFileRegex.test(msg)).toBe(true)
  })

  // Negative tests — make sure patterns don't match wrong errors
  it('dirty tree pattern does not match push rejected', () => {
    const msg = '! [rejected] master -> master (non-fast-forward)'
    expect(dirtyTreeRegex.test(msg)).toBe(false)
  })

  it('push rejected pattern does not match merge conflict', () => {
    const msg = 'CONFLICT (content): Merge conflict in file.txt'
    expect(pushRejectedRegex.test(msg)).toBe(false)
  })

  it('conflict pattern does not match non-fast-forward push rejection', () => {
    // Non-fast-forward messages contain "failed to push" but we exclude them
    const msg = '! [rejected] master -> master (non-fast-forward)'
    // conflictRegex alone might match, but we have the nonFfRegex exclusion
    const matches = conflictRegex.test(msg) && !nonFfRegex.test(msg)
    expect(matches).toBe(false)
  })
})

describe('stash error recovery integration', () => {
  let repo: TestRepo

  beforeEach(() => { repo = createTestRepo() })
  afterEach(() => { repo.cleanup() })

  it('full stash-checkout-pop flow works', async () => {
    commitFile(repo.cwd, 'file.txt', 'original', 'add file')
    run(repo.cwd, 'git', ['branch', 'feature'])
    run(repo.cwd, 'git', ['checkout', 'feature'])
    commitFile(repo.cwd, 'file.txt', 'feature-content', 'feature change')
    run(repo.cwd, 'git', ['checkout', 'master'])

    // Dirty working tree
    writeFile(repo.cwd, 'file.txt', 'my-local-work')

    // 1. Checkout fails
    try {
      await checkoutBranch(repo.cwd, 'feature')
      expect.unreachable('should have thrown')
    } catch {
      // expected
    }

    // 2. Stash saves changes
    await stashSave(repo.cwd, 'auto-stash')
    const stashList = await getStashList(repo.cwd)
    expect(stashList.length).toBe(1)

    // 3. Checkout now succeeds
    await checkoutBranch(repo.cwd, 'feature')
    const status = await getStatus(repo.cwd)
    expect(status.branch).toBe('feature')

    // 4. File has feature content
    const content = fs.readFileSync(path.join(repo.cwd, 'file.txt'), 'utf-8')
    expect(content).toBe('feature-content')
  })

  it('stash with --include-untracked then checkout works', async () => {
    commitFile(repo.cwd, 'file.txt', 'original', 'add file')
    run(repo.cwd, 'git', ['branch', 'feature'])

    // Create only untracked files (no dirty tracked files to avoid conflict on pop)
    writeFile(repo.cwd, 'newfile.txt', 'untracked')

    // Stash with include-untracked
    await stashSave(repo.cwd, 'auto-stash', '--include-untracked')

    // Untracked file should be gone
    expect(fs.existsSync(path.join(repo.cwd, 'newfile.txt'))).toBe(false)

    // Checkout should work
    await checkoutBranch(repo.cwd, 'feature')
    const status = await getStatus(repo.cwd)
    expect(status.branch).toBe('feature')

    // Pop stash on feature branch to get local work back
    await stashPop(repo.cwd, 0)
    expect(fs.existsSync(path.join(repo.cwd, 'newfile.txt'))).toBe(true)
    expect(fs.readFileSync(path.join(repo.cwd, 'newfile.txt'), 'utf-8')).toBe('untracked')
  })

  it('stash with --keep-index preserves staged changes', async () => {
    commitFile(repo.cwd, 'file.txt', 'original', 'add file')
    commitFile(repo.cwd, 'other.txt', 'original-other', 'add other')

    // Stage a change to file.txt
    writeFile(repo.cwd, 'file.txt', 'staged-change')
    run(repo.cwd, 'git', ['add', 'file.txt'])

    // Make unstaged change to other.txt
    writeFile(repo.cwd, 'other.txt', 'unstaged-change')

    await stashSave(repo.cwd, 'keep-index', '--keep-index')

    // Staged change should still be in index
    const status = await getStatus(repo.cwd)
    const stagedPaths = status.staged.map(f => f.path)
    expect(stagedPaths).toContain('file.txt')

    // The stash should exist
    const list = await getStashList(repo.cwd)
    expect(list.length).toBe(1)
  })
})

describe('lock file recovery', () => {
  let repo: TestRepo

  beforeEach(() => { repo = createTestRepo() })
  afterEach(() => { repo.cleanup() })

  it('removeLockFile deletes stale index.lock', async () => {
    // Create a stale lock file
    const lockPath = path.join(repo.cwd, '.git', 'index.lock')
    fs.writeFileSync(lockPath, '')
    expect(fs.existsSync(lockPath)).toBe(true)

    await removeLockFile(repo.cwd)
    expect(fs.existsSync(lockPath)).toBe(false)
  })

  it('removeLockFile succeeds even when no lock file exists', async () => {
    // Should not throw
    await removeLockFile(repo.cwd)
  })

  it('git operations fail when lock file exists', async () => {
    commitFile(repo.cwd, 'file.txt', 'content', 'init')
    writeFile(repo.cwd, 'file.txt', 'changed')

    // Create a stale lock file
    const lockPath = path.join(repo.cwd, '.git', 'index.lock')
    fs.writeFileSync(lockPath, '')

    try {
      await stageFiles(repo.cwd, ['file.txt'])
      expect.unreachable('should have thrown')
    } catch (err: any) {
      const msg = err.message || String(err)
      expect(msg).toMatch(/index\.lock|another git process/i)
    }

    // Remove lock and retry should work
    await removeLockFile(repo.cwd)
    await stageFiles(repo.cwd, ['file.txt'])
    const status = await getStatus(repo.cwd)
    expect(status.staged.map(f => f.path)).toContain('file.txt')
  })
})

describe('merge conflict then abort flow', () => {
  let repo: TestRepo

  beforeEach(() => { repo = createTestRepo() })
  afterEach(() => { repo.cleanup() })

  it('merge conflict can be aborted', async () => {
    commitFile(repo.cwd, 'file.txt', 'base', 'base')
    run(repo.cwd, 'git', ['branch', 'feature'])
    commitFile(repo.cwd, 'file.txt', 'master-v2', 'master change')
    run(repo.cwd, 'git', ['checkout', 'feature'])
    commitFile(repo.cwd, 'file.txt', 'feature-v2', 'feature change')
    run(repo.cwd, 'git', ['checkout', 'master'])

    // Merge will conflict
    try {
      await mergeBranch(repo.cwd, 'feature')
      expect.unreachable('should conflict')
    } catch {
      // expected
    }

    // Abort the merge
    run(repo.cwd, 'git', ['merge', '--abort'])

    // Should be back to clean state
    const status = await getStatus(repo.cwd)
    expect(status.staged.length).toBe(0)
    expect(status.unstaged.length).toBe(0)

    // File should have master content
    const content = fs.readFileSync(path.join(repo.cwd, 'file.txt'), 'utf-8')
    expect(content).toBe('master-v2')
  })
})
