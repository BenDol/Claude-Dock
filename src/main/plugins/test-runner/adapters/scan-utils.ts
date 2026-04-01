import * as fs from 'fs'
import * as path from 'path'
import type { TestItem } from './runner-adapter'

/**
 * Recursively scan a directory for files matching any of the given patterns.
 * Skips directories in the skipDirs set.
 */
export function scanTestFiles(dir: string, patterns: RegExp[], skipDirs: Set<string>, maxDepth = 10): string[] {
  const results: string[] = []
  const walk = (current: string, depth: number) => {
    if (depth > maxDepth) return
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(current, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) walk(path.join(current, entry.name), depth + 1)
      } else if (entry.isFile()) {
        const name = entry.name
        if (patterns.some((p) => p.test(name))) {
          results.push(path.join(current, name))
        }
      }
    }
  }
  walk(dir, 0)
  return results.sort()
}

/**
 * Parse JS/TS test file content to extract describe/it/test blocks.
 * Uses regex heuristics — not a full AST parse, but good enough for discovery.
 */
export function parseTestBlocks(content: string, fileId: string): TestItem[] {
  const items: TestItem[] = []
  const lines = content.split('\n')
  const describeStack: { label: string; children: TestItem[] }[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineNo = i + 1

    // Match: describe('name', ...) or describe("name", ...)
    const descMatch = line.match(/^\s*describe\s*\(\s*['"`](.+?)['"`]/)
    if (descMatch) {
      const item: TestItem = {
        id: `${fileId}::describe::${descMatch[1]}`,
        label: descMatch[1],
        type: 'describe',
        filePath: fileId,
        line: lineNo,
        children: []
      }
      if (describeStack.length > 0) {
        describeStack[describeStack.length - 1].children.push(item)
      } else {
        items.push(item)
      }
      describeStack.push({ label: descMatch[1], children: item.children! })
      continue
    }

    // Match: it('name', ...) or test('name', ...)
    const testMatch = line.match(/^\s*(?:it|test)\s*\(\s*['"`](.+?)['"`]/)
    if (testMatch) {
      const item: TestItem = {
        id: `${fileId}::test::${testMatch[1]}`,
        label: testMatch[1],
        type: 'test',
        filePath: fileId,
        line: lineNo
      }
      if (describeStack.length > 0) {
        describeStack[describeStack.length - 1].children.push(item)
      } else {
        items.push(item)
      }
      continue
    }

    // Track closing braces to pop describe stack (heuristic)
    if (line.match(/^\s*\}\s*\)/) && describeStack.length > 0) {
      describeStack.pop()
    }
  }

  return items
}

/**
 * Parse Java test file content to extract @Test annotated methods.
 */
export function parseJavaTestMethods(content: string, fileId: string, className: string): TestItem[] {
  const items: TestItem[] = []
  const lines = content.split('\n')
  let nextIsTest = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    const lineNo = i + 1

    if (line === '@Test' || line.startsWith('@Test(') || line.includes('@org.junit.')) {
      nextIsTest = true
      continue
    }

    if (nextIsTest) {
      // Match: public void methodName() or void methodName()
      const methodMatch = line.match(/(?:public\s+)?(?:void|boolean|int|String)\s+(\w+)\s*\(/)
      if (methodMatch) {
        items.push({
          id: `${className}#${methodMatch[1]}`,
          label: methodMatch[1],
          type: 'test',
          filePath: fileId,
          line: lineNo
        })
      }
      nextIsTest = false
    }
  }

  return items
}
