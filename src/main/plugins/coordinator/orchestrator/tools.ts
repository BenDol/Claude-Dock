/**
 * Tool schemas + dispatcher for the Coordinator orchestrator.
 *
 * The LLM sees a fixed vocabulary (list_terminals, spawn_terminal,
 * close_terminal, prompt_terminal, wait_for_idle). Each tool is dispatched
 * to the CoordinatorServices interface — no MCP round-trip is involved,
 * the orchestrator drives the dock directly.
 */

import type { ToolSchema } from '../llm/provider'
import type { CoordinatorServices } from '../services'

export const COORDINATOR_TOOLS: ToolSchema[] = [
  {
    name: 'list_terminals',
    description: 'List every live terminal across the user\'s dock windows with idle state and the terminal id needed for prompt_terminal / close_terminal.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: 'spawn_terminal',
    description: 'Open a new Claude Code terminal in the current project. Returns the new terminal id.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Optional human-readable title for the terminal.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'close_terminal',
    description: 'Close (kill) a terminal by id. Irrecoverable — use only for idle terminals whose work is finished.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Terminal id from list_terminals.' }
      },
      required: ['id'],
      additionalProperties: false
    }
  },
  {
    name: 'prompt_terminal',
    description: 'Write a prompt into a terminal. By default a newline is appended so the target (Claude Code) submits. Keep prompts short and self-contained.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Terminal id from list_terminals.' },
        prompt: { type: 'string', description: 'Text to inject. Include worktree setup as the first line if the coordinator enforces worktrees.' },
        submit: { type: 'boolean', description: 'Whether to submit the prompt by appending a carriage return. Defaults to true.' }
      },
      required: ['id', 'prompt'],
      additionalProperties: false
    }
  }
]

export interface ToolDispatchContext {
  projectDir: string
  services: CoordinatorServices
}

export interface ToolResult {
  content: string
  isError: boolean
}

function asString(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`Tool arg ${field} must be a non-empty string (got ${typeof v})`)
  }
  return v
}

export async function dispatchTool(
  name: string,
  rawArgs: unknown,
  ctx: ToolDispatchContext
): Promise<ToolResult> {
  const args = (typeof rawArgs === 'string'
    ? safeParse(rawArgs)
    : (rawArgs as Record<string, unknown>)) ?? {}

  try {
    switch (name) {
      case 'list_terminals': {
        const terms = ctx.services.listTerminals(ctx.projectDir)
        return { content: JSON.stringify(terms), isError: false }
      }
      case 'spawn_terminal': {
        const title = typeof args.title === 'string' ? args.title : undefined
        const id = await ctx.services.spawnTerminal(ctx.projectDir, { title })
        return { content: JSON.stringify({ id }), isError: false }
      }
      case 'close_terminal': {
        const id = asString(args.id, 'id')
        ctx.services.closeTerminal(ctx.projectDir, id)
        return { content: JSON.stringify({ ok: true }), isError: false }
      }
      case 'prompt_terminal': {
        const id = asString(args.id, 'id')
        const prompt = asString(args.prompt, 'prompt')
        const submit = args.submit === undefined ? true : Boolean(args.submit)
        const ok = ctx.services.writeToTerminal(ctx.projectDir, id, prompt, submit)
        if (!ok) {
          return {
            content: JSON.stringify({
              ok: false,
              error: `no terminal with id ${id} found in project ${ctx.projectDir}`
            }),
            isError: true
          }
        }
        return { content: JSON.stringify({ ok: true }), isError: false }
      }
      default:
        return {
          content: JSON.stringify({ error: `Unknown tool ${name}` }),
          isError: true
        }
    }
  } catch (err) {
    return {
      content: JSON.stringify({ error: (err as Error).message }),
      isError: true
    }
  }
}

function safeParse(s: string): Record<string, unknown> | null {
  try { return JSON.parse(s) } catch { return null }
}
