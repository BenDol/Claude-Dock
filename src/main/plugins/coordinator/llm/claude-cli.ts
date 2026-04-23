/**
 * Claude Code CLI provider (passthrough backend).
 *
 * Spawns the bundled `claude` binary directly via `child_process.spawn` with
 * `--print --output-format stream-json --input-format stream-json --verbose`
 * and consumes the JSON-Lines event stream the same way `claude-sdk.ts` does.
 * The orchestrator sees identical `ChatDelta`s — only the transport changes.
 *
 * Why this exists alongside `claude-sdk`:
 *   1. Direct control of `--session-id <UUID>` lets us mint the session id
 *      up-front (matching `pty-manager.ts:111`'s precedent for user terminals)
 *      so the dock MCP's `DOCK_MCP_BOUND_SESSION_ID` pre-bind is genuinely
 *      authoritative — no race window where the LLM is asked to use an id the
 *      hidden Claude doesn't yet know about. The SDK provider can't do this
 *      because the SDK assigns the id internally and only surfaces it via
 *      events.
 *   2. We own the stdio contract end-to-end. stderr no longer disappears into
 *      the SDK; we capture a tail buffer and surface it on non-zero exit so
 *      auth failures, missing flags, and CLI panics become diagnosable.
 *   3. No SDK version coupling — when the agent SDK changes its event shape we
 *      can keep the wire-format adapter local instead of waiting for an SDK
 *      bump.
 *
 * The MCP wiring (DOCK_MCP_COMPACT, DOCK_MCP_BOUND_SESSION_ID, strictMcpConfig,
 * tools:[], allowedTools wildcard) mirrors `claude-sdk.ts` exactly. Same system
 * prompt path is reused via `backend: 'sdk'` in `system-prompt.ts` because the
 * call convention is identical.
 *
 * The MCP config is written to a per-turn JSON file under
 * `<dockDataDir>/coordinator/mcp-config-<uuid>.json` and removed in the
 * `finally` of `chat()`. A best-effort sweep on module load deletes any orphans
 * older than 1h so a previous crash doesn't leak files indefinitely.
 */

import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'child_process'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { log, logError } from '../../../logger'
import type {
  ChatDelta,
  ChatRequest,
  LLMProvider,
  TestConnectionResult
} from './provider'
import { getClaudeBinaryPath } from './claude-binary'

export interface ClaudeCliProviderDeps {
  /** Project directory — becomes the CLI's `cwd` and keys the session-id chain. */
  projectDir: string
  /** Absolute path handed to the MCP subprocess as `DOCK_DATA_DIR`. Also where
   *  per-turn MCP config files are written (under `coordinator/`). */
  dockDataDir: string
  /** Absolute path to `resources/claude-dock-mcp.cjs`. */
  mcpScriptPath: string
  /** MCP server key (profile-suffixed, e.g. `claude-dock-uat`). */
  mcpServerKey: string
  /**
   * Cap on internal CLI tool-loop steps per user message. Mirrors
   * `maxToolStepsPerTurn` from coordinator config; passed via `--max-turns`.
   */
  maxToolSteps: number
  /**
   * Stable session id the orchestrator assigns to this Coordinator turn. Used
   * three ways:
   *   - Passed to the CLI via `--session-id <UUID>` on fresh turns (the CLI
   *     enforces "must be a valid UUID").
   *   - Forwarded to the MCP subprocess via DOCK_MCP_BOUND_SESSION_ID so the
   *     server pre-binds before any tool call.
   *   - Surfaced to the LLM in the system prompt so it can satisfy each dock_*
   *     tool's `session_id` requirement.
   * On resume turns we use `--resume <prevId>` instead and let the CLI fork the
   * id; the fresh id from the CLI's events is what we persist for next turn.
   */
  coordinatorSessionId: string
  /** Last captured session id for this project, or null for a fresh session. */
  getLatestSessionId: (projectDir: string) => string | null
  /** Called with the final session_id once a turn's `result` event arrives. */
  setLatestSessionId: (projectDir: string, id: string) => void
}

// ---------- internal helpers ----------

interface McpServerEntry {
  type: 'stdio'
  command: string
  args: string[]
  env: Record<string, string>
}

interface McpConfigShape {
  mcpServers: Record<string, McpServerEntry>
}

/**
 * Build the MCP config payload the CLI loads via `--mcp-config <file>`.
 * Mirrors the inline `mcpServers` object the SDK provider passes — same
 * compact-mode flag (so all 11 dock tools fit Claude Code's per-server tool
 * budget) and same DOCK_MCP_BOUND_SESSION_ID pre-bind so the server accepts
 * tool calls without waiting for a dock_status to "claim" the session.
 */
function buildMcpConfig(deps: ClaudeCliProviderDeps): McpConfigShape {
  return {
    mcpServers: {
      [deps.mcpServerKey]: {
        type: 'stdio',
        command: 'node',
        args: [deps.mcpScriptPath],
        env: {
          DOCK_DATA_DIR: deps.dockDataDir,
          DOCK_MCP_COMPACT: '1',
          DOCK_MCP_BOUND_SESSION_ID: deps.coordinatorSessionId
        }
      }
    }
  }
}

/**
 * Write `<dockDataDir>/coordinator/mcp-config-<turnUuid>.json` and return its
 * absolute path. Uses a per-turn UUID (NOT `coordinatorSessionId`) so future
 * concurrent turns don't collide. Caller is responsible for `unlinkSync` in
 * `finally`; the module-load sweep in `sweepStaleMcpConfigs` is a backstop for
 * crashes that prevented the finally from running.
 */
function writeMcpConfigFile(deps: ClaudeCliProviderDeps, turnUuid: string): string {
  const dir = path.join(deps.dockDataDir, 'coordinator')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `mcp-config-${turnUuid}.json`)
  fs.writeFileSync(file, JSON.stringify(buildMcpConfig(deps)), 'utf8')
  return file
}

/**
 * Best-effort sweep of orphaned MCP config files older than 1h. Runs once on
 * module load. Cheap (one readdir + a few stats) and catches the case where a
 * previous crash skipped the per-turn unlink. We DON'T sweep on a timer —
 * coordinator turns run in the same process that wrote the files, so once-per-
 * boot is enough.
 */
let sweepRan = false
function sweepStaleMcpConfigs(dockDataDir: string): void {
  if (sweepRan) return
  sweepRan = true
  const dir = path.join(dockDataDir, 'coordinator')
  let entries: string[]
  try { entries = fs.readdirSync(dir) } catch { return }
  const cutoff = Date.now() - 60 * 60 * 1000
  for (const name of entries) {
    if (!name.startsWith('mcp-config-') || !name.endsWith('.json')) continue
    const full = path.join(dir, name)
    try {
      const st = fs.statSync(full)
      if (st.mtimeMs < cutoff) fs.unlinkSync(full)
    } catch { /* ignore — concurrent sweep, file already gone, etc. */ }
  }
}

interface BuildArgvOpts {
  prompt: string
  systemPrompt: string
  model: string
  resume: string | undefined
  mcpConfigPath: string
}

/**
 * Build the argv we pass to `claude`. Each flag's purpose:
 *
 * - `-p` / `--print`: REQUIRED. Without it the CLI starts an interactive TUI
 *   and `--input-format`/`--output-format` are ignored. Claude's own `--help`
 *   states that all three of those flags only work with `--print`.
 *
 * - `--output-format stream-json --input-format stream-json --verbose`: the
 *   canonical streaming protocol the SDK uses internally (see node_modules/
 *   @anthropic-ai/claude-agent-sdk/sdk.mjs). `--verbose` is mandatory for
 *   `stream-json` non-interactive mode.
 *
 * - `--mcp-config <file>`: file path (the CLI accepts both inline JSON and a
 *   file path). File is preferred — easier to debug, immune to Windows argv
 *   limits if the config ever grows.
 *
 * - `--strict-mcp-config`: don't load the user's `~/.claude.json` MCP servers
 *   (Gmail, voice, etc.). The coordinator only sees the dock MCP.
 *
 * - `--allowedTools mcp__<key>__*`: wildcard for every dock_* tool. Mirrors
 *   the SDK provider's `allowedTools: ['mcp__<key>__*']`.
 *
 * - `--tools ""`: explicitly disables all built-ins (Bash/Read/Edit/etc.) so
 *   the coordinator can't bypass `dock_prompt_terminal`. The CLI documents
 *   `""` as "disable all tools".
 *
 * - `--model <name>`: pin to whatever the user picked (defaults to opus 4.7).
 *
 * - `--max-turns N` (when N > 0): caps internal tool-loop steps. Same role as
 *   the SDK's `maxTurns`.
 *
 * - `--session-id <UUID>` for fresh turns / `--resume <id>` for continuations.
 *   The CLI emits a fresh session id mid-stream during resume; we capture it
 *   from events for next turn.
 *
 * - `--append-system-prompt <text>`: appends to Claude Code's default preset.
 *   Equivalent to the SDK's `systemPrompt: { type: 'preset', preset: 'claude_code', append }`.
 *
 * - `--permission-mode bypassPermissions`: the coordinator runs unattended —
 *   there's no human to answer permission prompts. This is safe in combination
 *   with `--tools ""` because the only callable tools are MCP `dock_*`, none
 *   of which can read/write/exec arbitrary content directly; they only
 *   marshal commands to other Claude terminals (which DO get permission
 *   prompts in their own sessions).
 */
export function buildArgv(deps: ClaudeCliProviderDeps, opts: BuildArgvOpts): string[] {
  const argv: string[] = [
    '-p',
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--verbose',
    '--mcp-config', opts.mcpConfigPath,
    '--strict-mcp-config',
    '--allowedTools', `mcp__${deps.mcpServerKey}__*`,
    '--tools', '',
    '--model', opts.model,
    '--permission-mode', 'bypassPermissions'
  ]
  if (deps.maxToolSteps > 0) {
    argv.push('--max-turns', String(deps.maxToolSteps))
  }
  if (opts.resume) {
    argv.push('--resume', opts.resume)
  } else {
    argv.push('--session-id', deps.coordinatorSessionId)
  }
  // Append-system-prompt last so any debug eyeballing of the argv shows the
  // operational flags first.
  argv.push('--append-system-prompt', opts.systemPrompt)
  return argv
}

function lastUserText(req: ChatRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i]
    if (m.role === 'user') {
      return typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    }
  }
  return ''
}

/**
 * Format the user message exactly like the SDK does on stdin. The CLI's
 * `--input-format stream-json` parser expects this shape (see SDK's
 * sdk.mjs around offset 278200).
 */
function formatUserMessageLine(prompt: string): string {
  return JSON.stringify({
    type: 'user',
    session_id: '',
    message: { role: 'user', content: [{ type: 'text', text: prompt }] },
    parent_tool_use_id: null
  }) + '\n'
}

/**
 * Cross-platform tree-kill. Native binaries on Windows ignore SIGTERM, so we
 * shell out to `taskkill /T /F` to also reap the MCP node child the CLI
 * spawned (without `/T` it would orphan and keep holding the dock-data file).
 *
 * Accepts the broader `ChildProcess` type (rather than `ChildProcessWithoutNullStreams`)
 * because `testConnection()` spawns with `stdio: ['ignore', 'pipe', 'pipe']`,
 * which TypeScript types as `ChildProcessByStdio<null, ...>`.
 */
function killTree(child: ChildProcess): void {
  if (child.killed || child.exitCode !== null) return
  if (process.platform === 'win32') {
    if (typeof child.pid === 'number') {
      try {
        // /T = tree, /F = force. Without /T the MCP node child orphans.
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      } catch (err) {
        logError('[claude-cli] taskkill failed', err)
      }
    }
  } else {
    try { child.kill('SIGTERM') } catch { /* already gone */ }
    setTimeout(() => {
      if (!child.killed && child.exitCode === null) {
        try { child.kill('SIGKILL') } catch { /* already gone */ }
      }
    }, 2000).unref()
  }
}

/** Capped FIFO buffer for stderr — last ~4KB, surfaced on non-zero exit. */
class StderrTail {
  private chunks: string[] = []
  private bytes = 0
  private readonly cap = 4096

  push(s: string): void {
    if (!s) return
    this.chunks.push(s)
    this.bytes += s.length
    while (this.bytes > this.cap && this.chunks.length > 1) {
      const head = this.chunks.shift()!
      this.bytes -= head.length
    }
  }

  text(): string {
    return this.chunks.join('').slice(-this.cap).trim()
  }
}

/**
 * Tiny single-consumer queue that bridges EventEmitter callbacks to an async
 * iterator. The CLI runs on its own schedule — events arrive whenever the
 * subprocess flushes — but `chat()` is an async generator that yields one
 * delta at a time. This queue lets the parser `push` deltas as they're
 * decoded, while the generator `pull`s in its `for await` loop. When the
 * stream ends the queue is closed; pulls after close return undefined.
 */
class DeltaQueue {
  private items: ChatDelta[] = []
  private waiting: ((v: ChatDelta | undefined) => void) | null = null
  private closed = false

  push(d: ChatDelta): void {
    if (this.closed) return
    if (this.waiting) {
      const w = this.waiting
      this.waiting = null
      w(d)
      return
    }
    this.items.push(d)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.waiting) {
      const w = this.waiting
      this.waiting = null
      w(undefined)
    }
  }

  pull(): Promise<ChatDelta | undefined> {
    if (this.items.length > 0) return Promise.resolve(this.items.shift())
    if (this.closed) return Promise.resolve(undefined)
    return new Promise((resolve) => { this.waiting = resolve })
  }
}

// ---------- provider ----------

export function createClaudeCliProvider(deps: ClaudeCliProviderDeps): LLMProvider {
  // Trigger the orphan sweep on first construction. Safe to call unconditionally
  // — guarded by `sweepRan` — and cheap on every run after.
  sweepStaleMcpConfigs(deps.dockDataDir)

  async function* chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatDelta> {
    const prompt = lastUserText(req)
    if (!prompt) {
      yield { type: 'done', stopReason: 'error', errorMessage: 'claude-cli: empty user prompt' }
      return
    }

    const exe = getClaudeBinaryPath()
    if (!exe) {
      yield { type: 'done', stopReason: 'error', errorMessage: 'claude-cli: bundled claude binary not found' }
      return
    }

    const resume = deps.getLatestSessionId(deps.projectDir) || undefined
    const turnUuid = crypto.randomUUID()
    let mcpConfigPath: string
    try {
      mcpConfigPath = writeMcpConfigFile(deps, turnUuid)
    } catch (err) {
      logError('[claude-cli] failed to write MCP config', err)
      yield {
        type: 'done',
        stopReason: 'error',
        errorMessage: `claude-cli: failed to write MCP config: ${(err as Error).message}`
      }
      return
    }

    const argv = buildArgv(deps, {
      prompt,
      systemPrompt: req.system,
      model: req.model || 'claude-opus-4-7',
      resume,
      mcpConfigPath
    })

    log(
      '[claude-cli] chat start',
      `project=${deps.projectDir}`,
      `mcpKey=${deps.mcpServerKey}`,
      `resume=${resume ?? '(fresh)'}`,
      `maxTurns=${deps.maxToolSteps}`,
      `coordSession=${deps.coordinatorSessionId.slice(0, 8)}`,
      `mcpConfig=${mcpConfigPath}`
    )

    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(exe, argv, {
        cwd: deps.projectDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
        windowsHide: true
      })
    } catch (err) {
      logError('[claude-cli] spawn failed', err)
      try { fs.unlinkSync(mcpConfigPath) } catch { /* ignore */ }
      yield {
        type: 'done',
        stopReason: 'error',
        errorMessage: `claude-cli: spawn failed: ${(err as Error).message}`
      }
      return
    }

    const queue = new DeltaQueue()
    const stderrTail = new StderrTail()
    let latestSessionId: string | null = null
    let doneEmitted = false
    let exited = false
    let exitCode: number | null = null
    let stdoutEnded = false
    let stderrEnded = false

    /** Funnel `done` deltas through one place so we never emit two. */
    const emitDone = (delta: Extract<ChatDelta, { type: 'done' }>): void => {
      if (doneEmitted) return
      doneEmitted = true
      queue.push(delta)
      // Closing here lets the consumer's loop exit promptly even if the
      // subprocess is still flushing trailing diagnostic events.
      queue.close()
    }

    const tryFinalize = (): void => {
      if (!exited || !stdoutEnded) return
      // Stream + process both done. If a `result` already produced a `done`
      // we've already emitted; otherwise synthesize one based on exit code.
      if (doneEmitted) {
        queue.close()
        return
      }
      if (latestSessionId) {
        try { deps.setLatestSessionId(deps.projectDir, latestSessionId) } catch (err) {
          logError('[claude-cli] setLatestSessionId threw on finalize', err)
        }
      }
      if (exitCode === 0) {
        log('[claude-cli] stream ended without result; treating as end_turn')
        emitDone({ type: 'done', stopReason: 'end_turn' })
      } else {
        const tail = stderrTail.text()
        const errorMessage = `claude-cli exited with code ${exitCode}${tail ? `: ${tail}` : ''}`
        logError('[claude-cli] non-zero exit', errorMessage)
        emitDone({ type: 'done', stopReason: 'error', errorMessage })
      }
    }

    /**
     * Decode one parsed event into a stream of ChatDeltas pushed to `queue`.
     * Mirror of the SDK provider's mapping (see claude-sdk.ts switch over
     * `ev.type`) so the orchestrator behaviour is identical between backends.
     */
    const handleEvent = (ev: any): void => {
      if (ev && typeof ev === 'object' && typeof ev.session_id === 'string') {
        latestSessionId = ev.session_id
      }
      if (!ev || typeof ev.type !== 'string') return

      switch (ev.type) {
        case 'assistant': {
          const content = ev.message?.content
          if (!Array.isArray(content)) return
          for (const part of content) {
            if (part?.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
              queue.push({ type: 'text', delta: part.text })
            } else if (part?.type === 'tool_use') {
              queue.push({
                type: 'tool_call',
                id: typeof part.id === 'string' ? part.id : `call_${crypto.randomUUID()}`,
                name: typeof part.name === 'string' ? part.name : 'unknown',
                args: (part as { input?: unknown }).input ?? {}
              })
            }
          }
          return
        }
        case 'result': {
          if (latestSessionId) {
            try { deps.setLatestSessionId(deps.projectDir, latestSessionId) } catch (err) {
              logError('[claude-cli] setLatestSessionId threw on result', err)
            }
          }
          if (ev.subtype === 'success') {
            log('[claude-cli] chat result=success', `session=${latestSessionId ?? 'none'}`)
            emitDone({ type: 'done', stopReason: 'end_turn' })
          } else {
            const msg = Array.isArray(ev.errors) && ev.errors.length > 0
              ? ev.errors.join('; ')
              : (typeof ev.subtype === 'string' ? ev.subtype : 'unknown error')
            logError('[claude-cli] chat result=error', ev.subtype, msg)
            emitDone({ type: 'done', stopReason: 'error', errorMessage: msg })
          }
          return
        }
        // `user` events carry tool_results that the CLI's internal MCP loop
        // already handled — emitting a synthetic ChatDelta would double-render
        // in the UI. `system`/init/control events are diagnostic-only.
        default:
          return
      }
    }

    // ---------- stdout: line-buffered JSON-Lines parser ----------
    let stdoutBuf = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdoutBuf += chunk
      let nl: number
      while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, nl).trim()
        stdoutBuf = stdoutBuf.slice(nl + 1)
        if (!line) continue
        try {
          handleEvent(JSON.parse(line))
        } catch (err) {
          // Non-JSON output is rare but possible (CLI panics, deprecation
          // warnings printed to stdout in some builds). Log a truncated
          // sample but keep parsing.
          logError('[claude-cli] non-JSON stdout line', line.slice(0, 200), (err as Error).message)
        }
      }
    })
    child.stdout.on('end', () => {
      // Flush a trailing partial line that the CLI emitted without a newline.
      const tail = stdoutBuf.trim()
      stdoutBuf = ''
      if (tail) {
        try { handleEvent(JSON.parse(tail)) } catch (err) {
          logError('[claude-cli] non-JSON trailing stdout line', tail.slice(0, 200), (err as Error).message)
        }
      }
      stdoutEnded = true
      tryFinalize()
    })
    child.stdout.on('error', (err: Error) => {
      logError('[claude-cli] stdout error', err)
    })

    // ---------- stderr: capture tail for error surfacing ----------
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderrTail.push(chunk)
    })
    child.stderr.on('end', () => { stderrEnded = true })
    child.stderr.on('error', (err: Error) => {
      logError('[claude-cli] stderr error', err)
    })

    // ---------- subprocess lifecycle ----------
    child.on('error', (err: Error) => {
      logError('[claude-cli] subprocess error', err)
      emitDone({ type: 'done', stopReason: 'error', errorMessage: err.message })
    })
    child.on('exit', (code: number | null) => {
      exited = true
      exitCode = code
      log('[claude-cli] subprocess exit', `code=${code}`, `stderrEnded=${stderrEnded}`)
      tryFinalize()
    })

    // ---------- abort wiring ----------
    const onAbort = (): void => {
      log('[claude-cli] abort requested', `pid=${child.pid}`)
      killTree(child)
      // Surface the abort as a clean end_turn (matches SDK provider behaviour
      // at claude-sdk.ts:308-310). The downstream UI cancels the assistant
      // message; rendering an "error" here would falsely flag the abort as a
      // failure.
      emitDone({ type: 'done', stopReason: 'end_turn' })
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })

    // ---------- write the user message and let the CLI run ----------
    try {
      child.stdin.write(formatUserMessageLine(prompt))
      // We intentionally do NOT end stdin here. Stream-json input keeps the
      // CLI alive between user messages; ending early can race with the CLI's
      // initial setup and cause a SIGPIPE on its first reply attempt. End
      // stdin only after we've seen the result event, in the finally below.
    } catch (err) {
      logError('[claude-cli] stdin.write failed', err)
      emitDone({
        type: 'done',
        stopReason: 'error',
        errorMessage: `claude-cli: stdin write failed: ${(err as Error).message}`
      })
    }

    try {
      while (true) {
        const ev = await queue.pull()
        if (!ev) return
        yield ev
        if (ev.type === 'done') return
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      // Be polite — close stdin so the CLI exits cleanly. If it's already
      // exited the write side is gone; swallow.
      try { child.stdin.end() } catch { /* already closed */ }
      // If the consumer's `for await` was broken early (e.g. the orchestrator
      // moved on after a `done`), kill the subprocess so we don't leak.
      if (!exited) killTree(child)
      try { fs.unlinkSync(mcpConfigPath) } catch { /* may already be gone */ }
    }
  }

  async function testConnection(): Promise<TestConnectionResult> {
    const start = Date.now()
    log('[claude-cli] testConnection start')
    const exe = getClaudeBinaryPath()
    if (!exe) {
      return { ok: false, error: 'bundled claude binary not found' }
    }
    return new Promise((resolve) => {
      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (result: TestConnectionResult): void => {
        if (settled) return
        settled = true
        resolve(result)
      }
      const child = spawn(exe, ['--version'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (c: string) => { stdout += c })
      child.stderr.on('data', (c: string) => { stderr += c })
      child.on('error', (err) => {
        logError('[claude-cli] testConnection spawn error', err)
        finish({ ok: false, error: (err as Error).message, latencyMs: Date.now() - start })
      })
      child.on('exit', (code) => {
        const latencyMs = Date.now() - start
        if (code === 0) {
          const version = stdout.trim().split(/\s+/)[0] || 'claude-cli'
          log('[claude-cli] testConnection ok', `${latencyMs}ms`, `version=${version}`)
          finish({ ok: true, model: version, latencyMs })
        } else {
          const tail = (stderr || stdout).trim().slice(-512)
          logError('[claude-cli] testConnection exit', `code=${code}`, tail)
          finish({ ok: false, error: tail || `exit code ${code}`, latencyMs })
        }
      })
      // 10s safety net — `--version` should return in well under a second.
      setTimeout(() => {
        if (settled) return
        killTree(child)
        finish({ ok: false, error: 'timeout', latencyMs: Date.now() - start })
      }, 10_000).unref()
    })
  }

  return {
    id: 'claude-cli',
    passthrough: true,
    chat,
    testConnection
  }
}
