import { describe, it, expect, vi, beforeEach } from 'vitest'

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

const { mockHttpsGet, mockHttpsRequest } = vi.hoisted(() => {
  return { mockHttpsGet: vi.fn(), mockHttpsRequest: vi.fn() }
})

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

vi.mock('https', () => ({
  default: { get: mockHttpsGet, request: mockHttpsRequest },
  get: mockHttpsGet,
  request: mockHttpsRequest
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn().mockReturnValue('/mock/userData') },
  safeStorage: {
    isEncryptionAvailable: vi.fn().mockReturnValue(false),
    encryptString: vi.fn((val: string) => Buffer.from(val)),
    decryptString: vi.fn((buf: Buffer) => buf.toString())
  }
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

vi.mock('../../../safe-store', () => ({
  createSafeStore: () => mockStore,
  safeRead: (fn: () => any) => { try { return fn() } catch { return undefined } }
}))

import { BitbucketPrProvider } from '../bitbucket-pr-provider'

function mockBitbucketRemote(owner = 'myteam', repo = 'myrepo'): void {
  mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
    cb(null, `https://bitbucket.org/${owner}/${repo}.git\n`, '')
    return {} as any
  })
}

function setCredentials(username = 'testuser', token = 'testtoken'): void {
  mockStoreData['bb.username'] = username
  mockStoreData['bb.token'] = token
}

function clearCredentials(): void {
  delete mockStoreData['bb.username']
  delete mockStoreData['bb.token']
}

// Helper to mock HTTPS responses
function mockHttpsResponse(statusCode: number, body: unknown): void {
  const mockRes = {
    statusCode,
    on: vi.fn((event: string, handler: Function) => {
      if (event === 'data') handler(JSON.stringify(body))
      if (event === 'end') handler()
      return mockRes
    })
  }

  mockHttpsGet.mockImplementation((_opts: unknown, cb: Function) => {
    cb(mockRes)
    return { on: vi.fn(), setTimeout: vi.fn() }
  })

  mockHttpsRequest.mockImplementation((_opts: unknown, cb: Function) => {
    cb(mockRes)
    return { on: vi.fn(), setTimeout: vi.fn(), write: vi.fn(), end: vi.fn() }
  })
}

const SAMPLE_BB_PR = {
  id: 5,
  title: 'feat: add API endpoint',
  state: 'OPEN',
  source: { branch: { name: 'feature/api' } },
  destination: { branch: { name: 'main' } },
  author: { display_name: 'Alice' },
  links: { html: { href: 'https://bitbucket.org/myteam/myrepo/pull-requests/5' } },
  created_on: '2026-03-01T10:00:00Z',
  updated_on: '2026-03-02T15:00:00Z',
  description: 'Adds REST API'
}

describe('BitbucketPrProvider', () => {
  let provider: BitbucketPrProvider

  beforeEach(() => {
    vi.clearAllMocks()
    Object.keys(mockStoreData).forEach((k) => delete mockStoreData[k])
    provider = new BitbucketPrProvider()
  })

  describe('isAvailable', () => {
    it('returns true when credentials exist and repo is accessible', async () => {
      setCredentials()
      mockBitbucketRemote()
      mockHttpsResponse(200, { slug: 'myrepo' })

      expect(await provider.isAvailable('/project')).toBe(true)
    })

    it('returns false when no credentials', async () => {
      clearCredentials()
      mockBitbucketRemote()

      expect(await provider.isAvailable('/project')).toBe(false)
    })

    it('returns false when no Bitbucket remote', async () => {
      setCredentials()
      mockExecFile.mockImplementation((_c: string, _a: string[], _o: unknown, cb: Function) => {
        cb(null, 'https://github.com/user/repo.git\n', '')
        return {} as any
      })

      expect(await provider.isAvailable('/project')).toBe(false)
    })
  })

  describe('listPrs', () => {
    it('returns parsed PRs from Bitbucket API', async () => {
      setCredentials()
      mockBitbucketRemote()
      mockHttpsResponse(200, { values: [SAMPLE_BB_PR] })

      const prs = await provider.listPrs('/project')
      expect(prs).toHaveLength(1)

      expect(prs[0].id).toBe(5)
      expect(prs[0].title).toBe('feat: add API endpoint')
      expect(prs[0].state).toBe('open')
      expect(prs[0].sourceBranch).toBe('feature/api')
      expect(prs[0].targetBranch).toBe('main')
      expect(prs[0].author).toBe('Alice')
      expect(prs[0].url).toBe('https://bitbucket.org/myteam/myrepo/pull-requests/5')
    })

    it('returns empty array without credentials', async () => {
      clearCredentials()
      mockBitbucketRemote()

      expect(await provider.listPrs('/project')).toEqual([])
    })

    it('returns empty array on API error', async () => {
      setCredentials()
      mockBitbucketRemote()
      mockHttpsResponse(403, { error: 'forbidden' })

      expect(await provider.listPrs('/project')).toEqual([])
    })
  })

  describe('createPr', () => {
    it('creates PR via POST and returns result', async () => {
      setCredentials()
      mockBitbucketRemote()
      mockHttpsResponse(201, SAMPLE_BB_PR)

      const result = await provider.createPr('/project', {
        title: 'New PR',
        body: 'Description',
        sourceBranch: 'feature/api',
        targetBranch: 'main'
      })

      expect(result.success).toBe(true)
      expect(result.pr).toBeDefined()
      expect(result.pr!.id).toBe(5)
    })

    it('returns failure without credentials', async () => {
      clearCredentials()
      mockBitbucketRemote()

      const result = await provider.createPr('/project', {
        title: 'Test',
        body: '',
        sourceBranch: 'x',
        targetBranch: 'main'
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('credentials')
    })
  })

  describe('getDefaultBranch', () => {
    it('returns mainbranch name from API', async () => {
      setCredentials()
      mockBitbucketRemote()
      mockHttpsResponse(200, { mainbranch: { name: 'develop' } })

      expect(await provider.getDefaultBranch('/project')).toBe('develop')
    })

    it('returns "main" as fallback', async () => {
      clearCredentials()
      mockBitbucketRemote()

      expect(await provider.getDefaultBranch('/project')).toBe('main')
    })
  })

  describe('getNewPrUrl', () => {
    it('constructs Bitbucket new PR URL', async () => {
      mockBitbucketRemote('myteam', 'myrepo')

      const url = await provider.getNewPrUrl('/project', 'feature/x', 'main')
      expect(url).toBe('https://bitbucket.org/myteam/myrepo/pull-requests/new?source=feature%2Fx&dest=main')
    })

    it('returns null when no Bitbucket remote', async () => {
      mockExecFile.mockImplementation((_c: string, _a: string[], _o: unknown, cb: Function) => {
        cb(new Error('no remote'), '', '')
        return {} as any
      })

      expect(await provider.getNewPrUrl('/project', 'x', 'main')).toBeNull()
    })
  })

  describe('state mapping', () => {
    it('maps OPEN to open', async () => {
      setCredentials()
      mockBitbucketRemote()
      mockHttpsResponse(200, { values: [{ ...SAMPLE_BB_PR, state: 'OPEN' }] })
      const prs = await provider.listPrs('/project')
      expect(prs[0].state).toBe('open')
    })

    it('maps MERGED to merged', async () => {
      setCredentials()
      mockBitbucketRemote()
      mockHttpsResponse(200, { values: [{ ...SAMPLE_BB_PR, state: 'MERGED' }] })
      const prs = await provider.listPrs('/project')
      expect(prs[0].state).toBe('merged')
    })

    it('maps DECLINED to closed', async () => {
      setCredentials()
      mockBitbucketRemote()
      mockHttpsResponse(200, { values: [{ ...SAMPLE_BB_PR, state: 'DECLINED' }] })
      const prs = await provider.listPrs('/project')
      expect(prs[0].state).toBe('closed')
    })
  })

  describe('getSetupStatus', () => {
    it('reports ready when remote and credentials exist', async () => {
      setCredentials()
      mockBitbucketRemote()

      const status = await provider.getSetupStatus('/project')
      expect(status.ready).toBe(true)
      expect(status.steps.every((s) => s.status === 'ok')).toBe(true)
    })

    it('reports missing credentials', async () => {
      clearCredentials()
      mockBitbucketRemote()

      const status = await provider.getSetupStatus('/project')
      expect(status.ready).toBe(false)
      expect(status.steps.find((s) => s.id === 'credentials')?.status).toBe('missing')
    })
  })
})
