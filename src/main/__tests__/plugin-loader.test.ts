import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as path from 'path'

// We need to test the private validation functions by extracting their logic.
// Since plugin-loader.ts has heavy Electron deps, we test the validation logic
// by importing and intercepting the module.

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/mock/userData')
  },
  dialog: {
    showMessageBox: vi.fn().mockResolvedValue({ response: 1 }) // deny by default
  }
}))

vi.mock('electron-store', () => ({
  default: vi.fn().mockImplementation(() => ({
    get: vi.fn().mockReturnValue({}),
    set: vi.fn(),
    path: '/mock/store.json'
  }))
}))

vi.mock('../safe-store', () => ({
  createSafeStore: vi.fn().mockReturnValue({
    get: vi.fn().mockReturnValue({}),
    set: vi.fn(),
    path: '/mock/store.json'
  }),
  safeRead: vi.fn((fn: () => any) => {
    try { return fn() } catch { return undefined }
  }),
  safeWriteSync: vi.fn((fn: () => void) => {
    try { fn(); return true } catch { return false }
  })
}))

vi.mock('../logger', () => ({
  log: vi.fn(),
  logError: vi.fn()
}))

vi.mock('./runtime-plugin', () => ({
  RuntimePlugin: vi.fn().mockImplementation((manifest, dir, mod) => ({
    id: manifest.id,
    name: manifest.name,
    manifest,
    pluginDir: dir,
    module: mod
  }))
}))

describe('plugin-loader validation', () => {
  describe('dangerous SVG detection', () => {
    // Test the SVG pattern directly
    const DANGEROUS_SVG = /<script|on\w+\s*=|javascript\s*:|data\s*:\s*text\/html/i

    it('detects <script> tags in SVG', () => {
      expect(DANGEROUS_SVG.test('<svg><script>alert(1)</script></svg>')).toBe(true)
    })

    it('detects onload event handlers', () => {
      expect(DANGEROUS_SVG.test('<svg onload="alert(1)">')).toBe(true)
    })

    it('detects onclick event handlers', () => {
      expect(DANGEROUS_SVG.test('<rect onclick="alert(1)">')).toBe(true)
    })

    it('detects javascript: protocol', () => {
      expect(DANGEROUS_SVG.test('<a href="javascript:alert(1)">')).toBe(true)
    })

    it('detects data:text/html', () => {
      expect(DANGEROUS_SVG.test('<img src="data: text/html,<script>alert(1)</script>">')).toBe(true)
    })

    it('allows safe SVG content', () => {
      expect(DANGEROUS_SVG.test('<svg viewBox="0 0 24 24"><path d="M12 2L2 22h20z"/></svg>')).toBe(false)
    })

    it('allows SVG with styling', () => {
      expect(DANGEROUS_SVG.test('<svg fill="currentColor"><circle cx="12" cy="12" r="10"/></svg>')).toBe(false)
    })

    it('is case-insensitive for detection', () => {
      expect(DANGEROUS_SVG.test('<SCRIPT>alert(1)</SCRIPT>')).toBe(true)
      expect(DANGEROUS_SVG.test('<svg ONLOAD="alert(1)">')).toBe(true)
      expect(DANGEROUS_SVG.test('JAVASCRIPT:alert(1)')).toBe(true)
    })
  })

  describe('path traversal detection', () => {
    // Reimplementation of isPathInsideDir for testing
    function isPathInsideDir(dir: string, relativePath: string): boolean {
      const resolved = path.resolve(dir, relativePath)
      const normalizedDir = path.resolve(dir) + path.sep
      return resolved.startsWith(normalizedDir) || resolved === path.resolve(dir)
    }

    it('allows paths inside the directory', () => {
      expect(isPathInsideDir('/plugins/test', 'index.js')).toBe(true)
      expect(isPathInsideDir('/plugins/test', 'src/main.js')).toBe(true)
      expect(isPathInsideDir('/plugins/test', './index.js')).toBe(true)
    })

    it('blocks path traversal with ../', () => {
      expect(isPathInsideDir('/plugins/test', '../other/index.js')).toBe(false)
      expect(isPathInsideDir('/plugins/test', '../../etc/passwd')).toBe(false)
    })

    it('blocks absolute paths outside directory', () => {
      expect(isPathInsideDir('/plugins/test', '/etc/passwd')).toBe(false)
    })

    it('allows nested subdirectories', () => {
      expect(isPathInsideDir('/plugins/test', 'dist/bundle/main.js')).toBe(true)
    })
  })

  describe('manifest validation', () => {
    // Reimplementation for direct testing
    function looksLikeFilePath(icon: string): boolean {
      const trimmed = icon.trim()
      return !trimmed.startsWith('<') && /\.svg$/i.test(trimmed)
    }

    function validateManifest(data: any, dir: string): boolean {
      if (!data.id || typeof data.id !== 'string') return false
      if (!data.name || typeof data.name !== 'string') return false
      if (!data.version || typeof data.version !== 'string') return false

      const DANGEROUS_SVG = /<script|on\w+\s*=|javascript\s*:|data\s*:\s*text\/html/i
      if (data.toolbar?.icon && !looksLikeFilePath(data.toolbar.icon) && DANGEROUS_SVG.test(data.toolbar.icon)) return false

      function isPathInsideDir(d: string, relativePath: string): boolean {
        const resolved = path.resolve(d, relativePath)
        const normalizedDir = path.resolve(d) + path.sep
        return resolved.startsWith(normalizedDir) || resolved === path.resolve(d)
      }

      if (data.toolbar?.icon && looksLikeFilePath(data.toolbar.icon) && !isPathInsideDir(dir, data.toolbar.icon)) return false
      if (data.main && !isPathInsideDir(dir, data.main)) return false
      if (data.window?.entry && !isPathInsideDir(dir, data.window.entry)) return false

      return true
    }

    it('accepts valid manifest', () => {
      expect(
        validateManifest(
          { id: 'my-plugin', name: 'My Plugin', version: '1.0.0', main: 'index.js' },
          '/plugins/my-plugin'
        )
      ).toBe(true)
    })

    it('rejects missing id', () => {
      expect(
        validateManifest({ name: 'My Plugin', version: '1.0.0' }, '/plugins/x')
      ).toBe(false)
    })

    it('rejects non-string id', () => {
      expect(
        validateManifest({ id: 123, name: 'My Plugin', version: '1.0.0' }, '/plugins/x')
      ).toBe(false)
    })

    it('rejects missing name', () => {
      expect(
        validateManifest({ id: 'x', version: '1.0.0' }, '/plugins/x')
      ).toBe(false)
    })

    it('rejects missing version', () => {
      expect(
        validateManifest({ id: 'x', name: 'X' }, '/plugins/x')
      ).toBe(false)
    })

    it('rejects dangerous toolbar icon', () => {
      expect(
        validateManifest(
          {
            id: 'x',
            name: 'X',
            version: '1.0.0',
            toolbar: { icon: '<svg onload="alert(1)">', title: 't', action: 'a' }
          },
          '/plugins/x'
        )
      ).toBe(false)
    })

    it('rejects path-traversal in main', () => {
      expect(
        validateManifest(
          { id: 'x', name: 'X', version: '1.0.0', main: '../../evil.js' },
          '/plugins/x'
        )
      ).toBe(false)
    })

    it('rejects path-traversal in window.entry', () => {
      expect(
        validateManifest(
          {
            id: 'x',
            name: 'X',
            version: '1.0.0',
            window: { entry: '../../../index.html' }
          },
          '/plugins/x'
        )
      ).toBe(false)
    })

    it('accepts toolbar icon as file path', () => {
      expect(
        validateManifest(
          {
            id: 'x',
            name: 'X',
            version: '1.0.0',
            toolbar: { icon: './icon.svg', title: 't', action: 'a' }
          },
          '/plugins/x'
        )
      ).toBe(true)
    })

    it('rejects path-traversal in toolbar icon file path', () => {
      expect(
        validateManifest(
          {
            id: 'x',
            name: 'X',
            version: '1.0.0',
            toolbar: { icon: '../../evil.svg', title: 't', action: 'a' }
          },
          '/plugins/x'
        )
      ).toBe(false)
    })

    it('does not apply dangerous SVG check to file path icons', () => {
      // A file path ending in .svg that happens to contain "onload" should not be rejected
      // (validation checks the file contents separately, not the path string)
      expect(
        validateManifest(
          {
            id: 'x',
            name: 'X',
            version: '1.0.0',
            toolbar: { icon: './icons/onload.svg', title: 't', action: 'a' }
          },
          '/plugins/x'
        )
      ).toBe(true)
    })

    it('accepts valid manifest with toolbar and window', () => {
      expect(
        validateManifest(
          {
            id: 'my-plugin',
            name: 'My Plugin',
            version: '1.0.0',
            main: 'index.js',
            toolbar: {
              title: 'Open',
              icon: '<svg viewBox="0 0 24 24"><path d="M12 2"/></svg>',
              action: 'my-plugin:open'
            },
            window: {
              entry: 'ui/index.html',
              width: 600,
              height: 400
            }
          },
          '/plugins/my-plugin'
        )
      ).toBe(true)
    })
  })

  describe('manifest hash', () => {
    it('produces consistent SHA-256 hashes', async () => {
      const crypto = await import('crypto')
      const raw = '{"id":"test","name":"Test","version":"1.0.0"}'
      const hash1 = crypto.createHash('sha256').update(raw).digest('hex')
      const hash2 = crypto.createHash('sha256').update(raw).digest('hex')
      expect(hash1).toBe(hash2)
      expect(hash1).toHaveLength(64) // SHA-256 hex length
    })

    it('produces different hashes for different content', async () => {
      const crypto = await import('crypto')
      const hash1 = crypto.createHash('sha256').update('content-a').digest('hex')
      const hash2 = crypto.createHash('sha256').update('content-b').digest('hex')
      expect(hash1).not.toBe(hash2)
    })
  })
})
