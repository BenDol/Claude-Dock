import { describe, it, expect, beforeEach } from 'vitest'
import { useDockStore } from '../dock-store'

describe('dock-store claudeTaskTerminals', () => {
  beforeEach(() => {
    // Reset store to initial state
    useDockStore.setState({
      dockId: '',
      projectDir: '/project',
      terminals: [],
      gridMode: 'auto',
      focusedTerminalId: null,
      nextTerminalNum: 1,
      unlockedTerminals: new Set(),
      loadingTerminals: new Set(),
      claudeTaskTerminals: new Map()
    })
  })

  describe('setTerminalClaudeTask', () => {
    it('adds a ci-fix task to the map', () => {
      useDockStore.getState().setTerminalClaudeTask('term-1', 'ci-fix')

      const map = useDockStore.getState().claudeTaskTerminals
      expect(map.get('term-1')).toBe('ci-fix')
      expect(map.size).toBe(1)
    })

    it('adds a write-tests task to the map', () => {
      useDockStore.getState().setTerminalClaudeTask('term-1', 'write-tests')

      const map = useDockStore.getState().claudeTaskTerminals
      expect(map.get('term-1')).toBe('write-tests')
    })

    it('removes task when set to null', () => {
      useDockStore.getState().setTerminalClaudeTask('term-1', 'ci-fix')
      useDockStore.getState().setTerminalClaudeTask('term-1', null)

      const map = useDockStore.getState().claudeTaskTerminals
      expect(map.has('term-1')).toBe(false)
      expect(map.size).toBe(0)
    })

    it('overwrites existing task type', () => {
      useDockStore.getState().setTerminalClaudeTask('term-1', 'ci-fix')
      useDockStore.getState().setTerminalClaudeTask('term-1', 'write-tests')

      expect(useDockStore.getState().claudeTaskTerminals.get('term-1')).toBe('write-tests')
    })

    it('tracks multiple terminals independently', () => {
      useDockStore.getState().setTerminalClaudeTask('term-1', 'ci-fix')
      useDockStore.getState().setTerminalClaudeTask('term-2', 'write-tests')

      const map = useDockStore.getState().claudeTaskTerminals
      expect(map.get('term-1')).toBe('ci-fix')
      expect(map.get('term-2')).toBe('write-tests')
      expect(map.size).toBe(2)
    })

    it('removing one terminal does not affect others', () => {
      useDockStore.getState().setTerminalClaudeTask('term-1', 'ci-fix')
      useDockStore.getState().setTerminalClaudeTask('term-2', 'write-tests')
      useDockStore.getState().setTerminalClaudeTask('term-1', null)

      const map = useDockStore.getState().claudeTaskTerminals
      expect(map.has('term-1')).toBe(false)
      expect(map.get('term-2')).toBe('write-tests')
      expect(map.size).toBe(1)
    })

    it('setting null on non-existent terminal is a no-op', () => {
      useDockStore.getState().setTerminalClaudeTask('nonexistent', null)

      expect(useDockStore.getState().claudeTaskTerminals.size).toBe(0)
    })
  })

  describe('removeTerminal cleans up claudeTaskTerminals', () => {
    it('removes task entry when terminal is removed', () => {
      useDockStore.getState().addTerminal('term-1')
      useDockStore.getState().setTerminalClaudeTask('term-1', 'ci-fix')

      useDockStore.getState().removeTerminal('term-1')

      expect(useDockStore.getState().claudeTaskTerminals.has('term-1')).toBe(false)
    })

    it('preserves other terminal tasks when one is removed', () => {
      useDockStore.getState().addTerminal('term-1')
      useDockStore.getState().addTerminal('term-2')
      useDockStore.getState().setTerminalClaudeTask('term-1', 'ci-fix')
      useDockStore.getState().setTerminalClaudeTask('term-2', 'write-tests')

      useDockStore.getState().removeTerminal('term-1')

      const map = useDockStore.getState().claudeTaskTerminals
      expect(map.has('term-1')).toBe(false)
      expect(map.get('term-2')).toBe('write-tests')
    })

    it('removing terminal without task is safe', () => {
      useDockStore.getState().addTerminal('term-1')
      useDockStore.getState().removeTerminal('term-1')

      expect(useDockStore.getState().claudeTaskTerminals.size).toBe(0)
    })
  })
})
