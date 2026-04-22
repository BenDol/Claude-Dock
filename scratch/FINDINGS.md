# Coordinator-SDK Backend — Investigation Findings

Results from the six-thread investigation defined in
`C:/Users/dolb9/.claude/plans/giggly-skipping-parnas.md`. Raw event fixtures live
beside this file in `sdk-spike/events.log` and `sdk-spike/events-turn2.log`.

---

## Thread 1 — SDK smoke test: **PASS**

`@anthropic-ai/claude-agent-sdk@0.2.116` runs in-process from Node v22.16.0 on
Windows. No separate `claude` CLI install required — the SDK ships a
`@anthropic-ai/claude-agent-sdk-win32-x64` optional-dependency binary that it
invokes internally.

What the spike did: `query({ prompt, options })` with our dock MCP configured
as stdio, `allowedTools: ['mcp__claude-dock-uat__dock_status']`, then iterated
events.

What we observed: 13 events total, `dock_status` fired with `is_error=false`,
zero permission prompts, used the user's Claude Code subscription auth.

**Call path for wiring the real provider:**
```js
import { query } from '@anthropic-ai/claude-agent-sdk'
const q = query({
  prompt: userMessage,
  options: {
    mcpServers: { 'claude-dock-uat': { type: 'stdio', command: 'node',
                                        args: [mcpPath], env: { DOCK_DATA_DIR }}},
    allowedTools: ['mcp__claude-dock-uat__*'],  // wildcard
    tools: [],            // disable built-in tools to keep coordinator scoped
    appendSystemPrompt: buildCoordinatorPrompt(...),
    persistSession: true, // required for resume
    resume: storedSessionIdOrUndefined
  }
})
for await (const msg of q) { ... }
```

**Open concern for Thread 6:** The SDK inherited the user's OTHER MCP servers
(voice-input, Google auth) even though I only passed `claude-dock-uat` in
`mcpServers`. For production we likely want to scope the coordinator to our
MCP only. Either pass `extraArgs: { 'strict-mcp-config': null }` (equivalent
to the CLI `--strict-mcp-config` flag) or live with inheritance. TBD in
Thread 6 wiring.

---

## Thread 2 — Dock-side trust: **PASS (end-to-end verified)**

MCP-side trust: after `dock_status` bound the coordinator session,
`dock_list_terminals` (which requires `validateSessionBinding`) also returned
`is_error=false`.

End-to-end verification (2026-04-21): `spike-prompt-terminal.mjs` ran against
the live dock, picked an idle terminal in the dock's project, and issued
`dock_prompt_terminal`:

- Coordinator session id: `coordinator-e2e-1776797303906` (never bound to any
  visible terminal).
- Target terminal id: `term-6-1776796755418` (session
  `c7e95be2…`, owned by the visible Claude instance — not the coordinator).
- Tool result: `ok=true`, dock replied `"Prompt sent to terminal
  term-6-1776796755418."`
- `result.stop_reason = end_turn`, `is_error = false`.

**Implication:** the dock main process routes `dock-terminal-commands.json`
entries purely by `terminalId`, not by whether the requesting session owns
the terminal. Phase 1's inspection of `dock-window.ts:268-312` is confirmed.
No dock-side changes are needed for the coordinator role.

**Surprise win (folds into Task #19):** `dock_list_terminals` already exposes
`alive: yes/no` and `idle: Ns` (seconds since last output) per terminal, plus
a truncated `last:` line. That's a usable starting signal for pick-an-idle-
terminal logic; the remaining gap is that "idle seconds" is time-since-last-
output, not true busy/idle state (a thinking Claude can be silent for 30s
while still mid-turn). See Task #19 section below.

---

## Thread 3 — SDK event-to-ChatDelta mapping: **PASS**

Event types observed in the fixtures, with mappings:

| SDK event                              | Our `ChatDelta`                                       | Notes |
|----------------------------------------|-------------------------------------------------------|-------|
| `system` / `hook_started` \| `hook_response` | none (ignore)                                   | hooks lifecycle, not user-relevant |
| `system` / `init`                      | none (metadata capture only)                          | extract `session_id`, `mcp_servers[].status` for diagnostics |
| `system` / `api_retry`                 | optional `{type:'text', delta:'[retrying…]'}`         | cosmetic; can be dropped |
| `system` / `compact_boundary`          | none                                                  | informational; log only |
| `assistant` with `content[].type=text` | `{type:'text', delta: text}`                          | these are COMPLETE messages, not deltas — concat into renderer's current turn |
| `assistant` with `content[].type=tool_use` | `{type:'tool_call', id, name, args: input}`       | name is prefixed `mcp__<server>__<tool>` — strip for display |
| `user` with `content[].type=tool_result` | render as pill only; do NOT emit a ChatDelta       | in SDK mode the orchestrator doesn't dispatch, so no synthetic pairing needed |
| `result` / `success`                   | `{type:'done', stopReason: mapStop(stop_reason)}`     | `stop_reason === 'end_turn'` → `end_turn`; `'tool_use'` shouldn't terminate a turn in SDK mode; else `'error'` |
| `result` / `error_max_turns` etc.      | `{type:'done', stopReason:'error', errorMessage}`     | surface SDK error to user |

For richer streaming (typing indicator etc.) we can flip
`includePartialMessages: true` later and map `stream_event` → per-token text
deltas. Not required for v2.

**Key mapping invariant:** in SDK-backed mode we do NOT emit synthetic
`tool_result` ChatDeltas — the SDK dispatches the tool internally via MCP, so
our orchestrator's v1 pairing assumption (`tool_call` ChatDelta followed by a
later tool_result ChatDelta we emit ourselves) no longer holds. The renderer
needs to accept lone `tool_call` deltas and display them as "action" pills
without waiting for a paired result.

---

## Thread 4 — Session continuity: **PASS**

Recipe, verified end-to-end:

1. On first turn, call `query({ prompt, options })` with `persistSession: true`
   and NO `resume`.
2. Capture `session_id` from any event (every event carries it, but the
   `system`/`init` event is the earliest and cleanest).
3. Store `session_id` in `coordinator-chat-store` keyed by `projectDir`.
4. On subsequent turns: `query({ prompt, options: { ...opts, resume:
   storedSessionId }})`. The resumed turn inherits full conversation history.
5. **After each turn, capture and store the NEW `session_id`** — the SDK
   forks to a new id on every resume (observed: `383e84ef…` → `bdb057d4…`).
   The next resume uses the newer one, chaining forward.

Confirmed: turn 2 correctly remembered "Saw 0 terminals." from turn 1 and
replied `"0"`.

**Storage shape in coordinator-chat-store:**
```ts
{
  projectDir: string,
  latestSessionId: string | null,     // null = next turn starts fresh
  messages: [...]                     // existing field
}
```

**Edge case:** user clicks "Clear" in the coordinator panel → we clear
`latestSessionId` alongside the message history. Next turn starts a fresh
SDK session.

---

## Thread 5 — Coordinator system prompt design: **DONE**

**Decisions:**
- Use `appendSystemPrompt` (not `systemPrompt`) — keeps Claude Code's default
  guardrails and adds coordinator-specific rules on top.
- Reuse `buildSystemPrompt()` in `src/main/plugins/coordinator/llm/system-prompt.ts`
  with a small adapter:
  - Rewrite the `TOOLS:` section to name the MCP tools explicitly:
    `mcp__claude-dock-uat__dock_list_terminals` etc.
  - Drop the `"You have at most N tool-calling steps"` line — the SDK's
    `maxTurns` option enforces this at the transport level.
  - Add a line near the top: *"You are the background Coordinator for this
    project — a hidden Claude Code session driven by Dock. Do not use the
    Read/Edit/Bash tools directly; route every concrete action through
    prompt_terminal."*
- Do NOT ship a `.claude/skills/dock-coordinator/SKILL.md` file in v2.
  Rationale: the system prompt gets us there without the install-time skill
  copy + user-profile write permission + skill-discovery timing. Skill file
  stays an optional follow-up for users who want per-project customisation.

**New/changed file:** extend `buildSystemPrompt` with a `backend: 'llm' |
'sdk'` flag and branch on that. One function, two outputs.

---

## Thread 6 — Passthrough wiring: **DESIGN READY**

File-by-file changes needed for the implementation plan:

### `src/main/plugins/coordinator/llm/`
- **provider.ts** — add optional `passthrough?: boolean` to `LLMProvider` (or
  a narrower `emitsChatDeltasWithInternalTooling: boolean`). Signals the
  orchestrator that tool_call deltas do NOT require dispatch.
- **registry.ts** — add `case 'claude-sdk':` to `createProvider` and a
  `PROVIDER_PRESETS` entry.
- **claude-sdk.ts (new)** — implements `LLMProvider.chat()` by wrapping
  `query()` and translating events via the Thread 3 mapping table. Manages
  the `resume` session-id chain (Thread 4) via `CoordinatorChatStore`.

### `src/main/plugins/coordinator/orchestrator/`
- **orchestrator.ts:213** — branch: `if (provider.passthrough) { skip
  dispatchTool loop; just forward ChatDeltas to the renderer }`. v1 loop
  stays as the `else` branch for LLM providers.

### `src/main/plugins/coordinator/`
- **coordinator-chat-store.ts** — add `latestSessionId: string | null` per
  project. `clear(projectDir)` also nulls it.
- **coordinator-settings-store.ts** — add `backend: 'llm' | 'claude-sdk'`.
  Default `'llm'` for existing installs (no surprise migrations).

### `src/renderer/src/`
- **coordinator-settings panel** — add backend dropdown. When `claude-sdk`:
  hide api-key / base-url / model inputs. Show a "uses your Claude Code
  subscription" blurb.

### Packaging
- **package.json** — add `@anthropic-ai/claude-agent-sdk` as a regular dep.
  Size: 97 packages, ~7s install. The win32 prebuilt is ~16MB — verify
  `electron-builder.config.js` bundles the correct platform binary (the
  optional-dependency pattern should handle this automatically, but confirm
  the build doesn't accidentally pick up `linux-x64` on a cross-build).

### What explicitly does NOT change
- `resources/claude-dock-mcp.cjs` — Thread 2 (MCP side) confirmed no changes
  needed. Pending full Thread 2 verification with dock running for the PTY
  injection edge.
- `src/main/linked-mode.ts` — no install-time artefacts required (no skill
  file in v2).
- The orchestrator's tool-call rendering (renderer side) — tool_call pills
  already render; they just won't be paired with tool_results in SDK mode
  (verify the renderer doesn't wait for pairing before displaying).

---

## Task #19 — Terminal-state tracking for coordinator dispatch

**Problem.** The coordinator will dispatch work to user terminals via
`dock_prompt_terminal`. We need to pick terminals that are *actually idle*,
not just terminals whose output happens to have paused. Sending a prompt to
a terminal that is mid-turn (thinking, reading files, calling tools) would
either corrupt its input or pile up a queued prompt the user didn't request.

**What we already have** (observed 2026-04-21):

| Signal | Source | Strength | Weakness |
|---|---|---|---|
| `isAlive: boolean` | `dock-activity.json` + `dock_list_terminals` | Reliable | Binary — tells us nothing about busy vs idle |
| `idle: Ns` (seconds since last output) | `dock_list_terminals` text output | Cheap, already there | "No output for 30s" does not equal "waiting for input"; a thinking Claude is silent |
| `recentLines[]` | `dock-activity.json` | Rich | Unstructured — parsing chars like `>`, `✶ Warping…`, `Thinking…` is fragile and version-drifts |
| `lastUpdate: epoch_ms` | `dock-activity.json` | Reliable | Same weakness as `idle:` — activity is I/O, not state |

**Design options** (ordered by implementation cost, lowest first):

**Option A — heuristic via existing signals.** Coordinator picks a terminal
where `isAlive=true` AND the last non-empty `recentLines` entry is a bare
`>` prompt AND `idle >= threshold` (say 10s). This is what the spike does
and it works for the obvious cases. Failure modes: a terminal that just
accepted input but hasn't yet rendered `>` looks "idle" for a brief window;
Claude Code UI changes break the regex.

**Option B — add a structured status field to `dock-activity.json`.** The
dock already tracks terminal activity. Have it classify each terminal as
`idle | thinking | tool_use | awaiting_input | errored` based on what it
sees on the PTY (prompt redraw, tool_use banner, permission dialog). Expose
this as `status: string` per terminal, surfaced via `dock_list_terminals`.
Cost: dock main-process changes, per-UI-release fragility still applies to
the classifier. Upside: one authoritative signal the coordinator can trust.

**Option C — handshake via the MCP.** The coordinator's prompt always ends
with a unique sentinel token and an instruction "when you finish, run
`dock_report_done <token>`". A new MCP tool `dock_report_done` writes to
`dock-terminal-completions.json`; the coordinator polls/subscribes. Cost:
new MCP tool, contract change to the system prompt. Upside: correct by
construction — doesn't depend on scraping terminal state. Downside: user's
visible Claude has to cooperate (follow the instruction), which is a new
coordination rule the user might edit or ignore.

**Option D — treat the coordinator itself as the source of truth.** The
coordinator maintains its own map `{terminalId → currentTask}`. When a task
is dispatched it flips to `busy`; when the coordinator observes a reply
from the terminal (via whatever back-channel) it flips to `idle`. Cost:
needs a back-channel — either Option C's sentinel or a new stream of
terminal-output events sent to the coordinator. Essentially a superset of C.

**Interim (keeps v2 moving):** ship **Option A** with the threshold and the
prompt-regex extracted into one place that's easy to adjust. Add a unit
test with fixture recentLines. Land **Option C** as a follow-up once the
v2 backend is in users' hands — we'll have real data on how often A picks
wrong, which lets us justify C's complexity.

**Exit criterion for Task #19 in this investigation:** the decision above
(ship A now, defer C) plus a short file-level sketch of where the idle-
picker lives in the new SDK provider. Not: actually implementing B or C.

**Sketched location in the v2 code:**
- Add `pickIdleTerminal(projectDir): Promise<string | null>` to a new file
  `src/main/plugins/coordinator/terminal-selector.ts`. It reads
  `dock-activity.json` (path from the same dock-link config the MCP uses)
  and applies the Option-A rules. The SDK coordinator calls this when it
  wants to dispatch work; the result is passed to `dock_prompt_terminal` in
  the prompt it sends to the hidden Claude, OR the coordinator asks the
  hidden Claude to call `dock_list_terminals` itself and pick by the same
  rules (system-prompt expresses the rules). The second variant keeps the
  selection logic inside the LLM and is simpler — recommended.

---

## Summary — decisions locked

| Decision | Value |
|---|---|
| Backend mechanism | Agent SDK, in-process |
| Node runtime | v22+ (already our target) |
| Claude CLI binary | not required (SDK bundles via optionalDep) |
| MCP reuse | same `claude-dock-mcp.cjs`, no changes |
| System prompt delivery | `appendSystemPrompt` |
| Skill file | deferred to post-v2 |
| Session persistence | per-project `latestSessionId` in coordinator-chat-store |
| Tool dispatch | SDK-internal; orchestrator adds `passthrough` branch |
| Strict MCP scope | `strictMcpConfig: true` (first-class SDK option; forwards to `--strict-mcp-config`) |
| Default backend for new users | `'llm'` unchanged; opt-in to `'claude-sdk'` |

## Outstanding before implementation plan

1. ~~End-to-end Thread 2 verification~~ — **DONE** 2026-04-21. See Thread 2
   section above.
2. ~~**Strict MCP scope**~~ — **RETIRED** during v2 Phase 9. The SDK exposes
   this as a first-class option (`strictMcpConfig: boolean`), not an
   `extraArgs` escape hatch. Grepping `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`
   confirms `strictMcpConfig: true` is forwarded to the CLI as
   `--strict-mcp-config`, which in Claude Code semantics means *"only use
   MCP servers from --mcp-config; ignore user/project configs."* Our
   provider passes `strictMcpConfig: true` unconditionally; the `claude-sdk`
   unit test asserts the flag reaches `query()`. No `disallowedTools`
   fallback needed.
3. **SDK packaging verification** — build the dock app with the SDK dep and
   confirm the Windows-x64 prebuilt is unpacked correctly at runtime. Also
   best done as the first step of the v2 implementation (build-before-wire).
4. **Idle-terminal selection (Task #19)** — Option A heuristic decided
   above; implementation lives in the v2 coordinator SDK provider (or is
   expressed purely in the coordinator's system prompt — leaning toward the
   latter per the sketch in the Task #19 section).

Items 3–4 are engineering confirmation steps, not design unknowns. Safe to
proceed to a v2 implementation plan.
