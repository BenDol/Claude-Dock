#!/usr/bin/env node
/**
 * claude-dock PostToolUse hook — automatic worktree detection.
 *
 * Installed by linked-mode when a project is linked to the Dock. Claude Code
 * invokes this script after every matching tool call (Bash/Task) with a JSON
 * payload on stdin:
 *
 *   {
 *     "session_id": "...",
 *     "cwd": "<agent's current working directory after the tool call>",
 *     "tool_name": "Bash" | "Task" | ...,
 *     ...
 *   }
 *
 * If the session's cwd moves outside the project root, we enqueue a
 * `worktree_changed` entry in the Dock's terminal-commands file so the dock
 * UI auto-lights up the worktree actions for the corresponding terminal.
 * Main-process validation (dock-window.ts) drops the entry if the path isn't
 * a real git worktree, so this script can be permissive.
 *
 * CWD changes within the project root (e.g. `cd src/main`) are ignored.
 *
 * The hook tolerates two install shapes:
 *   1. Command line:  `node .claude/dock-worktree-hook.cjs <dataDir>`
 *      — preferred; the dataDir is baked in at install time so multiple
 *      Dock profiles (uat/prod) each write to their own inbox.
 *   2. No argv        — fallback to DOCK_DATA_DIR env var, then to the
 *      platform default. Works for single-profile installs.
 *
 * Never fails. Any exception is swallowed so a buggy hook never blocks the
 * user's tool call.
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

/**
 * Resolve a path through any symlinks, tolerating non-existent leaves by
 * walking up to the closest existing ancestor and re-appending the suffix.
 * Why: on macOS `/var/folders/...` is a symlink to `/private/var/folders/...`
 * and Node resolves `__dirname` through the symlink, so a raw payload `cwd`
 * and the script-derived `projectDir` can disagree on prefix without this.
 */
function safeRealpath(p) {
  const resolved = path.resolve(p)
  try { return fs.realpathSync(resolved) } catch { /* fall through */ }
  let current = resolved
  const suffix = []
  while (true) {
    const parent = path.dirname(current)
    if (parent === current) return resolved
    suffix.unshift(path.basename(current))
    current = parent
    try { return path.join(fs.realpathSync(current), ...suffix) } catch { /* keep walking */ }
  }
}

/** Normalize a filesystem path for equality comparison (case-insensitive on Windows). */
function normalizePath(p) {
  if (!p) return ''
  let n = safeRealpath(p).replace(/\\/g, '/').replace(/\/$/, '')
  if (process.platform === 'win32') n = n.toLowerCase()
  return n
}

/**
 * Resolve the Dock data directory. Priority:
 *   1. argv[2] (written at install time by linked-mode)
 *   2. DOCK_DATA_DIR env var
 *   3. .mcp.json in the project root — scan mcpServers[*].env.DOCK_DATA_DIR
 *   4. Platform default (same fallback as the MCP server)
 */
function resolveDataDir(projectDir) {
  const fromArgv = process.argv[2]
  if (fromArgv && fromArgv.trim()) return fromArgv.trim()
  if (process.env.DOCK_DATA_DIR) return process.env.DOCK_DATA_DIR
  try {
    const mcpPath = path.join(projectDir, '.mcp.json')
    const raw = JSON.parse(fs.readFileSync(mcpPath, 'utf8'))
    const servers = raw && raw.mcpServers ? raw.mcpServers : {}
    for (const key of Object.keys(servers)) {
      const env = servers[key] && servers[key].env
      if (env && env.DOCK_DATA_DIR) return env.DOCK_DATA_DIR
    }
  } catch { /* no .mcp.json or malformed; fall through */ }
  const home = require('os').homedir()
  return path.join(process.env.APPDATA || path.join(home, '.config'), 'claude-dock')
}

function readStdin() {
  return new Promise((resolve) => {
    let buf = ''
    const t = setTimeout(() => resolve(buf), 2000) // hard cap
    process.stdin.on('data', (chunk) => { buf += chunk })
    process.stdin.on('end', () => { clearTimeout(t); resolve(buf) })
    process.stdin.on('error', () => { clearTimeout(t); resolve(buf) })
  })
}

async function main() {
  // The hook script lives at `<projectDir>/.claude/dock-worktree-hook.cjs`
  // so the parent dir is the project root — no ambiguity, no env needed.
  const projectDir = path.resolve(__dirname, '..')

  const raw = await readStdin()
  if (!raw.trim()) return

  let payload
  try { payload = JSON.parse(raw) } catch { return }

  const sessionId = payload && payload.session_id
  const cwd = payload && payload.cwd
  const toolName = payload && payload.tool_name
  if (!sessionId || !cwd) return

  // Only Bash and Task can plausibly move the session cwd. Filtering other
  // tools keeps the hook cheap and avoids spamming the queue.
  if (toolName !== 'Bash' && toolName !== 'Task') return

  const normCwd = normalizePath(cwd)
  const normProject = normalizePath(projectDir)

  const dataDir = resolveDataDir(projectDir)
  try { fs.mkdirSync(dataDir, { recursive: true }) } catch { /* readable from main side is best-effort */ }

  // Session-keyed last-seen cache. Avoids writing a command every single
  // Bash call when the cwd hasn't actually changed.
  const cacheFile = path.join(dataDir, 'dock-hook-cwd-cache.json')
  let cache = {}
  try {
    const rawCache = fs.readFileSync(cacheFile, 'utf8')
    const parsed = JSON.parse(rawCache)
    if (parsed && typeof parsed === 'object') cache = parsed
  } catch { /* fresh cache */ }

  // Inside the project root (but not the root itself) isn't a worktree switch
  // — just an ordinary sub-dir cd. Treat the whole project root as "no worktree".
  const inProject = normCwd === normProject || normCwd.startsWith(normProject + '/')
  const worktreePath = inProject ? null : cwd

  const cacheKey = `${normalizePath(projectDir)}::${sessionId}`
  const prev = cache[cacheKey]
  if (prev) {
    // Two cases are no-ops vs. the last emitted state:
    //   1. Both in-project (any sub-dir → sub-dir move, no worktree change).
    //   2. Same out-of-project cwd.
    if (prev.inProject && inProject) return
    if (!prev.inProject && !inProject && prev.cwd === normCwd) return
  }

  // Update cache BEFORE writing the command so partial failures still skip
  // next tick. A successful write below will further confirm the state.
  cache[cacheKey] = { cwd: normCwd, inProject, t: Date.now() }
  // Prune entries older than 24h; cap size so cache never grows unbounded.
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000
  for (const k of Object.keys(cache)) {
    if (!cache[k] || typeof cache[k].t !== 'number' || cache[k].t < dayAgo) delete cache[k]
  }
  const keys = Object.keys(cache)
  if (keys.length > 100) {
    keys.sort((a, b) => (cache[a].t || 0) - (cache[b].t || 0))
    for (const k of keys.slice(0, keys.length - 100)) delete cache[k]
  }
  try { fs.writeFileSync(cacheFile, JSON.stringify(cache)) } catch { /* best-effort */ }

  // Enqueue a worktree_changed command — same shape the MCP server writes
  // when Claude calls dock_notify_worktree. Main-process watcher validates
  // the path and updates the renderer if it's a real git worktree.
  const cmdFile = path.join(dataDir, 'dock-terminal-commands.json')
  let commands = []
  try {
    const existing = JSON.parse(fs.readFileSync(cmdFile, 'utf8'))
    if (Array.isArray(existing)) commands = existing
  } catch { /* file may not exist yet */ }

  // Drop entries older than 30s — matches the MCP server's retention.
  const cutoff = Date.now() - 30000
  commands = commands.filter((c) => c && typeof c.timestamp === 'number' && c.timestamp > cutoff)

  commands.push({
    id: crypto.randomUUID(),
    op: 'worktree_changed',
    origin: 'hook',
    projectDir,
    sessionId,
    worktreePath,
    branch: null,
    timestamp: Date.now()
  })

  try { fs.writeFileSync(cmdFile, JSON.stringify(commands, null, 2)) } catch { /* best-effort */ }
}

main().catch(() => { /* never surface errors to the user's tool call */ }).finally(() => process.exit(0))
