import * as fs from 'fs'
import * as path from 'path'
import type { RunnerAdapter, DetectionResult, TestItem, RunOptions, TestRunResult, TestResult } from './runner-adapter'
import { scanTestFiles, parseJavaTestMethods } from './scan-utils'

const JAVA_TEST_PATTERNS = [/Test\.java$/, /Tests\.java$/, /TestCase\.java$/]
const SKIP_DIRS = new Set(['node_modules', '.git', 'build', 'target', '.gradle', '.idea', 'bin', 'out'])

/** Shared discovery + result parsing for JUnit (Maven and Gradle) */
class JUnitAdapterBase implements RunnerAdapter {
  readonly id: string
  readonly name: string
  readonly icon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#B07219" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 9h6v6H9z"/></svg>'

  constructor(id: string, name: string) {
    this.id = id
    this.name = name
  }

  async detect(_projectDir: string): Promise<DetectionResult | null> {
    return null
  }

  async discover(projectDir: string, config: DetectionResult): Promise<TestItem[]> {
    // Scan for Java test files under src/test
    const testRoot = path.join(config.configDir, 'src', 'test', 'java')
    if (!fs.existsSync(testRoot)) {
      // Fallback: scan the whole project for test files
      const files = scanTestFiles(config.configDir, JAVA_TEST_PATTERNS, SKIP_DIRS)
      return this.buildTestItems(files, projectDir)
    }
    const files = scanTestFiles(testRoot, JAVA_TEST_PATTERNS, SKIP_DIRS)
    return this.buildTestItems(files, projectDir)
  }

  private buildTestItems(files: string[], projectDir: string): TestItem[] {
    const items: TestItem[] = []
    for (const absPath of files) {
      const relPath = path.relative(projectDir, absPath).replace(/\\/g, '/')
      let content = ''
      try { content = fs.readFileSync(absPath, 'utf-8') } catch { continue }

      // Extract class name from file
      const classMatch = content.match(/(?:public\s+)?class\s+(\w+)/)
      const className = classMatch ? classMatch[1] : path.basename(absPath, '.java')

      // Extract package
      const pkgMatch = content.match(/package\s+([\w.]+)\s*;/)
      const fqn = pkgMatch ? `${pkgMatch[1]}.${className}` : className

      const methods = parseJavaTestMethods(content, relPath, fqn)

      items.push({
        id: fqn,
        label: className,
        type: 'suite',
        filePath: relPath,
        children: methods.length > 0 ? methods : undefined
      })
    }
    return items
  }

  buildRunCommand(_projectDir: string, _config: DetectionResult, _testIds: string[], _options?: RunOptions): string {
    return ''
  }

  async parseResults(output: string, projectDir: string, config: DetectionResult): Promise<TestRunResult> {
    // Try to parse JUnit XML reports first
    const xmlResults = this.parseXmlReports(projectDir, config)
    if (xmlResults) return xmlResults

    // Fallback: parse console output
    return this.parseConsoleOutput(output)
  }

  private parseXmlReports(projectDir: string, config: DetectionResult): TestRunResult | null {
    // Look for surefire or gradle test XML reports
    const reportDirs = [
      path.join(config.configDir, 'target', 'surefire-reports'),
      path.join(config.configDir, 'build', 'test-results', 'test')
    ]

    const tests: TestResult[] = []
    let found = false

    for (const dir of reportDirs) {
      if (!fs.existsSync(dir)) continue
      let files: string[]
      try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.xml')) } catch { continue }

      for (const file of files) {
        try {
          const xml = fs.readFileSync(path.join(dir, file), 'utf-8')
          found = true

          // Parse <testcase> elements
          const testcaseRe = /<testcase\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g
          let m: RegExpExecArray | null
          while ((m = testcaseRe.exec(xml)) !== null) {
            const attrs = m[1]
            const body = m[2] || ''
            const nameMatch = attrs.match(/name="([^"]*)"/)
            const classMatch = attrs.match(/classname="([^"]*)"/)
            const timeMatch = attrs.match(/time="([^"]*)"/)
            const name = nameMatch ? nameMatch[1] : 'unknown'
            const suite = classMatch ? classMatch[1] : undefined
            const duration = timeMatch ? Math.round(parseFloat(timeMatch[1]) * 1000) : undefined

            let status: TestResult['status'] = 'passed'
            let error: TestResult['error'] | undefined
            if (body.includes('<failure') || body.includes('<error')) {
              status = 'failed'
              const msgMatch = body.match(/message="([^"]*)"/)
              error = { message: msgMatch ? msgMatch[1] : 'Test failed', stack: body.replace(/<[^>]+>/g, '').trim() || undefined }
            } else if (body.includes('<skipped')) {
              status = 'skipped'
            }

            tests.push({ id: suite ? `${suite}#${name}` : name, name, suite, status, duration, error })
          }
        } catch { /* skip unparseable files */ }
      }
    }

    if (!found) return null

    const passed = tests.filter((t) => t.status === 'passed').length
    const failed = tests.filter((t) => t.status === 'failed').length
    const skipped = tests.filter((t) => t.status === 'skipped').length
    const total = tests.length
    const overallStatus = failed > 0 ? 'failed' : total > 0 ? 'passed' : 'error'

    return { status: overallStatus, summary: { total, passed, failed, skipped }, tests }
  }

  private parseConsoleOutput(output: string): TestRunResult {
    const tests: TestResult[] = []
    // Parse Maven/Gradle console output for test results
    // Maven: Tests run: X, Failures: Y, Errors: Z, Skipped: W
    const summaryMatch = output.match(/Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+),\s*Skipped:\s*(\d+)/)
    if (summaryMatch) {
      const total = parseInt(summaryMatch[1])
      const failed = parseInt(summaryMatch[2]) + parseInt(summaryMatch[3])
      const skipped = parseInt(summaryMatch[4])
      const passed = total - failed - skipped
      return {
        status: failed > 0 ? 'failed' : 'passed',
        summary: { total, passed, failed, skipped },
        tests
      }
    }
    // Gradle: X tests completed, Y failed
    const gradleMatch = output.match(/(\d+)\s+tests?\s+completed,\s*(\d+)\s+failed/)
    if (gradleMatch) {
      const total = parseInt(gradleMatch[1])
      const failed = parseInt(gradleMatch[2])
      return {
        status: failed > 0 ? 'failed' : 'passed',
        summary: { total, passed: total - failed, failed, skipped: 0 },
        tests
      }
    }
    return { status: 'error', summary: { total: 0, passed: 0, failed: 0, skipped: 0 }, tests }
  }
}

export class JUnitMavenAdapter extends JUnitAdapterBase {
  constructor() { super('junit-maven', 'JUnit (Maven)') }

  async detect(projectDir: string): Promise<DetectionResult | null> {
    const pomPath = path.join(projectDir, 'pom.xml')
    if (!fs.existsSync(pomPath)) return null
    try {
      const content = fs.readFileSync(pomPath, 'utf-8')
      if (content.includes('junit') || content.includes('surefire')) {
        return { adapterId: this.id, configFile: 'pom.xml', configDir: projectDir, confidence: 0.9 }
      }
      return { adapterId: this.id, configFile: 'pom.xml', configDir: projectDir, confidence: 0.5 }
    } catch { return null }
  }

  buildRunCommand(_projectDir: string, _config: DetectionResult, testIds: string[], _options?: RunOptions): string {
    if (testIds.length === 0) return 'mvn test -Dsurefire.useFile=false'
    const tests = testIds.join(',')
    return `mvn test -Dtest=${tests} -Dsurefire.useFile=false`
  }
}

export class JUnitGradleAdapter extends JUnitAdapterBase {
  constructor() { super('junit-gradle', 'JUnit (Gradle)') }

  async detect(projectDir: string): Promise<DetectionResult | null> {
    const gradleKts = path.join(projectDir, 'build.gradle.kts')
    const gradle = path.join(projectDir, 'build.gradle')
    const configFile = fs.existsSync(gradleKts) ? 'build.gradle.kts' : fs.existsSync(gradle) ? 'build.gradle' : null
    if (!configFile) return null
    try {
      const content = fs.readFileSync(path.join(projectDir, configFile), 'utf-8')
      if (content.includes('junit') || content.includes('test')) {
        return { adapterId: this.id, configFile, configDir: projectDir, confidence: 0.9 }
      }
      return { adapterId: this.id, configFile, configDir: projectDir, confidence: 0.5 }
    } catch { return null }
  }

  buildRunCommand(_projectDir: string, _config: DetectionResult, testIds: string[], _options?: RunOptions): string {
    if (testIds.length === 0) return './gradlew test'
    const tests = testIds.map((t) => `--tests "${t}"`).join(' ')
    return `./gradlew test ${tests}`
  }
}
