/**
 * Thread 2 end-to-end: send a prompt through a user's visible terminal
 * from a hidden Claude session (coordinator).
 *
 * Preconditions:
 *   - Dock app running with project C:/Projects/claude/plugins/dock open.
 *   - At least one idle Claude terminal spawned in that dock.
 *
 * What this proves (if it passes):
 *   The dock main process accepts a dock_prompt_terminal command from a
 *   session id that doesn't own the target terminal — i.e. the coordinator
 *   role is viable without dock-side changes. We see this pass/fail two
 *   ways: (a) tool_result is_error, (b) the visible terminal actually
 *   receives the prompt.
 *
 * Idle-terminal selection (interim; see Task #19):
 *   - Caller's own session is excluded (otherwise we'd drive ourselves).
 *   - Only alive terminals are considered.
 *   - Of those, we pick the one whose last non-empty recent line is `>`
 *     (Claude Code's "waiting for input" prompt). If multiple, we prefer
 *     the one with the OLDEST lastUpdate so we don't collide with a
 *     terminal that just finished.
 *   - An optional TARGET_TERMINAL_ID env var overrides the heuristic.
 */
import { query } from '@anthropic-ai/claude-agent-sdk'
import * as fs from 'node:fs'
import * as path from 'node:path'

const REPO_ROOT = 'C:/Projects/claude/plugins/dock'
const MCP_PATH = path.join(REPO_ROOT, 'resources', 'claude-dock-mcp.cjs')
// Dock writes dock-activity.json at %APPDATA%/claude-dock (not a dock-link subfolder).
const DOCK_DATA_DIR = path.join(process.env.APPDATA ?? '', 'claude-dock')
const SESSION = `coordinator-e2e-${Date.now()}`
const MY_SESSION_ID = process.env.CLAUDE_CODE_SESSION_ID ?? null

const EVENTS_LOG = path.join(import.meta.dirname, 'events-prompt-terminal.log')
fs.writeFileSync(EVENTS_LOG, '')
function log(line) {
  process.stdout.write(line + '\n')
  fs.appendFileSync(EVENTS_LOG, line + '\n')
}

// Pre-flight: inspect dock-activity.json and pick an idle terminal.
const activityPath = path.join(DOCK_DATA_DIR, 'dock-activity.json')
if (!fs.existsSync(activityPath)) {
  console.error(`[spike] FAIL precondition: ${activityPath} does not exist`)
  process.exit(2)
}
const activity = JSON.parse(fs.readFileSync(activityPath, 'utf8'))

// Find the dock whose projectDir matches REPO_ROOT (case-insensitive, slash-normalised).
function normaliseDir(p) {
  return (p ?? '').replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')
}
const wantKey = normaliseDir(REPO_ROOT)
let matchedDock = null
for (const [dockId, dock] of Object.entries(activity.docks ?? {})) {
  if (normaliseDir(dock.projectDir) === wantKey) {
    matchedDock = { dockId, ...dock }
    break
  }
}
if (!matchedDock) {
  console.error(`[spike] FAIL precondition: no dock has ${REPO_ROOT} open`)
  console.error(`  Seen docks:`, Object.values(activity.docks ?? {}).map((d) => d.projectDir))
  process.exit(2)
}
log(`[spike] matched ${matchedDock.dockId} for ${matchedDock.projectDir}`)

const terminals = Array.isArray(matchedDock.terminals) ? matchedDock.terminals : []
const aliveOthers = terminals.filter(
  (t) => t.isAlive && (!MY_SESSION_ID || t.sessionId !== MY_SESSION_ID)
)
log(`[spike] alive terminals (not me): ${aliveOthers.length}`)

function looksIdle(t) {
  // Find the last non-empty recent line and check for the `>` prompt.
  const lines = (t.recentLines ?? []).slice().reverse()
  for (const raw of lines) {
    const line = (raw ?? '').trim()
    if (!line) continue
    // A bare `>` means Claude Code is waiting for input. Also accept lines
    // that CONTAIN `>` followed only by whitespace (some variants).
    return line === '>' || /(^|\s)>\s*$/.test(line)
  }
  return false
}

let targetId = process.env.TARGET_TERMINAL_ID ?? null
if (!targetId) {
  const idle = aliveOthers.filter(looksIdle).sort((a, b) => (a.lastUpdate ?? 0) - (b.lastUpdate ?? 0))
  if (idle.length === 0) {
    console.error(`[spike] FAIL precondition: no idle terminals detected. Candidates:`)
    for (const t of aliveOthers) {
      const tail = (t.recentLines ?? []).slice(-3).map((s) => JSON.stringify(String(s).slice(0, 80))).join(' | ')
      console.error(`  ${t.id}  lastUpdate=${t.lastUpdate}  tail=${tail}`)
    }
    process.exit(2)
  }
  targetId = idle[0].id
  log(`[spike] idle candidates: ${idle.map((t) => t.id).join(', ')}`)
}
log(`[spike] TARGET terminal_id = ${targetId}`)

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
  'mcp__claude-dock-uat__dock_list_terminals',
  'mcp__claude-dock-uat__dock_prompt_terminal'
]

const marker = `hello-from-coordinator-${Date.now()}`
const prompt = [
  `You are a coordinator testing that you can drive the user's visible terminals.`,
  `Step 1: Call dock_status with project_dir="${REPO_ROOT}" and session_id="${SESSION}".`,
  `Step 2: Call dock_list_terminals with the same arguments (verify the target is listed).`,
  `Step 3: Call dock_prompt_terminal with project_dir="${REPO_ROOT}", session_id="${SESSION}",`,
  `        terminal_id="${targetId}", prompt="echo ${marker}".`,
  `Step 4: Reply with just the terminal id you targeted. No other text.`
].join('\n')

const q = query({
  prompt,
  options: {
    mcpServers,
    allowedTools,
    tools: [],
    persistSession: false
  }
})

let errored = false
let sawTargetInList = false
for await (const msg of q) {
  fs.appendFileSync(EVENTS_LOG, JSON.stringify(msg) + '\n')
  if (msg.type === 'assistant') {
    for (const c of msg.message?.content ?? []) {
      if (c.type === 'tool_use') log(`TOOL_USE ${c.name} input=${JSON.stringify(c.input)}`)
      if (c.type === 'text') log(`TEXT ${c.text}`)
    }
  }
  if (msg.type === 'user') {
    const content = Array.isArray(msg.message?.content) ? msg.message.content : []
    for (const c of content) {
      if (c.type === 'tool_result') {
        const ok = !c.is_error
        const body = typeof c.content === 'string' ? c.content : JSON.stringify(c.content)
        log(`TOOL_RESULT ok=${ok} body=${body.slice(0, 200)}${body.length > 200 ? '…' : ''}`)
        if (c.is_error) errored = true
        if (ok && body.includes(targetId)) sawTargetInList = true
      }
    }
  }
  if (msg.type === 'result') {
    log(`RESULT subtype=${msg.subtype} stop=${msg.stop_reason} is_error=${msg.is_error}`)
  }
}

log(``)
log(`[spike] marker to look for in visible terminal: echo ${marker}`)
log(`[spike] target visible in dock_list_terminals result: ${sawTargetInList}`)
log(`[spike] tool-level errors: ${errored ? 'YES (see log)' : 'none'}`)
process.exit(errored ? 1 : 0)
