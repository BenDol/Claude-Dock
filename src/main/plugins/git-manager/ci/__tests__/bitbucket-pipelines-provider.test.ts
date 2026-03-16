import { describe, it, expect, vi, beforeEach } from 'vitest'

// Hoisted mocks for credential store
const { mockStoreData, mockStore } = vi.hoisted(() => {
  const mockStoreData: Record<string, any> = {}
  const mockStore = {
    get: vi.fn((key: string) => mockStoreData[key]),
    set: vi.fn((key: string, value: any) => { mockStoreData[key] = value }),
    delete: vi.fn((key: string) => { delete mockStoreData[key] }),
    has: vi.fn((key: string) => key in mockStoreData),
    clear: vi.fn(() => { Object.keys(mockStoreData).forEach((k) => delete mockStoreData[k]) }),
    path: '/mock/store.json',
    store: {}
  }
  return { mockStoreData, mockStore }
})

// Hoisted mock for https
const { mockHttpsRequest } = vi.hoisted(() => {
  const mockHttpsRequest = vi.fn()
  return { mockHttpsRequest }
})

// Create a mock execFile that works with promisify
const { mockExecFile } = vi.hoisted(() => {
  const fn: any = vi.fn()
  fn[Symbol.for('nodejs.util.promisify.custom')] = async (...args: any[]) => {
    return new Promise((resolve, reject) => {
      fn(...args, (err: any, stdout: string, stderr: string) => {
        if (err) reject(err)
        else resolve({ stdout, stderr })
      })
    })
  }
  return { mockExecFile: fn }
})

vi.mock('child_process', () => ({
  execFile: mockExecFile
}))

vi.mock('fs', () => ({
  default: {
    promises: {
      access: vi.fn().mockRejectedValue(new Error('ENOENT')),
      writeFile: vi.fn().mockResolvedValue(undefined)
    }
  },
  promises: {
    access: vi.fn().mockRejectedValue(new Error('ENOENT')),
    writeFile: vi.fn().mockResolvedValue(undefined)
  }
}))

vi.mock('https', () => ({
  default: { request: mockHttpsRequest },
  request: mockHttpsRequest
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn().mockReturnValue('/mock/userData') },
  safeStorage: {
    isEncryptionAvailable: vi.fn().mockReturnValue(false),
    encryptString: vi.fn((val: string) => Buffer.from(val)),
    decryptString: vi.fn((buf: Buffer) => buf.toString())
  },
  shell: { openExternal: vi.fn() }
}))

vi.mock('electron-store', () => {
  function MockStore(this: any) {
    this.path = '/mock/store.json'
    this.store = {}
    this.get = mockStore.get
    this.set = mockStore.set
    this.delete = mockStore.delete
    this.has = mockStore.has
    this.clear = mockStore.clear
  }
  return { default: MockStore }
})

vi.mock('../../services', () => ({
  getServices: () => ({
    log: vi.fn(),
    logInfo: vi.fn(),
    logError: vi.fn(),
    createSafeStore: () => mockStore
  })
}))

import { BitbucketPipelinesProvider } from '../bitbucket-pipelines-provider'

// Helper: mock git remote to return a Bitbucket URL
function mockBitbucketRemote(owner = 'myteam', repo = 'myrepo'): void {
  mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
    cb(null, `https://bitbucket.org/${owner}/${repo}.git\n`, '')
    return {} as any
  })
}

function mockNoRemote(): void {
  mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
    cb(new Error('fatal: No such remote'), '', '')
    return {} as any
  })
}

// Helper: set up mock credentials in the store
function setMockCredentials(username = 'testuser', token = 'test-token'): void {
  mockStoreData['bb.username'] = username
  mockStoreData['bb.token'] = token
}

function clearMockCredentials(): void {
  delete mockStoreData['bb.username']
  delete mockStoreData['bb.token']
}

// Helper: simulate a successful HTTPS API response
function mockApiResponse(body: string, statusCode = 200): void {
  mockHttpsRequest.mockImplementation((_opts: unknown, callback: Function) => {
    const res = {
      statusCode,
      on: vi.fn((event: string, handler: Function) => {
        if (event === 'data') handler(body)
        if (event === 'end') handler()
      })
    }
    callback(res)
    return {
      on: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(),
      write: vi.fn()
    }
  })
}

function mockApiError(statusCode: number, body = 'error'): void {
  mockHttpsRequest.mockImplementation((_opts: unknown, callback: Function) => {
    const res = {
      statusCode,
      on: vi.fn((event: string, handler: Function) => {
        if (event === 'data') handler(body)
        if (event === 'end') handler()
      })
    }
    callback(res)
    return {
      on: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(),
      write: vi.fn()
    }
  })
}

describe('BitbucketPipelinesProvider', () => {
  let provider: BitbucketPipelinesProvider

  beforeEach(() => {
    vi.clearAllMocks()
    clearMockCredentials()
    provider = new BitbucketPipelinesProvider()
  })

  describe('identity', () => {
    it('has correct name', () => {
      expect(provider.name).toBe('Bitbucket Pipelines')
    })

    it('has correct providerKey', () => {
      expect(provider.providerKey).toBe('bitbucket')
    })
  })

  describe('getWorkflows', () => {
    it('returns a single synthetic "All Pipelines" workflow', async () => {
      const workflows = await provider.getWorkflows('/fake/project')
      expect(workflows).toHaveLength(1)
      expect(workflows[0]).toEqual({
        id: 0,
        name: 'All Pipelines',
        path: '',
        state: 'active'
      })
    })
  })

  describe('getRunUrl', () => {
    it('builds correct Bitbucket pipeline URL', async () => {
      mockBitbucketRemote('myteam', 'myrepo')
      const url = await provider.getRunUrl('/fake/project', 42)
      expect(url).toBe('https://bitbucket.org/myteam/myrepo/pipelines/results/42')
    })

    it('returns empty string when no remote', async () => {
      mockNoRemote()
      const url = await provider.getRunUrl('/fake/project', 42)
      expect(url).toBe('')
    })
  })

  describe('parseLogSections', () => {
    it('returns a single section for plain text', () => {
      const log = 'line 1\nline 2\nline 3'
      const sections = provider.parseLogSections(log)
      expect(sections).toHaveLength(1)
      expect(sections[0].name).toBe('')
      expect(sections[0].collapsed).toBe(false)
      expect(sections[0].lines).toEqual(['line 1', 'line 2', 'line 3'])
    })

    it('handles empty log', () => {
      const sections = provider.parseLogSections('')
      expect(sections).toHaveLength(1)
      expect(sections[0].lines).toEqual([''])
    })

    it('preserves all lines in the output', () => {
      const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`)
      const sections = provider.parseLogSections(lines.join('\n'))
      expect(sections[0].lines).toHaveLength(50)
    })
  })

  describe('isAvailable', () => {
    it('returns false when no remote', async () => {
      mockNoRemote()
      const result = await provider.isAvailable('/fake/project')
      expect(result).toBe(false)
    })

    it('returns false when no credentials', async () => {
      mockBitbucketRemote()
      clearMockCredentials()
      const result = await provider.isAvailable('/fake/project')
      expect(result).toBe(false)
    })

    it('returns true when remote, credentials, and API succeeds', async () => {
      mockBitbucketRemote()
      setMockCredentials()
      mockApiResponse(JSON.stringify({ values: [] }))

      const result = await provider.isAvailable('/fake/project')
      expect(result).toBe(true)
    })

    it('returns false when API returns error', async () => {
      mockBitbucketRemote()
      setMockCredentials()
      mockApiError(401)

      const result = await provider.isAvailable('/fake/project')
      expect(result).toBe(false)
    })
  })

  describe('getWorkflowRuns', () => {
    it('returns empty array when no remote', async () => {
      mockNoRemote()
      const runs = await provider.getWorkflowRuns('/fake/project', 0, 1, 10)
      expect(runs).toEqual([])
    })

    it('returns empty array when no credentials', async () => {
      mockBitbucketRemote()
      clearMockCredentials()
      const runs = await provider.getWorkflowRuns('/fake/project', 0, 1, 10)
      expect(runs).toEqual([])
    })

    it('maps Bitbucket pipeline data to CiWorkflowRun', async () => {
      mockBitbucketRemote('myteam', 'myrepo')
      setMockCredentials()

      const apiResponse = {
        values: [{
          build_number: 42,
          uuid: '{uuid-1}',
          state: { name: 'COMPLETED', result: { name: 'SUCCESSFUL' } },
          target: {
            ref_name: 'main',
            ref_type: 'branch',
            commit: { hash: 'abc123' }
          },
          created_on: '2026-03-12T10:00:00Z',
          completed_on: '2026-03-12T10:05:00Z',
          creator: { display_name: 'John Doe', username: 'johndoe' }
        }]
      }
      mockApiResponse(JSON.stringify(apiResponse))

      const runs = await provider.getWorkflowRuns('/fake/project', 0, 1, 10)
      expect(runs).toHaveLength(1)

      const run = runs[0]
      expect(run.id).toBe(42)
      expect(run.name).toBe('Pipeline #42')
      expect(run.workflowId).toBe(0)
      expect(run.headBranch).toBe('main')
      expect(run.headSha).toBe('abc123')
      expect(run.status).toBe('completed')
      expect(run.conclusion).toBe('success')
      expect(run.createdAt).toBe('2026-03-12T10:00:00Z')
      expect(run.url).toBe('https://bitbucket.org/myteam/myrepo/pipelines/results/42')
      expect(run.event).toBe('branch')
      expect(run.runNumber).toBe(42)
      expect(run.runAttempt).toBe(1)
      expect(run.actor).toBe('John Doe')
    })

    it('maps IN_PROGRESS status correctly', async () => {
      mockBitbucketRemote()
      setMockCredentials()
      mockApiResponse(JSON.stringify({
        values: [{
          build_number: 1,
          uuid: '{uuid}',
          state: { name: 'IN_PROGRESS' },
          target: { ref_name: 'feat', commit: { hash: 'def' } },
          created_on: '2026-01-01T00:00:00Z',
          creator: {}
        }]
      }))

      const runs = await provider.getWorkflowRuns('/fake/project', 0, 1, 10)
      expect(runs[0].status).toBe('in_progress')
      expect(runs[0].conclusion).toBeNull()
    })

    it('maps PENDING status to queued', async () => {
      mockBitbucketRemote()
      setMockCredentials()
      mockApiResponse(JSON.stringify({
        values: [{
          build_number: 1,
          uuid: '{uuid}',
          state: { name: 'PENDING' },
          target: { ref_name: 'feat', commit: { hash: 'def' } },
          created_on: '2026-01-01T00:00:00Z',
          creator: {}
        }]
      }))

      const runs = await provider.getWorkflowRuns('/fake/project', 0, 1, 10)
      expect(runs[0].status).toBe('queued')
    })

    it('maps FAILED result to failure conclusion', async () => {
      mockBitbucketRemote()
      setMockCredentials()
      mockApiResponse(JSON.stringify({
        values: [{
          build_number: 1,
          uuid: '{uuid}',
          state: { name: 'COMPLETED', result: { name: 'FAILED' } },
          target: { ref_name: 'main', commit: { hash: 'abc' } },
          created_on: '2026-01-01T00:00:00Z',
          creator: {}
        }]
      }))

      const runs = await provider.getWorkflowRuns('/fake/project', 0, 1, 10)
      expect(runs[0].status).toBe('completed')
      expect(runs[0].conclusion).toBe('failure')
    })

    it('maps STOPPED result to cancelled conclusion', async () => {
      mockBitbucketRemote()
      setMockCredentials()
      mockApiResponse(JSON.stringify({
        values: [{
          build_number: 1,
          uuid: '{uuid}',
          state: { name: 'STOPPED' },
          target: { ref_name: 'main', commit: { hash: 'abc' } },
          created_on: '2026-01-01T00:00:00Z',
          creator: {}
        }]
      }))

      const runs = await provider.getWorkflowRuns('/fake/project', 0, 1, 10)
      expect(runs[0].status).toBe('completed')
      expect(runs[0].conclusion).toBe('cancelled')
    })

    it('maps ERROR result to failure conclusion', async () => {
      mockBitbucketRemote()
      setMockCredentials()
      mockApiResponse(JSON.stringify({
        values: [{
          build_number: 1,
          uuid: '{uuid}',
          state: { name: 'ERROR' },
          target: { ref_name: 'main', commit: { hash: 'abc' } },
          created_on: '2026-01-01T00:00:00Z',
          creator: {}
        }]
      }))

      const runs = await provider.getWorkflowRuns('/fake/project', 0, 1, 10)
      expect(runs[0].conclusion).toBe('failure')
    })

    it('falls back to username when display_name is missing', async () => {
      mockBitbucketRemote()
      setMockCredentials()
      mockApiResponse(JSON.stringify({
        values: [{
          build_number: 1,
          uuid: '{uuid}',
          state: { name: 'COMPLETED', result: { name: 'SUCCESSFUL' } },
          target: { ref_name: 'main', commit: { hash: 'abc' } },
          created_on: '2026-01-01T00:00:00Z',
          creator: { username: 'jdoe' }
        }]
      }))

      const runs = await provider.getWorkflowRuns('/fake/project', 0, 1, 10)
      expect(runs[0].actor).toBe('jdoe')
    })

    it('uses "Pipeline" as name when branch is empty', async () => {
      mockBitbucketRemote()
      setMockCredentials()
      mockApiResponse(JSON.stringify({
        values: [{
          build_number: 1,
          uuid: '{uuid}',
          state: { name: 'PENDING' },
          target: {},
          created_on: '2026-01-01T00:00:00Z',
          creator: {}
        }]
      }))

      const runs = await provider.getWorkflowRuns('/fake/project', 0, 1, 10)
      expect(runs[0].name).toBe('Pipeline')
    })

    it('returns empty array when API fails', async () => {
      mockBitbucketRemote()
      setMockCredentials()
      mockApiError(500)

      const runs = await provider.getWorkflowRuns('/fake/project', 0, 1, 10)
      expect(runs).toEqual([])
    })
  })

  describe('getRunJobs', () => {
    it('returns empty array when no remote', async () => {
      mockNoRemote()
      const jobs = await provider.getRunJobs('/fake/project', 1)
      expect(jobs).toEqual([])
    })

    it('maps Bitbucket step data to CiJob', async () => {
      mockBitbucketRemote()
      setMockCredentials()
      mockApiResponse(JSON.stringify({
        values: [{
          uuid: '{step-uuid-1}',
          name: 'Build and Test',
          state: { name: 'COMPLETED', result: { name: 'SUCCESSFUL' } },
          started_on: '2026-03-12T10:00:00Z',
          completed_on: '2026-03-12T10:02:00Z'
        }]
      }))

      const jobs = await provider.getRunJobs('/fake/project', 42)
      expect(jobs).toHaveLength(1)

      const job = jobs[0]
      expect(job.name).toBe('Build and Test')
      expect(job.status).toBe('completed')
      expect(job.conclusion).toBe('success')
      expect(job.startedAt).toBe('2026-03-12T10:00:00Z')
      expect(job.completedAt).toBe('2026-03-12T10:02:00Z')
      expect(job.steps).toEqual([])
      expect(job.matrixKey).toBeNull()
      expect(job.matrixValues).toBeNull()
    })

    it('parses matrix job names', async () => {
      mockBitbucketRemote()
      setMockCredentials()
      mockApiResponse(JSON.stringify({
        values: [{
          uuid: '{step-uuid-2}',
          name: 'Test (node-18, ubuntu)',
          state: { name: 'COMPLETED', result: { name: 'SUCCESSFUL' } },
          started_on: null,
          completed_on: null
        }]
      }))

      const jobs = await provider.getRunJobs('/fake/project', 42)
      expect(jobs[0].matrixKey).toBe('Test')
      expect(jobs[0].matrixValues).toEqual({ '0': 'node-18', '1': 'ubuntu' })
    })

    it('generates stable numeric IDs from step UUIDs', async () => {
      mockBitbucketRemote()
      setMockCredentials()
      mockApiResponse(JSON.stringify({
        values: [
          { uuid: '{abc-123}', name: 'Step 1', state: { name: 'PENDING' } },
          { uuid: '{def-456}', name: 'Step 2', state: { name: 'PENDING' } }
        ]
      }))

      const jobs = await provider.getRunJobs('/fake/project', 1)
      expect(jobs).toHaveLength(2)
      // IDs should be positive numbers
      expect(jobs[0].id).toBeGreaterThan(0)
      expect(jobs[1].id).toBeGreaterThan(0)
      // IDs should be different for different UUIDs
      expect(jobs[0].id).not.toBe(jobs[1].id)
    })

    it('generates consistent ID for same UUID', async () => {
      mockBitbucketRemote()
      setMockCredentials()

      // First call
      mockApiResponse(JSON.stringify({
        values: [{ uuid: '{same-uuid}', name: 'Step', state: { name: 'PENDING' } }]
      }))
      const jobs1 = await provider.getRunJobs('/fake/project', 1)

      // Second call with same UUID
      mockApiResponse(JSON.stringify({
        values: [{ uuid: '{same-uuid}', name: 'Step', state: { name: 'COMPLETED', result: { name: 'SUCCESSFUL' } } }]
      }))
      const jobs2 = await provider.getRunJobs('/fake/project', 1)

      expect(jobs1[0].id).toBe(jobs2[0].id)
    })
  })

  describe('getRun', () => {
    it('returns null when no remote', async () => {
      mockNoRemote()
      const run = await provider.getRun('/fake/project', 1)
      expect(run).toBeNull()
    })

    it('returns null when no credentials', async () => {
      mockBitbucketRemote()
      clearMockCredentials()
      const run = await provider.getRun('/fake/project', 1)
      expect(run).toBeNull()
    })

    it('returns mapped run on success', async () => {
      mockBitbucketRemote('owner', 'repo')
      setMockCredentials()
      mockApiResponse(JSON.stringify({
        build_number: 5,
        uuid: '{uuid-5}',
        state: { name: 'COMPLETED', result: { name: 'SUCCESSFUL' } },
        target: { ref_name: 'main', ref_type: 'branch', commit: { hash: 'abc' } },
        created_on: '2026-01-01T00:00:00Z',
        completed_on: '2026-01-01T00:01:00Z',
        creator: { display_name: 'Bot' }
      }))

      const run = await provider.getRun('/fake/project', 5)
      expect(run).not.toBeNull()
      expect(run!.id).toBe(5)
      expect(run!.conclusion).toBe('success')
    })
  })

  describe('getActiveRuns', () => {
    it('returns empty array when no remote', async () => {
      mockNoRemote()
      const runs = await provider.getActiveRuns('/fake/project')
      expect(runs).toEqual([])
    })
  })

  describe('cancelRun', () => {
    it('throws when no remote', async () => {
      mockNoRemote()
      await expect(provider.cancelRun('/fake/project', 1)).rejects.toThrow('No Bitbucket remote')
    })

    it('throws when no credentials', async () => {
      mockBitbucketRemote()
      clearMockCredentials()
      await expect(provider.cancelRun('/fake/project', 1)).rejects.toThrow('No Bitbucket credentials')
    })

    it('calls stopPipeline API endpoint', async () => {
      mockBitbucketRemote('owner', 'repo')
      setMockCredentials()
      mockApiResponse('{}')

      await provider.cancelRun('/fake/project', 42)

      // Verify https.request was called with POST to stopPipeline
      expect(mockHttpsRequest).toHaveBeenCalled()
      const callOpts = mockHttpsRequest.mock.calls[0][0]
      expect(callOpts.method).toBe('POST')
      expect(callOpts.path).toContain('pipelines/42/stopPipeline')
    })
  })

  describe('rerunFailedJobs', () => {
    it('throws when no remote', async () => {
      mockNoRemote()
      await expect(provider.rerunFailedJobs('/fake/project', 1)).rejects.toThrow('No Bitbucket remote')
    })

    it('throws when no credentials', async () => {
      mockBitbucketRemote()
      clearMockCredentials()
      await expect(provider.rerunFailedJobs('/fake/project', 1)).rejects.toThrow('No Bitbucket credentials')
    })
  })

  describe('getSetupStatus', () => {
    it('returns steps with expected IDs', async () => {
      mockNoRemote()
      const status = await provider.getSetupStatus('/fake/project')
      expect(status.providerName).toBe('Bitbucket Pipelines')
      expect(status.steps.length).toBe(3)
      expect(status.steps.map((s) => s.id)).toEqual([
        'remote-configured',
        'api-authenticated',
        'pipelines-enabled'
      ])
    })

    it('marks remote as missing when no origin', async () => {
      mockNoRemote()
      const status = await provider.getSetupStatus('/fake/project')
      expect(status.steps[0].status).toBe('missing')
      expect(status.ready).toBe(false)
    })

    it('marks remote as ok when origin exists', async () => {
      mockBitbucketRemote()
      const status = await provider.getSetupStatus('/fake/project')
      expect(status.steps[0].status).toBe('ok')
    })

    it('includes credential fields for API authentication step', async () => {
      mockNoRemote()
      const status = await provider.getSetupStatus('/fake/project')
      const authStep = status.steps.find((s) => s.id === 'api-authenticated')
      expect(authStep).toBeDefined()
      expect(authStep!.credentialFields).toHaveLength(2)
      expect(authStep!.credentialFields![0].id).toBe('username')
      expect(authStep!.credentialFields![1].id).toBe('token')
      expect(authStep!.credentialFields![1].type).toBe('password')
    })
  })

  describe('runSetupAction', () => {
    it('returns error for unknown action', async () => {
      const result = await provider.runSetupAction('/fake', 'unknown-action')
      expect(result.success).toBe(false)
      expect(result.error).toBe('Unknown action')
    })

    it('returns error when storing credentials without remote', async () => {
      mockNoRemote()
      const result = await provider.runSetupAction('/fake', 'store-credentials', {
        username: 'user',
        token: 'tok'
      })
      expect(result.success).toBe(false)
      expect(result.error).toContain('No Bitbucket remote')
    })

    it('stores credentials when API auth succeeds', async () => {
      mockBitbucketRemote('owner', 'repo')
      mockApiResponse(JSON.stringify({ full_name: 'owner/repo' }))

      const result = await provider.runSetupAction('/fake', 'store-credentials', {
        username: 'myuser',
        token: 'mytoken'
      })
      expect(result.success).toBe(true)
      expect(mockStore.set).toHaveBeenCalled()
    })

    it('returns missing scopes error on 403', async () => {
      mockBitbucketRemote('owner', 'repo')
      const errorBody = JSON.stringify({
        error: { detail: { required: ['repository', 'pipeline'] } }
      })
      mockApiError(403, `Bitbucket API 403: ${errorBody}`)

      const result = await provider.runSetupAction('/fake', 'store-credentials', {
        username: 'myuser',
        token: 'badtoken'
      })
      expect(result.success).toBe(false)
      expect(result.error).toContain('missing required scopes')
    })

    it('returns auth failed when all methods fail with 401', async () => {
      mockBitbucketRemote('owner', 'repo')
      mockApiError(401)

      const result = await provider.runSetupAction('/fake', 'store-credentials', {
        username: 'myuser',
        token: 'badtoken'
      })
      expect(result.success).toBe(false)
      expect(result.error).toContain('Authentication failed')
    })
  })
})
