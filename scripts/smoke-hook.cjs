#!/usr/bin/env node
/**
 * Standalone smoke test for resources/dock-worktree-hook.cjs — does not
 * depend on vitest / node_modules. Run with: `node scripts/smoke-hook.cjs`.
 *
 * Mirrors the cases in src/main/__tests__/dock-worktree-hook.test.ts so
 * this works even when the repo's node_modules haven't been installed.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const HOOK_SRC = path.resolve(__dirname, '../resources/dock-worktree-hook.cjs')

let failures = 0
function assert(cond, msg) {
  if (!cond) { failures++; console.error(`  FAIL: ${msg}`) }
  else { console.log(`  ok: ${msg}`) }
}

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dock-hook-smoke-'))
  const projectDir = path.join(root, 'project')
  const dataDir = path.join(root, 'data')
  fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true })
  fs.mkdirSync(dataDir, { recursive: true })
  const hookPath = path.join(projectDir, '.claude', 'dock-worktree-hook.cjs')
  fs.copyFileSync(HOOK_SRC, hookPath)
  return {
    projectDir,
    dataDir,
    hookPath,
    commandsPath: path.join(dataDir, 'dock-terminal-commands.json'),
    cleanup: () => { try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* */ } }
  }
}

function runHook(hookPath, dataDir, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookPath, dataDir], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (c) => { stderr += c.toString() })
    const t = setTimeout(() => { child.kill(); reject(new Error('timeout')) }, 3000)
    child.on('exit', () => { clearTimeout(t); resolve(stderr) })
    child.on('error', (err) => { clearTimeout(t); reject(err) })
    child.stdin.write(JSON.stringify(payload))
    child.stdin.end()
  })
}

function readCommands(p) {
  if (!fs.existsSync(p)) return []
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return [] }
}

async function test(name, fn) {
  console.log(`\n[${name}]`)
  const sb = makeSandbox()
  try { await fn(sb) } finally { sb.cleanup() }
}

async function main() {
  await test('enqueues worktree_changed when cwd is outside project root', async (sb) => {
    const wt = path.join(sb.projectDir, '..', 'some-wt')
    await runHook(sb.hookPath, sb.dataDir, { session_id: 'a', cwd: wt, tool_name: 'Bash', tool_input: { command: 'cd' } })
    const cmds = readCommands(sb.commandsPath)
    assert(cmds.length === 1, `got ${cmds.length} commands (want 1)`)
    if (cmds[0]) {
      assert(cmds[0].op === 'worktree_changed', `op=${cmds[0].op}`)
      assert(cmds[0].origin === 'hook', `origin=${cmds[0].origin}`)
      assert(cmds[0].sessionId === 'a', `sessionId=${cmds[0].sessionId}`)
      assert(cmds[0].worktreePath === wt, `worktreePath=${cmds[0].worktreePath}`)
    }
  })

  await test('worktreePath=null when cwd equals project root', async (sb) => {
    await runHook(sb.hookPath, sb.dataDir, { session_id: 'b', cwd: sb.projectDir, tool_name: 'Bash', tool_input: {} })
    const cmds = readCommands(sb.commandsPath)
    assert(cmds.length === 1, `got ${cmds.length}`)
    if (cmds[0]) assert(cmds[0].worktreePath === null, `worktreePath=${cmds[0].worktreePath}`)
  })

  await test('sub-dirs of project root treated as "no worktree"', async (sb) => {
    await runHook(sb.hookPath, sb.dataDir, { session_id: 'c', cwd: path.join(sb.projectDir, 'src', 'main'), tool_name: 'Bash', tool_input: {} })
    const cmds = readCommands(sb.commandsPath)
    assert(cmds.length === 1, `got ${cmds.length}`)
    if (cmds[0]) assert(cmds[0].worktreePath === null, `expected null got ${cmds[0].worktreePath}`)
  })

  await test('in-project sub-dir moves do not re-emit once cached', async (sb) => {
    await runHook(sb.hookPath, sb.dataDir, { session_id: 'c2', cwd: sb.projectDir, tool_name: 'Bash', tool_input: {} })
    await runHook(sb.hookPath, sb.dataDir, { session_id: 'c2', cwd: path.join(sb.projectDir, 'src'), tool_name: 'Bash', tool_input: {} })
    await runHook(sb.hookPath, sb.dataDir, { session_id: 'c2', cwd: path.join(sb.projectDir, 'src', 'main'), tool_name: 'Bash', tool_input: {} })
    const cmds = readCommands(sb.commandsPath)
    assert(cmds.length === 1, `got ${cmds.length} (want 1 — only first in-project emit)`)
  })

  await test('ignores non-Bash/Task tools', async (sb) => {
    await runHook(sb.hookPath, sb.dataDir, { session_id: 'd', cwd: path.join(sb.projectDir, '..', 'x'), tool_name: 'Read', tool_input: {} })
    const cmds = readCommands(sb.commandsPath)
    assert(cmds.length === 0, `got ${cmds.length} commands (want 0)`)
  })

  await test('deduplicates consecutive unchanged-cwd calls', async (sb) => {
    const wt = path.join(sb.projectDir, '..', 'wt')
    await runHook(sb.hookPath, sb.dataDir, { session_id: 'e', cwd: wt, tool_name: 'Bash', tool_input: {} })
    await runHook(sb.hookPath, sb.dataDir, { session_id: 'e', cwd: wt, tool_name: 'Bash', tool_input: {} })
    const cmds = readCommands(sb.commandsPath)
    assert(cmds.length === 1, `got ${cmds.length} (want 1)`)
  })

  await test('emits again when cwd transitions back to project root', async (sb) => {
    const wt = path.join(sb.projectDir, '..', 'wt')
    await runHook(sb.hookPath, sb.dataDir, { session_id: 'f', cwd: wt, tool_name: 'Bash', tool_input: {} })
    await runHook(sb.hookPath, sb.dataDir, { session_id: 'f', cwd: sb.projectDir, tool_name: 'Bash', tool_input: {} })
    const cmds = readCommands(sb.commandsPath)
    assert(cmds.length === 2, `got ${cmds.length} (want 2)`)
    if (cmds[0]) assert(cmds[0].worktreePath === wt, `first.worktreePath=${cmds[0].worktreePath}`)
    if (cmds[1]) assert(cmds[1].worktreePath === null, `second.worktreePath=${cmds[1].worktreePath}`)
  })

  await test('distinct sessions each get their own emission', async (sb) => {
    const wt = path.join(sb.projectDir, '..', 'wt')
    await runHook(sb.hookPath, sb.dataDir, { session_id: 'g1', cwd: wt, tool_name: 'Bash', tool_input: {} })
    await runHook(sb.hookPath, sb.dataDir, { session_id: 'g2', cwd: wt, tool_name: 'Bash', tool_input: {} })
    const cmds = readCommands(sb.commandsPath)
    assert(cmds.length === 2, `got ${cmds.length} (want 2)`)
  })

  await test('no-op for malformed payloads', async (sb) => {
    await runHook(sb.hookPath, sb.dataDir, {})
    await runHook(sb.hookPath, sb.dataDir, { session_id: 'x' })
    await runHook(sb.hookPath, sb.dataDir, { cwd: '/tmp' })
    const cmds = readCommands(sb.commandsPath)
    assert(cmds.length === 0, `got ${cmds.length} (want 0)`)
  })

  console.log(failures === 0 ? `\nAll checks passed.` : `\n${failures} check(s) failed.`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => { console.error('smoke test errored:', err); process.exit(2) })
