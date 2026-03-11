import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'

// Mock electron app
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/mock/userData/claude-dock')
  }
}))

vi.mock('../logger', () => ({
  log: vi.fn(),
  logError: vi.fn()
}))

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof fs>('fs')
  return {
    ...actual,
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(true)
  }
})

import { ActivityTracker } from '../activity-tracker'

/** Helper: get the last writeFileSync call that wrote dock-activity.json */
function getLastSavedState(): any | null {
  const calls = vi.mocked(fs.writeFileSync).mock.calls
  for (let i = calls.length - 1; i >= 0; i--) {
    if (String(calls[i][0]).includes('dock-activity.json')) {
      return JSON.parse(String(calls[i][1]))
    }
  }
  return null
}

describe('ActivityTracker', () => {
  let tracker: ActivityTracker

  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(fs.writeFileSync).mockClear()
    // Reset singleton
    ;(ActivityTracker as any).instance = null
    tracker = ActivityTracker.getInstance()
  })

  afterEach(() => {
    tracker.shutdown()
    vi.useRealTimers()
  })

  describe('singleton', () => {
    it('returns the same instance', () => {
      const a = ActivityTracker.getInstance()
      const b = ActivityTracker.getInstance()
      expect(a).toBe(b)
    })

    it('creates new instance after shutdown', () => {
      const a = ActivityTracker.getInstance()
      a.shutdown()
      const b = ActivityTracker.getInstance()
      expect(a).not.toBe(b)
    })
  })

  describe('addTerminal', () => {
    it('adds a terminal to a new dock', () => {
      tracker.addTerminal('dock-1', 'term-1', 'Terminal 1', 'session-1', '/project')
      // Verify dock was created - trackData should not throw
      tracker.trackData('dock-1', 'term-1', 'hello\n')
    })

    it('prevents duplicate terminal additions', () => {
      tracker.addTerminal('dock-1', 'term-1', 'Terminal 1', 'session-1', '/project')
      tracker.addTerminal('dock-1', 'term-1', 'Terminal 1 Dup', 'session-1', '/project')
      tracker.removeTerminal('dock-1', 'term-1')
      // trackData on removed terminal is a no-op (no error)
      tracker.trackData('dock-1', 'term-1', 'hello\n')
    })

    it('adds multiple terminals to same dock', () => {
      tracker.addTerminal('dock-1', 'term-1', 'T1', 'sess-1', '/project')
      tracker.addTerminal('dock-1', 'term-2', 'T2', 'sess-2', '/project')
      tracker.trackData('dock-1', 'term-1', 'data1\n')
      tracker.trackData('dock-1', 'term-2', 'data2\n')
    })
  })

  describe('trackData', () => {
    beforeEach(() => {
      tracker.addTerminal('dock-1', 'term-1', 'T1', 'sess-1', '/project')
      // Flush the addTerminal save so we start clean
      vi.advanceTimersByTime(600)
      vi.mocked(fs.writeFileSync).mockClear()
    })

    it('ignores data for unknown docks', () => {
      tracker.trackData('unknown-dock', 'term-1', 'hello\n')
    })

    it('ignores data for unknown terminals', () => {
      tracker.trackData('dock-1', 'unknown-term', 'hello\n')
    })

    it('strips ANSI escape codes from data', () => {
      tracker.trackData('dock-1', 'term-1', '\x1b[32mgreen text\x1b[0m\n')
      vi.advanceTimersByTime(600)

      const state = getLastSavedState()
      expect(state).not.toBeNull()
      expect(state.docks['dock-1'].terminals[0].recentLines[0]).toBe('green text')
    })

    it('handles partial lines (buffering)', () => {
      tracker.trackData('dock-1', 'term-1', 'partial')
      tracker.trackData('dock-1', 'term-1', ' line\ncomplete\n')
      vi.advanceTimersByTime(600)

      const state = getLastSavedState()
      expect(state).not.toBeNull()
      const lines = state.docks['dock-1'].terminals[0].recentLines
      expect(lines).toContain('partial line')
      expect(lines).toContain('complete')
    })

    it('respects MAX_LINES limit (40)', () => {
      for (let i = 0; i < 50; i++) {
        tracker.trackData('dock-1', 'term-1', `line ${i}\n`)
      }
      vi.advanceTimersByTime(600)

      const state = getLastSavedState()
      expect(state).not.toBeNull()
      const lines = state.docks['dock-1'].terminals[0].recentLines
      expect(lines.length).toBeLessThanOrEqual(40)
      expect(lines[lines.length - 1]).toBe('line 49')
    })

    it('truncates lines longer than 500 characters', () => {
      const longLine = 'x'.repeat(600)
      tracker.trackData('dock-1', 'term-1', longLine + '\n')
      vi.advanceTimersByTime(600)

      const state = getLastSavedState()
      expect(state).not.toBeNull()
      const line = state.docks['dock-1'].terminals[0].recentLines[0]
      expect(line.length).toBeLessThanOrEqual(503) // 500 + '...'
      expect(line.endsWith('...')).toBe(true)
    })

    it('skips empty lines', () => {
      tracker.trackData('dock-1', 'term-1', '\n\n\nhello\n\n')
      vi.advanceTimersByTime(600)

      const state = getLastSavedState()
      expect(state).not.toBeNull()
      const lines = state.docks['dock-1'].terminals[0].recentLines
      expect(lines).toEqual(['hello'])
    })
  })

  describe('ANSI stripping', () => {
    beforeEach(() => {
      tracker.addTerminal('dock-1', 'term-1', 'T1', 'sess-1', '/project')
      vi.advanceTimersByTime(600)
      vi.mocked(fs.writeFileSync).mockClear()
    })

    it('strips CSI color sequences', () => {
      tracker.trackData('dock-1', 'term-1', '\x1b[31mred\x1b[0m\n')
      vi.advanceTimersByTime(600)
      const state = getLastSavedState()
      expect(state).not.toBeNull()
      expect(state.docks['dock-1'].terminals[0].recentLines[0]).toBe('red')
    })

    it('strips OSC sequences (window title, hyperlinks)', () => {
      tracker.trackData('dock-1', 'term-1', '\x1b]0;Window Title\x07plain text\n')
      vi.advanceTimersByTime(600)
      const state = getLastSavedState()
      expect(state).not.toBeNull()
      expect(state.docks['dock-1'].terminals[0].recentLines[0]).toBe('plain text')
    })

    it('strips cursor movement sequences', () => {
      tracker.trackData('dock-1', 'term-1', '\x1b[2Jcleared\n')
      vi.advanceTimersByTime(600)
      const state = getLastSavedState()
      expect(state).not.toBeNull()
      expect(state.docks['dock-1'].terminals[0].recentLines[0]).toBe('cleared')
    })
  })

  describe('setTerminalTitle', () => {
    it('updates terminal title', () => {
      tracker.addTerminal('dock-1', 'term-1', 'Old Title', 'sess-1', '/project')
      vi.advanceTimersByTime(600)
      vi.mocked(fs.writeFileSync).mockClear()

      tracker.setTerminalTitle('dock-1', 'term-1', 'New Title')
      vi.advanceTimersByTime(600)

      const state = getLastSavedState()
      expect(state).not.toBeNull()
      expect(state.docks['dock-1'].terminals[0].title).toBe('New Title')
    })

    it('ignores unknown dock/terminal', () => {
      tracker.setTerminalTitle('unknown', 'term-1', 'Title')
    })
  })

  describe('setTerminalAlive', () => {
    it('updates alive status', () => {
      tracker.addTerminal('dock-1', 'term-1', 'T1', 'sess-1', '/project')
      vi.advanceTimersByTime(600)
      vi.mocked(fs.writeFileSync).mockClear()

      tracker.setTerminalAlive('dock-1', 'term-1', false)
      vi.advanceTimersByTime(600)

      const state = getLastSavedState()
      expect(state).not.toBeNull()
      expect(state.docks['dock-1'].terminals[0].isAlive).toBe(false)
    })
  })

  describe('removeTerminal', () => {
    it('removes a terminal and its buffers', () => {
      tracker.addTerminal('dock-1', 'term-1', 'T1', 'sess-1', '/project')
      tracker.addTerminal('dock-1', 'term-2', 'T2', 'sess-2', '/project')
      vi.advanceTimersByTime(600)
      vi.mocked(fs.writeFileSync).mockClear()

      tracker.removeTerminal('dock-1', 'term-1')
      vi.advanceTimersByTime(600)

      const state = getLastSavedState()
      expect(state).not.toBeNull()
      const terminals = state.docks['dock-1'].terminals
      expect(terminals.length).toBe(1)
      expect(terminals[0].id).toBe('term-2')
    })
  })

  describe('removeDock', () => {
    it('removes a dock and all its terminals', () => {
      tracker.addTerminal('dock-1', 'term-1', 'T1', 'sess-1', '/project')
      tracker.addTerminal('dock-1', 'term-2', 'T2', 'sess-2', '/project')
      vi.advanceTimersByTime(600)
      vi.mocked(fs.writeFileSync).mockClear()

      tracker.removeDock('dock-1')
      vi.advanceTimersByTime(600)

      const state = getLastSavedState()
      expect(state).not.toBeNull()
      expect(state.docks['dock-1']).toBeUndefined()
    })
  })

  describe('shutdown', () => {
    it('saves final state and clears everything', () => {
      tracker.addTerminal('dock-1', 'term-1', 'T1', 'sess-1', '/project')
      tracker.shutdown()

      const newTracker = ActivityTracker.getInstance()
      expect(newTracker).not.toBe(tracker)
    })

    it('clears pending flush timer', () => {
      tracker.addTerminal('dock-1', 'term-1', 'T1', 'sess-1', '/project')
      tracker.trackData('dock-1', 'term-1', 'data\n')
      tracker.shutdown()
    })
  })

  describe('flush scheduling', () => {
    it('batches saves with 500ms delay', () => {
      tracker.addTerminal('dock-1', 'term-1', 'T1', 'sess-1', '/project')
      // Flush the addTerminal save
      vi.advanceTimersByTime(600)
      vi.mocked(fs.writeFileSync).mockClear()

      tracker.trackData('dock-1', 'term-1', 'data1\n')
      tracker.trackData('dock-1', 'term-1', 'data2\n')
      tracker.trackData('dock-1', 'term-1', 'data3\n')

      // Not flushed yet (only 100ms)
      vi.advanceTimersByTime(100)
      const callsAt100 = vi.mocked(fs.writeFileSync).mock.calls.length
      expect(callsAt100).toBe(0)

      // Flush at 500ms
      vi.advanceTimersByTime(500)
      const callsAt600 = vi.mocked(fs.writeFileSync).mock.calls.length
      expect(callsAt600).toBe(1)
    })
  })
})
