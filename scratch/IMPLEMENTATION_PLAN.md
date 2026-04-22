# Coordinator-SDK Backend — v2 Implementation Plan

**Source of truth for the "why"**: `./FINDINGS.md`, which captures all six
investigation threads and the Task #19 (terminal-state tracking) design.

**Source of truth for the "what"**: this document.

Plan is ordered so that each phase is independently verifiable and
revertable. If a phase fails its exit criterion, stop and re-scope — don't
start the next phase with the current one half-working.

---

## Phase completion status — 2026-04-21

| Phase | Status |
|---|---|
| 0 — Dependency + packaging | ✅ done (SDK installed, asarUnpack verified) |
| 1 — Type surface            | ✅ done |
| 2 — `claude-sdk` provider   | ✅ done (`src/main/plugins/coordinator/llm/claude-sdk.ts`) |
| 3 — Orchestrator passthrough | ✅ done (guard in `orchestrator.ts`) |
| 4 — System prompt variant   | ✅ done (SDK branch added) |
| 5 — Session persistence     | ✅ done (chat store wraps to `{messages, latestSessionId}`) |
| 6 — Registry wiring         | ✅ done (`createProvider` takes `ProviderDeps`) |
| 7 — Settings UI             | ✅ done (SDK info blurb; model/temp hidden) |
| 8 — Tests                   | ✅ done (`claude-sdk.test.ts` 10 cases, `orchestrator-passthrough.test.ts` 2 cases) |
| 9 — Strict-MCP-config       | ✅ verified (`strictMcpConfig: true` → `--strict-mcp-config`) |
| 10 — Docs + merge           | 🟡 pending user review (commits/merge are user-gated) |

**Suite health**: 1072 tests across 78 files pass on this branch.

---

## Phase 0 — Dependency + packaging verification

Goal: prove the SDK builds, packages, and runs inside our Electron app
BEFORE we write any wiring code. If the Windows prebuilt doesn't resolve
at runtime in a packaged build, everything downstream is wasted work.

**Actions**
1. In the repo root: `npm install @anthropic-ai/claude-agent-sdk@^0.2.116`.
2. Import the SDK from `src/main/plugins/coordinator/llm/__probe__.ts`
   (throwaway): `import { query } from '@anthropic-ai/claude-agent-sdk'`.
   Expose a temporary IPC channel that calls `query({ prompt: 'say hi' })`
   with `tools: []` and iterates one event.
3. `npm run build` and `npm run start` (packaged build, not vite dev).
4. Trigger the probe IPC; confirm it reaches an `init` event with
   `mcp_servers=[]` and `model=claude-opus-4-7`.
5. In `electron-builder.config.js` (or `package.json > build`) confirm the
   SDK's optional-dependency prebuilt binary
   (`@anthropic-ai/claude-agent-sdk-win32-x64`) is included in the asar
   unpack list OR is bundled by default. Inspect the produced `app.asar`
   via `npx asar list` and grep for the platform binary name.

**Exit criterion**
- Probe IPC produces a non-error `init` event on a packaged Windows build.
- No missing-binary runtime error.
- Delete the probe file before merging Phase 0 — it's throwaway.

**Revert**: remove the `dependencies` entry and the probe file.

---

## Phase 1 — Type surface

Goal: make the TypeScript compiler aware of the new backend without
breaking the existing switch-exhaustiveness check in `registry.ts`.

**Files**
- `src/shared/coordinator-types.ts`
  - Add `'claude-sdk'` to `CoordinatorProviderId`.
  - Add a `CoordinatorProviderPreset` entry for `'claude-sdk'` (no baseUrl,
    no requiresApiKey, `defaultModel: 'claude-opus-4-7'` as a display-only
    value — the SDK picks the model, not us).
- `src/main/plugins/coordinator/llm/provider.ts`
  - Add `readonly passthrough?: boolean` to `LLMProvider`. Document: "When
    true, the orchestrator does not dispatch tool_call deltas locally — the
    provider runs tools internally (e.g. via MCP) and the orchestrator
    only streams deltas to the renderer."

**Exit criterion**
- `npm run typecheck` passes.
- Any existing `switch (id)` over `CoordinatorProviderId` surfaces as an
  unhandled case in the compiler output — that's the registry switch in
  Phase 5, expected.

---

## Phase 2 — `claude-sdk` provider

Goal: translate SDK events into our `ChatDelta` stream per the Thread 3
mapping table in `FINDINGS.md`. Manages the session-id resume chain
(Thread 4).

**New file:** `src/main/plugins/coordinator/llm/claude-sdk.ts`

**Surface**
```ts
export function createClaudeSdkProvider(deps: {
  projectDir: string          // for session-id chain lookup
  dockDataDir: string         // DOCK_DATA_DIR env for the MCP subprocess
  mcpScriptPath: string       // absolute path to claude-dock-mcp.cjs
  getLatestSessionId: (projectDir: string) => string | null
  setLatestSessionId: (projectDir: string, id: string) => void
}): LLMProvider
```

**Behaviour**
- `passthrough = true`.
- `chat(req, signal)`:
  - Uses `req.system` as `options.appendSystemPrompt`.
  - Flattens `req.messages` into a single prompt string: the last `user`
    message's text. (Prior turns are not re-sent — `resume` carries them.)
  - `options.mcpServers = { 'claude-dock-uat': { type:'stdio', command:'node',
    args:[mcpScriptPath], env:{ DOCK_DATA_DIR: dockDataDir } } }`.
  - `options.allowedTools = ['mcp__claude-dock-uat__*']` (wildcard).
  - `options.tools = []` (disable built-in Read/Edit/Bash).
  - `options.persistSession = true`.
  - `options.resume = deps.getLatestSessionId(deps.projectDir)` (undefined
    if none).
  - Attach signal cancellation — the SDK `query()` accepts `{ abort: signal }`
    via its options. Verify the exact option name in Phase 0's probe.
  - For each event:
    | SDK event | Action |
    |---|---|
    | `system/init` | capture `session_id` for later persistence |
    | `assistant.content[].text` | yield `{type:'text', delta:text}` |
    | `assistant.content[].tool_use` | yield `{type:'tool_call', id, name, args:input}` |
    | `user.content[].tool_result` | ignore (no ChatDelta emitted — see FINDINGS Thread 3) |
    | `result/success` | yield `{type:'done', stopReason: mapStop(stop_reason)}` and `setLatestSessionId(captured)` |
    | `result/error_*` | yield `{type:'done', stopReason:'error', errorMessage}` |
    | other `system/*` (hook, retry, compact) | ignore |
- `testConnection()`: call `query({ prompt: 'ping', options: { tools: [],
  mcpServers: {}, persistSession: false } })`, iterate until `result`, return
  `{ ok: true, model: 'claude-opus-4-7' }` on success.

**Tool-name stripping for display**
The Thread 3 mapping notes the `mcp__claude-dock-uat__` prefix. We do NOT
strip at the provider level — the orchestrator and UI already handle the
tool name as an opaque string. Display-side stripping is a separate
renderer-side tweak if we decide it looks noisy.

**Exit criterion**
- Unit test (Phase 8) using a recorded fixture from `sdk-spike/events.log`
  produces exactly the expected `ChatDelta` sequence.
- `testConnection()` returns `ok: true` against a live SDK with valid auth.

---

## Phase 3 — Orchestrator passthrough branch

Goal: when the provider has `passthrough === true`, skip the local
`dispatchTool` loop at `orchestrator.ts:211-238` and the multi-step
outer loop. The SDK handles its own tool-use iteration; we emit exactly
one assistant turn per user message.

**File:** `src/main/plugins/coordinator/orchestrator/orchestrator.ts`

**Change** (pseudocode, at the top of `runTurn`):
```ts
if (provider.passthrough) {
  await runPassthroughTurn({ provider, projectDir, userText, config, signal })
  return
}
// else: existing loop, unchanged
```

`runPassthroughTurn` is a new local helper that:
- Persists the user message (already happens above the branch — move it
  up so both paths share it).
- Creates ONE assistant placeholder, streams deltas into it, broadcasts
  `text` and `tool_call` payloads as they arrive.
- Does NOT call `dispatchTool` — tool_call deltas are display-only.
- Does NOT emit synthetic `tool_result` ChatDeltas (covered in FINDINGS).
- Finalises on `done`:
  - `end_turn` → broadcast `done`, persist final message, return.
  - `error` → broadcast `error`, persist, return.
  - `tool_use` stop reason should NOT terminate a passthrough turn — if we
    see it, log a warning (the SDK is supposed to keep looping
    internally). Defensive: treat as `end_turn`.

**Renderer impact**
`tool_call` ChatDeltas arrive without a paired `tool_result` broadcast.
Confirm the renderer's `CoordinatorMessage` rendering shows the tool-call
pill immediately instead of waiting for a pairing. If it waits, add a
`paired?: boolean` flag and render unpaired calls as "action" pills.
(Inspect `src/main/plugins/coordinator/renderer/register.ts` and the
renderer store — likely a 3-line change or a no-op.)

**Exit criterion**
- Unit test: passthrough provider emitting the FINDINGS Thread 3 sequence
  produces the expected `CoordinatorStreamEvent` broadcasts AND does NOT
  call `dispatchTool` (spy on it).
- Manual test: user types "what terminals are open?" in coordinator panel
  with `claude-sdk` selected; UI shows the tool-call pill for
  `dock_list_terminals` and the assistant's text reply, no error.

---

## Phase 4 — System prompt variant

Goal: the same coordinator rules, but phrased for the SDK backend where
tool names are `mcp__claude-dock-uat__*` and there's no per-turn step cap
enforced by our loop.

**File:** `src/main/plugins/coordinator/llm/system-prompt.ts`

**Change**
```ts
export interface SystemPromptOptions {
  enforceWorktreeInPrompt: boolean
  projectDir: string
  maxToolSteps: number
  backend: 'llm' | 'sdk'   // NEW
}
```

**For `backend === 'sdk'`:**
- Replace the `TOOLS:` section tool names with the MCP-prefixed names:
  `mcp__claude-dock-uat__dock_list_terminals`,
  `mcp__claude-dock-uat__dock_spawn_terminal`,
  `mcp__claude-dock-uat__dock_prompt_terminal`,
  `mcp__claude-dock-uat__dock_close_terminal`.
- Drop rule 6 (`"You have at most N tool-calling steps"`). The SDK's
  `maxTurns` option enforces it at the transport level (set to the same
  `maxToolStepsPerTurn` value from config).
- Add a line near the top: *"You are the background Coordinator for this
  project — a hidden Claude Code session driven by Dock. Do not use
  Read/Edit/Bash directly; route every concrete action through
  dock_prompt_terminal."*
- Add an idle-terminal rule (Task #19 Option A): *"Before dispatching
  work, call dock_list_terminals. Pick a terminal where `alive: yes` AND
  `idle: Ns` where N >= 10. If all live terminals are busy, spawn a new
  one with dock_spawn_terminal."*

**Exit criterion**
- Unit test snapshot for each `backend` variant.
- `orchestrator.ts` passes `backend` through based on
  `provider.passthrough`.

---

## Phase 5 — Session persistence

Goal: resume the hidden Claude across user messages so it remembers which
terminals it dispatched work to.

**File:** `src/main/plugins/coordinator/coordinator-chat-store.ts`

**Change**
- Switch the per-project value shape from `CoordinatorMessage[]` to:
  ```ts
  interface ProjectChatState {
    messages: CoordinatorMessage[]
    latestSessionId: string | null
  }
  ```
- Migration: on first read of an old-shape entry (plain array), wrap it as
  `{ messages: array, latestSessionId: null }` and write back.
- Add `getLatestSessionId(projectDir)`, `setLatestSessionId(projectDir, id)`,
  `clearLatestSessionId(projectDir)`.
- In `clearHistory(projectDir)`: also null `latestSessionId`.

**Exit criterion**
- Existing `coordinator-chat-store.test.ts` still passes (add migration
  coverage).
- New test: set, read back, clear resets to null.

---

## Phase 6 — Registry wiring

Goal: hook the provider into `createProvider` + presets. Done after
Phases 2 and 5 so the constructor has everything it needs.

**File:** `src/main/plugins/coordinator/llm/registry.ts`

**Changes**
- `PROVIDER_PRESETS['claude-sdk'] = { id, label: 'Claude Code subscription',
  defaultModel: 'claude-opus-4-7', requiresApiKey: false }`.
- `createProvider` signature grows a second argument:
  ```ts
  export function createProvider(
    id: CoordinatorProviderId,
    config: ProviderConfig,
    deps?: { projectDir: string; dockDataDir: string; mcpScriptPath: string }
  ): LLMProvider
  ```
- `case 'claude-sdk':` pulls `deps` (throws if missing) and constructs the
  provider with `getLatestSessionId` / `setLatestSessionId` wired to
  `coordinator-chat-store`.
- `orchestrator.ts`'s call site passes the new `deps` argument; it already
  has `projectDir`. `dockDataDir` comes from `getServices()` (needs a new
  accessor — mirror the path the MCP uses: `app.getPath('userData')`).
- `mcpScriptPath` — compute once at plugin init from the linked-mode
  resource path. Fail loudly if the file doesn't exist.

**Exit criterion**
- `npm run typecheck` passes (Phase 1's unhandled-case warning resolves).
- Existing providers still instantiate.

---

## Phase 7 — Settings UI

Goal: user can opt in to the SDK backend. When selected, api-key/baseUrl
inputs are hidden because they don't apply.

**Files**
- `src/main/plugins/coordinator/coordinator-settings-store.ts` — no
  structural change (the `provider` field already accepts any
  `CoordinatorProviderId`). Verify defaults don't auto-migrate existing
  users off their current provider.
- `src/renderer/src/**/CoordinatorSettingsPanel.*` — find and audit:
  - Add `'claude-sdk'` to the provider dropdown via `listProviderPresets()`
    (it'll appear automatically since Phase 6 added it).
  - When `selected.id === 'claude-sdk'`: hide `apiKey`, `baseUrl`, and
    `model` inputs. Show a short info card: *"Uses your Claude Code
    subscription. No API key required. Requires you to be signed in to
    Claude Code on this machine."*
  - Temperature stays visible (the SDK accepts it via `options.temperature`
    — confirm in Phase 2).

**Default-backend policy**
- `DEFAULT_COORDINATOR_CONFIG.provider` stays `'groq'`. Existing users'
  settings are untouched. `claude-sdk` is explicit opt-in. New users see
  the full list including `claude-sdk`.

**Exit criterion**
- Manual: open coordinator settings, pick `Claude Code subscription`, the
  api-key field hides, save, reload app — setting persists.
- Manual: switch back to Groq, api-key field reappears, nothing is lost.

---

## Phase 8 — Tests

Goal: lock in the two load-bearing translations (SDK events → ChatDelta,
and ChatDelta → CoordinatorStreamEvent in passthrough mode).

**New files**
- `src/main/plugins/coordinator/llm/__tests__/claude-sdk.test.ts`
  - Fixture: `sdk-spike/events-turn2.log` (copy to `__fixtures__/`).
  - Feed events through a mocked `query()` iterator, assert ChatDelta
    sequence matches the expected array.
  - Assert session_id is captured and passed to `setLatestSessionId`.
- `src/main/plugins/coordinator/orchestrator/__tests__/passthrough.test.ts`
  - Stub provider with `passthrough: true` emits a scripted ChatDelta
    sequence; assert broadcasts match and `dispatchTool` is never called.

**Exit criterion**
- `npm test` passes. Added tests exercise the critical-path translation.

---

## Phase 9 — Strict-MCP-config verification

Goal: confirm FINDINGS Thread 1's open concern ("the SDK inherited user's
OTHER MCP servers") is addressed.

**Action**
- In Phase 2's provider: add `extraArgs: { 'strict-mcp-config': null }` to
  the SDK options. Documentation suggests this flags the CLI that our
  `mcpServers` is the ONLY MCP config to honour.
- Verify with a throwaway spike (or an integration test) that the `init`
  event's `mcp_servers` array contains ONLY `claude-dock-uat`, not the
  user's Gmail / voice / etc. servers.
- If strict-mcp-config does NOT isolate: fall back to explicit
  `disallowedTools: ['mcp__voice-input__*', 'mcp__claude_ai_*__*', ...]`
  built from a list of known-unwanted MCPs. Hardcode with a comment
  explaining why.

**Exit criterion**
- `init` event in a running `claude-sdk` session shows the coordinator's
  MCP exclusively. Capture this as a debug log line for future audits.

---

## Phase 10 — Documentation + merge

- Update the coordinator plugin's README (if one exists) with the new
  backend option.
- Squash-merge strategy: one commit per phase on the feature branch, then
  a single squash to `main` with `FINDINGS.md` + `IMPLEMENTATION_PLAN.md`
  linked in the body.
- Delete `scratch/` from the branch before merge — it's investigation
  artefact, not shipped code. The plan and findings remain accessible via
  git history if needed later.

---

## Explicit non-goals for v2

- **No `.claude/skills/dock-coordinator/SKILL.md`.** System prompt carries
  the rules. Skill file is a post-v2 follow-up for per-project
  customisation.
- **No migration tool** for existing users. `claude-sdk` is opt-in.
- **No cost/usage panel.** The SDK may report usage; we ignore it for v2.
- **No automatic strict-MCP fallback UI.** If the user's MCPs bleed
  through, they file a bug; we don't build auto-detect.
- **No Task #19 Option C (sentinel handshake).** Option A (heuristic) in
  the system prompt is sufficient for v2 per the FINDINGS analysis.

---

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| SDK's Windows prebuilt not bundled by electron-builder | Medium | Phase 0 catches this before any wiring |
| Renderer waits for tool_result pairing | Low | Phase 3 audit step; 3-line renderer fix if needed |
| `strict-mcp-config` doesn't isolate | Medium | Phase 9 documents fallback |
| Session-id chain breaks on clear-history mid-conversation | Low | Phase 5 migration + unit test covers |
| `options.abort` API shape differs from expected | Low | Phase 0 probe confirms |
| SDK auth prompts user at first use | Low | Already signed-in in the spikes; document in README if seen |

---

## Rough effort estimate

- Phase 0: 1–2 hours (one rebuild cycle)
- Phase 1–2: half a day
- Phase 3: half a day including renderer audit
- Phase 4–5: a couple hours
- Phase 6: an hour
- Phase 7: half a day (UI polish tends to eat time)
- Phase 8: half a day
- Phase 9: an hour
- Phase 10: an hour

**Total: ~2–3 focused days** on top of the investigation already landed.
