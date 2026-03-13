import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { mockHostOn, mockHostPostMessage, mockHostKill } = vi.hoisted(() => ({
  mockHostOn: vi.fn(),
  mockHostPostMessage: vi.fn(),
  mockHostKill: vi.fn()
}))

vi.mock('electron', () => ({
  utilityProcess: {
    fork: vi.fn().mockReturnValue({
      on: mockHostOn,
      postMessage: mockHostPostMessage,
      kill: mockHostKill
    })
  }
}))

vi.mock('../logger', () => ({
  log: vi.fn(),
  logError: vi.fn()
}))

vi.mock('../util/shell', () => ({
  getDefaultShell: vi.fn().mockReturnValue('/bin/bash'),
  getShellArgs: vi.fn().mockReturnValue(['-l'])
}))

import { PtyManager } from '../pty-manager'

describe('PtyManager', () => {
  let manager: PtyManager
  let onData: ReturnType<typeof vi.fn>
  let onExit: ReturnType<typeof vi.fn>
  let onSessionCreated: ReturnType<typeof vi.fn>
  let onSessionsChanged: ReturnType<typeof vi.fn>
  let messageHandler: (msg: any) => void

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()

    onData = vi.fn()
    onExit = vi.fn()
    onSessionCreated = vi.fn()
    onSessionsChanged = vi.fn()

    // Capture the message handler when host.on('message', ...) is called
    mockHostOn.mockImplementation((event: string, handler: any) => {
      if (event === 'message') messageHandler = handler
    })

    manager = new PtyManager(onData, onExit, onSessionCreated, onSessionsChanged)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('spawn', () => {
    it('creates a PTY instance and sends spawn to host', () => {
      manager.spawn('term-1', '/project')

      expect(manager.has('term-1')).toBe(true)
      expect(manager.size).toBe(1)
      expect(mockHostPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'spawn',
          terminalId: 'term-1',
          cwd: '/project'
        })
      )
    })

    it('generates a session ID for new terminals', () => {
      manager.spawn('term-1', '/project')

      const sessionId = manager.getSessionId('term-1')
      expect(sessionId).toBeTruthy()
      expect(typeof sessionId).toBe('string')
    })

    it('uses resumeId when provided', () => {
      manager.spawn('term-1', '/project', 'existing-session-123')

      const sessionId = manager.getSessionId('term-1')
      expect(sessionId).toBe('existing-session-123')
    })

    it('does NOT call onSessionCreated at spawn for new terminals (deferred to first write)', () => {
      manager.spawn('term-1', '/project')
      expect(onSessionCreated).not.toHaveBeenCalled()
    })

    it('calls onSessionCreated on first write for new terminals', () => {
      manager.spawn('term-1', '/project')
      manager.write('term-1', 'hello')
      expect(onSessionCreated).toHaveBeenCalledWith(expect.any(String))
    })

    it('calls onSessionCreated at spawn for resumed terminals', () => {
      manager.spawn('term-1', '/project', 'existing-session')
      expect(onSessionCreated).toHaveBeenCalledWith('existing-session')
    })

    it('queues claude launch command with session-id for new terminals', () => {
      manager.spawn('term-1', '/project')

      // Process the queue (200ms initial delay)
      vi.advanceTimersByTime(200)

      const writeCalls = mockHostPostMessage.mock.calls.filter(
        (c) => c[0].type === 'write'
      )
      expect(writeCalls.length).toBe(1)
      expect(writeCalls[0][0].data).toContain('claude --session-id')
    })

    it('queues claude launch command with --resume for resumed terminals', () => {
      manager.spawn('term-1', '/project', 'sess-abc')

      vi.advanceTimersByTime(200)

      const writeCalls = mockHostPostMessage.mock.calls.filter(
        (c) => c[0].type === 'write'
      )
      expect(writeCalls[0][0].data).toContain('claude --resume sess-abc')
    })
  })

  describe('serial launch queue', () => {
    it('serializes multiple spawns with delays between launches', () => {
      manager.spawn('term-1', '/project')
      manager.spawn('term-2', '/project')
      manager.spawn('term-3', '/project')

      const countWrites = () =>
        mockHostPostMessage.mock.calls.filter((c) => c[0].type === 'write').length

      // First launch after 200ms initial delay
      vi.advanceTimersByTime(200)
      expect(countWrites()).toBe(1)

      // processQueue uses nested setTimeout: 200ms (first) -> next() -> setTimeout(processQueue, 3000)
      // Then next processQueue: setTimeout(next, 200) -> next() -> setTimeout(processQueue, 3000)
      // Second launch: 3000ms (gap) + 200ms (delay) = 3200ms after first
      vi.advanceTimersByTime(3200)
      expect(countWrites()).toBe(2)

      // Third launch: another 3000ms + 200ms
      vi.advanceTimersByTime(3200)
      expect(countWrites()).toBe(3)
    })

    it('does not write to killed terminal even if queued', () => {
      manager.spawn('term-1', '/project')
      manager.kill('term-1')

      // Queue fires after 200ms but terminal no longer exists
      vi.advanceTimersByTime(200)

      const writeCalls = mockHostPostMessage.mock.calls.filter(
        (c) => c[0].type === 'write'
      )
      expect(writeCalls.length).toBe(0)
    })
  })

  describe('data batching', () => {
    it('batches data over 8ms window', () => {
      // Simulate data messages from host
      messageHandler({ type: 'data', terminalId: 'term-1', data: 'chunk1' })
      messageHandler({ type: 'data', terminalId: 'term-1', data: 'chunk2' })

      // Not flushed yet
      expect(onData).not.toHaveBeenCalled()

      // Flush after 8ms
      vi.advanceTimersByTime(8)
      expect(onData).toHaveBeenCalledTimes(1)
      expect(onData).toHaveBeenCalledWith('term-1', 'chunk1chunk2')
    })

    it('batches data per terminal separately', () => {
      manager.spawn('term-1', '/project')
      manager.spawn('term-2', '/project')

      messageHandler({ type: 'data', terminalId: 'term-1', data: 'a' })
      messageHandler({ type: 'data', terminalId: 'term-2', data: 'b' })

      vi.advanceTimersByTime(8)
      expect(onData).toHaveBeenCalledWith('term-1', 'a')
      expect(onData).toHaveBeenCalledWith('term-2', 'b')
    })
  })

  describe('exit handling', () => {
    it('removes PTY and fires callbacks on exit', () => {
      manager.spawn('term-1', '/project')
      expect(manager.has('term-1')).toBe(true)

      messageHandler({ type: 'exit', terminalId: 'term-1', exitCode: 0 })

      expect(manager.has('term-1')).toBe(false)
      expect(onExit).toHaveBeenCalledWith('term-1', 0)
      expect(onSessionsChanged).toHaveBeenCalled()
    })

    it('fires onSessionsChanged when not suppressed', () => {
      manager.spawn('term-1', '/project')
      messageHandler({ type: 'exit', terminalId: 'term-1', exitCode: 0 })
      expect(onSessionsChanged).toHaveBeenCalled()
    })
  })

  describe('write', () => {
    it('sends write message to host for existing PTY', () => {
      manager.spawn('term-1', '/project')
      manager.write('term-1', 'hello')

      expect(mockHostPostMessage).toHaveBeenCalledWith({
        type: 'write',
        terminalId: 'term-1',
        data: 'hello'
      })
    })

    it('does nothing for non-existent PTY', () => {
      const callsBefore = mockHostPostMessage.mock.calls.length
      manager.write('non-existent', 'hello')
      // Only spawn message sent, no write
      expect(
        mockHostPostMessage.mock.calls.filter((c) => c[0].type === 'write').length
      ).toBe(0)
    })
  })

  describe('resize', () => {
    it('sends resize message to host for existing PTY', () => {
      manager.spawn('term-1', '/project')
      manager.resize('term-1', 120, 40)

      expect(mockHostPostMessage).toHaveBeenCalledWith({
        type: 'resize',
        terminalId: 'term-1',
        cols: 120,
        rows: 40
      })
    })

    it('does nothing for non-existent PTY', () => {
      manager.resize('non-existent', 120, 40)
      expect(
        mockHostPostMessage.mock.calls.filter((c) => c[0].type === 'resize').length
      ).toBe(0)
    })
  })

  describe('kill', () => {
    it('sends kill message and removes PTY', () => {
      manager.spawn('term-1', '/project')
      manager.kill('term-1')

      expect(mockHostPostMessage).toHaveBeenCalledWith({
        type: 'kill',
        terminalId: 'term-1'
      })
      expect(manager.has('term-1')).toBe(false)
      expect(manager.size).toBe(0)
    })

    it('clears pending data for killed terminal', () => {
      manager.spawn('term-1', '/project')
      messageHandler({ type: 'data', terminalId: 'term-1', data: 'pending' })
      manager.kill('term-1')

      // Flush timer should not deliver data for killed terminal
      vi.advanceTimersByTime(8)
      expect(onData).not.toHaveBeenCalledWith('term-1', expect.anything())
    })

    it('fires onSessionsChanged', () => {
      manager.spawn('term-1', '/project')
      onSessionsChanged.mockClear()
      manager.kill('term-1')
      expect(onSessionsChanged).toHaveBeenCalled()
    })

    it('does nothing for non-existent PTY', () => {
      const callsBefore = mockHostPostMessage.mock.calls.length
      manager.kill('non-existent')
      expect(
        mockHostPostMessage.mock.calls.filter((c) => c[0].type === 'kill').length
      ).toBe(0)
    })
  })

  describe('killAll', () => {
    it('sends killAll and terminates host process', () => {
      manager.spawn('term-1', '/project')
      manager.spawn('term-2', '/project')
      manager.killAll()

      expect(mockHostPostMessage).toHaveBeenCalledWith({ type: 'killAll' })
      expect(mockHostKill).toHaveBeenCalled()
      expect(manager.size).toBe(0)
    })

    it('suppresses session change events during killAll', () => {
      manager.spawn('term-1', '/project')
      manager.spawn('term-2', '/project')
      onSessionsChanged.mockClear()

      manager.killAll()
      // onSessionsChanged should NOT have been called during killAll
      expect(onSessionsChanged).not.toHaveBeenCalled()
    })

    it('clears all pending data and timers', () => {
      manager.spawn('term-1', '/project')
      messageHandler({ type: 'data', terminalId: 'term-1', data: 'pending' })
      manager.killAll()

      vi.advanceTimersByTime(8)
      expect(onData).not.toHaveBeenCalled()
    })
  })

  describe('session ID accessors', () => {
    it('getSessionIds returns all interacted session IDs', () => {
      manager.spawn('term-1', '/project')
      manager.spawn('term-2', '/project')
      // Terminals must be interacted (via write) to appear in session IDs
      manager.write('term-1', 'a')
      manager.write('term-2', 'b')

      const ids = manager.getSessionIds()
      expect(ids).toHaveLength(2)
    })

    it('getOrderedSessionIds returns IDs in specified order', () => {
      manager.spawn('term-1', '/project')
      manager.spawn('term-2', '/project')
      manager.write('term-1', 'a')
      manager.write('term-2', 'b')

      const id1 = manager.getSessionId('term-1')!
      const id2 = manager.getSessionId('term-2')!

      const ordered = manager.getOrderedSessionIds(['term-2', 'term-1'])
      expect(ordered).toEqual([id2, id1])
    })

    it('getOrderedSessionIds filters out non-existent terminals', () => {
      manager.spawn('term-1', '/project')
      manager.write('term-1', 'a')

      const ordered = manager.getOrderedSessionIds(['term-1', 'non-existent'])
      expect(ordered).toHaveLength(1)
    })

    it('getSessionId returns null for non-existent terminal', () => {
      expect(manager.getSessionId('non-existent')).toBeNull()
    })
  })
})
