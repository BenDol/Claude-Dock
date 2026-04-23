# Plan: `claude-cli` LLM Provider for Coordinator

Replace the `claude-sdk` passthrough provider with a direct subprocess that
spawns the bundled `claude` binary in `--output-format stream-json` mode.
Goal: end the SDK's opaque session-id assignment and own the entire IO contract.

## 1. File-by-file change list

### NEW: `src/main/plugins/coordinator/llm/claude-cli.ts` (~350 LOC)

Mirrors `claude-sdk.ts` structure:

- Re-export `resolveClaudeBinaryPath` from `./claude-sdk` (or hoist to a shared
  `llm/claude-binary.ts`). Do NOT duplicate the asar-unpack handling.
- `ClaudeCliProviderDeps` — same fields as `ClaudeSdkProviderDeps`.
- `writeMcpConfigFile(deps, turnUuid)` — writes
  `<dockDataDir>/coordinator/mcp-config-<turnUuid>.json` containing the same
  `mcpServers` object the SDK passes inline (`type: 'stdio'`, `command: 'node'`,
  `args: [mcpScriptPath]`, `env: { DOCK_DATA_DIR, DOCK_MCP_COMPACT: '1', DOCK_MCP_BOUND_SESSION_ID }`).
  `mkdirSync(..., { recursive: true })` first; cleanup in `finally`.
- `buildArgv(deps, opts)` — pure function returning `string[]` (see §2).
- `createClaudeCliProvider(deps)` — returns `LLMProvider` with
  `id: 'claude-cli'`, `passthrough: true`, `chat()`, `testConnection()`.
- `chat()` uses `child_process.spawn`, JSON-Lines parser (§3), abort wiring (§5).
- `testConnection()` spawns `claude --version` (cheap). Optionally a real
  1-turn ping mirroring the SDK provider's testConnection — see open questions.

### MODIFY: `src/main/plugins/coordinator/llm/registry.ts`

- Add `import { createClaudeCliProvider } from './claude-cli'`.
- Add a `'claude-cli'` entry to `PROVIDER_PRESETS` (label "Claude Code CLI
  (subprocess)", `defaultModel: 'claude-opus-4-7'`, `requiresApiKey: false`).
- Add `case 'claude-cli'` to the switch — identical to `'claude-sdk'` but
  calling `createClaudeCliProvider(...)`. Reuse the deps-required guard.

### MODIFY: `src/shared/coordinator-types.ts`

- Extend `CoordinatorProviderId` union with `| 'claude-cli'`.
- Leave `DEFAULT_COORDINATOR_CONFIG.provider` unchanged (no auto-migration).

### MODIFY: `src/main/plugins/coordinator/llm/system-prompt.ts`

- No code change required. The new provider uses `backend: 'sdk'` — same
  MCP-prefixed tool names, same `coordinatorSessionId` inlining.
- Optional rename: `'sdk'` → `'claude-mcp'` for clarity. Skip for smaller diff.

### MODIFY: `src/main/plugins/coordinator/orchestrator/orchestrator.ts`

- No structural change. `provider.passthrough ? 'sdk' : 'llm'` already routes
  `claude-cli` to the SDK prompt path.

### MODIFY: `src/main/plugins/coordinator/renderer/CoordinatorSettings.tsx`

- Rename `isSdkBackend` to `isClaudeBackend`, redefine as
  `config?.provider === 'claude-sdk' || config?.provider === 'claude-cli'`.
- Hint text parameterized via `selectedPreset.label` so it reads correctly
  for either backend.
- Provider dropdown (already maps over registry presets) needs no change.

### NEW: `src/main/plugins/coordinator/__tests__/claude-cli.test.ts`

Mirror `claude-sdk.test.ts`. Mock `child_process.spawn`. See §6 for case list.

### MODIFY: `src/main/plugins/coordinator/__tests__/registry.test.ts`

Add a `'createProvider — claude-cli backend'` describe block with two tests:
throws without deps, constructs with deps. Mock `child_process.spawn` to
no-op so the import-time side-effect doesn't actually spawn.

### NEW: `scratch/FINDINGS.md` thread

Record the canonical SDK CLI argv (extracted from `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`
around the `stream-json` reference) and the rationale for the subset we adopt.

### NO CHANGES

- `pty-manager.ts` — only consulted as precedent for `crypto.randomUUID()` + `--session-id`.
- `env-profile.ts`, `coordinator-chat-store.ts`, `tools.ts` — provider-agnostic.

## 2. The CLI invocation

### Argv

Per turn, with `prompt = lastUserText(req)`, `mcpConfigPath` written ahead,
`resume = deps.getLatestSessionId(deps.projectDir)`:

```
[
  '--output-format', 'stream-json',
  '--input-format', 'stream-json',
  '--verbose',                                  // required by stream-json
  '--mcp-config', mcpConfigPath,
  '--strict-mcp-config',                        // isolate from user MCPs
  '--allowedTools', `mcp__${deps.mcpServerKey}__*`,
  '--tools', '',                                // disable built-in Read/Edit/Bash
  '--model', req.model || 'claude-opus-4-7',
  ...(deps.maxToolSteps > 0 ? ['--max-turns', String(deps.maxToolSteps)] : []),
  ...(resume
    ? ['--resume', resume]
    : ['--session-id', deps.coordinatorSessionId]),
  '--append-system-prompt', req.system,
  '--permission-mode', 'bypassPermissions',     // unattended; we own the env
]
```

**Why each flag:**

| Flag | Why |
|---|---|
| `--output-format stream-json` | Same event stream we already consume from the SDK. |
| `--input-format stream-json` | Push user/tool_result messages as JSON-Lines on stdin. |
| `--verbose` | Required when `--output-format stream-json` is non-interactive (SDK proves this). |
| `--mcp-config <file>` | File-based avoids Windows ~32KB argv limit and is debuggable. |
| `--strict-mcp-config` | Don't load user's `~/.claude.json` MCPs (Gmail, voice, etc.). |
| `--allowedTools mcp__<key>__*` | Wildcard for every dock_* tool. |
| `--tools ''` | Disables built-ins so coordinator can't bypass `dock_prompt_terminal`. |
| `--model` | Honours user's preset. |
| `--max-turns N` | Caps internal tool-loop steps; mirrors SDK `maxTurns`. |
| `--session-id <uuid>` | Mints session up-front so `DOCK_MCP_BOUND_SESSION_ID` matches. |
| `--resume <prevId>` | Continues prior session; CLI may fork the id mid-stream. |
| `--append-system-prompt` | Appends to `claude_code` preset, matching SDK behaviour. |
| `--permission-mode bypassPermissions` | Unattended — interactive prompts would deadlock. |

### MCP config file

Path: `<dockDataDir>/coordinator/mcp-config-<perTurnUuid>.json`.
Use a **per-turn** UUID (NOT `coordinatorSessionId`) so future concurrent
turns don't collide. Cleanup: try `unlinkSync` in `finally`; belt-and-braces
sweep on module load for any `mcp-config-*.json` older than 1h.

### Binary resolution

Reuse `resolveClaudeBinaryPath()` from `claude-sdk.ts`. Spawn with no shell:

```ts
const exe = getClaudeBinaryPath()
if (!exe) {
  yield { type: 'done', stopReason: 'error', errorMessage: 'claude-cli: bundled claude binary not found' }
  return
}
const child = spawn(exe, argv, { cwd: deps.projectDir, stdio: ['pipe', 'pipe', 'pipe'], env: process.env })
```

## 3. Stream parsing

### Line-buffered JSON-Lines parser

```ts
let buf = ''
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk: string) => {
  buf += chunk
  let nl: number
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    try { pushEvent(JSON.parse(line)) }
    catch { logError('[claude-cli] non-JSON stdout', line.slice(0, 200)) }
  }
})
child.stdout.on('end', () => {
  const tail = buf.trim()
  if (tail) { try { pushEvent(JSON.parse(tail)) } catch { /* ignore */ } }
  signalStreamEnded()
})
```

Use a small `AsyncQueue<ChatDelta>` to bridge event-emitter callbacks to the
async generator. Or hand-roll with two promises (`pendingPush`, `pendingPull`).

### Process exit edge cases

- On `child.on('exit', code)`: if no `result` event seen, synthesize
  `{ type: 'done', stopReason: code === 0 ? 'end_turn' : 'error',
     errorMessage: code === 0 ? undefined : 'claude-cli exited with code ' + code }`.
- Race: stdout `end` may fire before/after `exit`. Wait for both before
  resolving the generator (`Promise.all([endP, exitP])`).
- Track `let doneEmitted = false` and gate every `done` yield. Two `done`s
  would confuse the orchestrator.

### Event → ChatDelta mapping (identical to claude-sdk.ts:261–300)

| CLI event | Action |
|---|---|
| `{ type: 'system', subtype: 'init', session_id }` | Capture `latestSessionId`. No delta. |
| `{ type: 'assistant', message: { content: [...] }, session_id }` | Capture `session_id`. For each part: `text` → `{ type: 'text', delta: part.text }`; `tool_use` → `{ type: 'tool_call', id, name, args: input ?? {} }`. |
| `{ type: 'user', ... }` | tool_result echo from CLI's internal MCP — DROP (would double-render). |
| `{ type: 'result', subtype, session_id, errors? }` | `setLatestSessionId(projectDir, latestSessionId)`. `success` → `done/end_turn`. Else → `done/error` with `errors.join('; ') ?? subtype`. Then return. |
| anything else | Drop with debug log. |

### Stdin

```ts
const userMsg = {
  type: 'user',
  session_id: '',
  message: { role: 'user', content: [{ type: 'text', text: prompt }] },
  parent_tool_use_id: null
}
child.stdin.write(JSON.stringify(userMsg) + '\n')
// Keep stdin open until `result`, then end so process exits cleanly.
```

## 4. Session-id lifecycle

| Phase | Action |
|---|---|
| Mint | Reuse `deps.coordinatorSessionId` (orchestrator already minted per turn — same precedent as `pty-manager.ts:111`). |
| Pre-bind MCP | `DOCK_MCP_BOUND_SESSION_ID: turnSessionId` in MCP config file's env. Identical to current SDK fix. |
| Pass to CLI | Fresh → `--session-id <turnSessionId>`. Resume → `--resume <prevId>` (only one). |
| Capture | On every event: if `ev.session_id` is a string, `latestSessionId = ev.session_id`. CLI may fork during resume. |
| Persist | On `result` event: `deps.setLatestSessionId(projectDir, latestSessionId)`. Also persist on stream-end-without-result. |
| Surface to LLM | Already inlined into system prompt by `buildSystemPrompt({ backend: 'sdk', coordinatorSessionId })`. |

## 5. Process lifecycle / abort handling

### AbortSignal → kill

```ts
const onAbort = () => {
  if (child.killed) return
  if (process.platform === 'win32') {
    // SIGTERM unreliable on Windows for native binaries without handlers.
    // taskkill /T kills the whole tree (CLI may have spawned MCP node child).
    try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']) } catch {}
  } else {
    child.kill('SIGTERM')
    setTimeout(() => { if (!child.killed) child.kill('SIGKILL') }, 2000).unref()
  }
}
if (signal.aborted) onAbort()
else signal.addEventListener('abort', onAbort, { once: true })
```

`finally`: `removeEventListener('abort', onAbort)` and best-effort
`unlinkSync(mcpConfigPath)`.

### Stdin close

After yielding the `result`-derived `done` delta:
`try { child.stdin.end() } catch {}`. CLI exits within a few hundred ms.

### Backpressure

For one user message per turn (~tens of KB), `child.stdin.write()` returns
synchronously OK. Revisit if we ever stream tool_results back.

### CLI exits mid-stream

- `child.on('error', ...)` → emit `done/error` once.
- `child.on('exit', code)` after stream-end without `result` → `done/error` with code.
- **Critical**: capture `child.stderr` line-by-line into a 4KB ring buffer.
  On `exit code !== 0`, include the tail in `errorMessage`. The SDK swallows
  stderr; we should NOT.

## 6. Testing strategy

### Mock pattern

```ts
const mockSpawn = vi.fn()
vi.mock('child_process', () => ({ spawn: (...a: any[]) => mockSpawn(...a) }))
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return { ...actual, existsSync: vi.fn().mockReturnValue(true), mkdirSync: vi.fn(), writeFileSync: vi.fn(), unlinkSync: vi.fn() }
})

function makeFakeChild() {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const stdin = { write: vi.fn(), end: vi.fn() }
  const child = Object.assign(new EventEmitter(), { stdout, stderr, stdin, killed: false, pid: 1234, kill: vi.fn() })
  return { child, stdout, stderr, stdin }
}
```

### Cases (8–10 in initial PR)

1. **assistant text → text deltas** — feed two text parts then `result/success`.
2. **tool_use → tool_call deltas** — same shape as `claude-sdk.test.ts:103-131`.
3. **partial-line buffering** — emit one event split across two stdout chunks.
4. **trailing line without newline** — complete event with no `\n`, then `end`.
5. **resume path** — `getLatestSessionId` returns `'prev'`; assert argv has `'--resume', 'prev'` and NO `--session-id`. After result, `setLatestSessionId` called.
6. **fresh session path** — `getLatestSessionId` returns `null`; assert argv has `'--session-id', deps.coordinatorSessionId`.
7. **MCP config file written correctly** — `fs.writeFileSync` got JSON containing `DOCK_MCP_BOUND_SESSION_ID` and `DOCK_MCP_COMPACT: '1'`.
8. **abort kills child** — start streaming, abort, assert `kill` (or taskkill spawn) called and generator yields `done/end_turn` (mirrors SDK at line 308–310).
9. **non-zero exit surfaces stderr tail** — text on stdout, "Authentication failed" on stderr, `exit(1)` without result. Assert `done/error` with stderr in message.
10. **non-success result** — emit `{type:'result', subtype:'error_max_turns', errors:['maxTurns reached']}`. Assert `done/error` with that message.
11. **passthrough flag** — `expect(provider.passthrough).toBe(true)` and `expect(provider.id).toBe('claude-cli')`.

Tests 3, 4, 8, 9 catch real bugs the SDK provider can't (it doesn't own line buffering, abort, or stderr).

## 7. Migration / coexistence

- Keep `claude-sdk` as-is for one release. Both providers coexist in the union.
- No automatic config migration. Stored `provider: 'claude-sdk'` stays.
- `DEFAULT_COORDINATOR_CONFIG.provider` unchanged (`'groq'`).
- Once `claude-cli` is proven, relabel SDK preset "(legacy)" and CLI "(recommended)".
- Sunset path (future PR): deprecate SDK preset, then remove SDK code + dep.

## 8. Risks & open questions

1. **CLI version skew.** The bundled CLI ships with `@anthropic-ai/claude-agent-sdk-<plat>-<arch>`. SDK upgrades change the CLI. Mitigation: pin SDK in `package.json`; CI smoke test runs `claude --version`.
2. **Windows bidirectional JSON-Lines stdio.** `spawn` with `stdio: ['pipe','pipe','pipe']` works as long as binary is a real `.exe` (not `.cmd` shim). `claude.exe` qualifies. Verify in dev.
3. **stderr surfacing.** Plan covers tail-on-error. Open: also emit text deltas with stderr for chat-UI visibility? Probably no — logs are enough.
4. **`--permission-mode bypassPermissions` blast radius.** Skips ALL prompts. Mitigated by `--tools ''` disabling Bash/Read/Edit. Combination is safe.
5. **Unhandled `control_request` messages.** SDK protocol expects acks for some control_requests. With `bypassPermissions` + `tools:[]`, shouldn't see any. If we do, CLI hangs. Mitigation: log + 30s no-progress timer → `done/error`.
6. **Concurrent turns.** Per-turn UUID for MCP config file already covers this. MCP server itself binds to one session at a time — out of scope.
7. **`testConnection()` shallowness.** `--version` proves binary runs but not auth. SDK does a real 1-turn ping. Recommend mirroring SDK exactly. Add as test 12.
8. **`--append-system-prompt` size limits.** Argv max ~32KB on Windows; current prompt ~2KB. Flag a regression if it grows past 16KB.

## 9. Estimated effort

| Chunk | Hours |
|---|---|
| Provider implementation (`claude-cli.ts`) | 4–6 |
| MCP config plumbing + cleanup sweep | 1 |
| Registry + types + UI wiring | 1 |
| Tests (provider + registry) | 3–4 |
| Manual smoke test in dev (real coordinator turn end-to-end) | 1–2 |
| Docs (`CLAUDE.md` / FINDINGS thread) | 0.5 |
| **Total** | **10–14h** (one focused day + ~2h buffer for unforeseen CLI quirks) |

## Critical files for implementation

- `src/main/plugins/coordinator/llm/claude-sdk.ts` — reference; copy structure, reuse `resolveClaudeBinaryPath`.
- `src/main/plugins/coordinator/llm/registry.ts` — add case + preset.
- `src/shared/coordinator-types.ts` — extend union.
- `src/main/plugins/coordinator/__tests__/claude-sdk.test.ts` — mirror for `claude-cli.test.ts`.
- `src/main/plugins/coordinator/renderer/CoordinatorSettings.tsx` — rename `isSdkBackend`.
- `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs` (search "stream-json") — canonical CLI argv reference.
