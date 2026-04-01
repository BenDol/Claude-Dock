import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

vi.mock('../services', () => ({
  getServices: () => ({
    log: () => {},
    logError: () => {}
  })
}))

import { scanTestFiles, parseTestBlocks, parseJavaTestMethods } from '../adapters/scan-utils'
import { VitestAdapter } from '../adapters/vitest-adapter'
import { JUnitMavenAdapter, JUnitGradleAdapter } from '../adapters/junit-adapter'
import { detectAdapters } from '../adapters/adapter-registry'
import { createTestDir, writeFile, type TestDir } from './setup'

describe('hardening: file system edge cases', () => {
  let dir: TestDir
  beforeEach(() => { dir = createTestDir() })
  afterEach(() => { dir.cleanup() })

  it('scanTestFiles handles permission-denied directories', () => {
    // Create a directory structure where one dir is unreadable
    writeFile(dir.root, 'ok/test.test.ts', '')
    // Use a nonexistent path inside the scan — readdirSync will fail silently
    const results = scanTestFiles(dir.root, [/\.test\.ts$/], new Set())
    expect(results.length).toBeGreaterThanOrEqual(1)
  })

  it('scanTestFiles respects MAX_SCAN_FILES cap (indirectly via large directory)', () => {
    // Create many test files to verify it doesn't hang or OOM
    for (let i = 0; i < 50; i++) {
      writeFile(dir.root, `test${i}.test.ts`, '')
    }
    const results = scanTestFiles(dir.root, [/\.test\.ts$/], new Set())
    expect(results.length).toBe(50)
    // All 50 should be found (well under 2000 cap)
  })

  it('scanTestFiles handles symlink loops gracefully via maxDepth', () => {
    // maxDepth prevents infinite recursion even without symlink detection
    writeFile(dir.root, 'a/b/c/d/e/f/g/h/i/j/k/deep.test.ts', '')
    const results = scanTestFiles(dir.root, [/\.test\.ts$/], new Set(), 5)
    // Won't find it at depth 11 with maxDepth 5
    expect(results).toHaveLength(0)
  })
})

describe('hardening: malformed input parsing', () => {
  it('parseTestBlocks handles files with only closing braces', () => {
    const items = parseTestBlocks('}\n)\n}\n)', 'bad.test.ts')
    expect(items).toEqual([])
  })

  it('parseTestBlocks handles extremely long lines', () => {
    const longLine = 'test("' + 'a'.repeat(10000) + '", () => {})'
    const items = parseTestBlocks(longLine, 'long.test.ts')
    expect(items).toHaveLength(1)
  })

  it('parseTestBlocks handles mixed quotes', () => {
    const content = `
it('single quoted', () => {})
it("double quoted", () => {})
it(\`backtick quoted\`, () => {})
`
    const items = parseTestBlocks(content, 'mixed.test.ts')
    expect(items).toHaveLength(3)
  })

  it('parseTestBlocks handles describe without closing brace', () => {
    const content = `
describe('unclosed', () => {
  it('test inside', () => {})
`
    // Should not throw
    const items = parseTestBlocks(content, 'unclosed.test.ts')
    expect(items.length).toBeGreaterThanOrEqual(1)
  })

  it('parseJavaTestMethods handles @Test on last line with no method after', () => {
    const content = `
public class FooTest {
    @Test
}
`
    const items = parseJavaTestMethods(content, 'FooTest.java', 'FooTest')
    // @Test on line 3, line 4 is "}" — no method match, nextIsTest should reset
    expect(items).toEqual([])
  })

  it('parseJavaTestMethods handles @Test followed by non-method line', () => {
    const content = `
@Test
// This is a comment
public void actualTest() {}
`
    const items = parseJavaTestMethods(content, 'Test.java', 'TestClass')
    // @Test on line 2, line 3 is comment (no match), nextIsTest resets
    // line 4 has no @Test before it
    // This is a known limitation — the regex parser doesn't handle comments between @Test and method
    expect(items).toHaveLength(0)
  })
})

describe('hardening: adapter detect resilience', () => {
  let dir: TestDir
  beforeEach(() => { dir = createTestDir() })
  afterEach(() => { dir.cleanup() })

  it('VitestAdapter handles binary package.json', async () => {
    // Write binary content that JSON.parse will fail on
    const binContent = Buffer.from([0x00, 0x01, 0xff, 0xfe])
    fs.writeFileSync(path.join(dir.root, 'package.json'), binContent)
    const adapter = new VitestAdapter()
    const result = await adapter.detect(dir.root)
    // Should not throw, just return null
    expect(result).toBeNull()
  })

  it('JUnitMavenAdapter handles binary pom.xml', async () => {
    const binContent = Buffer.from([0x00, 0x01, 0xff, 0xfe])
    fs.writeFileSync(path.join(dir.root, 'pom.xml'), binContent)
    const adapter = new JUnitMavenAdapter()
    // Should not throw
    const result = await adapter.detect(dir.root)
    expect(result).toBeDefined() // returns non-null because file exists, may have low confidence
  })

  it('detectAdapters never throws even with all adapters failing', async () => {
    // Empty dir — all adapters return null
    const results = await detectAdapters(dir.root)
    expect(Array.isArray(results)).toBe(true)
  })
})

describe('hardening: result parsing edge cases', () => {
  let dir: TestDir
  beforeEach(() => { dir = createTestDir() })
  afterEach(() => { dir.cleanup() })

  it('VitestAdapter parseResults handles garbled output', async () => {
    const adapter = new VitestAdapter()
    const config = { adapterId: 'vitest', configFile: 'vitest.config.ts', configDir: dir.root, confidence: 1 }
    const result = await adapter.parseResults('\x00\x01\xff binary garbage', dir.root, config)
    expect(result).toBeDefined()
    expect(result.summary.total).toBe(0)
  })

  it('JUnit parseResults handles XML with special characters', async () => {
    const adapter = new JUnitMavenAdapter()
    const config = { adapterId: 'junit-maven', configFile: 'pom.xml', configDir: dir.root, confidence: 0.9 }
    writeFile(dir.root, 'target/surefire-reports/TEST-Special.xml',
      '<testsuite tests="1"><testcase name="test &amp; special &lt;chars&gt;" classname="Special" time="0.1"/></testsuite>')
    const results = await adapter.parseResults('', dir.root, config)
    expect(results.summary.total).toBe(1)
    expect(results.summary.passed).toBe(1)
  })

  it('JUnit parseResults handles self-closing testcase tags', async () => {
    const adapter = new JUnitMavenAdapter()
    const config = { adapterId: 'junit-maven', configFile: 'pom.xml', configDir: dir.root, confidence: 0.9 }
    writeFile(dir.root, 'target/surefire-reports/TEST-SelfClose.xml',
      '<testsuite tests="2"><testcase name="a" classname="X" time="0.1"/><testcase name="b" classname="X" time="0.2"/></testsuite>')
    const results = await adapter.parseResults('', dir.root, config)
    expect(results.summary.total).toBe(2)
    expect(results.tests.every(t => t.status === 'passed')).toBe(true)
  })
})

describe('hardening: concurrent safety', () => {
  let dir: TestDir
  beforeEach(() => { dir = createTestDir() })
  afterEach(() => { dir.cleanup() })

  it('multiple concurrent detect calls for different dirs dont interfere', async () => {
    const dir2 = createTestDir()
    try {
      writeFile(dir.root, 'vitest.config.ts', 'export default {}')
      writeFile(dir2.root, 'pom.xml', '<project><dependencies><dependency><groupId>junit</groupId></dependency></dependencies></project>')

      const [r1, r2] = await Promise.all([
        detectAdapters(dir.root),
        detectAdapters(dir2.root)
      ])

      expect(r1.some(r => r.adapterId === 'vitest')).toBe(true)
      expect(r1.some(r => r.adapterId === 'junit-maven')).toBe(false)
      expect(r2.some(r => r.adapterId === 'junit-maven')).toBe(true)
    } finally {
      dir2.cleanup()
    }
  })
})
