import { describe, it, expect } from 'vitest'
import { buildSystemPrompt } from '../llm/system-prompt'

describe('buildSystemPrompt', () => {
  it('uses short tool names — no MCP prefix in the prompt', () => {
    const prompt = buildSystemPrompt({
      projectDir: 'C:/Projects/demo',
      maxToolSteps: 6,
      enforceWorktreeInPrompt: true
    })
    // The orchestrator dispatches tools locally (the legacy SDK passthrough
    // path was removed); short names — not `mcp__<server>__<tool>` — are the
    // only form the LLM should see.
    expect(prompt).toContain('list_terminals')
    expect(prompt).toContain('spawn_terminal')
    expect(prompt).toContain('prompt_terminal')
    expect(prompt).toContain('close_terminal')
    expect(prompt).not.toContain('mcp__')
  })

  it('surfaces the maxToolSteps budget to the model', () => {
    const prompt = buildSystemPrompt({
      projectDir: 'C:/Projects/demo',
      maxToolSteps: 7,
      enforceWorktreeInPrompt: true
    })
    expect(prompt).toContain('at most 7 tool-calling steps per turn')
  })

  it('includes the worktree rule verbatim when enforceWorktreeInPrompt is true', () => {
    const prompt = buildSystemPrompt({
      projectDir: 'C:/Projects/demo',
      maxToolSteps: 5,
      enforceWorktreeInPrompt: true
    })
    expect(prompt).toContain('new git worktree under ../worktrees/<slug>')
  })

  it('drops the worktree rule when enforceWorktreeInPrompt is false', () => {
    const prompt = buildSystemPrompt({
      projectDir: 'C:/Projects/demo',
      maxToolSteps: 5,
      enforceWorktreeInPrompt: false
    })
    expect(prompt).not.toContain('new git worktree under ../worktrees/<slug>')
    expect(prompt).toContain('share the working tree')
  })

  it('embeds the project directory in the prompt', () => {
    const prompt = buildSystemPrompt({
      projectDir: 'C:/Projects/demo',
      maxToolSteps: 5,
      enforceWorktreeInPrompt: true
    })
    expect(prompt).toContain('C:/Projects/demo')
  })
})
