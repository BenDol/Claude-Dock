import { describe, it, expect } from 'vitest'
import { getTaskMeta } from '../claude-task-types'
import type { CiFixTask, WriteTestsTask } from '../claude-task-types'

describe('getTaskMeta', () => {
  it('returns correct meta for ci-fix task', () => {
    const task: CiFixTask = {
      type: 'ci-fix',
      runId: 1,
      runName: 'CI',
      runNumber: 42,
      headBranch: 'main',
      failedJobs: [{ id: 100, name: 'build', failedSteps: ['Run tests'] }]
    }

    const meta = getTaskMeta(task)
    expect(meta.label).toBe('Fix CI Failure')
    expect(meta.completionMarker).toBe('CI_FIX_COMPLETE')
  })

  it('returns correct meta for write-tests task', () => {
    const task: WriteTestsTask = {
      type: 'write-tests',
      files: ['src/foo.ts']
    }

    const meta = getTaskMeta(task)
    expect(meta.label).toBe('Write Tests')
    expect(meta.completionMarker).toBeUndefined()
  })

  it('includes label for write-tests with commit info', () => {
    const task: WriteTestsTask = {
      type: 'write-tests',
      files: [],
      commitHash: 'abc123',
      commitSubject: 'feat: something'
    }

    const meta = getTaskMeta(task)
    expect(meta.label).toBe('Write Tests')
  })

  it('ci-fix task with optional context field', () => {
    const task: CiFixTask = {
      type: 'ci-fix',
      runId: 5,
      runName: 'Build',
      runNumber: 5,
      headBranch: 'feat/branch',
      failedJobs: [],
      context: 'Fix the linting errors only'
    }

    const meta = getTaskMeta(task)
    expect(meta.label).toBe('Fix CI Failure')
    expect(meta.completionMarker).toBe('CI_FIX_COMPLETE')
  })

  it('write-tests task with optional context field', () => {
    const task: WriteTestsTask = {
      type: 'write-tests',
      files: ['a.ts', 'b.ts'],
      context: 'Use vitest'
    }

    const meta = getTaskMeta(task)
    expect(meta.label).toBe('Write Tests')
  })
})
