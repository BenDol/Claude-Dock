import * as fs from 'fs'
import * as path from 'path'
import type { RunnerAdapter, DetectionResult, TestItem, RunOptions, TestRunResult } from './runner-adapter'
import { scanTestFiles, parseTestBlocks } from './scan-utils'

const TEST_PATTERNS = [/\.test\.[tjm]sx?$/, /\.spec\.[tjm]sx?$/, /__tests__\/.*\.[tjm]sx?$/]
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.nuxt'])

export class VitestAdapter implements RunnerAdapter {
  readonly id = 'vitest'
  readonly name = 'Vitest'
  readonly icon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#729B1B" stroke-width="2"><path d="M12 2L2 19h20L12 2z"/></svg>'

  async detect(projectDir: string): Promise<DetectionResult | null> {
    const configNames = ['vitest.config.ts', 'vitest.config.js', 'vitest.config.mts', 'vitest.config.mjs']
    for (const name of configNames) {
      if (fs.existsSync(path.join(projectDir, name))) {
        return { adapterId: this.id, configFile: name, configDir: projectDir, confidence: 1.0 }
      }
    }
    try {
      const pkgPath = path.join(projectDir, 'package.json')
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
        const deps = { ...pkg.devDependencies, ...pkg.dependencies }
        if (deps.vitest) {
          return { adapterId: this.id, configFile: 'package.json', configDir: projectDir, confidence: 0.8 }
        }
      }
    } catch { /* ignore */ }
    return null
  }

  async discover(projectDir: string, config: DetectionResult): Promise<TestItem[]> {
    const testFiles = scanTestFiles(config.configDir, TEST_PATTERNS, SKIP_DIRS)
    const items: TestItem[] = []

    for (const absPath of testFiles) {
      const relPath = path.relative(projectDir, absPath).replace(/\\/g, '/')
      let content = ''
      try { content = fs.readFileSync(absPath, 'utf-8') } catch { continue }

      const children = parseTestBlocks(content, relPath)

      items.push({
        id: relPath,
        label: path.basename(relPath),
        type: 'file',
        filePath: relPath,
        children: children.length > 0 ? children : undefined
      })
    }

    return items
  }

  buildRunCommand(_projectDir: string, _config: DetectionResult, testIds: string[], options?: RunOptions): string {
    const args = ['npx', 'vitest', 'run', '--reporter=verbose']
    if (options?.grep) args.push(`--testNamePattern="${options.grep}"`)
    // testIds are file paths or test name patterns
    const files = testIds.filter((id) => id.includes('/') || id.includes('.'))
    const names = testIds.filter((id) => !id.includes('/') && !id.includes('.'))
    if (files.length > 0) args.push(...files)
    if (names.length > 0 && !options?.grep) args.push(`--testNamePattern="${names.join('|')}"`)
    return args.join(' ')
  }

  async parseResults(output: string, _projectDir: string, _config: DetectionResult): Promise<TestRunResult> {
    const tests: TestRunResult['tests'] = []
    let passed = 0, failed = 0, skipped = 0
    const durationMatch = output.match(/Duration\s+([\d.]+)\s*s/)
    const duration = durationMatch ? Math.round(parseFloat(durationMatch[1]) * 1000) : undefined

    // Parse verbose output lines: ✓/×/- test name (Xms)
    for (const line of output.split('\n')) {
      const passMatch = line.match(/^\s*[✓✔√]\s+(.+?)(?:\s+\((\d+)\s*ms\))?\s*$/)
      if (passMatch) {
        passed++
        tests.push({ id: `t-${tests.length}`, name: passMatch[1].trim(), status: 'passed', duration: passMatch[2] ? parseInt(passMatch[2]) : undefined })
        continue
      }
      const failMatch = line.match(/^\s*[✗✘×]\s+(.+?)(?:\s+\((\d+)\s*ms\))?\s*$/)
      if (failMatch) {
        failed++
        tests.push({ id: `t-${tests.length}`, name: failMatch[1].trim(), status: 'failed', duration: failMatch[2] ? parseInt(failMatch[2]) : undefined })
        continue
      }
      const skipMatch = line.match(/^\s*[-○]\s+(.+?)(?:\s+\((\d+)\s*ms\))?\s*$/)
      if (skipMatch && !line.includes('SKIP')) {
        // Avoid false positives — only count lines that look like test results
        continue
      }
      if (line.match(/^\s*[-○⊘]\s+(.+)\[skipped\]/i) || line.match(/^\s*[-]\s+(.+?)$/)) {
        const m = line.match(/^\s*[-○⊘]\s+(.+?)(?:\s+\[skipped\])?\s*$/)
        if (m && line.toLowerCase().includes('skip')) {
          skipped++
          tests.push({ id: `t-${tests.length}`, name: m[1].trim(), status: 'skipped' })
        }
      }
    }

    // Parse error blocks: attach to the last failed test
    const errorBlocks = output.split(/FAIL\s+/)
    for (const block of errorBlocks.slice(1)) {
      const lines = block.split('\n')
      const errLines: string[] = []
      let capturing = false
      for (const l of lines) {
        if (l.includes('AssertionError') || l.includes('Error:') || l.includes('expected') || capturing) {
          capturing = true
          errLines.push(l)
          if (errLines.length > 20) break
        }
      }
      if (errLines.length > 0) {
        // Find the matching failed test and attach the error
        const failedTest = tests.find((t) => t.status === 'failed' && !t.error)
        if (failedTest) {
          failedTest.error = { message: errLines[0].trim(), stack: errLines.slice(1).join('\n').trim() || undefined }
        }
      }
    }

    const total = passed + failed + skipped
    const status = failed > 0 ? 'failed' : total > 0 ? 'passed' : 'error'
    return { status, summary: { total, passed, failed, skipped, duration }, tests }
  }
}
