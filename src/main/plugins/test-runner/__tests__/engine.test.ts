import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../services', () => ({
  getServices: () => ({
    log: () => {},
    logError: () => {}
  })
}))

// Mock the window manager so engine doesn't try to send to BrowserWindows
vi.mock('../test-runner-window', () => ({
  TestRunnerWindowManager: {
    getInstance: () => ({
      getWindow: () => null,
      open: async () => {},
      close: () => {},
      closeAll: () => {},
      isOpen: () => false
    })
  }
}))

import { detect, discover, clearDetectionCache, isRunning } from '../test-runner-engine'
import { createTestDir, createVitestProject, createVitestFile, createMavenProject, createJavaTestFile, type TestDir } from './setup'

describe('engine.detect', () => {
  let dir: TestDir
  beforeEach(() => { dir = createTestDir(); clearDetectionCache() })
  afterEach(() => { dir.cleanup() })

  it('detects vitest projects', async () => {
    createVitestProject(dir.root)
    const results = await detect(dir.root)
    expect(results.some(r => r.adapterId === 'vitest')).toBe(true)
  })

  it('detects maven projects', async () => {
    createMavenProject(dir.root)
    const results = await detect(dir.root)
    expect(results.some(r => r.adapterId === 'junit-maven')).toBe(true)
  })

  it('returns empty for empty directory', async () => {
    const results = await detect(dir.root)
    expect(results).toEqual([])
  })

  it('caches detection results', async () => {
    createVitestProject(dir.root)
    const r1 = await detect(dir.root)
    const r2 = await detect(dir.root)
    expect(r1).toBe(r2) // same reference = cached
  })

  it('clears cache when requested', async () => {
    createVitestProject(dir.root)
    const r1 = await detect(dir.root)
    clearDetectionCache(dir.root)
    const r2 = await detect(dir.root)
    expect(r1).not.toBe(r2) // different reference = re-detected
  })

  it('handles nonexistent directory without throwing', async () => {
    const results = await detect('/tmp/nonexistent-' + Date.now())
    expect(results).toEqual([])
  })
})

describe('engine.discover', () => {
  let dir: TestDir
  beforeEach(() => { dir = createTestDir(); clearDetectionCache() })
  afterEach(() => { dir.cleanup() })

  it('discovers vitest tests', async () => {
    createVitestProject(dir.root)
    createVitestFile(dir.root, 'src/utils.test.ts')
    const items = await discover(dir.root, 'vitest')
    expect(items.length).toBeGreaterThan(0)
    expect(items[0].type).toBe('file')
  })

  it('discovers junit tests', async () => {
    createMavenProject(dir.root)
    createJavaTestFile(dir.root, 'src/test/java/com/example/AppTest.java', 'AppTest', 'com.example')
    const items = await discover(dir.root, 'junit-maven')
    expect(items.length).toBeGreaterThan(0)
    expect(items[0].type).toBe('suite')
  })

  it('returns empty for unknown adapter without throwing', async () => {
    createVitestProject(dir.root)
    // unknown adapter returns empty (doesn't throw because engine catches)
    const items = await discover(dir.root, 'nonexistent-adapter')
    expect(items).toEqual([])
  })

  it('returns empty when framework not detected', async () => {
    // dir has nothing — vitest won't be detected
    const items = await discover(dir.root, 'vitest')
    expect(items).toEqual([])
  })
})

describe('engine.isRunning', () => {
  it('returns false when nothing is running', () => {
    expect(isRunning('/tmp/no-project')).toBe(false)
  })
})
