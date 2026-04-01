import { describe, it, expect, vi } from 'vitest'

vi.mock('../services', () => ({
  getServices: () => ({
    log: () => {},
    logError: () => {}
  })
}))

import { VitestAdapter } from '../adapters/vitest-adapter'
import { JUnitMavenAdapter, JUnitGradleAdapter } from '../adapters/junit-adapter'
import type { DetectionResult } from '../adapters/runner-adapter'

const vitestConfig: DetectionResult = { adapterId: 'vitest', configFile: 'vitest.config.ts', configDir: '/project', confidence: 1 }
const mavenConfig: DetectionResult = { adapterId: 'junit-maven', configFile: 'pom.xml', configDir: '/project', confidence: 0.9 }
const gradleConfig: DetectionResult = { adapterId: 'junit-gradle', configFile: 'build.gradle.kts', configDir: '/project', confidence: 0.9 }

describe('VitestAdapter command building', () => {
  const adapter = new VitestAdapter()

  it('builds run-all command', () => {
    const cmd = adapter.buildRunCommand('/project', vitestConfig, [])
    expect(cmd).toContain('npx vitest run')
    expect(cmd).toContain('--reporter=verbose')
  })

  it('builds command for specific test files', () => {
    const cmd = adapter.buildRunCommand('/project', vitestConfig, ['src/foo.test.ts', 'src/bar.test.ts'])
    expect(cmd).toContain('src/foo.test.ts')
    expect(cmd).toContain('src/bar.test.ts')
  })

  it('builds command with grep option', () => {
    const cmd = adapter.buildRunCommand('/project', vitestConfig, [], { grep: 'should add' })
    expect(cmd).toContain('--testNamePattern="should add"')
  })

  it('handles test name IDs (without path separators)', () => {
    const cmd = adapter.buildRunCommand('/project', vitestConfig, ['should add numbers'])
    expect(cmd).toContain('--testNamePattern=')
  })
})

describe('JUnitMavenAdapter command building', () => {
  const adapter = new JUnitMavenAdapter()

  it('builds run-all command', () => {
    const cmd = adapter.buildRunCommand('/project', mavenConfig, [])
    expect(cmd).toBe('mvn test -Dsurefire.useFile=false')
  })

  it('builds command for specific test classes', () => {
    const cmd = adapter.buildRunCommand('/project', mavenConfig, ['com.example.FooTest'])
    expect(cmd).toContain('-Dtest=com.example.FooTest')
  })

  it('builds command for multiple test classes', () => {
    const cmd = adapter.buildRunCommand('/project', mavenConfig, ['com.example.FooTest', 'com.example.BarTest'])
    expect(cmd).toContain('-Dtest=com.example.FooTest,com.example.BarTest')
  })
})

describe('JUnitGradleAdapter command building', () => {
  const adapter = new JUnitGradleAdapter()

  it('builds run-all command', () => {
    const cmd = adapter.buildRunCommand('/project', gradleConfig, [])
    expect(cmd).toBe('./gradlew test')
  })

  it('builds command for specific test classes', () => {
    const cmd = adapter.buildRunCommand('/project', gradleConfig, ['com.example.FooTest'])
    expect(cmd).toContain('--tests "com.example.FooTest"')
  })

  it('builds command for multiple tests', () => {
    const cmd = adapter.buildRunCommand('/project', gradleConfig, ['FooTest', 'BarTest'])
    expect(cmd).toContain('--tests "FooTest"')
    expect(cmd).toContain('--tests "BarTest"')
  })
})
