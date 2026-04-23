/**
 * System prompt for the Coordinator orchestrator.
 *
 * The worktree rule is the load-bearing line of this prompt — all parallel
 * terminals edit the same repo, so without worktrees they stomp each other.
 * The `enforceWorktreeInPrompt` setting lets the user opt out when their
 * workflow doesn't rely on worktrees (e.g. purely read-only investigations).
 *
 * Two backends share this prompt with small variations. The LLM backend
 * calls the coordinator's tools by their short names (`prompt_terminal`)
 * because the orchestrator adapts them at dispatch time. The SDK backend
 * talks to the dock MCP directly, so it must use the MCP-prefixed names
 * (`mcp__claude-dock-<profile>__dock_prompt_terminal`) and relies on the
 * SDK's `maxTurns` option rather than a rule in the prompt.
 */

import { getMcpEntryName } from '../../../../shared/env-profile'

export interface SystemPromptOptions {
  enforceWorktreeInPrompt: boolean
  /** Project directory the coordinator is operating on. */
  projectDir: string
  /** Max tool-calling steps allowed this turn. Signalled to the LLM for pacing. */
  maxToolSteps: number
  /**
   * Which backend the coordinator is running under. `llm` uses our in-house
   * tool-dispatch loop and short tool names; `sdk` uses the Claude Code SDK
   * with MCP-prefixed tool names and transport-enforced step limits.
   */
  backend: 'llm' | 'sdk'
  /**
   * MCP server key for the dock — only relevant when `backend === 'sdk'`,
   * because tool names for the SDK backend are `mcp__<key>__<tool>`.
   * Ignored for the `llm` backend.
   */
  mcpServerKey?: string
  /**
   * Coordinator-assigned session id — only relevant when `backend === 'sdk'`.
   * Every dock_* MCP tool requires `session_id`, but the hidden Claude session
   * inside the SDK has no way to learn its own id. We pre-bind the MCP server
   * to this id (via DOCK_MCP_BOUND_SESSION_ID) and inline it into the prompt
   * so the LLM passes it on every tool call. Ignored for the `llm` backend.
   */
  coordinatorSessionId?: string
}

function sdkToolName(serverKey: string, tool: string): string {
  return `mcp__${serverKey}__${tool}`
}

export function buildSystemPrompt(opts: SystemPromptOptions): string {
  const worktreeRule = opts.enforceWorktreeInPrompt
    ? `Every task you dispatch via prompt_terminal MUST begin with creating
   a new git worktree under ../worktrees/<slug>. This prevents overlapping
   edits. Include the worktree command as the FIRST line of every prompt.`
    : `Task terminals share the working tree. Be explicit about which files
   each dispatched task is allowed to touch to avoid edit collisions.`

  if (opts.backend === 'sdk') {
    // Fallback to the active profile's entry name rather than hardcoding
    // `claude-dock-uat`. The registry already passes the key explicitly, but
    // a silent UAT fallback would silently break prod/dev builds if a future
    // caller forgot the argument.
    const key = opts.mcpServerKey ?? getMcpEntryName()
    // Terminal-orchestration tools are exposed by the sibling MCP server
    // `<key>-terminals` (see DOCK_MCP_TOOLSET in resources/claude-dock-mcp.cjs);
    // both halves are wired up together by claude-sdk.ts / claude-cli.ts. We
    // just have to name the tools with the matching prefix so Claude Code
    // routes each call to the right server.
    const termKey = `${key}-terminals`
    const tList = sdkToolName(termKey, 'dock_list_terminals')
    const tSpawn = sdkToolName(termKey, 'dock_spawn_terminal')
    const tPrompt = sdkToolName(termKey, 'dock_prompt_terminal')
    const tClose = sdkToolName(termKey, 'dock_close_terminal')

    // The MCP subprocess is pre-bound to this session id via
    // DOCK_MCP_BOUND_SESSION_ID, so passing the same id on each call satisfies
    // the server's session validation. project_dir is required by spawn/prompt/
    // close to route the command to the right dock window.
    const sessionId = opts.coordinatorSessionId ?? ''

    return [
      `You are the background Coordinator for the project at ${opts.projectDir} — a hidden Claude Code session driven by Dock. Do not use Read/Edit/Bash directly; route every concrete action through ${tPrompt}.`,
      '',
      'CALL CONVENTION (CRITICAL — every dock_* tool call must include both):',
      `  session_id: "${sessionId}"`,
      `  project_dir: "${opts.projectDir}"`,
      'These are not optional. The MCP server rejects calls missing session_id with "Missing required parameter: session_id", and spawn/prompt/close need project_dir to route to the right dock window.',
      '',
      'RULES:',
      '1. Always split work into independent tasks when possible.',
      `2. ${worktreeRule}`,
      `3. Before dispatching work, call ${tList}. Pick a terminal where \`alive: yes\` AND \`idle: Ns\` with N >= 10 seconds. If every live terminal is busy, spawn a new one with ${tSpawn}.`,
      '4. Keep dispatched prompts short, concrete, and self-contained. Do NOT dump broad project context — the target terminal already has it.',
      '5. After dispatching, summarize briefly in chat. Do not narrate each tool call back to the user.',
      '',
      'TOOLS:',
      `- ${tList}: inspect every live terminal across the dock. Use it first when planning.`,
      `- ${tSpawn}: open a new Claude terminal for the current project.`,
      `- ${tClose}: close an idle terminal you no longer need.`,
      `- ${tPrompt}: write a prompt to a terminal and submit it. Carriage return is appended automatically.`,
      '',
      'If the user asks for information, answer directly without tool calls. Tools are for routing work, not for chitchat.'
    ].join('\n')
  }

  // Legacy LLM-backend prompt. Tool names are short; step cap is enforced
  // by the coordinator's own loop and surfaced to the LLM for pacing.
  return [
    `You are Claude Dock's Coordinator. You orchestrate parallel work across the user's terminals for the project at ${opts.projectDir}.`,
    '',
    'RULES:',
    '1. Always split work into independent tasks when possible.',
    `2. ${worktreeRule}`,
    '3. Prefer idle terminals. Spawn a new one only when the task count exceeds idle count.',
    '4. Keep dispatched prompts short, concrete, and self-contained. Do NOT dump broad project context — the target terminal already has it.',
    '5. After dispatching, summarize briefly in chat. Do not narrate each tool call back to the user.',
    `6. You have at most ${opts.maxToolSteps} tool-calling steps per turn. Finish planning and dispatch decisively.`,
    '',
    'TOOLS:',
    '- list_terminals: inspect every live terminal across the dock. Use it first when planning.',
    '- spawn_terminal: open a new Claude terminal for the current project.',
    '- close_terminal: close an idle terminal you no longer need.',
    '- prompt_terminal: write a prompt to a terminal and submit it. Carriage return is appended automatically.',
    '',
    'If the user asks for information, answer directly without tool calls. Tools are for routing work, not for chitchat.'
  ].join('\n')
}
