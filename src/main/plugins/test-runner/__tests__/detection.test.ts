import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Mock services before importing anything that uses them
vi.mock('../services', () => ({
  getServices: () => ({
    log: () => {},
    logError: () => {}
  })
}))

import { VitestAdapter } from '../adapters/vitest-adapter'
import { JUnitMavenAdapter, JUnitGradleAdapter } from '../adapters/junit-adapter'
import { detectAdapters } from '../adapters/adapter-registry'
import { createTestDir, writeFile, createVitestProject, createMavenProject, createGradleProject, type TestDir } from './setup'

describe('VitestAdapter detection', () => {
  let dir: TestDir
  const adapter = new VitestAdapter()

  beforeEach(() => { dir = createTestDir() })
  afterEach(() => { dir.cleanup() })

  it('detects vitest.config.ts', async () => {
    writeFile(dir.root, 'vitest.config.ts', 'export default {}')
    const result = await adapter.detect(dir.root)
    expect(result).not.toBeNull()
    expect(result!.adapterId).toBe('vitest')
    expect(result!.confidence).toBe(1.0)
    expect(result!.configFile).toBe('vitest.config.ts')
  })

  it('detects vitest.config.js', async () => {
    writeFile(dir.root, 'vitest.config.js', 'module.exports = {}')
    const result = await adapter.detect(dir.root)
    expect(result).not.toBeNull()
    expect(result!.confidence).toBe(1.0)
  })

  it('detects vitest.config.mts', async () => {
    writeFile(dir.root, 'vitest.config.mts', '')
    const result = await adapter.detect(dir.root)
    expect(result).not.toBeNull()
  })

  it('detects vitest in package.json devDependencies', async () => {
    writeFile(dir.root, 'package.json', JSON.stringify({
      devDependencies: { vitest: '^1.0.0' }
    }))
    const result = await adapter.detect(dir.root)
    expect(result).not.toBeNull()
    expect(result!.confidence).toBe(0.8)
  })

  it('detects vitest in package.json dependencies', async () => {
    writeFile(dir.root, 'package.json', JSON.stringify({
      dependencies: { vitest: '1.0.0' }
    }))
    const result = await adapter.detect(dir.root)
    expect(result).not.toBeNull()
  })

  it('returns null for empty directory', async () => {
    const result = await adapter.detect(dir.root)
    expect(result).toBeNull()
  })

  it('returns null for package.json without vitest', async () => {
    writeFile(dir.root, 'package.json', JSON.stringify({
      devDependencies: { jest: '29.0.0' }
    }))
    const result = await adapter.detect(dir.root)
    expect(result).toBeNull()
  })

  it('handles malformed package.json gracefully', async () => {
    writeFile(dir.root, 'package.json', '{ invalid json }}}')
    const result = await adapter.detect(dir.root)
    expect(result).toBeNull()
  })

  it('returns null for nonexistent directory', async () => {
    const result = await adapter.detect('/tmp/nonexistent-' + Date.now())
    expect(result).toBeNull()
  })
})

describe('JUnitMavenAdapter detection', () => {
  let dir: TestDir
  const adapter = new JUnitMavenAdapter()

  beforeEach(() => { dir = createTestDir() })
  afterEach(() => { dir.cleanup() })

  it('detects pom.xml with junit dependency', async () => {
    createMavenProject(dir.root)
    const result = await adapter.detect(dir.root)
    expect(result).not.toBeNull()
    expect(result!.adapterId).toBe('junit-maven')
    expect(result!.confidence).toBe(0.9)
  })

  it('detects pom.xml with surefire plugin', async () => {
    writeFile(dir.root, 'pom.xml', '<project><build><plugins><plugin><artifactId>maven-surefire-plugin</artifactId></plugin></plugins></build></project>')
    const result = await adapter.detect(dir.root)
    expect(result).not.toBeNull()
    expect(result!.confidence).toBe(0.9)
  })

  it('detects plain pom.xml with lower confidence', async () => {
    writeFile(dir.root, 'pom.xml', '<project><modelVersion>4.0.0</modelVersion></project>')
    const result = await adapter.detect(dir.root)
    expect(result).not.toBeNull()
    expect(result!.confidence).toBe(0.5)
  })

  it('returns null without pom.xml', async () => {
    const result = await adapter.detect(dir.root)
    expect(result).toBeNull()
  })
})

describe('JUnitGradleAdapter detection', () => {
  let dir: TestDir
  const adapter = new JUnitGradleAdapter()

  beforeEach(() => { dir = createTestDir() })
  afterEach(() => { dir.cleanup() })

  it('detects build.gradle.kts with junit', async () => {
    createGradleProject(dir.root)
    const result = await adapter.detect(dir.root)
    expect(result).not.toBeNull()
    expect(result!.adapterId).toBe('junit-gradle')
    expect(result!.confidence).toBe(0.9)
  })

  it('detects build.gradle (groovy)', async () => {
    writeFile(dir.root, 'build.gradle', "dependencies { testImplementation 'junit:junit:4.13' }")
    const result = await adapter.detect(dir.root)
    expect(result).not.toBeNull()
  })

  it('prefers .kts over .gradle', async () => {
    writeFile(dir.root, 'build.gradle.kts', 'dependencies { testImplementation("junit:junit:4.13") }')
    writeFile(dir.root, 'build.gradle', 'apply plugin: "java"')
    const result = await adapter.detect(dir.root)
    expect(result!.configFile).toBe('build.gradle.kts')
  })

  it('returns null without gradle files', async () => {
    const result = await adapter.detect(dir.root)
    expect(result).toBeNull()
  })
})

describe('detectAdapters (registry)', () => {
  let dir: TestDir

  beforeEach(() => { dir = createTestDir() })
  afterEach(() => { dir.cleanup() })

  it('returns empty array for empty directory', async () => {
    const results = await detectAdapters(dir.root)
    expect(results).toEqual([])
  })

  it('detects multiple frameworks', async () => {
    createVitestProject(dir.root)
    createMavenProject(dir.root)
    const results = await detectAdapters(dir.root)
    expect(results.length).toBeGreaterThanOrEqual(2)
    const ids = results.map(r => r.adapterId)
    expect(ids).toContain('vitest')
    expect(ids).toContain('junit-maven')
  })

  it('sorts by confidence descending', async () => {
    createVitestProject(dir.root) // confidence 1.0
    writeFile(dir.root, 'pom.xml', '<project></project>') // confidence 0.5
    const results = await detectAdapters(dir.root)
    expect(results.length).toBeGreaterThanOrEqual(2)
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].confidence).toBeGreaterThanOrEqual(results[i].confidence)
    }
  })
})
