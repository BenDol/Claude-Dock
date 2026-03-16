import { describe, it, expect, vi, beforeEach } from 'vitest'
import { promisify } from 'util'

// Create a mock execFile that works with promisify
const { mockExecFile } = vi.hoisted(() => {
  const fn: any = vi.fn()
  // Add custom promisify so `promisify(execFile)` returns a function that resolves with { stdout, stderr }
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
  execFileSync: vi.fn().mockImplementation(() => { throw new Error('not found') }),
  spawn: vi.fn().mockReturnValue({ unref: vi.fn() })
}))

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
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
    this.get = vi.fn()
    this.set = vi.fn()
    this.delete = vi.fn()
    this.has = vi.fn()
    this.clear = vi.fn()
  }
  return { default: MockStore }
})

vi.mock('../../services', () => ({
  getServices: () => ({
    log: vi.fn(),
    logInfo: vi.fn(),
    logError: vi.fn()
  })
}))

import { CiProviderRegistry } from '../ci-provider-registry'

function mockRemoteUrl(url: string): void {
  mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
    cb(null, url + '\n', '')
    return {} as any
  })
}

function mockNoRemote(): void {
  mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
    cb(new Error("fatal: No such remote 'origin'"), '', '')
    return {} as any
  })
}

describe('CiProviderRegistry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(CiProviderRegistry as any).instance = null
  })

  describe('singleton', () => {
    it('returns the same instance', () => {
      const a = CiProviderRegistry.getInstance()
      const b = CiProviderRegistry.getInstance()
      expect(a).toBe(b)
    })
  })

  describe('createProvider (via resolve)', () => {
    it('resolves GitHub provider for github.com HTTPS remote', async () => {
      const registry = new (CiProviderRegistry as any)() as CiProviderRegistry
      mockRemoteUrl('https://github.com/user/repo.git')

      const provider = await registry.resolve('/fake/project')
      expect(provider).not.toBeNull()
      expect(provider!.name).toBe('GitHub Actions')
      expect(provider!.providerKey).toBe('github')
    })

    it('resolves GitHub provider for SSH remote', async () => {
      const registry = new (CiProviderRegistry as any)() as CiProviderRegistry
      mockRemoteUrl('git@github.com:user/repo.git')

      const provider = await registry.resolve('/fake/project')
      expect(provider).not.toBeNull()
      expect(provider!.providerKey).toBe('github')
    })

    it('resolves GitLab provider for gitlab.com remote', async () => {
      const registry = new (CiProviderRegistry as any)() as CiProviderRegistry
      mockRemoteUrl('https://gitlab.com/user/repo.git')

      const provider = await registry.resolve('/fake/project')
      expect(provider).not.toBeNull()
      expect(provider!.name).toBe('GitLab CI')
      expect(provider!.providerKey).toBe('gitlab')
    })

    it('resolves GitLab provider for self-hosted GitLab', async () => {
      const registry = new (CiProviderRegistry as any)() as CiProviderRegistry
      mockRemoteUrl('https://gitlab.mycompany.com/team/repo.git')

      const provider = await registry.resolve('/fake/project')
      expect(provider).not.toBeNull()
      expect(provider!.providerKey).toBe('gitlab')
    })

    it('resolves Bitbucket provider for bitbucket.org remote', async () => {
      const registry = new (CiProviderRegistry as any)() as CiProviderRegistry
      mockRemoteUrl('https://bitbucket.org/user/repo.git')

      const provider = await registry.resolve('/fake/project')
      expect(provider).not.toBeNull()
      expect(provider!.name).toBe('Bitbucket Pipelines')
      expect(provider!.providerKey).toBe('bitbucket')
    })

    it('resolves Bitbucket provider for SSH remote', async () => {
      const registry = new (CiProviderRegistry as any)() as CiProviderRegistry
      mockRemoteUrl('git@bitbucket.org:user/repo.git')

      const provider = await registry.resolve('/fake/project')
      expect(provider).not.toBeNull()
      expect(provider!.providerKey).toBe('bitbucket')
    })

    it('returns null for unknown provider (generic host)', async () => {
      const registry = new (CiProviderRegistry as any)() as CiProviderRegistry
      mockRemoteUrl('https://myserver.com/user/repo.git')

      const provider = await registry.resolve('/fake/project')
      expect(provider).toBeNull()
    })

    it('returns null for Azure DevOps (unsupported CI)', async () => {
      const registry = new (CiProviderRegistry as any)() as CiProviderRegistry
      mockRemoteUrl('https://dev.azure.com/org/project/_git/repo')

      const provider = await registry.resolve('/fake/project')
      expect(provider).toBeNull()
    })

    it('returns null when no origin remote exists', async () => {
      const registry = new (CiProviderRegistry as any)() as CiProviderRegistry
      mockNoRemote()

      const provider = await registry.resolve('/fake/project')
      expect(provider).toBeNull()
    })
  })

  describe('caching', () => {
    it('caches resolved providers by project dir', async () => {
      const registry = new (CiProviderRegistry as any)() as CiProviderRegistry
      mockRemoteUrl('https://github.com/user/repo.git')

      const first = await registry.resolve('/fake/project')
      const second = await registry.resolve('/fake/project')
      expect(first).toBe(second)
      expect(mockExecFile).toHaveBeenCalledTimes(1)
    })

    it('caches null results (no remote)', async () => {
      const registry = new (CiProviderRegistry as any)() as CiProviderRegistry
      mockNoRemote()

      const first = await registry.resolve('/fake/project')
      const second = await registry.resolve('/fake/project')
      expect(first).toBeNull()
      expect(second).toBeNull()
      expect(mockExecFile).toHaveBeenCalledTimes(1)
    })

    it('resolves different providers for different project dirs', async () => {
      const registry = new (CiProviderRegistry as any)() as CiProviderRegistry
      let callCount = 0
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        callCount++
        if (callCount === 1) cb(null, 'https://github.com/user/repo.git\n', '')
        else cb(null, 'https://gitlab.com/user/repo.git\n', '')
        return {} as any
      })

      const github = await registry.resolve('/project-a')
      const gitlab = await registry.resolve('/project-b')
      expect(github!.providerKey).toBe('github')
      expect(gitlab!.providerKey).toBe('gitlab')
    })
  })

  describe('invalidate', () => {
    it('removes a project from cache so next resolve re-fetches', async () => {
      const registry = new (CiProviderRegistry as any)() as CiProviderRegistry
      mockRemoteUrl('https://github.com/user/repo.git')

      await registry.resolve('/fake/project')
      registry.invalidate('/fake/project')
      await registry.resolve('/fake/project')
      expect(mockExecFile).toHaveBeenCalledTimes(2)
    })

    it('does nothing for non-cached project', () => {
      const registry = new (CiProviderRegistry as any)() as CiProviderRegistry
      registry.invalidate('/nonexistent') // should not throw
    })
  })
})
