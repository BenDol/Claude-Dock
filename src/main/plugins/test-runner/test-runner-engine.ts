import { spawn, type ChildProcess } from 'child_process'
import { getServices } from './services'
import { detectAdapters, getAdapter } from './adapters/adapter-registry'
import type { DetectionResult, TestItem, TestRunResult, RunOptions } from './adapters/runner-adapter'
import { TestRunnerWindowManager } from './test-runner-window'

const svc = () => getServices()

/** Active test process per project */
const activeProcesses = new Map<string, { proc: ChildProcess; timer: ReturnType<typeof setTimeout> | null }>()

/** Cached detection results per project */
const detectionCache = new Map<string, { results: DetectionResult[]; timestamp: number }>()
const CACHE_TTL = 30000 // 30s

/** Hard limits */
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024 // 5MB output buffer cap
const MAX_RUN_TIMEOUT = 10 * 60 * 1000 // 10 minute timeout

export async function detect(projectDir: string): Promise<DetectionResult[]> {
  const cached = detectionCache.get(projectDir)
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.results
  try {
    const results = await detectAdapters(projectDir)
    detectionCache.set(projectDir, { results, timestamp: Date.now() })
    svc().log(`[test-runner] detected ${results.length} framework(s) in ${projectDir}`)
    return results
  } catch (err) {
    svc().logError('[test-runner] detect failed:', err)
    return []
  }
}

export function clearDetectionCache(projectDir?: string): void {
  if (projectDir) detectionCache.delete(projectDir)
  else detectionCache.clear()
}

export async function discover(projectDir: string, adapterId: string): Promise<TestItem[]> {
  const adapter = getAdapter(adapterId)
  if (!adapter) {
    svc().logError(`[test-runner] unknown adapter: ${adapterId}`)
    return []
  }
  const detections = await detect(projectDir)
  const config = detections.find((d) => d.adapterId === adapterId)
  if (!config) {
    svc().log(`[test-runner] framework ${adapterId} not detected in ${projectDir}`)
    return []
  }
  try {
    return await adapter.discover(projectDir, config)
  } catch (err) {
    svc().logError(`[test-runner] discover failed for ${adapterId}:`, err)
    return []
  }
}

export async function runTests(
  projectDir: string,
  adapterId: string,
  testIds: string[],
  options?: RunOptions
): Promise<string> {
  // Kill any existing run
  stopTests(projectDir)

  const adapter = getAdapter(adapterId)
  if (!adapter) throw new Error(`Unknown adapter: ${adapterId}`)
  const detections = await detect(projectDir)
  const config = detections.find((d) => d.adapterId === adapterId)
  if (!config) throw new Error(`Framework ${adapterId} not detected in ${projectDir}`)

  const command = adapter.buildRunCommand(projectDir, config, testIds, options)
  const runId = `run-${Date.now()}`

  svc().log(`[test-runner] running: ${command} in ${projectDir}`)

  const win = TestRunnerWindowManager.getInstance().getWindow(projectDir)
  const safeSend = (channel: string, data: unknown) => {
    try { if (win && !win.isDestroyed()) win.webContents.send(channel, data) } catch { /* non-fatal */ }
  }

  safeSend('testRunner:status', { status: 'running', runId })

  let proc: ChildProcess
  try {
    proc = spawn(command, {
      cwd: config.configDir,
      shell: true,
      env: { ...process.env, FORCE_COLOR: '1' }
    })
  } catch (err) {
    svc().logError('[test-runner] spawn failed:', err)
    safeSend('testRunner:status', { status: 'error', runId, error: err instanceof Error ? err.message : 'Spawn failed' })
    throw err
  }

  // Timeout guard — kill after MAX_RUN_TIMEOUT
  const timer = setTimeout(() => {
    svc().log(`[test-runner] timeout after ${MAX_RUN_TIMEOUT / 1000}s, killing process`)
    killProcess(proc)
    activeProcesses.delete(projectDir)
    safeSend('testRunner:output', '\n\n[Test run timed out]\n')
    safeSend('testRunner:status', { status: 'error', runId, error: 'Test run timed out' })
  }, MAX_RUN_TIMEOUT)

  activeProcesses.set(projectDir, { proc, timer })

  let outputBuffer = ''
  let outputTruncated = false

  const sendOutput = (data: Buffer) => {
    const text = data.toString()
    if (outputBuffer.length < MAX_OUTPUT_BYTES) {
      outputBuffer += text
    } else if (!outputTruncated) {
      outputTruncated = true
      outputBuffer += '\n\n[Output truncated — exceeded 5MB]\n'
    }
    safeSend('testRunner:output', text)
  }

  proc.stdout?.on('data', sendOutput)
  proc.stderr?.on('data', sendOutput)

  proc.on('close', async (code) => {
    const entry = activeProcesses.get(projectDir)
    if (entry?.timer) clearTimeout(entry.timer)
    activeProcesses.delete(projectDir)
    svc().log(`[test-runner] process exited with code ${code}`)

    let results: TestRunResult
    try {
      results = await adapter.parseResults(outputBuffer, projectDir, config)
    } catch (err) {
      svc().logError('[test-runner] parseResults failed:', err)
      results = {
        status: 'error',
        summary: { total: 0, passed: 0, failed: 0, skipped: 0 },
        tests: []
      }
    }

    if (results.status === 'running') {
      results.status = code === 0 ? 'passed' : 'failed'
    }

    safeSend('testRunner:results', results)
    safeSend('testRunner:status', { status: results.status, runId })
  })

  proc.on('error', (err) => {
    const entry = activeProcesses.get(projectDir)
    if (entry?.timer) clearTimeout(entry.timer)
    activeProcesses.delete(projectDir)
    svc().logError('[test-runner] spawn error:', err)
    safeSend('testRunner:status', { status: 'error', runId, error: err.message })
  })

  return runId
}

/** Kill a process and its children (Windows-safe) */
function killProcess(proc: ChildProcess): void {
  try {
    if (process.platform === 'win32' && proc.pid) {
      // On Windows, proc.kill() doesn't kill child processes.
      // Use taskkill to kill the entire process tree.
      spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      proc.kill('SIGTERM')
      // Force kill after 3s if still alive
      setTimeout(() => { try { proc.kill('SIGKILL') } catch { /* already dead */ } }, 3000)
    }
  } catch { /* process may already be dead */ }
}

export function stopTests(projectDir: string): boolean {
  const entry = activeProcesses.get(projectDir)
  if (entry) {
    if (entry.timer) clearTimeout(entry.timer)
    killProcess(entry.proc)
    activeProcesses.delete(projectDir)
    return true
  }
  return false
}

export function isRunning(projectDir: string): boolean {
  return activeProcesses.has(projectDir)
}
