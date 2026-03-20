import { describe, it, expect, vi, beforeEach } from 'vitest'

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
  execFile: mockExecFile,
  execFileSync: vi.fn().mockReturnValue('gh\n'),
  spawn: vi.fn().mockReturnValue({ unref: vi.fn() })
}))

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(false)
}))

vi.mock('https', () => ({
  default: { get: vi.fn(), request: vi.fn() },
  get: vi.fn(),
  request: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn().mockReturnValue('/mock') },
  safeStorage: {
    isEncryptionAvailable: vi.fn().mockReturnValue(false),
    encryptString: vi.fn((v: string) => Buffer.from(v)),
    decryptString: vi.fn((b: Buffer) => b.toString())
  }
}))

vi.mock('electron-store', () => {
  function MockStore(this: any) {
    this.get = vi.fn()
    this.set = vi.fn()
    this.delete = vi.fn()
    this.has = vi.fn()
    this.path = '/mock/store.json'
    this.store = {}
  }
  return { default: MockStore }
})

vi.mock('../../services', () => ({
  getServices: () => ({
    log: vi.fn(),
    logInfo: vi.fn(),
    logError: vi.fn(),
    createSafeStore: () => ({
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
      has: vi.fn()
    })
  })
}))

vi.mock('../../../safe-store', () => ({
  createSafeStore: () => ({
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    has: vi.fn()
  }),
  safeRead: (fn: () => any) => { try { return fn() } catch { return undefined } }
}))

import { PrProviderRegistry } from '../pr-provider-registry'

function mockRemoteUrl(url: string): void {
  mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
    if (args.includes('get-url')) {
      cb(null, url + '\n', '')
    } else {
      cb(null, '', '')
    }
    return {} as any
  })
}

describe('PrProviderRegistry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset singleton
    ;(PrProviderRegistry as any).instance = null
  })

  it('returns singleton instance', () => {
    const a = PrProviderRegistry.getInstance()
    const b = PrProviderRegistry.getInstance()
    expect(a).toBe(b)
  })

  it('resolves GitHub provider for github.com remote', async () => {
    mockRemoteUrl('https://github.com/user/repo.git')
    const registry = PrProviderRegistry.getInstance()
    const provider = await registry.resolve('/project')
    expect(provider).not.toBeNull()
    expect(provider!.providerKey).toBe('github')
    expect(provider!.name).toContain('GitHub')
  })

  it('resolves GitLab provider for gitlab.com remote', async () => {
    mockRemoteUrl('https://gitlab.com/team/project.git')
    const registry = PrProviderRegistry.getInstance()
    const provider = await registry.resolve('/project')
    expect(provider).not.toBeNull()
    expect(provider!.providerKey).toBe('gitlab')
    expect(provider!.name).toContain('GitLab')
  })

  it('resolves Bitbucket provider for bitbucket.org remote', async () => {
    mockRemoteUrl('https://bitbucket.org/team/repo.git')
    const registry = PrProviderRegistry.getInstance()
    const provider = await registry.resolve('/project')
    expect(provider).not.toBeNull()
    expect(provider!.providerKey).toBe('bitbucket')
    expect(provider!.name).toContain('Bitbucket')
  })

  it('returns null for unknown provider', async () => {
    mockRemoteUrl('https://sourcehut.org/user/repo')
    const registry = PrProviderRegistry.getInstance()
    const provider = await registry.resolve('/project')
    expect(provider).toBeNull()
  })

  it('returns null when no origin remote', async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(new Error('fatal: No such remote'), '', '')
      return {} as any
    })
    const registry = PrProviderRegistry.getInstance()
    const provider = await registry.resolve('/project')
    expect(provider).toBeNull()
  })

  it('caches resolved provider per project directory', async () => {
    mockRemoteUrl('https://github.com/user/repo.git')
    const registry = PrProviderRegistry.getInstance()

    const p1 = await registry.resolve('/project')
    const p2 = await registry.resolve('/project')
    expect(p1).toBe(p2)

    // git remote should only be called once
    const gitCalls = mockExecFile.mock.calls.filter(
      (c: any[]) => c[1]?.includes('get-url')
    )
    expect(gitCalls).toHaveLength(1)
  })

  it('invalidate clears cache for project', async () => {
    mockRemoteUrl('https://github.com/user/repo.git')
    const registry = PrProviderRegistry.getInstance()

    await registry.resolve('/project')
    registry.invalidate('/project')

    await registry.resolve('/project')

    const gitCalls = mockExecFile.mock.calls.filter(
      (c: any[]) => c[1]?.includes('get-url')
    )
    expect(gitCalls).toHaveLength(2)
  })

  it('resolves different providers for different projects', async () => {
    const registry = PrProviderRegistry.getInstance()

    mockRemoteUrl('https://github.com/user/repo.git')
    const gh = await registry.resolve('/project-a')

    mockRemoteUrl('https://gitlab.com/team/project.git')
    const gl = await registry.resolve('/project-b')

    expect(gh!.providerKey).toBe('github')
    expect(gl!.providerKey).toBe('gitlab')
  })
})
