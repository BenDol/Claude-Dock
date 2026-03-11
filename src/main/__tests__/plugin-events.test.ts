import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PluginEventBus } from '../plugins/plugin-events'

describe('PluginEventBus', () => {
  let bus: PluginEventBus

  beforeEach(() => {
    bus = new PluginEventBus()
  })

  describe('on / off', () => {
    it('registers a handler for an event', async () => {
      const handler = vi.fn()
      bus.on('project:postOpen', 'test-plugin', handler)

      await bus.emitPre('project:postOpen', { projectDir: '/test', dock: {} as any }, () => true)
      expect(handler).toHaveBeenCalledWith({ projectDir: '/test', dock: {} })
    })

    it('removes all handlers for a plugin via off()', async () => {
      const handler1 = vi.fn()
      const handler2 = vi.fn()
      bus.on('project:postOpen', 'plugin-a', handler1)
      bus.on('project:preClose', 'plugin-a', handler2)

      bus.off('plugin-a')

      await bus.emitPre('project:postOpen', { projectDir: '/test', dock: {} as any }, () => true)
      await bus.emitPre('project:preClose', { projectDir: '/test' }, () => true)
      expect(handler1).not.toHaveBeenCalled()
      expect(handler2).not.toHaveBeenCalled()
    })

    it('does not remove handlers from other plugins', async () => {
      const handlerA = vi.fn()
      const handlerB = vi.fn()
      bus.on('project:preClose', 'plugin-a', handlerA)
      bus.on('project:preClose', 'plugin-b', handlerB)

      bus.off('plugin-a')

      await bus.emitPre('project:preClose', { projectDir: '/test' }, () => true)
      expect(handlerA).not.toHaveBeenCalled()
      expect(handlerB).toHaveBeenCalled()
    })

    it('supports multiple handlers per event', async () => {
      const handler1 = vi.fn()
      const handler2 = vi.fn()
      bus.on('settings:changed', 'plugin-a', handler1)
      bus.on('settings:changed', 'plugin-b', handler2)

      await bus.emitPre('settings:changed', { settings: {} as any }, () => true)
      expect(handler1).toHaveBeenCalled()
      expect(handler2).toHaveBeenCalled()
    })
  })

  describe('emitPre', () => {
    it('awaits handlers sequentially', async () => {
      const order: number[] = []

      bus.on('project:preOpen', 'plugin-a', async () => {
        await new Promise((r) => setTimeout(r, 10))
        order.push(1)
      })
      bus.on('project:preOpen', 'plugin-b', async () => {
        order.push(2)
      })

      await bus.emitPre('project:preOpen', { projectDir: '/test', dock: {} as any }, () => true)
      expect(order).toEqual([1, 2])
    })

    it('respects the filter function', async () => {
      const handlerA = vi.fn()
      const handlerB = vi.fn()
      bus.on('project:preClose', 'plugin-a', handlerA)
      bus.on('project:preClose', 'plugin-b', handlerB)

      await bus.emitPre('project:preClose', { projectDir: '/test' }, (id) => id === 'plugin-a')
      expect(handlerA).toHaveBeenCalled()
      expect(handlerB).not.toHaveBeenCalled()
    })

    it('catches and logs errors from handlers without throwing', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const handler = vi.fn(() => {
        throw new Error('handler error')
      })
      const handler2 = vi.fn()
      bus.on('project:preClose', 'plugin-a', handler)
      bus.on('project:preClose', 'plugin-b', handler2)

      // Should not throw
      await bus.emitPre('project:preClose', { projectDir: '/test' }, () => true)
      expect(handler2).toHaveBeenCalled()
      consoleSpy.mockRestore()
    })

    it('handles empty event with no handlers', async () => {
      // Should not throw
      await bus.emitPre('terminal:preSpawn', { projectDir: '/test', terminalId: 't1' }, () => true)
    })
  })

  describe('emitPost', () => {
    it('fires handlers without awaiting', () => {
      const handler = vi.fn()
      bus.on('project:postClose', 'plugin-a', handler)

      bus.emitPost('project:postClose', { projectDir: '/test' }, () => true)
      expect(handler).toHaveBeenCalledWith({ projectDir: '/test' })
    })

    it('respects the filter function', () => {
      const handlerA = vi.fn()
      const handlerB = vi.fn()
      bus.on('terminal:postSpawn', 'plugin-a', handlerA)
      bus.on('terminal:postSpawn', 'plugin-b', handlerB)

      bus.emitPost(
        'terminal:postSpawn',
        { projectDir: '/test', terminalId: 't1', sessionId: 's1' },
        (id) => id === 'plugin-b'
      )
      expect(handlerA).not.toHaveBeenCalled()
      expect(handlerB).toHaveBeenCalled()
    })

    it('catches synchronous errors from handlers', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      bus.on('project:postClose', 'plugin-a', () => {
        throw new Error('sync error')
      })
      const handler2 = vi.fn()
      bus.on('project:postClose', 'plugin-b', handler2)

      // Should not throw
      bus.emitPost('project:postClose', { projectDir: '/test' }, () => true)
      expect(handler2).toHaveBeenCalled()
      consoleSpy.mockRestore()
    })

    it('catches async errors from handlers via .catch()', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      bus.on('project:postClose', 'plugin-a', async () => {
        throw new Error('async error')
      })

      // Should not throw
      bus.emitPost('project:postClose', { projectDir: '/test' }, () => true)
      consoleSpy.mockRestore()
    })

    it('handles empty event with no handlers', () => {
      // Should not throw
      bus.emitPost('terminal:postKill', { projectDir: '/test', terminalId: 't1' }, () => true)
    })
  })

  describe('event data integrity', () => {
    it('passes correct data to plugin:enabled handlers', async () => {
      const handler = vi.fn()
      bus.on('plugin:enabled', 'plugin-a', handler)

      await bus.emitPre('plugin:enabled', { projectDir: '/proj', pluginId: 'some-plugin' }, () => true)
      expect(handler).toHaveBeenCalledWith({ projectDir: '/proj', pluginId: 'some-plugin' })
    })

    it('passes terminal spawn data correctly', () => {
      const handler = vi.fn()
      bus.on('terminal:postSpawn', 'plugin-a', handler)

      bus.emitPost(
        'terminal:postSpawn',
        { projectDir: '/proj', terminalId: 't1', sessionId: 'sess-123' },
        () => true
      )
      expect(handler).toHaveBeenCalledWith({
        projectDir: '/proj',
        terminalId: 't1',
        sessionId: 'sess-123'
      })
    })
  })
})
