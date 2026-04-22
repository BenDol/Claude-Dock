/**
 * Claude Code SDK provider (passthrough backend).
 *
 * Wraps `@anthropic-ai/claude-agent-sdk`'s `query()` so the coordinator runs
 * a hidden Claude Code session against our dock MCP instead of calling a
 * remote LLM. Tool dispatch happens INSIDE the SDK session via MCP — our
 * orchestrator streams `ChatDelta`s through to the renderer but must not
 * dispatch the tool calls locally. That's signalled by `passthrough: true`.
 *
 * Session continuity is the SDK's: every event carries a `session_id`, and
 * each resume produces a fresh id. We capture the last id per turn and pass
 * it to the next turn via `options.resume`, chaining the conversation
 * forward. Callers persist the id through `setLatestSessionId`.
 *
 * See `scratch/FINDINGS.md` Threads 3 + 4 for the SDK-event → ChatDelta
 * mapping and the resume-chain recipe this file implements.
 */

import { query } from '@anthropic-ai/claude-agent-sdk'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { log, logError } from '../../../logger'
import type {
  ChatDelta,
  ChatRequest,
  LLMProvider,
  TestConnectionResult
} from './provider'

/**
 * Resolve the bundled `claude` native binary that ships with the
 * `@anthropic-ai/claude-agent-sdk-<platform>-<arch>` optional-dependency.
 *
 * The SDK's internal resolver fails inside packaged Electron apps because
 * its computed path assumes the platform package is nested beneath
 * `@anthropic-ai/claude-agent-sdk/node_modules/...`, while npm actually
 * hoists it to the top-level `node_modules`. Inside `app.asar` Node's
 * resolution doesn't fall through the way it does on disk, so the SDK
 * throws "Claude Code native binary not found at <nested-asar-path>".
 *
 * We pre-compute the correct absolute path (mirroring the better-sqlite3
 * binding resolver in `plugins/memory/adapters/claudest-adapter.ts`) and
 * feed it via `options.pathToClaudeCodeExecutable` so the SDK skips its
 * internal lookup entirely.
 */
// Exported for tests. Production code should go through `getClaudeBinaryPath`
// which memoizes the result and logs success/failure once.
export function resolveClaudeBinaryPath(): string | undefined {
  const exeSuffix = process.platform === 'win32' ? '.exe' : ''
  const archKey = `${process.platform}-${process.arch}`
  // Linux musl sibling is the first hop on that platform — match the SDK's
  // own lookup order (see sdk.mjs / assistant.mjs LV function).
  const pkgNames = process.platform === 'linux'
    ? [`@anthropic-ai/claude-agent-sdk-linux-${process.arch}-musl`,
       `@anthropic-ai/claude-agent-sdk-linux-${process.arch}`]
    : [`@anthropic-ai/claude-agent-sdk-${archKey}`]

  for (const pkg of pkgNames) {
    const binRel = `${pkg}/claude${exeSuffix}`
    // Layout A (hoisted): top-level `node_modules/<pkg>/claude.exe`. This is
    //   what modern npm produces when optionalDependencies can be hoisted.
    // Layout B (nested): `node_modules/@anthropic-ai/claude-agent-sdk/node_modules/<pkg>/claude.exe`.
    //   electron-builder's `install-app-deps` runs npm in production mode
    //   which often installs platform-specific optional-deps NESTED inside
    //   the parent package. Must check both.
    const relLayouts = [
      path.join('node_modules', pkg, `claude${exeSuffix}`),
      path.join('node_modules', '@anthropic-ai', 'claude-agent-sdk', 'node_modules', pkg, `claude${exeSuffix}`)
    ]
    const candidates: string[] = []

    // 1) Packaged build: asarUnpack extracts the platform package under
    //    `resources/app.asar.unpacked/`. This MUST come before any
    //    require.resolve result, because Electron may return a virtual
    //    `app.asar/...` path that child_process.spawn can't execute.
    if (app.isPackaged && process.resourcesPath) {
      for (const rel of relLayouts) {
        candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', rel))
      }
    }

    // 2) Normal Node resolution — works in `electron-vite dev`.
    try {
      const resolved = require.resolve(binRel)
      // Rewrite asar virtual paths to their unpacked counterpart. Spawning
      // a binary from inside app.asar always fails — Electron transparently
      // redirects reads but not exec.
      const unpacked = resolved.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2')
      candidates.push(unpacked)
      if (unpacked !== resolved) candidates.push(resolved)
    } catch { /* not resolvable from here */ }

    // 3) Dev fallback — app source tree, both layouts.
    try {
      const appPath = app.getAppPath()
      for (const rel of relLayouts) {
        candidates.push(path.join(appPath, rel))
      }
    } catch { /* app not ready — ignore */ }

    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) return candidate
      } catch { /* ignore */ }
    }
  }
  return undefined
}

let cachedBinaryPath: string | undefined | null = null

function getClaudeBinaryPath(): string | undefined {
  if (cachedBinaryPath === null) {
    cachedBinaryPath = resolveClaudeBinaryPath()
    if (cachedBinaryPath) {
      log('[claude-sdk] resolved native binary', cachedBinaryPath)
    } else {
      logError('[claude-sdk] could not locate bundled claude binary — SDK will attempt its own resolution')
    }
  }
  return cachedBinaryPath
}

export interface ClaudeSdkProviderDeps {
  /** Project directory — keys the session-id chain and becomes SDK `cwd`. */
  projectDir: string
  /** Absolute path handed to the MCP subprocess as `DOCK_DATA_DIR`. */
  dockDataDir: string
  /** Absolute path to `resources/claude-dock-mcp.cjs`. */
  mcpScriptPath: string
  /** MCP server key (profile-suffixed, e.g. `claude-dock-uat`). */
  mcpServerKey: string
  /**
   * Cap on SDK internal turns per user message. Mirrors
   * `maxToolStepsPerTurn` from coordinator config so the two backends
   * agree on the ceiling even though the SDK enforces it transport-side.
   */
  maxToolSteps: number
  /** Last captured session id for this project, or null for a fresh session. */
  getLatestSessionId: (projectDir: string) => string | null
  /** Called with the final session_id once a turn's `result` event arrives. */
  setLatestSessionId: (projectDir: string, id: string) => void
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

// No stop-reason mapping: passthrough closes every successful turn as
// `end_turn`. A `tool_use` value here would mean the SDK hit `maxTurns`
// mid-tool-loop; still surface as end_turn so the orchestrator doesn't
// try to dispatch locally (which would double-run the work the SDK
// already did via MCP).

export function createClaudeSdkProvider(deps: ClaudeSdkProviderDeps): LLMProvider {
  async function* chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatDelta> {
    const prompt = lastUserText(req)
    if (!prompt) {
      yield { type: 'done', stopReason: 'error', errorMessage: 'claude-sdk: empty user prompt' }
      return
    }

    // SDK cancellation is controller-based, not signal-based — forward.
    const abortController = new AbortController()
    const onAbort = (): void => abortController.abort()
    if (signal.aborted) abortController.abort()
    else signal.addEventListener('abort', onAbort, { once: true })

    const resume = deps.getLatestSessionId(deps.projectDir) || undefined
    let latestSessionId: string | null = null

    log(
      '[claude-sdk] chat start',
      `project=${deps.projectDir}`,
      `mcpKey=${deps.mcpServerKey}`,
      `resume=${resume ?? '(fresh)'}`,
      `maxTurns=${deps.maxToolSteps}`
    )

    try {
      const pathToClaudeCodeExecutable = getClaudeBinaryPath()
      const q = query({
        prompt,
        options: {
          abortController,
          cwd: deps.projectDir,
          ...(pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable } : {}),
          mcpServers: {
            [deps.mcpServerKey]: {
              type: 'stdio',
              command: 'node',
              args: [deps.mcpScriptPath],
              env: { DOCK_DATA_DIR: deps.dockDataDir }
            }
          },
          // Wildcard — allow every tool the coordinator MCP exposes.
          allowedTools: [`mcp__${deps.mcpServerKey}__*`],
          // Disable built-in Read/Edit/Bash etc. — the coordinator must
          // route concrete actions through dock_prompt_terminal, not do
          // work itself.
          tools: [],
          persistSession: true,
          resume,
          // Isolate from the user's other MCPs (Gmail/voice/etc.) — see
          // FINDINGS Thread 1 open concern retired in Phase 9.
          strictMcpConfig: true,
          // Keep Claude Code's default guardrails; append coordinator rules.
          systemPrompt: {
            type: 'preset',
            preset: 'claude_code',
            append: req.system
          },
          maxTurns: deps.maxToolSteps > 0 ? deps.maxToolSteps : undefined
        }
      })

      for await (const ev of q) {
        if (signal.aborted) break

        // Every SDK event carries the session id; remember the latest for
        // the resume chain. Assigning on every event (not just init) is
        // intentional: resumed sessions fork to a new id mid-stream.
        if ('session_id' in ev && typeof ev.session_id === 'string') {
          latestSessionId = ev.session_id
        }

        switch (ev.type) {
          case 'assistant': {
            const content = ev.message?.content
            if (!Array.isArray(content)) break
            for (const part of content) {
              if (part.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
                yield { type: 'text', delta: part.text }
              } else if (part.type === 'tool_use') {
                yield {
                  type: 'tool_call',
                  id: typeof part.id === 'string' ? part.id : `call_${crypto.randomUUID()}`,
                  name: typeof part.name === 'string' ? part.name : 'unknown',
                  args: (part as { input?: unknown }).input ?? {}
                }
              }
            }
            break
          }
          case 'result': {
            if (latestSessionId) deps.setLatestSessionId(deps.projectDir, latestSessionId)
            if (ev.subtype === 'success') {
              log('[claude-sdk] chat result=success', `session=${latestSessionId ?? 'none'}`)
              yield { type: 'done', stopReason: 'end_turn' }
            } else {
              const msg = Array.isArray(ev.errors) && ev.errors.length > 0
                ? ev.errors.join('; ')
                : ev.subtype
              logError('[claude-sdk] chat result=error', ev.subtype, msg)
              yield { type: 'done', stopReason: 'error', errorMessage: msg }
            }
            return
          }
          // `user` events carry tool_results but the SDK handles those
          // internally in passthrough mode — emitting a synthetic
          // ChatDelta would double-render in the UI.
          // `system`/hook/init/api_retry/compact_boundary events are
          // diagnostic-only for our purposes.
          default:
            break
        }
      }

      // Stream ended without a `result` event — treat as clean end_turn
      // but persist whatever session id we saw so the chain doesn't break.
      if (latestSessionId) deps.setLatestSessionId(deps.projectDir, latestSessionId)
      yield { type: 'done', stopReason: 'end_turn' }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        log('[claude-sdk] chat aborted', `project=${deps.projectDir}`)
        yield { type: 'done', stopReason: 'end_turn' }
      } else {
        logError('[claude-sdk] chat threw', err)
        yield { type: 'done', stopReason: 'error', errorMessage: (err as Error).message }
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  async function testConnection(): Promise<TestConnectionResult> {
    const start = Date.now()
    const abortController = new AbortController()
    log('[claude-sdk] testConnection start')
    try {
      const pathToClaudeCodeExecutable = getClaudeBinaryPath()
      const q = query({
        prompt: 'Respond with the single word: pong',
        options: {
          abortController,
          ...(pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable } : {}),
          mcpServers: {},
          allowedTools: [],
          tools: [],
          persistSession: false,
          strictMcpConfig: true,
          maxTurns: 1
        }
      })
      for await (const ev of q) {
        if (ev.type === 'result') {
          const latencyMs = Date.now() - start
          if (ev.subtype === 'success') {
            log('[claude-sdk] testConnection ok', `${latencyMs}ms`)
            return { ok: true, model: 'claude-opus-4-7', latencyMs }
          }
          logError('[claude-sdk] testConnection result=error', ev.subtype)
          return { ok: false, error: ev.subtype, latencyMs }
        }
      }
      logError('[claude-sdk] testConnection stream ended without result event')
      return { ok: false, error: 'stream ended without result event' }
    } catch (err) {
      logError('[claude-sdk] testConnection threw', err)
      return { ok: false, error: (err as Error).message }
    }
  }

  return {
    id: 'claude-sdk',
    passthrough: true,
    chat,
    testConnection
  }
}
