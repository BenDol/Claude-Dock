import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../services', () => ({
  getServices: () => ({
    log: () => {},
    logError: () => {}
  })
}))

import { VitestAdapter } from '../adapters/vitest-adapter'
import { JUnitMavenAdapter } from '../adapters/junit-adapter'
import { createTestDir, writeFile, createVitestProject, createVitestFile, createMavenProject, createJavaTestFile, type TestDir } from './setup'
import type { DetectionResult } from '../adapters/runner-adapter'

describe('VitestAdapter discovery', () => {
  let dir: TestDir
  const adapter = new VitestAdapter()

  beforeEach(() => { dir = createTestDir() })
  afterEach(() => { dir.cleanup() })

  it('discovers test files', async () => {
    createVitestProject(dir.root)
    createVitestFile(dir.root, 'src/math.test.ts')
    const config: DetectionResult = { adapterId: 'vitest', configFile: 'vitest.config.ts', configDir: dir.root, confidence: 1 }
    const items = await adapter.discover(dir.root, config)
    expect(items).toHaveLength(1)
    expect(items[0].type).toBe('file')
    expect(items[0].label).toBe('math.test.ts')
  })

  it('discovers nested test blocks inside files', async () => {
    createVitestProject(dir.root)
    createVitestFile(dir.root, 'src/calc.test.ts')
    const config: DetectionResult = { adapterId: 'vitest', configFile: 'vitest.config.ts', configDir: dir.root, confidence: 1 }
    const items = await adapter.discover(dir.root, config)
    expect(items[0].children).toBeDefined()
    expect(items[0].children!.length).toBeGreaterThan(0)
    // Should have a 'MathUtils' describe block with tests inside
    const descr = items[0].children!.find(c => c.label === 'MathUtils')
    expect(descr).toBeDefined()
    expect(descr!.type).toBe('describe')
    // MathUtils has at least 'should add numbers' and 'should subtract numbers'
    expect(descr!.children!.length).toBeGreaterThanOrEqual(1)
  })

  it('discovers multiple test files', async () => {
    createVitestProject(dir.root)
    createVitestFile(dir.root, 'src/a.test.ts')
    createVitestFile(dir.root, 'src/b.spec.ts')
    writeFile(dir.root, 'src/c.test.js', 'test("js test", () => {})')
    const config: DetectionResult = { adapterId: 'vitest', configFile: 'vitest.config.ts', configDir: dir.root, confidence: 1 }
    const items = await adapter.discover(dir.root, config)
    expect(items.length).toBeGreaterThanOrEqual(3)
  })

  it('skips node_modules', async () => {
    createVitestProject(dir.root)
    writeFile(dir.root, 'node_modules/pkg/index.test.ts', 'test("skip me", () => {})')
    writeFile(dir.root, 'src/real.test.ts', 'test("keep me", () => {})')
    const config: DetectionResult = { adapterId: 'vitest', configFile: 'vitest.config.ts', configDir: dir.root, confidence: 1 }
    const items = await adapter.discover(dir.root, config)
    expect(items).toHaveLength(1)
    expect(items[0].filePath).toContain('real.test.ts')
  })

  it('returns empty for project with no test files', async () => {
    createVitestProject(dir.root)
    writeFile(dir.root, 'src/util.ts', 'export const foo = 1')
    const config: DetectionResult = { adapterId: 'vitest', configFile: 'vitest.config.ts', configDir: dir.root, confidence: 1 }
    const items = await adapter.discover(dir.root, config)
    expect(items).toEqual([])
  })

  it('handles unreadable test files gracefully', async () => {
    createVitestProject(dir.root)
    // Create a directory with same name as a test file — readFileSync will fail
    const fs = await import('fs')
    fs.mkdirSync(dir.root + '/src/fake.test.ts', { recursive: true })
    writeFile(dir.root, 'src/real.test.ts', 'test("ok", () => {})')
    const config: DetectionResult = { adapterId: 'vitest', configFile: 'vitest.config.ts', configDir: dir.root, confidence: 1 }
    const items = await adapter.discover(dir.root, config)
    // Should not crash, and should still find the readable file
    expect(items.some(i => i.filePath?.includes('real.test.ts'))).toBe(true)
  })
})

describe('JUnitMavenAdapter discovery', () => {
  let dir: TestDir
  const adapter = new JUnitMavenAdapter()

  beforeEach(() => { dir = createTestDir() })
  afterEach(() => { dir.cleanup() })

  it('discovers Java test files in src/test/java', async () => {
    createMavenProject(dir.root)
    createJavaTestFile(dir.root, 'src/test/java/com/example/FooTest.java', 'FooTest', 'com.example')
    const config: DetectionResult = { adapterId: 'junit-maven', configFile: 'pom.xml', configDir: dir.root, confidence: 0.9 }
    const items = await adapter.discover(dir.root, config)
    expect(items).toHaveLength(1)
    expect(items[0].type).toBe('suite')
    expect(items[0].label).toBe('FooTest')
    expect(items[0].id).toBe('com.example.FooTest')
  })

  it('discovers @Test methods within test classes', async () => {
    createMavenProject(dir.root)
    createJavaTestFile(dir.root, 'src/test/java/com/example/CalcTest.java', 'CalcTest', 'com.example')
    const config: DetectionResult = { adapterId: 'junit-maven', configFile: 'pom.xml', configDir: dir.root, confidence: 0.9 }
    const items = await adapter.discover(dir.root, config)
    expect(items[0].children).toBeDefined()
    expect(items[0].children!.length).toBe(2) // testAddition + testSubtraction (not helperMethod)
    expect(items[0].children!.every(c => c.type === 'test')).toBe(true)
  })

  it('discovers multiple test classes', async () => {
    createMavenProject(dir.root)
    createJavaTestFile(dir.root, 'src/test/java/com/example/ATest.java', 'ATest', 'com.example')
    createJavaTestFile(dir.root, 'src/test/java/com/example/BTest.java', 'BTest', 'com.example')
    const config: DetectionResult = { adapterId: 'junit-maven', configFile: 'pom.xml', configDir: dir.root, confidence: 0.9 }
    const items = await adapter.discover(dir.root, config)
    expect(items).toHaveLength(2)
  })

  it('returns empty when no test directory exists', async () => {
    createMavenProject(dir.root)
    const config: DetectionResult = { adapterId: 'junit-maven', configFile: 'pom.xml', configDir: dir.root, confidence: 0.9 }
    const items = await adapter.discover(dir.root, config)
    expect(items).toEqual([])
  })
})
