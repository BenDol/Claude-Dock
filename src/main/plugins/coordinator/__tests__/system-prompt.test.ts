import { describe, it, expect } from 'vitest'
import { buildSystemPrompt } from '../llm/system-prompt'

describe('buildSystemPrompt — SDK backend', () => {
  it('uses the supplied mcpServerKey to build MCP-prefixed tool names', () => {
    const prompt = buildSystemPrompt({
      backend: 'sdk',
      projectDir: 'C:/Projects/demo',
      maxToolSteps: 5,
      enforceWorktreeInPrompt: true,
      mcpServerKey: 'claude-dock-prod'
    })

    // All four MCP tools must appear, fully prefixed. A missing prefix here
    // would mean the hidden Claude calls the wrong tool name and the SDK
    // rejects it via `strictMcpConfig` / `allowedTools`.
    expect(prompt).toContain('mcp__claude-dock-prod__dock_list_terminals')
    expect(prompt).toContain('mcp__claude-dock-prod__dock_spawn_terminal')
    expect(prompt).toContain('mcp__claude-dock-prod__dock_prompt_terminal')
    expect(prompt).toContain('mcp__claude-dock-prod__dock_close_terminal')

    // The LLM-backend short names must NOT leak into the SDK prompt —
    // the SDK has no adapter that maps them back.
    expect(prompt).not.toMatch(/\blist_terminals\b(?!_)/)
    expect(prompt).not.toMatch(/\bspawn_terminal\b(?!_)/)
  })

  it('falls back to the active profile entry name when mcpServerKey is omitted', () => {
    const prompt = buildSystemPrompt({
      backend: 'sdk',
      projectDir: 'C:/Projects/demo',
      maxToolSteps: 5,
      enforceWorktreeInPrompt: true
      // mcpServerKey deliberately omitted
    })

    // `__ENV_PROFILE__` is undefined in the test harness, so env-profile
    // resolves to the `uat` fallback → key `claude-dock-uat`.
    expect(prompt).toContain('mcp__claude-dock-uat__dock_prompt_terminal')
  })

  it('includes the worktree rule verbatim when enforceWorktreeInPrompt is true', () => {
    const prompt = buildSystemPrompt({
      backend: 'sdk',
      projectDir: 'C:/Projects/demo',
      maxToolSteps: 5,
      enforceWorktreeInPrompt: true,
      mcpServerKey: 'claude-dock-uat'
    })
    expect(prompt).toContain('new git worktree under ../worktrees/<slug>')
  })

  it('drops the worktree rule when enforceWorktreeInPrompt is false', () => {
    const prompt = buildSystemPrompt({
      backend: 'sdk',
      projectDir: 'C:/Projects/demo',
      maxToolSteps: 5,
      enforceWorktreeInPrompt: false,
      mcpServerKey: 'claude-dock-uat'
    })
    expect(prompt).not.toContain('new git worktree under ../worktrees/<slug>')
    expect(prompt).toContain('share the working tree')
  })
})

describe('buildSystemPrompt — LLM backend', () => {
  it('uses short tool names without any MCP prefix', () => {
    const prompt = buildSystemPrompt({
      backend: 'llm',
      projectDir: 'C:/Projects/demo',
      maxToolSteps: 6,
      enforceWorktreeInPrompt: true
    })
    expect(prompt).toContain('list_terminals')
    expect(prompt).toContain('prompt_terminal')
    expect(prompt).not.toContain('mcp__')
  })

  it('surfaces the maxToolSteps budget to the model', () => {
    const prompt = buildSystemPrompt({
      backend: 'llm',
      projectDir: 'C:/Projects/demo',
      maxToolSteps: 7,
      enforceWorktreeInPrompt: true
    })
    expect(prompt).toContain('at most 7 tool-calling steps per turn')
  })
})
