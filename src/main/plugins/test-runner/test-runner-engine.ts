import { spawn, type ChildProcess } from 'child_process'
import { getServices } from './services'
import { detectAdapters, getAdapter } from './adapters/adapter-registry'
import type { DetectionResult, TestItem, TestRunResult, RunOptions } from './adapters/runner-adapter'
import { TestRunnerWindowManager } from './test-runner-window'

const svc = () => getServices()

/** Active test process per project */
const activeProcesses = new Map<string, ChildProcess>()

/** Cached detection results per project */
const detectionCache = new Map<string, { results: DetectionResult[]; timestamp: number }>()
const CACHE_TTL = 30000 // 30s

export async function detect(projectDir: string): Promise<DetectionResult[]> {
  const cached = detectionCache.get(projectDir)
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.results
  const results = await detectAdapters(projectDir)
  detectionCache.set(projectDir, { results, timestamp: Date.now() })
  svc().log(`[test-runner] detected ${results.length} framework(s) in ${projectDir}`)
  return results
}

export async function discover(projectDir: string, adapterId: string): Promise<TestItem[]> {
  const adapter = getAdapter(adapterId)
  if (!adapter) throw new Error(`Unknown adapter: ${adapterId}`)
  const detections = await detect(projectDir)
  const config = detections.find((d) => d.adapterId === adapterId)
  if (!config) throw new Error(`Framework ${adapterId} not detected in ${projectDir}`)
  return adapter.discover(projectDir, config)
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

  // Send status update
  if (win && !win.isDestroyed()) {
    win.webContents.send('testRunner:status', { status: 'running', runId })
  }

  const proc = spawn(command, {
    cwd: config.configDir,
    shell: true,
    env: { ...process.env, FORCE_COLOR: '1' }
  })
  activeProcesses.set(projectDir, proc)

  let outputBuffer = ''

  const sendOutput = (data: Buffer) => {
    const text = data.toString()
    outputBuffer += text
    if (win && !win.isDestroyed()) {
      win.webContents.send('testRunner:output', text)
    }
  }

  proc.stdout?.on('data', sendOutput)
  proc.stderr?.on('data', sendOutput)

  proc.on('close', async (code) => {
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

    if (win && !win.isDestroyed()) {
      win.webContents.send('testRunner:results', results)
      win.webContents.send('testRunner:status', { status: results.status, runId })
    }
  })

  proc.on('error', (err) => {
    activeProcesses.delete(projectDir)
    svc().logError('[test-runner] spawn error:', err)
    if (win && !win.isDestroyed()) {
      win.webContents.send('testRunner:status', { status: 'error', runId, error: err.message })
    }
  })

  return runId
}

export function stopTests(projectDir: string): boolean {
  const proc = activeProcesses.get(projectDir)
  if (proc) {
    proc.kill()
    activeProcesses.delete(projectDir)
    return true
  }
  return false
}

export function isRunning(projectDir: string): boolean {
  return activeProcesses.has(projectDir)
}
