import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'

const tmpHome = path.join(os.tmpdir(), 'voice-mcp-test-' + Date.now() + '-' + Math.random().toString(36).slice(2))

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof os>('os')
  return { ...actual, homedir: () => tmpHome }
})

vi.mock('../services', () => ({
  getServices: () => ({
    log: vi.fn(),
    logError: vi.fn()
  })
}))

import {
  getClaudeJsonPath,
  getMcpStatus,
  ensureMcpEntry,
  removeMcpEntry,
  resolveConflict,
  VOICE_MCP_KEY
} from '../voice-mcp-register'

const PY = '/fake/venv/bin/python'
const SERVER = '/fake/voice/python/server.py'
const CFG = '/fake/userData/voice/config.json'

function writeJson(data: unknown): void {
  fs.mkdirSync(tmpHome, { recursive: true })
  fs.writeFileSync(getClaudeJsonPath(), JSON.stringify(data, null, 2), 'utf8')
}

function readJson(): any {
  return JSON.parse(fs.readFileSync(getClaudeJsonPath(), 'utf8'))
}

describe('voice-mcp-register', () => {
  beforeEach(() => {
    try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch { /* noop */ }
  })

  it('reports unregistered when ~/.claude.json is missing', () => {
    const status = getMcpStatus(PY, SERVER)
    expect(status.registered).toBe(false)
    expect(status.conflictsWithExisting).toBe(false)
  })

  it('writes a new entry without touching sibling MCP servers', () => {
    writeJson({
      otherKey: 'preserved',
      mcpServers: {
        foo: { command: 'foo-cmd', args: ['arg'] }
      }
    })

    const { key } = ensureMcpEntry(PY, SERVER, CFG)
    expect(key).toBe(VOICE_MCP_KEY)

    const data = readJson()
    expect(data.otherKey).toBe('preserved')
    expect(data.mcpServers.foo.command).toBe('foo-cmd')
    expect(data.mcpServers[VOICE_MCP_KEY]).toEqual({
      command: PY,
      args: [SERVER, '--managed', '--config', CFG],
      type: 'stdio'
    })
  })

  it('detects a conflicting existing entry pointing elsewhere', () => {
    writeJson({
      mcpServers: {
        [VOICE_MCP_KEY]: {
          command: '/other/python',
          args: ['/other/voice-input/server.py']
        }
      }
    })
    const status = getMcpStatus(PY, SERVER)
    expect(status.registered).toBe(true)
    expect(status.conflictsWithExisting).toBe(true)
    expect(status.existingPath).toBe('/other/voice-input/server.py')
  })

  it('treats an existing matching entry as non-conflicting', () => {
    writeJson({
      mcpServers: {
        [VOICE_MCP_KEY]: {
          command: PY,
          args: [SERVER, '--managed', '--config', CFG],
          type: 'stdio'
        }
      }
    })
    const status = getMcpStatus(PY, SERVER)
    expect(status.registered).toBe(true)
    expect(status.conflictsWithExisting).toBe(false)
  })

  it('refuses to overwrite a conflicting entry without force', () => {
    writeJson({
      mcpServers: {
        [VOICE_MCP_KEY]: {
          command: '/other/python',
          args: ['/other/voice-input/server.py']
        }
      }
    })
    expect(() => ensureMcpEntry(PY, SERVER, CFG)).toThrow(/conflict/i)
  })

  it('resolveConflict("overwrite") replaces the existing entry', () => {
    writeJson({
      mcpServers: {
        [VOICE_MCP_KEY]: {
          command: '/other/python',
          args: ['/other/voice-input/server.py']
        }
      }
    })
    const res = resolveConflict('overwrite', PY, SERVER, CFG)
    expect(res).toEqual({ key: VOICE_MCP_KEY })
    const data = readJson()
    expect(data.mcpServers[VOICE_MCP_KEY].command).toBe(PY)
  })

  it('resolveConflict("rename") writes under a new unique key', () => {
    writeJson({
      mcpServers: {
        [VOICE_MCP_KEY]: { command: '/other/python', args: ['/other/server.py'] }
      }
    })
    const res = resolveConflict('rename', PY, SERVER, CFG)
    expect(res?.key).toBe('voice-input-dock')
    const data = readJson()
    expect(data.mcpServers['voice-input-dock'].command).toBe(PY)
    // Original entry is preserved untouched
    expect(data.mcpServers[VOICE_MCP_KEY].command).toBe('/other/python')
  })

  it('resolveConflict("rename") increments when the fallback is taken', () => {
    writeJson({
      mcpServers: {
        [VOICE_MCP_KEY]: { command: '/other/python', args: ['/other/server.py'] },
        'voice-input-dock': { command: 'taken', args: [] }
      }
    })
    const res = resolveConflict('rename', PY, SERVER, CFG)
    expect(res?.key).toBe('voice-input-dock-2')
  })

  it('resolveConflict("cancel") returns null and does not mutate the file', () => {
    writeJson({
      mcpServers: {
        [VOICE_MCP_KEY]: { command: '/other/python', args: ['/other/server.py'] }
      }
    })
    const before = readJson()
    const res = resolveConflict('cancel', PY, SERVER, CFG)
    expect(res).toBeNull()
    expect(readJson()).toEqual(before)
  })

  it('removeMcpEntry deletes only the voice entry, preserving siblings', () => {
    writeJson({
      mcpServers: {
        [VOICE_MCP_KEY]: { command: PY, args: [SERVER] },
        sibling: { command: 'sib' }
      }
    })
    removeMcpEntry()
    const data = readJson()
    expect(data.mcpServers[VOICE_MCP_KEY]).toBeUndefined()
    expect(data.mcpServers.sibling).toEqual({ command: 'sib' })
  })

  it('removeMcpEntry is a no-op when the entry is missing', () => {
    writeJson({ mcpServers: { other: { command: 'x' } } })
    expect(() => removeMcpEntry()).not.toThrow()
    const data = readJson()
    expect(data.mcpServers.other).toEqual({ command: 'x' })
  })

  it('refuses to read malformed ~/.claude.json', () => {
    fs.mkdirSync(tmpHome, { recursive: true })
    fs.writeFileSync(getClaudeJsonPath(), '{not json', 'utf8')
    expect(() => ensureMcpEntry(PY, SERVER, CFG)).toThrow(/not valid JSON/i)
  })

  it('ensureMcpEntry force-writes even over a conflict', () => {
    writeJson({
      mcpServers: {
        [VOICE_MCP_KEY]: {
          command: '/other/python',
          args: ['/other/voice-input/server.py']
        }
      }
    })
    const res = ensureMcpEntry(PY, SERVER, CFG, { force: true })
    expect(res.key).toBe(VOICE_MCP_KEY)
    expect(readJson().mcpServers[VOICE_MCP_KEY].command).toBe(PY)
  })
})
