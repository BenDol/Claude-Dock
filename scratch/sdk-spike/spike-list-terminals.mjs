/**
 * Thread 2 (partial) + Thread 4 spike:
 *   - Verifies the coordinator session, once bound via dock_status, can then
 *     call session-validated tools (dock_list_terminals) — this is the MCP-
 *     side trust check. End-to-end dock-side trust still needs the dock
 *     running; see spike-prompt-terminal.mjs for that.
 *   - Captures the session_id on turn 1, then runs turn 2 with resume to
 *     confirm conversation continuity works.
 */
import { query } from '@anthropic-ai/claude-agent-sdk'
import * as fs from 'node:fs'
import * as path from 'node:path'

const REPO_ROOT = 'C:/Projects/claude/plugins/dock'
const MCP_PATH = path.join(REPO_ROOT, 'resources', 'claude-dock-mcp.cjs')
const DOCK_DATA_DIR = path.join(process.env.APPDATA ?? '', 'claude-dock', 'dock-link')
const SPIKE_SESSION_ID = `coordinator-spike-${Date.now()}`

const EVENTS_LOG = path.join(import.meta.dirname, 'events-turn2.log')
fs.writeFileSync(EVENTS_LOG, '')

function log(line) {
  process.stdout.write(line + '\n')
  fs.appendFileSync(EVENTS_LOG, line + '\n')
}

const mcpServers = {
  'claude-dock-uat': {
    type: 'stdio',
    command: 'node',
    args: [MCP_PATH],
    env: { DOCK_DATA_DIR }
  }
}

const allowedTools = [
  'mcp__claude-dock-uat__dock_status',
  'mcp__claude-dock-uat__dock_list_terminals'
]

async function runTurn(prompt, resumeId) {
  log(`\n=========================================`)
  log(`[spike] TURN  prompt="${prompt.slice(0, 80)}..."`)
  log(`[spike] resume=${resumeId ?? '<none>'}`)
  log(`=========================================`)

  const q = query({
    prompt,
    options: {
      mcpServers,
      allowedTools,
      tools: [],
      resume: resumeId,
      persistSession: true, // required for resume to work
      permissionMode: 'default'
    }
  })

  let capturedSessionId = null
  let eventCount = 0
  for await (const msg of q) {
    eventCount++
    if (msg.session_id && !capturedSessionId) capturedSessionId = msg.session_id

    const summary = summarise(msg)
    log(`#${eventCount}  ${summary}`)
    fs.appendFileSync(EVENTS_LOG, JSON.stringify(msg, null, 2) + '\n')
  }
  log(`[spike] turn complete, ${eventCount} events, session_id=${capturedSessionId}`)
  return capturedSessionId
}

const turn1Prompt = [
  `Call dock_status with:`,
  `  project_dir: "${REPO_ROOT}"`,
  `  session_id: "${SPIKE_SESSION_ID}"`,
  `Then call dock_list_terminals with:`,
  `  project_dir: "${REPO_ROOT}"`,
  `  session_id: "${SPIKE_SESSION_ID}"`,
  `Reply with a one-line summary of how many terminals you saw, then remember that count because I will ask about it next turn.`
].join('\n')

const turn1SessionId = await runTurn(turn1Prompt)

if (!turn1SessionId) {
  log('[spike] FAIL: no session_id captured from turn 1')
  process.exit(1)
}

// Turn 2: resume the same session, ask about the remembered count.
const turn2Prompt = `What terminal count did you report at the end of last turn? Give me just the number, nothing else.`
const turn2SessionId = await runTurn(turn2Prompt, turn1SessionId)

log(`\n[spike] SUMMARY`)
log(`  turn1 session_id = ${turn1SessionId}`)
log(`  turn2 session_id = ${turn2SessionId}`)
log(`  resume worked: ${turn2SessionId != null ? 'yes (iterated events without error)' : 'no'}`)

function summarise(msg) {
  if (!msg || typeof msg !== 'object') return `<non-object>`
  const bits = [`type=${msg.type}`]
  if (msg.subtype) bits.push(`subtype=${msg.subtype}`)
  if (msg.type === 'system' && msg.subtype === 'init') {
    bits.push(`mcp=[${msg.mcp_servers.map((s) => s.name + ':' + s.status).join(',')}]`)
    bits.push(`tools=${msg.tools.length}`)
  }
  if (msg.type === 'assistant' && msg.message?.content) {
    const content = msg.message.content
      .map((c) => {
        if (c.type === 'text') return `text(${JSON.stringify((c.text ?? '').slice(0, 60))})`
        if (c.type === 'tool_use') return `tool_use(${c.name})`
        return c.type
      })
      .join(', ')
    bits.push(`content=[${content}]`)
  }
  if (msg.type === 'user' && Array.isArray(msg.message?.content)) {
    const c = msg.message.content.map((x) => (x.type === 'tool_result' ? `tool_result(ok=${!x.is_error})` : x.type)).join(',')
    bits.push(`content=[${c}]`)
  }
  if (msg.type === 'result') {
    bits.push(`stop=${msg.stop_reason}`)
    bits.push(`is_error=${msg.is_error}`)
  }
  return bits.join(' ')
}
