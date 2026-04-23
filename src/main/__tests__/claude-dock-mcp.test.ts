/**
 * MCP-server smoke test — spawns `resources/claude-dock-mcp.cjs`, drives the
 * stdio JSON-RPC handshake, and verifies that the `tools/list` response has
 * expected shape in both the default (full-description) and compact modes.
 *
 * The compact mode is gated on `DOCK_MCP_COMPACT=1` and is used by the
 * Coordinator plugin's SDK-backed Claude Code subprocess so all 11 tools fit
 * under Claude Code's per-server tool-loading budget. Without compact mode the
 * subprocess defers the trailing tools (dock_list_terminals, dock_spawn/prompt/
 * close_terminal, dock_notify_worktree) and the Coordinator can't orchestrate.
 */

import { describe, it, expect } from 'vitest'
import { spawn } from 'child_process'
import * as path from 'path'

const MCP_PATH = path.resolve(__dirname, '../../../resources/claude-dock-mcp.cjs')

interface ToolsListResponse {
  tools: Array<{
    name: string
    description: string
    inputSchema: {
      type: string
      properties?: Record<string, { type: unknown; enum?: unknown[] }>
      required?: string[]
    }
  }>
}

interface ToolCallResponse {
  content?: Array<{ type: string; text: string }>
  isError?: boolean
}

async function callTool(
  toolName: string,
  args: Record<string, unknown>,
  env: Record<string, string>
): Promise<ToolCallResponse> {
  const child = spawn('node', [MCP_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env }
  })

  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {} } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: toolName, arguments: args } }
  ]
  for (const r of requests) child.stdin.write(JSON.stringify(r) + '\n')

  let buffer = ''
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error('MCP timed out'))
    }, 5000)
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const t = line.trim()
        if (!t.startsWith('{')) continue
        try {
          const msg = JSON.parse(t)
          if (msg.id === 2 && msg.result) {
            clearTimeout(timeout)
            child.kill()
            resolve(msg.result as ToolCallResponse)
            return
          }
        } catch {
          /* keep draining */
        }
      }
    })
    child.on('error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })
  })
}

async function queryToolsList(env: Record<string, string>): Promise<ToolsListResponse> {
  const child = spawn('node', [MCP_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env }
  })

  const requests = [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {} }
    },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' }
  ]
  for (const r of requests) child.stdin.write(JSON.stringify(r) + '\n')

  let buffer = ''
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error('MCP timed out'))
    }, 5000)
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const t = line.trim()
        if (!t.startsWith('{')) continue
        try {
          const msg = JSON.parse(t)
          if (msg.id === 2 && msg.result && Array.isArray(msg.result.tools)) {
            clearTimeout(timeout)
            child.kill()
            resolve(msg.result as ToolsListResponse)
            return
          }
        } catch {
          /* keep draining */
        }
      }
    })
    child.on('error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })
  })
}

describe('claude-dock-mcp tools/list', () => {
  it('returns all 11 core tools in full mode (default env)', async () => {
    const res = await queryToolsList({})
    const names = res.tools.map((t) => t.name).sort()
    expect(names).toEqual(
      [
        'dock_check_shell_events',
        'dock_clear_shell',
        'dock_close_terminal',
        'dock_list_shells',
        'dock_list_terminals',
        'dock_notify_worktree',
        'dock_prompt_terminal',
        'dock_read_shell',
        'dock_run_in_shell',
        'dock_spawn_terminal',
        'dock_status'
      ].sort()
    )
  }, 10000)

  it('returns the same 11 tools in compact mode with shorter descriptions', async () => {
    const [full, compact] = await Promise.all([
      queryToolsList({}),
      queryToolsList({ DOCK_MCP_COMPACT: '1' })
    ])
    const fullNames = full.tools.map((t) => t.name).sort()
    const compactNames = compact.tools.map((t) => t.name).sort()
    expect(compactNames).toEqual(fullNames)

    // Compact payload must be meaningfully smaller than full, or the fix is
    // pointless — the whole reason this mode exists is to squeeze under
    // Claude Code's per-server tool-loading budget.
    const fullSize = JSON.stringify(full.tools).length
    const compactSize = JSON.stringify(compact.tools).length
    expect(compactSize).toBeLessThan(fullSize * 0.7)
  }, 10000)

  it('pre-binds the session id from DOCK_MCP_BOUND_SESSION_ID so first dock_* call succeeds without prior dock_status', async () => {
    // The Coordinator's SDK passthrough backend has no way to discover its
    // own session_id, so it pre-binds via env var and instructs the LLM to
    // pass that same id. Without pre-binding, the very first dock_* call
    // (e.g. dock_spawn_terminal) fails with "Missing required parameter:
    // session_id" because the server's "first call binds" flow never gets
    // to run before validateSessionBinding rejects it.
    const result = await callTool(
      'dock_spawn_terminal',
      { session_id: 'coord-bound-test', project_dir: 'C:/tmp/dock-test-proj' },
      { DOCK_MCP_BOUND_SESSION_ID: 'coord-bound-test' }
    )
    const text = result.content?.[0]?.text ?? ''
    // We don't care that the spawn succeeds — there's no live dock — only
    // that the session check passes. The success path produces a "Spawn
    // requested" message; the failure path we're guarding against produces
    // "Missing required parameter: session_id" or a binding-mismatch error.
    expect(text).not.toMatch(/Missing required parameter: session_id/)
    expect(text).not.toMatch(/Session mismatch/)
  }, 10000)

  it('rejects calls with a different session_id when pre-bound', async () => {
    // The pre-bind lock must hold against unrelated sessions just like the
    // normal first-call lock — otherwise the env var would silently weaken
    // the cross-session shell-isolation guarantee.
    const result = await callTool(
      'dock_spawn_terminal',
      { session_id: 'someone-else', project_dir: 'C:/tmp/dock-test-proj' },
      { DOCK_MCP_BOUND_SESSION_ID: 'coord-bound-test' }
    )
    const text = result.content?.[0]?.text ?? ''
    expect(text).toMatch(/Session mismatch/)
  }, 10000)

  it('preserves required fields and enum values between full and compact', async () => {
    const [full, compact] = await Promise.all([
      queryToolsList({}),
      queryToolsList({ DOCK_MCP_COMPACT: '1' })
    ])
    const byName = new Map(full.tools.map((t) => [t.name, t]))
    for (const c of compact.tools) {
      const f = byName.get(c.name)
      expect(f, `full mode missing ${c.name}`).toBeDefined()
      if (!f) continue
      // Required params must match — a compact-mode divergence would silently
      // break callers that omit newly-required fields, or waste tokens on
      // fields the server no longer demands.
      expect(c.inputSchema.required?.slice().sort() ?? []).toEqual(
        f.inputSchema.required?.slice().sort() ?? []
      )
      // Property names must match so the two modes accept the same call shapes.
      expect(Object.keys(c.inputSchema.properties ?? {}).sort()).toEqual(
        Object.keys(f.inputSchema.properties ?? {}).sort()
      )
      // Any enum-constrained params must share identical enums (e.g. shell
      // type, shell_layout) — these are validated client-side.
      for (const pname of Object.keys(f.inputSchema.properties ?? {})) {
        const fEnum = f.inputSchema.properties?.[pname]?.enum
        const cEnum = c.inputSchema.properties?.[pname]?.enum
        if (fEnum) expect(cEnum).toEqual(fEnum)
        else expect(cEnum).toBeUndefined()
      }
    }
  }, 10000)
})
