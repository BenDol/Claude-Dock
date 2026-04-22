import { describe, it, expect, vi, beforeEach } from 'vitest'

// Expose the most recently constructed mock store so tests can seed
// legacy-shape entries and assert the read-time migration.
const mockStoreRef: { current: any } = { current: null }

vi.mock('electron-store', () => {
  function MockStore(this: any, opts?: any) {
    this.path = '/mock/coordinator-chat.json'
    this.store = opts?.defaults ? { ...opts.defaults } : {}
    this.get = vi.fn((key: string) => this.store[key])
    this.set = vi.fn((keyOrObj: any, value?: any) => {
      if (typeof keyOrObj === 'object') this.store = { ...this.store, ...keyOrObj }
      else this.store[keyOrObj] = value
    })
    this.delete = vi.fn((key: string) => { delete this.store[key] })
    this.has = vi.fn((k: string) => k in this.store)
    this.clear = vi.fn(() => { this.store = {} })
    mockStoreRef.current = this
  }
  return { default: MockStore }
})

vi.mock('../../../logger', () => ({
  log: vi.fn(),
  logError: vi.fn()
}))

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
  renameSync: vi.fn()
}))

import {
  getHistory,
  appendMessage,
  upsertMessage,
  clearHistory,
  getLatestSessionId,
  setLatestSessionId,
  clearLatestSessionId,
  __resetChatStoreForTests
} from '../coordinator-chat-store'
import type { CoordinatorMessage } from '../../../../shared/coordinator-types'

function userMsg(id: string, content = 'hi'): CoordinatorMessage {
  return { id, role: 'user', content, timestamp: Date.now() }
}

function assistantMsg(id: string, content: string, streaming = false): CoordinatorMessage {
  return { id, role: 'assistant', content, timestamp: Date.now(), streaming }
}

const PROJECT_A = 'C:\\Projects\\alpha'
const PROJECT_B = 'C:\\Projects\\beta'

describe('coordinator-chat-store', () => {
  beforeEach(() => {
    __resetChatStoreForTests()
  })

  it('returns an empty array for a project with no history', () => {
    expect(getHistory(PROJECT_A)).toEqual([])
  })

  it('appends messages and preserves insertion order', () => {
    appendMessage(PROJECT_A, userMsg('1', 'first'), 100)
    appendMessage(PROJECT_A, assistantMsg('2', 'second'), 100)
    const hist = getHistory(PROJECT_A)
    expect(hist).toHaveLength(2)
    expect(hist[0].id).toBe('1')
    expect(hist[1].id).toBe('2')
  })

  it('keeps project histories isolated', () => {
    appendMessage(PROJECT_A, userMsg('a1'), 100)
    appendMessage(PROJECT_B, userMsg('b1'), 100)
    expect(getHistory(PROJECT_A).map((m) => m.id)).toEqual(['a1'])
    expect(getHistory(PROJECT_B).map((m) => m.id)).toEqual(['b1'])
  })

  it('treats project paths as case-insensitive (normalized)', () => {
    appendMessage('C:\\Projects\\SameProj', userMsg('1'), 100)
    const lookup = getHistory('c:/projects/sameproj')
    expect(lookup.map((m) => m.id)).toEqual(['1'])
  })

  it('caps history at maxMessages by dropping the oldest entries', () => {
    for (let i = 0; i < 12; i++) appendMessage(PROJECT_A, userMsg(String(i)), 10)
    const hist = getHistory(PROJECT_A)
    expect(hist).toHaveLength(10)
    // Oldest two (0, 1) must have been dropped.
    expect(hist[0].id).toBe('2')
    expect(hist[9].id).toBe('11')
  })

  it('upsertMessage replaces an existing message by id', () => {
    appendMessage(PROJECT_A, userMsg('u1'), 100)
    appendMessage(PROJECT_A, assistantMsg('a1', 'partial', true), 100)
    upsertMessage(PROJECT_A, assistantMsg('a1', 'final text', false), 100)
    const hist = getHistory(PROJECT_A)
    expect(hist).toHaveLength(2)
    const a1 = hist.find((m) => m.id === 'a1')!
    expect(a1.role).toBe('assistant')
    if (a1.role === 'assistant') {
      expect(a1.content).toBe('final text')
      expect(a1.streaming).toBe(false)
    }
  })

  it('upsertMessage appends when the id is new', () => {
    appendMessage(PROJECT_A, userMsg('u1'), 100)
    upsertMessage(PROJECT_A, assistantMsg('a1', 'hello'), 100)
    const hist = getHistory(PROJECT_A)
    expect(hist.map((m) => m.id)).toEqual(['u1', 'a1'])
  })

  it('upsertMessage honors the max-messages cap', () => {
    for (let i = 0; i < 8; i++) appendMessage(PROJECT_A, userMsg(String(i)), 10)
    // Upsert two new messages that push over the cap.
    upsertMessage(PROJECT_A, assistantMsg('new1', 'x'), 10)
    upsertMessage(PROJECT_A, assistantMsg('new2', 'y'), 10)
    const hist = getHistory(PROJECT_A)
    expect(hist).toHaveLength(10)
    // The oldest originals (0, 1, ...) should be dropped to make room.
    expect(hist[hist.length - 1].id).toBe('new2')
    expect(hist[hist.length - 2].id).toBe('new1')
  })

  it('clearHistory drops only the targeted project', () => {
    appendMessage(PROJECT_A, userMsg('a1'), 100)
    appendMessage(PROJECT_B, userMsg('b1'), 100)
    clearHistory(PROJECT_A)
    expect(getHistory(PROJECT_A)).toEqual([])
    expect(getHistory(PROJECT_B).map((m) => m.id)).toEqual(['b1'])
  })

  it('latestSessionId starts null, persists, and clears independently', () => {
    expect(getLatestSessionId(PROJECT_A)).toBeNull()
    setLatestSessionId(PROJECT_A, 'sess-1')
    expect(getLatestSessionId(PROJECT_A)).toBe('sess-1')
    // Appending messages must not disturb the session id.
    appendMessage(PROJECT_A, userMsg('u1'), 100)
    expect(getLatestSessionId(PROJECT_A)).toBe('sess-1')
    clearLatestSessionId(PROJECT_A)
    expect(getLatestSessionId(PROJECT_A)).toBeNull()
    // Messages remain after clearing session id.
    expect(getHistory(PROJECT_A).map((m) => m.id)).toEqual(['u1'])
  })

  it('setLatestSessionId overwrites previous id (chain-forward)', () => {
    setLatestSessionId(PROJECT_A, 'first')
    setLatestSessionId(PROJECT_A, 'second')
    expect(getLatestSessionId(PROJECT_A)).toBe('second')
  })

  it('session ids are per-project', () => {
    setLatestSessionId(PROJECT_A, 'a-sess')
    setLatestSessionId(PROJECT_B, 'b-sess')
    expect(getLatestSessionId(PROJECT_A)).toBe('a-sess')
    expect(getLatestSessionId(PROJECT_B)).toBe('b-sess')
  })

  it('clearHistory also drops the session id for that project', () => {
    setLatestSessionId(PROJECT_A, 'sess-x')
    appendMessage(PROJECT_A, userMsg('u1'), 100)
    clearHistory(PROJECT_A)
    expect(getLatestSessionId(PROJECT_A)).toBeNull()
    expect(getHistory(PROJECT_A)).toEqual([])
  })

  it('migrates legacy array-shaped entries on read', () => {
    // Force the real store instance to materialise, then inject a legacy
    // entry (bare CoordinatorMessage[]) directly into its backing map.
    appendMessage(PROJECT_A, userMsg('warmup'), 100)
    clearHistory(PROJECT_A)

    // Compute the project key the same way the module does — sha1 of the
    // lowercased, forward-slash-normalized project dir, first 16 chars.
    // We don't import the internal projectKey helper; instead we rely on
    // the fact that writing via the internal key `project-a-legacy` and
    // reading through PROJECT_A_LEGACY_DIR exercises the same path.
    // For this test we use the mock store's backing map and seed a known
    // key directly, then read via the public API using the matching dir.
    const legacyMessages: CoordinatorMessage[] = [
      userMsg('legacy-1', 'pre-migration'),
      assistantMsg('legacy-2', 'also pre-migration')
    ]
    // Seed under PROJECT_A's key by writing through the API first, then
    // overwriting with the legacy shape. The module re-reads per call.
    appendMessage(PROJECT_A, userMsg('placeholder'), 100)
    const storedKeys = Object.keys(mockStoreRef.current.store)
    expect(storedKeys.length).toBeGreaterThan(0)
    // The most recently written key is PROJECT_A's hash.
    const aKey = storedKeys[storedKeys.length - 1]
    // Overwrite with legacy shape (bare array, no wrapping object).
    mockStoreRef.current.store[aKey] = legacyMessages

    // Read back — migration wraps the array and preserves it.
    expect(getHistory(PROJECT_A).map((m) => m.id)).toEqual(['legacy-1', 'legacy-2'])
    expect(getLatestSessionId(PROJECT_A)).toBeNull()
  })
})
