/**
 * Thread 1 spike: drive the dock MCP through the Claude Agent SDK.
 *
 * What this proves / disproves:
 *   - SDK runs in-process from Node on Windows without the `claude` CLI on PATH
 *   - Our resources/claude-dock-mcp.cjs connects as an mcpServer and shows
 *     status='connected' in the init event
 *   - Auto-approval via allowedTools lets the hidden Claude call dock_status
 *   - A dock_status call actually reaches the dock main process (visible by
 *     timestamp update on %APPDATA%/claude-dock/dock-link/dock-activity.json)
 *   - Every SDK event type shape we actually see — raw JSON goes to events.log
 *
 * Preconditions:
 *   - The dock app is running with the repo root C:/Projects/claude/plugins/dock
 *     open as a project (needed for dock_status to return a real response; the
 *     MCP will connect either way, but the tool call requires the dock side).
 *   - User already logged in to Claude Code (subscription auth).
 */
import { query } from '@anthropic-ai/claude-agent-sdk'
import * as fs from 'node:fs'
import * as path from 'node:path'

const REPO_ROOT = 'C:/Projects/claude/plugins/dock'
const MCP_PATH = path.join(REPO_ROOT, 'resources', 'claude-dock-mcp.cjs')
const DOCK_DATA_DIR = path.join(process.env.APPDATA ?? '', 'claude-dock', 'dock-link')
const SPIKE_SESSION_ID = `coordinator-spike-${Date.now()}`

const EVENTS_LOG = path.join(import.meta.dirname, 'events.log')
fs.writeFileSync(EVENTS_LOG, '')

function log(line) {
  process.stdout.write(line + '\n')
  fs.appendFileSync(EVENTS_LOG, line + '\n')
}

log(`[spike] MCP script: ${MCP_PATH} (exists=${fs.existsSync(MCP_PATH)})`)
log(`[spike] DOCK_DATA_DIR: ${DOCK_DATA_DIR} (exists=${fs.existsSync(DOCK_DATA_DIR)})`)
log(`[spike] Spike session id: ${SPIKE_SESSION_ID}`)

const prompt = [
  `Call the dock_status MCP tool with these exact arguments:`,
  `  project_dir: "${REPO_ROOT}"`,
  `  session_id: "${SPIKE_SESSION_ID}"`,
  ``,
  `After the tool returns, reply with just the word DONE and nothing else.`
].join('\n')

log(`[spike] starting query...`)

const q = query({
  prompt,
  options: {
    mcpServers: {
      'claude-dock-uat': {
        type: 'stdio',
        command: 'node',
        args: [MCP_PATH],
        env: {
          DOCK_DATA_DIR,
          // the mcp reads these; pass through if set on the host
          ...(process.env.DOCK_LOG_LEVEL ? { DOCK_LOG_LEVEL: process.env.DOCK_LOG_LEVEL } : {})
        }
      }
    },
    allowedTools: [
      'mcp__claude-dock-uat__dock_status'
    ],
    // Restrict built-in tools so we isolate the MCP path cleanly.
    tools: [],
    includePartialMessages: false, // keep output readable; flip on for Thread 3
    persistSession: false,
    permissionMode: 'default'
  }
})

let eventCount = 0
try {
  for await (const msg of q) {
    eventCount++
    const summary = summarise(msg)
    log(`\n--- event #${eventCount} ---`)
    log(summary)
    // full raw JSON to the log file only (stdout gets the summary)
    fs.appendFileSync(EVENTS_LOG, JSON.stringify(msg, null, 2) + '\n')
  }
} catch (err) {
  log(`\n[spike] ITERATION ERROR: ${err?.stack ?? err}`)
  process.exit(1)
}

log(`\n[spike] finished. ${eventCount} events total. Raw JSON in ${EVENTS_LOG}`)

function summarise(msg) {
  if (!msg || typeof msg !== 'object') return `<non-object: ${String(msg)}>`
  const m = msg
  const bits = [`type=${m.type}`]
  if (m.subtype) bits.push(`subtype=${m.subtype}`)
  if (m.session_id) bits.push(`session_id=${String(m.session_id).slice(0, 8)}...`)
  if (m.type === 'system' && m.subtype === 'init') {
    bits.push(`mcp_servers=${JSON.stringify(m.mcp_servers)}`)
    bits.push(`tools_count=${(m.tools ?? []).length}`)
    bits.push(`model=${m.model}`)
  }
  if (m.type === 'assistant' && m.message?.content) {
    const content = m.message.content
      .map((c) => {
        if (c.type === 'text') return `text(${JSON.stringify(c.text?.slice(0, 80))})`
        if (c.type === 'tool_use') return `tool_use(${c.name}, input=${JSON.stringify(c.input)})`
        return c.type
      })
      .join(', ')
    bits.push(`content=[${content}]`)
  }
  if (m.type === 'user' && m.message?.content) {
    const content = Array.isArray(m.message.content)
      ? m.message.content.map((c) => (c.type === 'tool_result' ? `tool_result(ok=${!c.is_error})` : c.type)).join(', ')
      : typeof m.message.content === 'string'
      ? `string(${JSON.stringify(m.message.content.slice(0, 80))})`
      : 'unknown'
    bits.push(`content=[${content}]`)
  }
  if (m.type === 'result') {
    bits.push(`stop_reason=${m.stop_reason}`)
    bits.push(`is_error=${m.is_error}`)
    if (m.usage) bits.push(`usage=${JSON.stringify(m.usage)}`)
  }
  return bits.join(' ')
}
