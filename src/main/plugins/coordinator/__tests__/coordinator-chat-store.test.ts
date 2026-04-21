import { describe, it, expect, vi, beforeEach } from 'vitest'

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
})
