import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

// `__BUILD_SHA__` is normally injected by electron-vite's define plugin. Tests
// run under vitest which doesn't go through that pipeline, so provide a real
// global before loading the module under test.
;(globalThis as { __BUILD_SHA__?: string }).__BUILD_SHA__ = 'test-build-sha-1'

// Temp directory layout the tests control:
//   <tmp>/userData/                → app.getPath('userData')
//   <tmp>/install/resources/       → process.resourcesPath
//   <tmp>/install/resources/app.asar/main/voice-python/
//                                  → __dirname/voice-python (the asar copy)
//
// `__dirname` at runtime for bundled-services.ts will be deep inside the
// vitest module graph, so we pivot the asar-backed tree off a symlinked /
// mocked location instead. We achieve that by shimming the module's
// `__dirname` resolution via a separate helper the module uses.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-bundle-test-'))
const userData = path.join(tmpRoot, 'userData')
const resourcesPath = path.join(tmpRoot, 'install', 'resources')
const asarMainDir = path.join(tmpRoot, 'install', 'resources', 'app.asar', 'main')

fs.mkdirSync(userData, { recursive: true })
fs.mkdirSync(resourcesPath, { recursive: true })
fs.mkdirSync(asarMainDir, { recursive: true })

const isPackagedRef = { current: true }

vi.mock('electron', () => ({
  app: {
    getPath: (key: string) => {
      if (key === 'userData') return userData
      throw new Error(`unexpected getPath(${key}) in test`)
    },
    get isPackaged() {
      return isPackagedRef.current
    }
  }
}))

// Silence logger output but keep counts so we can assert behaviour.
const logCalls: string[] = []
const errCalls: string[] = []
vi.mock('../../../logger', () => ({
  log: (msg: string) => logCalls.push(msg),
  logError: (msg: string, _err?: unknown) => errCalls.push(msg)
}))

// Other imports bundled-services.ts pulls in — stubbed to no-ops so the
// module can load in a test environment without wiring up every singleton.
vi.mock('../../../settings-store', () => ({ getSettings: () => ({}) }))
vi.mock('../../../window-state-store', () => ({
  getWindowState: () => null,
  saveWindowState: () => {}
}))
vi.mock('../../plugin-window-broadcast', () => ({ broadcastPluginWindowState: () => {} }))
vi.mock('../../plugin-renderer-utils', () => ({ resolveRendererOverride: () => undefined }))
vi.mock('../../../notification-manager', () => ({
  NotificationManager: { getInstance: () => ({ notify: () => {} }) }
}))

// `process.resourcesPath` is a runtime-injected field on `process`. Set it on
// the real process object so the module under test sees our temp tree.
Object.defineProperty(process, 'resourcesPath', { value: resourcesPath, configurable: true })

const EXPECTED = [
  'server.py',
  'hotkey_daemon.py',
  'dictation_daemon.py',
  'requirements.txt',
  'src/hotkey_parser.py',
  'src/cuda_setup.py'
]

function writeTree(root: string, files: string[]) {
  for (const rel of files) {
    const full = path.join(root, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, `# ${rel}\n`)
  }
}

function resetDirs() {
  fs.rmSync(path.join(resourcesPath, 'voice-python'), { recursive: true, force: true })
  fs.rmSync(path.join(userData, 'voice-python-fallback'), { recursive: true, force: true })
  fs.rmSync(path.join(userData, 'plugin-overrides'), { recursive: true, force: true })
  // Lay down a healthy asar-bundled copy at the location bundled-services
  // resolves via `path.join(__dirname, 'voice-python')`. We can't control
  // __dirname, so we also stub it — see below.
  fs.rmSync(path.join(asarMainDir, 'voice-python'), { recursive: true, force: true })
  writeTree(path.join(asarMainDir, 'voice-python'), EXPECTED)
}

// The module under test uses its own `__dirname` to find the asar-bundled
// copy. Under vitest, that __dirname points to src/main/plugins/voice/ and
// we don't want to pollute the repo. Override it by writing the asar copy
// into the real __dirname at import time, then cleaning up afterwards.
const moduleDir = path.resolve(__dirname, '..')
const moduleAsarCopy = path.join(moduleDir, 'voice-python')

function plantAsarCopyAtModuleDir() {
  fs.rmSync(moduleAsarCopy, { recursive: true, force: true })
  writeTree(moduleAsarCopy, EXPECTED)
}
function removeAsarCopyAtModuleDir() {
  fs.rmSync(moduleAsarCopy, { recursive: true, force: true })
}

describe('resolveBundledPythonDirWithSource + verifyBundledPythonIntegrity', () => {
  beforeEach(() => {
    logCalls.length = 0
    errCalls.length = 0
    resetDirs()
    plantAsarCopyAtModuleDir()
    isPackagedRef.current = true
    ;(globalThis as { __BUILD_SHA__?: string }).__BUILD_SHA__ = 'test-build-sha-1'
    vi.resetModules()
  })

  afterEach(() => {
    removeAsarCopyAtModuleDir()
  })

  it('returns packaged when the extraResources tree is healthy', async () => {
    writeTree(path.join(resourcesPath, 'voice-python'), EXPECTED)
    const mod = await import('../bundled-services')
    const report = mod.verifyBundledPythonIntegrity()
    expect(report.source).toBe('packaged')
    expect(report.missing).toEqual([])
    expect(report.pythonDir).toBe(path.join(resourcesPath, 'voice-python'))
  })

  it('self-heals to fallback when the packaged tree is missing files', async () => {
    // Simulate the real-world bug: top-level scripts present but src/ subdir
    // was silently not replaced by NSIS because it held locked .pyc files.
    writeTree(path.join(resourcesPath, 'voice-python'), [
      'server.py',
      'hotkey_daemon.py',
      'dictation_daemon.py',
      'requirements.txt'
    ])

    const mod = await import('../bundled-services')
    const report = mod.verifyBundledPythonIntegrity()

    expect(report.source).toBe('fallback')
    expect(report.missing).toEqual([])
    expect(report.pythonDir).toBe(path.join(userData, 'voice-python-fallback'))

    // Stamp file written with the current build sha.
    const stampPath = path.join(userData, 'voice-python-fallback', '.asar-source.json')
    expect(fs.existsSync(stampPath)).toBe(true)
    const stamp = JSON.parse(fs.readFileSync(stampPath, 'utf-8'))
    expect(stamp.buildSha).toBe('test-build-sha-1')

    // Every expected file was extracted.
    for (const rel of EXPECTED) {
      expect(fs.existsSync(path.join(userData, 'voice-python-fallback', rel))).toBe(true)
    }

    // Self-heal logged.
    expect(logCalls.some((m) => m.includes('self-healed stale python tree'))).toBe(true)
  })

  it('reuses the extracted fallback on subsequent calls with the same build sha', async () => {
    writeTree(path.join(resourcesPath, 'voice-python'), ['server.py']) // clearly stale

    const mod = await import('../bundled-services')
    mod.verifyBundledPythonIntegrity() // first call extracts

    // Mutate one of the fallback files. If the second call re-extracted, our
    // change would be overwritten. If it reused the stamp, our change stays.
    const marker = path.join(userData, 'voice-python-fallback', 'server.py')
    fs.writeFileSync(marker, 'SENTINEL')
    mod.verifyBundledPythonIntegrity()
    expect(fs.readFileSync(marker, 'utf-8')).toBe('SENTINEL')
  })

  it('re-extracts when the build sha changes', async () => {
    writeTree(path.join(resourcesPath, 'voice-python'), ['server.py']) // stale

    const mod1 = await import('../bundled-services')
    mod1.verifyBundledPythonIntegrity()

    // Simulate a new app build replacing app.asar. Bump the global and
    // re-import so the module re-reads __BUILD_SHA__.
    ;(globalThis as { __BUILD_SHA__?: string }).__BUILD_SHA__ = 'test-build-sha-2'
    // Also refresh the asar-planted tree to prove the new copy is used.
    removeAsarCopyAtModuleDir()
    plantAsarCopyAtModuleDir()
    const marker = path.join(userData, 'voice-python-fallback', 'server.py')
    fs.writeFileSync(marker, 'OLD-SENTINEL')

    vi.resetModules()
    const mod2 = await import('../bundled-services')
    mod2.verifyBundledPythonIntegrity()

    // Stamp updated and old file content gone.
    const stamp = JSON.parse(
      fs.readFileSync(path.join(userData, 'voice-python-fallback', '.asar-source.json'), 'utf-8')
    )
    expect(stamp.buildSha).toBe('test-build-sha-2')
    expect(fs.readFileSync(marker, 'utf-8')).not.toBe('OLD-SENTINEL')
  })

  it('falls through a stale override to packaged (when packaged is healthy)', async () => {
    writeTree(path.join(userData, 'plugin-overrides', 'voice', 'python'), [
      'server.py' // stale — missing most expected files
    ])
    writeTree(path.join(resourcesPath, 'voice-python'), EXPECTED)

    const mod = await import('../bundled-services')
    const report = mod.verifyBundledPythonIntegrity()

    expect(report.source).toBe('packaged')
    expect(report.pythonDir).toBe(path.join(resourcesPath, 'voice-python'))
    expect(logCalls.some((m) => m.includes('ignoring stale override'))).toBe(true)
  })

  it('reports packaged with a missing list when self-heal cannot find the asar source', async () => {
    writeTree(path.join(resourcesPath, 'voice-python'), ['server.py']) // stale
    removeAsarCopyAtModuleDir() // simulate asar copy missing (shouldn't happen in prod)

    const mod = await import('../bundled-services')
    const report = mod.verifyBundledPythonIntegrity()

    expect(report.source).toBe('packaged')
    expect(report.missing.length).toBeGreaterThan(0)
    expect(errCalls.some((m) => m.includes('asar-bundled python source missing'))).toBe(true)
  })
})
