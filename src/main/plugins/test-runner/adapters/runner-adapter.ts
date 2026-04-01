/**
 * Abstract interface that all test framework adapters must implement.
 * Adding a new framework = create a new file implementing RunnerAdapter
 * and register it in adapter-registry.ts.
 */

export interface RunnerAdapter {
  readonly id: string
  readonly name: string
  readonly icon: string // SVG markup

  /** Detect if this framework is present in the project. */
  detect(projectDir: string): Promise<DetectionResult | null>

  /** Discover available tests/suites/files. */
  discover(projectDir: string, config: DetectionResult): Promise<TestItem[]>

  /** Build the shell command to run specific tests (empty testIds = run all). */
  buildRunCommand(projectDir: string, config: DetectionResult, testIds: string[], options?: RunOptions): string

  /** Parse structured results from test output or result files. */
  parseResults(output: string, projectDir: string, config: DetectionResult): Promise<TestRunResult>
}

export interface DetectionResult {
  adapterId: string
  configFile: string
  configDir: string
  confidence: number // 0-1
  metadata?: Record<string, unknown>
}

export interface TestItem {
  id: string
  label: string
  type: 'suite' | 'file' | 'test' | 'describe'
  filePath?: string
  line?: number
  children?: TestItem[]
}

export interface RunOptions {
  watch?: boolean
  verbose?: boolean
  grep?: string
  adapterConfig?: {
    profiles?: string
    extraArgs?: string
    env?: Record<string, string>
  }
}

export interface TestRunResult {
  status: 'passed' | 'failed' | 'error' | 'running'
  summary: {
    total: number
    passed: number
    failed: number
    skipped: number
    duration?: number // milliseconds
  }
  tests: TestResult[]
}

export interface TestResult {
  id: string
  name: string
  suite?: string
  status: 'passed' | 'failed' | 'skipped' | 'error'
  duration?: number
  error?: {
    message: string
    stack?: string
    expected?: string
    actual?: string
  }
}
