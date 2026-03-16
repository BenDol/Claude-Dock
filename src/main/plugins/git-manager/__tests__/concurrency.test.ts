import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../services', () => ({
  getServices: () => ({
    log: () => {},
    logInfo: () => {},
    logError: () => {}
  })
}))

import { createTestRepo, commitFile, writeFile, run, type TestRepo } from './setup'
import {
  checkoutBranch,
  stashSave,
  stageFiles,
  getStatus,
  getLog,
  getBranches,
  getStashList,
  removeLockFile,
  fetchSimple
} from '../git-operations'

import * as fs from 'fs'
import * as path from 'path'

// ============================================================
// Concurrency & busy guard tests
//
// These tests verify that:
// 1. Concurrent git operations on the same repo cause index.lock errors
// 2. Sequential (serialized) operations complete without lock conflicts
// 3. The busy guard pattern correctly blocks/allows operations
// 4. Recovery from lock file errors works
// ============================================================

describe('concurrent git operations cause lock file errors', () => {
  let repo: TestRepo

  beforeEach(() => { repo = createTestRepo() })
  afterEach(() => { repo.cleanup() })

  it('parallel git write operations race on index.lock', async () => {
    // Set up repo with files to stage
    commitFile(repo.cwd, 'a.txt', 'a', 'add a')
    commitFile(repo.cwd, 'b.txt', 'b', 'add b')
    writeFile(repo.cwd, 'a.txt', 'modified-a')
    writeFile(repo.cwd, 'b.txt', 'modified-b')

    // Create a lock file to simulate a concurrent git process holding the lock
    const lockPath = path.join(repo.cwd, '.git', 'index.lock')
    fs.writeFileSync(lockPath, '')

    // Any git write operation should fail when lock exists
    try {
      await stageFiles(repo.cwd, ['a.txt'])
      expect.unreachable('should have thrown due to lock file')
    } catch (err: any) {
      const msg = err.message || String(err)
      expect(msg).toMatch(/index\.lock|another git process/i)
    }

    // Cleanup lock so afterEach cleanup works
    fs.unlinkSync(lockPath)
  })

  it('stash fails when lock file exists (simulates race with refresh)', async () => {
    commitFile(repo.cwd, 'file.txt', 'original', 'init')
    writeFile(repo.cwd, 'file.txt', 'dirty')

    // Simulate a concurrent git process holding the lock (like refresh() running)
    const lockPath = path.join(repo.cwd, '.git', 'index.lock')
    fs.writeFileSync(lockPath, '')

    try {
      await stashSave(repo.cwd, 'should-fail')
      expect.unreachable('should have thrown due to lock file')
    } catch (err: any) {
      const msg = err.message || String(err)
      expect(msg).toMatch(/index\.lock|another git process/i)
    }

    fs.unlinkSync(lockPath)
  })

  it('checkout fails when lock file exists', async () => {
    commitFile(repo.cwd, 'file.txt', 'content', 'init')
    run(repo.cwd, 'git', ['branch', 'feature'])

    const lockPath = path.join(repo.cwd, '.git', 'index.lock')
    fs.writeFileSync(lockPath, '')

    try {
      await checkoutBranch(repo.cwd, 'feature')
      expect.unreachable('should have thrown due to lock file')
    } catch (err: any) {
      const msg = err.message || String(err)
      expect(msg).toMatch(/index\.lock|another git process/i)
    }

    fs.unlinkSync(lockPath)
  })
})

describe('serialized operations complete without lock conflicts', () => {
  let repo: TestRepo

  beforeEach(() => { repo = createTestRepo() })
  afterEach(() => { repo.cleanup() })

  it('stash then checkout sequentially succeeds', async () => {
    commitFile(repo.cwd, 'file.txt', 'original', 'init')
    run(repo.cwd, 'git', ['branch', 'feature'])
    run(repo.cwd, 'git', ['checkout', 'feature'])
    commitFile(repo.cwd, 'file.txt', 'feature-content', 'feature')
    run(repo.cwd, 'git', ['checkout', 'master'])
    writeFile(repo.cwd, 'file.txt', 'dirty')

    // Sequential: stash completes fully before checkout starts
    await stashSave(repo.cwd, 'stash-first')
    // No lock file should exist between operations
    expect(fs.existsSync(path.join(repo.cwd, '.git', 'index.lock'))).toBe(false)
    await checkoutBranch(repo.cwd, 'feature')

    const status = await getStatus(repo.cwd)
    expect(status.branch).toBe('feature')
  })

  it('stash then multiple read operations sequentially succeeds', async () => {
    commitFile(repo.cwd, 'file.txt', 'original', 'init')
    writeFile(repo.cwd, 'file.txt', 'dirty')

    await stashSave(repo.cwd, 'stash-first')

    // These simulate what refresh() does — multiple parallel reads
    const [status, log, branches, stashes] = await Promise.all([
      getStatus(repo.cwd),
      getLog(repo.cwd, {}),
      getBranches(repo.cwd),
      getStashList(repo.cwd)
    ])

    expect(status.branch).toBe('master')
    expect(log.length).toBeGreaterThan(0)
    expect(branches.length).toBeGreaterThan(0)
    expect(stashes.length).toBe(1)
  })

  it('remove lock then retry succeeds (recovery flow)', async () => {
    commitFile(repo.cwd, 'file.txt', 'original', 'init')
    writeFile(repo.cwd, 'file.txt', 'dirty')

    // Simulate stale lock from crashed process
    const lockPath = path.join(repo.cwd, '.git', 'index.lock')
    fs.writeFileSync(lockPath, '')

    // Stash fails
    try {
      await stashSave(repo.cwd, 'should-fail')
      expect.unreachable('should have thrown')
    } catch {
      // expected
    }

    // Remove lock file then retry — simulates the resolution action
    await removeLockFile(repo.cwd)
    expect(fs.existsSync(lockPath)).toBe(false)

    // Now stash succeeds
    await stashSave(repo.cwd, 'recovered')
    const list = await getStashList(repo.cwd)
    expect(list.length).toBe(1)
    expect(list[0].message).toContain('recovered')
  })
})

describe('busy guard pattern', () => {
  // These tests verify the busy guard logic used in the UI layer.
  // The actual guards use a React ref ({ current: boolean }) to coordinate
  // between ErrorDialog resolution actions and auto-fetch/refresh.
  // We test the pattern here without React dependencies.

  /** Simulates the actionBusyRef from GitManagerApp */
  function createBusyRef() {
    return { current: false }
  }

  /**
   * Simulates the auto-fetch guard:
   *   if (actionBusyRef.current) return
   *   await fetchAll(...)
   */
  async function simulateAutoFetch(busyRef: { current: boolean }, action: () => Promise<void>) {
    if (busyRef.current) return 'skipped'
    await action()
    return 'executed'
  }

  /**
   * Simulates the ErrorDialog resolution handler:
   *   busyRef.current = true
   *   try { await resolution.action() } finally { busyRef.current = false }
   */
  async function simulateResolution(busyRef: { current: boolean }, action: () => Promise<void>) {
    busyRef.current = true
    try {
      await action()
    } finally {
      busyRef.current = false
    }
  }

  it('auto-fetch is skipped when busy ref is set', async () => {
    const busyRef = createBusyRef()
    const fetchFn = vi.fn()

    busyRef.current = true
    const result = await simulateAutoFetch(busyRef, fetchFn)

    expect(result).toBe('skipped')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('auto-fetch executes when busy ref is not set', async () => {
    const busyRef = createBusyRef()
    const fetchFn = vi.fn()

    const result = await simulateAutoFetch(busyRef, fetchFn)

    expect(result).toBe('executed')
    expect(fetchFn).toHaveBeenCalledOnce()
  })

  it('resolution sets busy ref during execution and clears after', async () => {
    const busyRef = createBusyRef()
    const states: boolean[] = []

    await simulateResolution(busyRef, async () => {
      // During resolution, ref should be true
      states.push(busyRef.current)
    })

    // After resolution, ref should be false
    states.push(busyRef.current)

    expect(states).toEqual([true, false])
  })

  it('resolution clears busy ref even on error', async () => {
    const busyRef = createBusyRef()

    try {
      await simulateResolution(busyRef, async () => {
        throw new Error('resolution failed')
      })
    } catch {
      // expected
    }

    expect(busyRef.current).toBe(false)
  })

  it('auto-fetch blocked during resolution, allowed after', async () => {
    const busyRef = createBusyRef()
    const fetchFn = vi.fn()
    const results: string[] = []

    // Start resolution — sets busy
    const resolutionPromise = simulateResolution(busyRef, async () => {
      // While resolution runs, auto-fetch should be blocked
      results.push(await simulateAutoFetch(busyRef, fetchFn) as string)
    })

    await resolutionPromise

    // After resolution, auto-fetch should work
    results.push(await simulateAutoFetch(busyRef, fetchFn) as string)

    expect(results).toEqual(['skipped', 'executed'])
    expect(fetchFn).toHaveBeenCalledOnce()
  })

  it('multiple auto-fetch attempts are all blocked during resolution', async () => {
    const busyRef = createBusyRef()
    const fetchFn = vi.fn()

    busyRef.current = true

    const results = await Promise.all([
      simulateAutoFetch(busyRef, fetchFn),
      simulateAutoFetch(busyRef, fetchFn),
      simulateAutoFetch(busyRef, fetchFn)
    ])

    expect(results).toEqual(['skipped', 'skipped', 'skipped'])
    expect(fetchFn).not.toHaveBeenCalled()

    busyRef.current = false

    const afterResult = await simulateAutoFetch(busyRef, fetchFn)
    expect(afterResult).toBe('executed')
    expect(fetchFn).toHaveBeenCalledOnce()
  })
})

describe('handler early-return on failure (no refresh after error)', () => {
  // Tests the pattern where handleCheckoutBranch/handlePush return early
  // when the operation fails, instead of calling refresh().
  // This prevents refresh() from racing with the resolution action.

  it('simulated checkout handler does not refresh on failure', async () => {
    const refreshFn = vi.fn()
    const showErrorFn = vi.fn()

    // Simulate handleCheckoutBranch logic
    const handleCheckout = async (succeed: boolean) => {
      const result = { success: succeed, error: succeed ? undefined : 'local changes would be overwritten' }
      if (!result.success) {
        showErrorFn(result.error)
        return // <-- the fix: early return, no refresh
      }
      refreshFn()
    }

    // Failure case: error shown, no refresh
    await handleCheckout(false)
    expect(showErrorFn).toHaveBeenCalledOnce()
    expect(refreshFn).not.toHaveBeenCalled()

    showErrorFn.mockClear()

    // Success case: refresh called, no error
    await handleCheckout(true)
    expect(showErrorFn).not.toHaveBeenCalled()
    expect(refreshFn).toHaveBeenCalledOnce()
  })

  it('simulated push handler does not refresh on failure', async () => {
    const refreshFn = vi.fn()
    const showErrorFn = vi.fn()

    const handlePush = async (succeed: boolean) => {
      const result = { success: succeed, error: succeed ? undefined : 'non-fast-forward' }
      if (!result.success) {
        showErrorFn(result.error)
        return
      }
      refreshFn()
    }

    await handlePush(false)
    expect(showErrorFn).toHaveBeenCalledOnce()
    expect(refreshFn).not.toHaveBeenCalled()

    showErrorFn.mockClear()

    await handlePush(true)
    expect(showErrorFn).not.toHaveBeenCalled()
    expect(refreshFn).toHaveBeenCalledOnce()
  })
})

describe('full resolution flow with busy guard (integration)', () => {
  let repo: TestRepo

  beforeEach(() => { repo = createTestRepo() })
  afterEach(() => { repo.cleanup() })

  it('stash-checkout resolution does not conflict with guarded refresh', async () => {
    // Setup: divergent branches with dirty working tree
    commitFile(repo.cwd, 'file.txt', 'original', 'init')
    run(repo.cwd, 'git', ['branch', 'feature'])
    run(repo.cwd, 'git', ['checkout', 'feature'])
    commitFile(repo.cwd, 'file.txt', 'feature-content', 'feature')
    run(repo.cwd, 'git', ['checkout', 'master'])
    writeFile(repo.cwd, 'file.txt', 'dirty')

    const busyRef = { current: false }
    const refreshCalls: string[] = []

    // Simulate the resolution flow exactly as it happens in the UI:
    // 1. ErrorDialog sets busyRef = true
    // 2. Resolution runs stash + checkout
    // 3. Meanwhile, auto-fetch checks busyRef and skips
    // 4. ErrorDialog sets busyRef = false
    // 5. onResolved calls refresh()

    // Step 1-2: Resolution action (stash then checkout)
    busyRef.current = true
    try {
      await stashSave(repo.cwd, 'Auto-stash before checkout')
      await checkoutBranch(repo.cwd, 'feature')
    } finally {
      busyRef.current = false
    }

    // Step 3: While resolution was running, auto-fetch would have been blocked
    // (verified by the busy guard pattern tests above)

    // Step 5: After resolution, refresh runs
    const [status, stashes] = await Promise.all([
      getStatus(repo.cwd),
      getStashList(repo.cwd)
    ])

    // Verify everything completed correctly
    expect(status.branch).toBe('feature')
    expect(stashes.length).toBe(1)
    expect(fs.readFileSync(path.join(repo.cwd, 'file.txt'), 'utf-8')).toBe('feature-content')

    // No lock file should be left behind
    expect(fs.existsSync(path.join(repo.cwd, '.git', 'index.lock'))).toBe(false)
  })

  it('multiple sequential resolutions do not leave stale locks', async () => {
    commitFile(repo.cwd, 'file.txt', 'original', 'init')
    run(repo.cwd, 'git', ['branch', 'feature'])
    run(repo.cwd, 'git', ['checkout', 'feature'])
    commitFile(repo.cwd, 'feature-only.txt', 'feature', 'feature file')
    run(repo.cwd, 'git', ['checkout', 'master'])

    const busyRef = { current: false }

    // First resolution: stash + checkout to feature
    writeFile(repo.cwd, 'file.txt', 'dirty-1')
    busyRef.current = true
    try {
      await stashSave(repo.cwd, 'stash-1')
      await checkoutBranch(repo.cwd, 'feature')
    } finally {
      busyRef.current = false
    }
    expect(fs.existsSync(path.join(repo.cwd, '.git', 'index.lock'))).toBe(false)

    // Second resolution: stash + checkout back to master
    writeFile(repo.cwd, 'feature-only.txt', 'dirty-2')
    busyRef.current = true
    try {
      await stashSave(repo.cwd, 'stash-2')
      await checkoutBranch(repo.cwd, 'master')
    } finally {
      busyRef.current = false
    }
    expect(fs.existsSync(path.join(repo.cwd, '.git', 'index.lock'))).toBe(false)

    const status = await getStatus(repo.cwd)
    expect(status.branch).toBe('master')

    const stashes = await getStashList(repo.cwd)
    expect(stashes.length).toBe(2)
  })
})
