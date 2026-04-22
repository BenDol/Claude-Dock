/**
 * Smoke test for the PostToolUse worktree-detection hook.
 *
 * Spawns `resources/dock-worktree-hook.cjs` as a subprocess, feeds it a
 * simulated Claude Code hook payload on stdin, and asserts it writes the
 * expected `worktree_changed` entry into `dock-terminal-commands.json`.
 *
 * The hook's contract (see resources/dock-worktree-hook.cjs):
 *   - Only reacts to Bash/Task tool_name values.
 *   - Ignores cwds inside the project root (script lives at
 *     `<projectDir>/.claude/dock-worktree-hook.cjs`, so parent = projectDir).
 *   - Enqueues a worktree_changed command when cwd moves outside the project.
 *   - Clears (worktreePath=null) when cwd returns to the project root.
 *   - Caches last-seen cwd per session to suppress duplicate emissions.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const HOOK_SRC = path.resolve(__dirname, '../../../resources/dock-worktree-hook.cjs')

interface EnqueuedCommand {
  id: string
  op: string
  origin?: string
  projectDir: string
  sessionId: string
  worktreePath: string | null
  branch: string | null
  timestamp: number
}

/**
 * Build a temp sandbox mirroring a linked project: <projectDir>/.claude/
 * holds the hook script; <dataDir> receives the enqueued command file.
 */
function makeSandbox(): { projectDir: string; dataDir: string; hookPath: string; commandsPath: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dock-hook-'))
  const projectDir = path.join(root, 'project')
  const dataDir = path.join(root, 'data')
  fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true })
  fs.mkdirSync(dataDir, { recursive: true })
  const hookPath = path.join(projectDir, '.claude', 'dock-worktree-hook.cjs')
  fs.copyFileSync(HOOK_SRC, hookPath)
  const commandsPath = path.join(dataDir, 'dock-terminal-commands.json')
  return {
    projectDir,
    dataDir,
    hookPath,
    commandsPath,
    cleanup: () => { try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* best-effort */ } }
  }
}

function runHook(hookPath: string, dataDir: string, payload: object, cwdOverride?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [hookPath, dataDir], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: cwdOverride ?? path.dirname(hookPath)
    })
    let stderr = ''
    child.stderr.on('data', (c) => { stderr += c.toString() })
    const timeout = setTimeout(() => { child.kill(); reject(new Error('hook timed out')) }, 3000)
    child.on('exit', () => { clearTimeout(timeout); resolve() })
    child.on('error', (err) => { clearTimeout(timeout); reject(err) })
    child.stdin.write(JSON.stringify(payload))
    child.stdin.end()
    // Surface stderr on failure for easier debugging.
    child.on('close', (code) => {
      if (code !== 0 && stderr) {
        // eslint-disable-next-line no-console
        console.error(`hook stderr: ${stderr}`)
      }
    })
  })
}

function readCommands(commandsPath: string): EnqueuedCommand[] {
  if (!fs.existsSync(commandsPath)) return []
  try { return JSON.parse(fs.readFileSync(commandsPath, 'utf8')) } catch { return [] }
}

describe('dock-worktree-hook', () => {
  let sandbox: ReturnType<typeof makeSandbox>

  beforeEach(() => { sandbox = makeSandbox() })
  afterEach(() => { sandbox.cleanup() })

  it('enqueues worktree_changed when cwd is outside the project root', async () => {
    const worktreeCwd = path.join(sandbox.projectDir, '..', 'some-worktree')
    await runHook(sandbox.hookPath, sandbox.dataDir, {
      session_id: 'sess-outside',
      cwd: worktreeCwd,
      tool_name: 'Bash',
      tool_input: { command: 'cd ../some-worktree' }
    })

    const cmds = readCommands(sandbox.commandsPath)
    expect(cmds.length).toBe(1)
    expect(cmds[0].op).toBe('worktree_changed')
    expect(cmds[0].origin).toBe('hook')
    expect(cmds[0].sessionId).toBe('sess-outside')
    expect(cmds[0].worktreePath).toBe(worktreeCwd)
  })

  it('emits worktreePath=null when cwd equals the project root', async () => {
    await runHook(sandbox.hookPath, sandbox.dataDir, {
      session_id: 'sess-returning',
      cwd: sandbox.projectDir,
      tool_name: 'Bash',
      tool_input: { command: 'cd ..' }
    })

    const cmds = readCommands(sandbox.commandsPath)
    expect(cmds.length).toBe(1)
    expect(cmds[0].worktreePath).toBeNull()
  })

  it('treats sub-dirs of project root as "no worktree" on first sighting', async () => {
    await runHook(sandbox.hookPath, sandbox.dataDir, {
      session_id: 'sess-inside',
      cwd: path.join(sandbox.projectDir, 'src', 'main'),
      tool_name: 'Bash',
      tool_input: { command: 'cd src/main' }
    })

    const cmds = readCommands(sandbox.commandsPath)
    // First-sighting for this session — emit a clearing event (worktreePath=null).
    expect(cmds.length).toBe(1)
    expect(cmds[0].worktreePath).toBeNull()
  })

  it('collapses subsequent in-project sub-dir moves into a single emission', async () => {
    await runHook(sandbox.hookPath, sandbox.dataDir, {
      session_id: 'sess-inproject', cwd: sandbox.projectDir, tool_name: 'Bash', tool_input: {}
    })
    await runHook(sandbox.hookPath, sandbox.dataDir, {
      session_id: 'sess-inproject', cwd: path.join(sandbox.projectDir, 'src'), tool_name: 'Bash', tool_input: {}
    })
    await runHook(sandbox.hookPath, sandbox.dataDir, {
      session_id: 'sess-inproject', cwd: path.join(sandbox.projectDir, 'src', 'main'), tool_name: 'Bash', tool_input: {}
    })

    const cmds = readCommands(sandbox.commandsPath)
    expect(cmds.length).toBe(1)
    expect(cmds[0].worktreePath).toBeNull()
  })

  it('ignores non-Bash/Task tools', async () => {
    await runHook(sandbox.hookPath, sandbox.dataDir, {
      session_id: 'sess-read',
      cwd: path.join(sandbox.projectDir, '..', 'elsewhere'),
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/foo.txt' }
    })

    const cmds = readCommands(sandbox.commandsPath)
    expect(cmds.length).toBe(0)
  })

  it('deduplicates consecutive tool calls with unchanged cwd', async () => {
    const worktreeCwd = path.join(sandbox.projectDir, '..', 'wt')
    await runHook(sandbox.hookPath, sandbox.dataDir, {
      session_id: 'sess-dedupe',
      cwd: worktreeCwd,
      tool_name: 'Bash',
      tool_input: { command: 'ls' }
    })
    await runHook(sandbox.hookPath, sandbox.dataDir, {
      session_id: 'sess-dedupe',
      cwd: worktreeCwd,
      tool_name: 'Bash',
      tool_input: { command: 'pwd' }
    })

    const cmds = readCommands(sandbox.commandsPath)
    expect(cmds.length).toBe(1)
  })

  it('emits again when cwd transitions back to project root', async () => {
    const worktreeCwd = path.join(sandbox.projectDir, '..', 'wt')
    await runHook(sandbox.hookPath, sandbox.dataDir, {
      session_id: 'sess-roundtrip',
      cwd: worktreeCwd,
      tool_name: 'Bash',
      tool_input: { command: 'ls' }
    })
    await runHook(sandbox.hookPath, sandbox.dataDir, {
      session_id: 'sess-roundtrip',
      cwd: sandbox.projectDir,
      tool_name: 'Bash',
      tool_input: { command: 'cd ..' }
    })

    const cmds = readCommands(sandbox.commandsPath)
    expect(cmds.length).toBe(2)
    expect(cmds[0].worktreePath).toBe(worktreeCwd)
    expect(cmds[1].worktreePath).toBeNull()
  })

  it('emits per-session independently', async () => {
    const wt = path.join(sandbox.projectDir, '..', 'wt')
    await runHook(sandbox.hookPath, sandbox.dataDir, {
      session_id: 'sess-a', cwd: wt, tool_name: 'Bash', tool_input: { command: 'ls' }
    })
    await runHook(sandbox.hookPath, sandbox.dataDir, {
      session_id: 'sess-b', cwd: wt, tool_name: 'Bash', tool_input: { command: 'ls' }
    })

    const cmds = readCommands(sandbox.commandsPath)
    expect(cmds.length).toBe(2)
    expect(cmds.map((c) => c.sessionId).sort()).toEqual(['sess-a', 'sess-b'])
  })

  it('is a no-op for malformed payloads', async () => {
    await runHook(sandbox.hookPath, sandbox.dataDir, {} as any)
    await runHook(sandbox.hookPath, sandbox.dataDir, { session_id: 'x' } as any)
    await runHook(sandbox.hookPath, sandbox.dataDir, { cwd: '/tmp' } as any)

    const cmds = readCommands(sandbox.commandsPath)
    expect(cmds.length).toBe(0)
  })
})
