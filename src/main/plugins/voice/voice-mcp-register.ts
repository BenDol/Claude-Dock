/**
 * Registers / deregisters the Voice MCP server in ~/.claude.json (user scope).
 *
 * We never rewrite the entire file — we read, mutate only the `voice-input`
 * entry inside `mcpServers`, and write atomically via a tmp file + rename
 * so a concurrent Claude CLI process never sees a half-written file.
 */

import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { getServices } from './services'
import type { VoiceMcpStatus } from '../../../shared/voice-types'

const svc = () => getServices()

const MCP_KEY = 'voice-input'

export function getClaudeJsonPath(): string {
  return path.join(os.homedir(), '.claude.json')
}

interface McpEntry {
  command: string
  args?: string[]
  env?: Record<string, string>
  type?: string
}

interface ClaudeJson {
  mcpServers?: Record<string, McpEntry>
  [key: string]: unknown
}

function readClaudeJson(): ClaudeJson {
  const p = getClaudeJsonPath()
  if (!fs.existsSync(p)) return {}
  try {
    const raw = fs.readFileSync(p, 'utf8')
    return JSON.parse(raw) as ClaudeJson
  } catch (err) {
    svc().logError(`[voice-mcp] failed to parse ${p}`, err)
    throw new Error(`~/.claude.json is not valid JSON: ${String(err)}`)
  }
}

function writeClaudeJsonAtomic(data: ClaudeJson): void {
  const p = getClaudeJsonPath()
  // Unique tmp name so concurrent writers (two Dock processes, or another tool)
  // do not stomp each other's partial file.
  const tmp = `${p}.voice.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    const body = JSON.stringify(data, null, 2)
    fs.writeFileSync(tmp, body, 'utf8')
    fs.renameSync(tmp, p)
  } catch (err) {
    svc().logError(`[voice-mcp] atomic write to ${p} failed`, err)
    try { fs.unlinkSync(tmp) } catch { /* ignore */ }
    throw err
  }
}

function buildEntry(pythonPath: string, serverScript: string, configPath: string): McpEntry {
  return {
    command: pythonPath,
    args: [serverScript, '--managed', '--config', configPath],
    type: 'stdio'
  }
}

/**
 * Insert or update our entry. Detects a pre-existing entry at a different
 * path (e.g. from the standalone voice-input plugin) so the UI can offer
 * overwrite/rename/cancel.
 */
export function getMcpStatus(
  pythonPath: string,
  serverScript: string
): VoiceMcpStatus {
  const data = readClaudeJson()
  const existing = data.mcpServers?.[MCP_KEY]
  const configPath = getClaudeJsonPath()

  if (!existing) {
    return {
      registered: false,
      entry: null,
      configPath,
      conflictsWithExisting: false
    }
  }

  const existingScript = Array.isArray(existing.args) ? existing.args[0] : undefined
  const existingCommand = existing.command
  const matches = existingCommand === pythonPath && existingScript === serverScript

  return {
    registered: true,
    entry: { command: existing.command, args: existing.args },
    configPath,
    conflictsWithExisting: !matches,
    existingPath: existingScript
  }
}

export function ensureMcpEntry(
  pythonPath: string,
  serverScript: string,
  configPath: string,
  opts: { key?: string; force?: boolean } = {}
): { key: string } {
  const key = opts.key ?? MCP_KEY
  const data = readClaudeJson()
  data.mcpServers = data.mcpServers ?? {}

  const existing = data.mcpServers[key]
  if (existing && !opts.force) {
    const existingScript = Array.isArray(existing.args) ? existing.args[0] : undefined
    const matches = existing.command === pythonPath && existingScript === serverScript
    if (!matches) {
      throw new Error(
        `MCP entry "${key}" already exists with different paths — resolve conflict first`
      )
    }
  }

  data.mcpServers[key] = buildEntry(pythonPath, serverScript, configPath)
  writeClaudeJsonAtomic(data)
  svc().log(`[voice-mcp] wrote entry "${key}" -> ${serverScript}`)
  return { key }
}

export function removeMcpEntry(key: string = MCP_KEY): void {
  const data = readClaudeJson()
  if (!data.mcpServers || !(key in data.mcpServers)) {
    svc().log(`[voice-mcp] no entry "${key}" to remove`)
    return
  }
  delete data.mcpServers[key]
  writeClaudeJsonAtomic(data)
  svc().log(`[voice-mcp] removed entry "${key}"`)
}

export function resolveConflict(
  action: 'overwrite' | 'rename' | 'cancel',
  pythonPath: string,
  serverScript: string,
  configPath: string
): { key: string } | null {
  if (action === 'cancel') return null
  if (action === 'overwrite') {
    return ensureMcpEntry(pythonPath, serverScript, configPath, { force: true })
  }
  // rename: pick a unique fallback key
  const data = readClaudeJson()
  data.mcpServers = data.mcpServers ?? {}
  let i = 1
  let key = 'voice-input-dock'
  while (data.mcpServers[key]) {
    key = `voice-input-dock-${++i}`
  }
  return ensureMcpEntry(pythonPath, serverScript, configPath, { key })
}

export const VOICE_MCP_KEY = MCP_KEY
