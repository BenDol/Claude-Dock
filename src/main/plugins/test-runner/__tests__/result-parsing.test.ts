import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../services', () => ({
  getServices: () => ({
    log: () => {},
    logError: () => {}
  })
}))

import { VitestAdapter } from '../adapters/vitest-adapter'
import { JUnitMavenAdapter } from '../adapters/junit-adapter'
import { createTestDir, writeFile, type TestDir } from './setup'
import type { DetectionResult } from '../adapters/runner-adapter'

describe('VitestAdapter result parsing', () => {
  const adapter = new VitestAdapter()
  const config: DetectionResult = { adapterId: 'vitest', configFile: 'vitest.config.ts', configDir: '/project', confidence: 1 }

  it('parses passing tests from verbose output', async () => {
    const output = `
 ✓ src/math.test.ts > MathUtils > should add numbers (3ms)
 ✓ src/math.test.ts > MathUtils > should subtract numbers (1ms)

 Test Files  1 passed (1)
 Tests  2 passed (2)
 Duration  1.5s
`
    const results = await adapter.parseResults(output, '/project', config)
    expect(results.status).toBe('passed')
    expect(results.summary.passed).toBe(2)
    expect(results.summary.failed).toBe(0)
    expect(results.summary.total).toBe(2)
    expect(results.tests).toHaveLength(2)
    expect(results.tests[0].status).toBe('passed')
    expect(results.tests[0].duration).toBe(3)
  })

  it('parses failing tests', async () => {
    const output = `
 ✓ src/math.test.ts > MathUtils > should add (1ms)
 ✗ src/math.test.ts > MathUtils > should subtract (5ms)

FAIL src/math.test.ts
 AssertionError: expected 3 to be 2

 Test Files  1 failed (1)
 Tests  1 passed | 1 failed (2)
 Duration  2.1s
`
    const results = await adapter.parseResults(output, '/project', config)
    expect(results.status).toBe('failed')
    expect(results.summary.passed).toBe(1)
    expect(results.summary.failed).toBe(1)
    expect(results.tests.find(t => t.status === 'failed')?.error).toBeDefined()
  })

  it('parses duration from output', async () => {
    const output = `
 ✓ test one (10ms)

 Duration  3.2s
`
    const results = await adapter.parseResults(output, '/project', config)
    expect(results.summary.duration).toBe(3200)
  })

  it('handles empty output gracefully', async () => {
    const results = await adapter.parseResults('', '/project', config)
    expect(results.status).toBe('error')
    expect(results.summary.total).toBe(0)
    expect(results.tests).toEqual([])
  })

  it('handles output with no test markers', async () => {
    const results = await adapter.parseResults('some random output\nno tests here\n', '/project', config)
    expect(results.summary.total).toBe(0)
  })
})

describe('JUnitMavenAdapter result parsing', () => {
  let dir: TestDir
  const adapter = new JUnitMavenAdapter()

  beforeEach(() => { dir = createTestDir() })
  afterEach(() => { dir.cleanup() })

  it('parses surefire XML reports', async () => {
    const config: DetectionResult = { adapterId: 'junit-maven', configFile: 'pom.xml', configDir: dir.root, confidence: 0.9 }
    writeFile(dir.root, 'target/surefire-reports/TEST-com.example.FooTest.xml', `<?xml version="1.0"?>
<testsuite name="com.example.FooTest" tests="3" failures="1" errors="0" skipped="1" time="0.5">
  <testcase name="testAddition" classname="com.example.FooTest" time="0.1"/>
  <testcase name="testSubtraction" classname="com.example.FooTest" time="0.2">
    <failure message="Expected 2 but got 3">java.lang.AssertionError: Expected 2 but got 3
at com.example.FooTest.testSubtraction(FooTest.java:15)</failure>
  </testcase>
  <testcase name="testMultiply" classname="com.example.FooTest" time="0.0">
    <skipped/>
  </testcase>
</testsuite>`)
    const results = await adapter.parseResults('', dir.root, config)
    expect(results.status).toBe('failed')
    expect(results.summary.total).toBe(3)
    expect(results.summary.passed).toBe(1)
    expect(results.summary.failed).toBe(1)
    expect(results.summary.skipped).toBe(1)
    expect(results.tests).toHaveLength(3)

    const failed = results.tests.find(t => t.status === 'failed')
    expect(failed).toBeDefined()
    expect(failed!.error?.message).toContain('Expected 2 but got 3')
  })

  it('parses multiple XML report files', async () => {
    const config: DetectionResult = { adapterId: 'junit-maven', configFile: 'pom.xml', configDir: dir.root, confidence: 0.9 }
    writeFile(dir.root, 'target/surefire-reports/TEST-A.xml',
      '<testsuite tests="1"><testcase name="t1" classname="A" time="0.1"/></testsuite>')
    writeFile(dir.root, 'target/surefire-reports/TEST-B.xml',
      '<testsuite tests="1"><testcase name="t2" classname="B" time="0.2"/></testsuite>')
    const results = await adapter.parseResults('', dir.root, config)
    expect(results.summary.total).toBe(2)
    expect(results.summary.passed).toBe(2)
  })

  it('falls back to console output parsing when no XML reports', async () => {
    const config: DetectionResult = { adapterId: 'junit-maven', configFile: 'pom.xml', configDir: dir.root, confidence: 0.9 }
    const output = `
[INFO] Tests run: 5, Failures: 1, Errors: 0, Skipped: 1
[INFO] BUILD FAILURE
`
    const results = await adapter.parseResults(output, dir.root, config)
    expect(results.summary.total).toBe(5)
    expect(results.summary.failed).toBe(1)
    expect(results.summary.skipped).toBe(1)
    expect(results.summary.passed).toBe(3)
  })

  it('parses Gradle console output format', async () => {
    const config: DetectionResult = { adapterId: 'junit-maven', configFile: 'pom.xml', configDir: dir.root, confidence: 0.9 }
    const output = `10 tests completed, 2 failed`
    const results = await adapter.parseResults(output, dir.root, config)
    expect(results.summary.total).toBe(10)
    expect(results.summary.failed).toBe(2)
    expect(results.summary.passed).toBe(8)
  })

  it('handles empty output and no reports', async () => {
    const config: DetectionResult = { adapterId: 'junit-maven', configFile: 'pom.xml', configDir: dir.root, confidence: 0.9 }
    const results = await adapter.parseResults('', dir.root, config)
    expect(results.status).toBe('error')
    expect(results.summary.total).toBe(0)
  })

  it('handles malformed XML gracefully', async () => {
    const config: DetectionResult = { adapterId: 'junit-maven', configFile: 'pom.xml', configDir: dir.root, confidence: 0.9 }
    writeFile(dir.root, 'target/surefire-reports/TEST-Bad.xml', '<testsuite><<broken xml>')
    const results = await adapter.parseResults('', dir.root, config)
    // Should not throw — falls back to empty/error
    expect(results).toBeDefined()
  })
})
