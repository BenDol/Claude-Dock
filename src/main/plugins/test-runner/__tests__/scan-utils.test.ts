import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { scanTestFiles, parseTestBlocks, parseJavaTestMethods } from '../adapters/scan-utils'
import { createTestDir, writeFile, type TestDir } from './setup'

describe('scanTestFiles', () => {
  let dir: TestDir
  beforeEach(() => { dir = createTestDir() })
  afterEach(() => { dir.cleanup() })

  it('finds test files matching patterns', () => {
    writeFile(dir.root, 'src/foo.test.ts', '')
    writeFile(dir.root, 'src/bar.spec.js', '')
    writeFile(dir.root, 'src/baz.ts', '') // not a test
    const results = scanTestFiles(dir.root, [/\.test\.tsx?$/, /\.spec\.jsx?$/], new Set())
    expect(results).toHaveLength(2)
    expect(results.some(r => r.includes('foo.test.ts'))).toBe(true)
    expect(results.some(r => r.includes('bar.spec.js'))).toBe(true)
  })

  it('skips directories in skipDirs', () => {
    writeFile(dir.root, 'node_modules/pkg/index.test.ts', '')
    writeFile(dir.root, 'src/real.test.ts', '')
    const results = scanTestFiles(dir.root, [/\.test\.tsx?$/], new Set(['node_modules']))
    expect(results).toHaveLength(1)
    expect(results[0]).toContain('real.test.ts')
  })

  it('respects maxDepth', () => {
    writeFile(dir.root, 'a/b/c/d/e/deep.test.ts', '')
    const shallow = scanTestFiles(dir.root, [/\.test\.tsx?$/], new Set(), 2)
    expect(shallow).toHaveLength(0) // depth 4 > maxDepth 2
    const deep = scanTestFiles(dir.root, [/\.test\.tsx?$/], new Set(), 10)
    expect(deep).toHaveLength(1)
  })

  it('returns empty array for nonexistent directory', () => {
    const results = scanTestFiles('/tmp/does-not-exist-' + Date.now(), [/\.test\.ts$/], new Set())
    expect(results).toEqual([])
  })

  it('returns sorted results', () => {
    writeFile(dir.root, 'z.test.ts', '')
    writeFile(dir.root, 'a.test.ts', '')
    writeFile(dir.root, 'm.test.ts', '')
    const results = scanTestFiles(dir.root, [/\.test\.ts$/], new Set())
    const names = results.map(r => r.split(/[/\\]/).pop())
    expect(names).toEqual(['a.test.ts', 'm.test.ts', 'z.test.ts'])
  })

  it('handles empty directories gracefully', () => {
    const results = scanTestFiles(dir.root, [/\.test\.ts$/], new Set())
    expect(results).toEqual([])
  })
})

describe('parseTestBlocks', () => {
  it('parses describe and it blocks', () => {
    const content = `
describe('Calculator', () => {
  it('should add', () => {})
  it('should subtract', () => {})
})
`
    const items = parseTestBlocks(content, 'calc.test.ts')
    expect(items).toHaveLength(1)
    expect(items[0].label).toBe('Calculator')
    expect(items[0].type).toBe('describe')
    expect(items[0].children).toHaveLength(2)
    expect(items[0].children![0].label).toBe('should add')
    expect(items[0].children![0].type).toBe('test')
    expect(items[0].children![1].label).toBe('should subtract')
  })

  it('parses test() calls as top-level tests', () => {
    const content = `test('standalone test', () => {})`
    const items = parseTestBlocks(content, 'file.test.ts')
    expect(items).toHaveLength(1)
    expect(items[0].label).toBe('standalone test')
    expect(items[0].type).toBe('test')
  })

  it('parses nested describe blocks', () => {
    const content = `
describe('outer', () => {
  describe('inner', () => {
    it('deep test', () => {})
  })
})
`
    const items = parseTestBlocks(content, 'nested.test.ts')
    expect(items).toHaveLength(1)
    expect(items[0].children).toHaveLength(1)
    expect(items[0].children![0].label).toBe('inner')
    expect(items[0].children![0].children).toHaveLength(1)
    expect(items[0].children![0].children![0].label).toBe('deep test')
  })

  it('includes line numbers', () => {
    const content = `describe('suite', () => {\n  it('test one', () => {})\n})`
    const items = parseTestBlocks(content, 'file.test.ts')
    expect(items[0].line).toBe(1)
    expect(items[0].children![0].line).toBe(2)
  })

  it('handles double-quoted strings', () => {
    const content = `it("double quoted", () => {})`
    const items = parseTestBlocks(content, 'file.test.ts')
    expect(items[0].label).toBe('double quoted')
  })

  it('handles backtick strings', () => {
    const content = 'it(`template literal`, () => {})'
    const items = parseTestBlocks(content, 'file.test.ts')
    expect(items[0].label).toBe('template literal')
  })

  it('returns empty array for non-test file', () => {
    const items = parseTestBlocks('const x = 1;\nconsole.log(x);', 'util.ts')
    expect(items).toEqual([])
  })

  it('handles empty content', () => {
    expect(parseTestBlocks('', 'empty.test.ts')).toEqual([])
  })

  it('generates unique IDs', () => {
    const content = `
describe('suite', () => {
  it('test a', () => {})
  it('test b', () => {})
})
`
    const items = parseTestBlocks(content, 'file.test.ts')
    const ids = items[0].children!.map(c => c.id)
    expect(new Set(ids).size).toBe(ids.length) // all unique
  })
})

describe('parseJavaTestMethods', () => {
  it('extracts @Test annotated methods', () => {
    const content = `
package com.example;
import org.junit.Test;
public class FooTest {
    @Test
    public void testSomething() {}

    @Test
    public void testAnother() {}

    public void notATest() {}
}
`
    const items = parseJavaTestMethods(content, 'FooTest.java', 'com.example.FooTest')
    expect(items).toHaveLength(2)
    expect(items[0].label).toBe('testSomething')
    expect(items[0].id).toBe('com.example.FooTest#testSomething')
    expect(items[1].label).toBe('testAnother')
  })

  it('handles @Test with parameters', () => {
    const content = `
@Test(expected = Exception.class)
public void testThrows() {}
`
    const items = parseJavaTestMethods(content, 'Test.java', 'TestClass')
    expect(items).toHaveLength(1)
    expect(items[0].label).toBe('testThrows')
  })

  it('handles @org.junit.Test fully qualified annotation', () => {
    const content = `
@org.junit.Test
public void testFullyQualified() {}
`
    const items = parseJavaTestMethods(content, 'Test.java', 'TestClass')
    expect(items).toHaveLength(1)
  })

  it('handles different return types', () => {
    const content = `
@Test
void testNoModifier() {}
@Test
public boolean testBoolean() { return true; }
`
    const items = parseJavaTestMethods(content, 'Test.java', 'TestClass')
    expect(items).toHaveLength(2)
  })

  it('skips methods without @Test', () => {
    const content = `
public void setUp() {}
public void helperMethod() {}
`
    const items = parseJavaTestMethods(content, 'Test.java', 'TestClass')
    expect(items).toEqual([])
  })

  it('returns empty array for empty content', () => {
    expect(parseJavaTestMethods('', 'Test.java', 'TestClass')).toEqual([])
  })

  it('includes line numbers', () => {
    const content = `@Test\npublic void testOne() {}`
    const items = parseJavaTestMethods(content, 'Test.java', 'TestClass')
    expect(items[0].line).toBe(2)
  })
})
