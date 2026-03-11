import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

export interface TestRepo {
  cwd: string
  cleanup: () => void
}

/** Run a command synchronously in the given directory */
export function run(cwd: string, cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { cwd, encoding: 'utf-8', timeout: 15000 }).trim()
}

/** Run a git command with protocol.file.allow=always (needed for clone/submodule operations) */
export function gitRun(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'protocol.file.allow=always', ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 15000
  }).trim()
}

/** Create an isolated test repo with an orphan branch and empty root commit */
export function createTestRepo(): TestRepo {
  const tmpDir = path.join(os.tmpdir(), `git-mgr-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(tmpDir, { recursive: true })

  run(tmpDir, 'git', ['init'])
  run(tmpDir, 'git', ['config', 'user.email', 'test@test.com'])
  run(tmpDir, 'git', ['config', 'user.name', 'Test User'])
  run(tmpDir, 'git', ['config', 'protocol.file.allow', 'always'])
  run(tmpDir, 'git', ['commit', '--allow-empty', '-m', 'test root'])

  return {
    cwd: tmpDir,
    cleanup: () => cleanupDir(tmpDir)
  }
}

/** Create a bare repo that can be used as a remote for push/pull tests */
export function createBareRemote(): string {
  const bareDir = path.join(os.tmpdir(), `git-mgr-bare-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(bareDir, { recursive: true })
  run(bareDir, 'git', ['init', '--bare'])
  return bareDir
}

/** Create a standalone repo that can be added as a submodule */
export function createSubmoduleRepo(): { dir: string; cleanup: () => void } {
  const subDir = path.join(os.tmpdir(), `git-mgr-sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(subDir, { recursive: true })
  run(subDir, 'git', ['init'])
  run(subDir, 'git', ['config', 'user.email', 'test@test.com'])
  run(subDir, 'git', ['config', 'user.name', 'Test User'])
  fs.writeFileSync(path.join(subDir, 'sub-file.txt'), 'submodule content')
  run(subDir, 'git', ['add', '.'])
  run(subDir, 'git', ['commit', '-m', 'initial submodule commit'])

  return {
    dir: subDir,
    cleanup: () => cleanupDir(subDir)
  }
}

/** Write a file, stage it, and commit it */
export function commitFile(cwd: string, filename: string, content: string, message: string): string {
  const filePath = path.join(cwd, filename)
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(filePath, content)
  run(cwd, 'git', ['add', filename])
  run(cwd, 'git', ['commit', '-m', message])
  return run(cwd, 'git', ['rev-parse', 'HEAD'])
}

/** Write a file without staging/committing */
export function writeFile(cwd: string, filename: string, content: string): void {
  const filePath = path.join(cwd, filename)
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(filePath, content)
}

/** Remove a directory with retry for Windows file locking */
function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  } catch {
    // best-effort cleanup
  }
}
