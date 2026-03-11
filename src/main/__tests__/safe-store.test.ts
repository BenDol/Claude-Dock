import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock electron-store before importing the module
// Use a regular function (not arrow) so it can be called with `new`
vi.mock('electron-store', () => {
  function MockStore(this: any, opts?: any) {
    this.path = '/mock/store.json'
    this.store = opts?.defaults ?? {}
    this.get = vi.fn()
    this.set = vi.fn()
    this.delete = vi.fn()
    this.has = vi.fn()
    this.clear = vi.fn()
  }
  return { default: MockStore }
})

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
  renameSync: vi.fn()
}))

import { safeWrite, safeWriteSync, safeRead, createSafeStore } from '../safe-store'

describe('safe-store', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  describe('safeWrite', () => {
    it('returns true on successful write', async () => {
      const result = await safeWrite(() => {})
      expect(result).toBe(true)
    })

    it('returns true on first attempt when fn succeeds', async () => {
      const fn = vi.fn()
      const result = await safeWrite(fn)
      expect(result).toBe(true)
      expect(fn).toHaveBeenCalledTimes(1)
    })

    it('retries on failure and succeeds on subsequent attempt', async () => {
      let calls = 0
      const fn = vi.fn(() => {
        calls++
        if (calls < 3) throw new Error('fail')
      })
      const result = await safeWrite(fn)
      expect(result).toBe(true)
      expect(fn).toHaveBeenCalledTimes(3)
    })

    it('returns false after exhausting all retries', async () => {
      const fn = vi.fn(() => {
        throw new Error('persistent failure')
      })
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const result = await safeWrite(fn)
      expect(result).toBe(false)
      // MAX_RETRIES = 3, so 4 total attempts (0, 1, 2, 3)
      expect(fn).toHaveBeenCalledTimes(4)
      consoleSpy.mockRestore()
    })
  })

  describe('safeWriteSync', () => {
    it('returns true on successful write', () => {
      const result = safeWriteSync(() => {})
      expect(result).toBe(true)
    })

    it('retries synchronously and returns true on recovery', () => {
      let calls = 0
      const fn = vi.fn(() => {
        calls++
        if (calls < 2) throw new Error('fail')
      })
      const result = safeWriteSync(fn)
      expect(result).toBe(true)
      expect(fn).toHaveBeenCalledTimes(2)
    })

    it('returns false after exhausting retries synchronously', () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const fn = vi.fn(() => {
        throw new Error('persistent')
      })
      const result = safeWriteSync(fn)
      expect(result).toBe(false)
      expect(fn).toHaveBeenCalledTimes(4) // 0..3 inclusive
    })
  })

  describe('safeRead', () => {
    it('returns the value from fn on success', () => {
      const result = safeRead(() => 42)
      expect(result).toBe(42)
    })

    it('returns undefined on error', () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const result = safeRead(() => {
        throw new Error('read failed')
      })
      expect(result).toBeUndefined()
    })

    it('returns complex objects', () => {
      const obj = { a: 1, b: [2, 3] }
      const result = safeRead(() => obj)
      expect(result).toEqual(obj)
    })

    it('returns null if fn returns null (not undefined)', () => {
      const result = safeRead(() => null)
      expect(result).toBeNull()
    })
  })

  describe('createSafeStore', () => {
    it('creates a store on success', () => {
      const store = createSafeStore({ name: 'test' })
      expect(store).toBeDefined()
      expect(store.clear).toBeDefined()
    })
  })
})
