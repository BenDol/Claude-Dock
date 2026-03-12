import { describe, it, expect, vi, beforeEach } from 'vitest'

// Test the deepMergeDefaults logic used in settings-store.
// We don't import settings-store directly because it depends on electron-store
// and __UPDATE_PROFILE__ define. Instead we test the pure merge function inline.

import { DEFAULT_SETTINGS } from '../../shared/settings-schema'

describe('settings-store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset module state
    vi.resetModules()
  })

  describe('deepMergeDefaults', () => {
    // Extract and test the logic directly
    function deepMergeDefaults(defaults: Record<string, any>, stored: Record<string, any>): any {
      const result = { ...defaults }
      for (const key of Object.keys(stored)) {
        const sval = stored[key]
        const dval = defaults[key]
        if (sval !== undefined && sval !== null) {
          if (dval && typeof dval === 'object' && !Array.isArray(dval) && typeof sval === 'object' && !Array.isArray(sval)) {
            result[key] = deepMergeDefaults(dval, sval)
          } else {
            result[key] = sval
          }
        }
      }
      return result
    }

    it('returns defaults when stored is empty', () => {
      const result = deepMergeDefaults({ a: 1, b: 2 }, {})
      expect(result).toEqual({ a: 1, b: 2 })
    })

    it('overrides defaults with stored values', () => {
      const result = deepMergeDefaults({ a: 1, b: 2 }, { a: 10 })
      expect(result).toEqual({ a: 10, b: 2 })
    })

    it('deep merges nested objects', () => {
      const defaults = { theme: { mode: 'dark', accentColor: '#da7756' } }
      const stored = { theme: { mode: 'light' } }
      const result = deepMergeDefaults(defaults, stored)
      expect(result).toEqual({ theme: { mode: 'light', accentColor: '#da7756' } })
    })

    it('preserves new default keys not in stored data', () => {
      const defaults = {
        terminal: { fontSize: 14, lineHeight: 1.2 },
        keybindings: { focusUp: 'Ctrl+Up' }
      }
      const stored = {
        terminal: { fontSize: 16 }
        // keybindings missing entirely
      }
      const result = deepMergeDefaults(defaults, stored)
      expect(result.terminal.fontSize).toBe(16)
      expect(result.terminal.lineHeight).toBe(1.2)
      expect(result.keybindings.focusUp).toBe('Ctrl+Up')
    })

    it('handles arrays by replacing, not merging', () => {
      const defaults = { items: [1, 2, 3] }
      const stored = { items: [4, 5] }
      const result = deepMergeDefaults(defaults, stored)
      expect(result.items).toEqual([4, 5])
    })

    it('ignores null stored values (keeps defaults)', () => {
      const defaults = { a: 'hello', b: 'world' }
      const stored = { a: null }
      const result = deepMergeDefaults(defaults, stored)
      expect(result.a).toBe('hello')
    })

    it('ignores undefined stored values (keeps defaults)', () => {
      const defaults = { a: 'hello' }
      const stored = { a: undefined }
      const result = deepMergeDefaults(defaults, stored)
      expect(result.a).toBe('hello')
    })

    it('handles deeply nested merges', () => {
      const defaults = {
        level1: {
          level2: {
            level3: { a: 1, b: 2 }
          }
        }
      }
      const stored = {
        level1: {
          level2: {
            level3: { a: 99 }
          }
        }
      }
      const result = deepMergeDefaults(defaults, stored)
      expect(result.level1.level2.level3).toEqual({ a: 99, b: 2 })
    })

    it('merges the full Settings schema correctly', () => {
      const stored = {
        theme: { mode: 'light' as const },
        terminal: { fontSize: 18 }
      }
      const result = deepMergeDefaults(DEFAULT_SETTINGS, stored as any)

      // Stored values applied
      expect(result.theme.mode).toBe('light')
      expect(result.terminal.fontSize).toBe(18)

      // Default values preserved
      expect(result.theme.accentColor).toBe('#da7756')
      expect(result.terminal.cursorStyle).toBe('block')
      expect(result.grid.maxColumns).toBe(4)
      expect(result.behavior.confirmCloseWithRunning).toBe(true)
      expect(result.keybindings.focusUp).toBe('Ctrl+Shift+ArrowUp')
      expect(result.linked.enabled).toBe(false)
      expect(result.advanced.debugLogging).toBe(false)
    })

    it('handles extra stored keys not in defaults gracefully', () => {
      const defaults = { a: 1 }
      const stored = { a: 2, extraKey: 'bonus' }
      const result = deepMergeDefaults(defaults, stored)
      expect(result.a).toBe(2)
      expect(result.extraKey).toBe('bonus')
    })
  })
})
