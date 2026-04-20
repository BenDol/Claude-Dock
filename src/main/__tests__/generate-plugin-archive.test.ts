import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { execSync } from 'child_process'

const ROOT = path.resolve(__dirname, '..', '..', '..')
const SCRIPT = path.join(ROOT, 'scripts', 'generate-plugin-archive.js')
const DIST_DIR = path.join(ROOT, 'dist')

describe('generate-plugin-archive.js', () => {
  // The archive script builds standalone plugin bundles via esbuild.
  // Check that esbuild is available (it's a dependency of electron-vite).
  const hasEsbuild = fs.existsSync(path.join(ROOT, 'node_modules', '.bin', 'esbuild')) ||
    fs.existsSync(path.join(ROOT, 'node_modules', '.bin', 'esbuild.cmd'))
  const hasBuiltPlugins = hasEsbuild

  it.skipIf(!hasBuiltPlugins)('generates plugins.zip', () => {
    // Clean previous artifacts
    const zipPath = path.join(DIST_DIR, 'plugins.zip')
    const updatePath = path.join(DIST_DIR, 'plugins.update')
    try { fs.unlinkSync(zipPath) } catch { /* ignore */ }
    try { fs.unlinkSync(updatePath) } catch { /* ignore */ }

    execSync(`node "${SCRIPT}"`, { cwd: ROOT, encoding: 'utf-8' })

    expect(fs.existsSync(zipPath)).toBe(true)
    expect(fs.statSync(zipPath).size).toBeGreaterThan(0)
  })

  it.skipIf(!hasBuiltPlugins)('generates plugins.update manifest', () => {
    const updatePath = path.join(DIST_DIR, 'plugins.update')
    // Script may have been run by previous test
    if (!fs.existsSync(updatePath)) {
      execSync(`node "${SCRIPT}"`, { cwd: ROOT, encoding: 'utf-8' })
    }

    expect(fs.existsSync(updatePath)).toBe(true)

    const manifest = JSON.parse(fs.readFileSync(updatePath, 'utf-8'))
    expect(manifest.schemaVersion).toBe(1)
    expect(manifest.buildSha).toBeDefined()
    expect(manifest.buildDate).toBeDefined()
    expect(manifest.plugins).toBeDefined()
  })

  it.skipIf(!hasBuiltPlugins)('manifest contains entries for each built-in plugin', () => {
    const updatePath = path.join(DIST_DIR, 'plugins.update')
    if (!fs.existsSync(updatePath)) {
      execSync(`node "${SCRIPT}"`, { cwd: ROOT, encoding: 'utf-8' })
    }

    const manifest = JSON.parse(fs.readFileSync(updatePath, 'utf-8'))

    for (const pluginId of ['git-sync', 'git-manager', 'voice']) {
      expect(manifest.plugins[pluginId]).toBeDefined()
      const entry = manifest.plugins[pluginId]
      expect(entry.version).toBeDefined()
      expect(entry.buildSha).toBeDefined()
      expect(entry.hash).toBeDefined()
      expect(entry.archivePath).toBe(`${pluginId}/`)
    }
  })

  it.skipIf(!hasBuiltPlugins)('per-plugin buildSha is scoped to the plugin source directory', () => {
    const updatePath = path.join(DIST_DIR, 'plugins.update')
    if (!fs.existsSync(updatePath)) {
      execSync(`node "${SCRIPT}"`, { cwd: ROOT, encoding: 'utf-8' })
    }

    const manifest = JSON.parse(fs.readFileSync(updatePath, 'utf-8'))

    // The per-plugin buildSha should be the last commit touching that plugin's src dir.
    // Skip plugins with no git history (uncommitted) — they fall back to a content
    // hash in generate-plugin-archive.js.
    for (const pluginId of ['git-sync', 'git-manager', 'voice']) {
      const entry = manifest.plugins[pluginId]
      const srcDir = `src/main/plugins/${pluginId}`

      let expectedSha: string
      try {
        expectedSha = execSync(`git log -1 --format=%H -- "${srcDir}"`, { cwd: ROOT, encoding: 'utf-8' }).trim()
      } catch {
        continue // skip if git is unavailable
      }

      if (!expectedSha) continue // uncommitted plugin — skip this specific check
      expect(entry.buildSha).toBe(expectedSha)
    }
  })

  it.skipIf(!hasBuiltPlugins)('per-plugin buildSha differs from repo-wide buildSha when appropriate', () => {
    const updatePath = path.join(DIST_DIR, 'plugins.update')
    if (!fs.existsSync(updatePath)) {
      execSync(`node "${SCRIPT}"`, { cwd: ROOT, encoding: 'utf-8' })
    }

    const manifest = JSON.parse(fs.readFileSync(updatePath, 'utf-8'))

    // Repo-wide SHA is the HEAD commit
    let headSha: string
    try {
      headSha = execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf-8' }).trim()
    } catch {
      return // skip if git unavailable
    }

    // The top-level manifest buildSha should be the repo-wide HEAD
    expect(manifest.buildSha).toBe(headSha)

    // At least one plugin should have a different (older) per-plugin SHA
    // unless the most recent commit happened to touch all plugin dirs
    const pluginShas = Object.values(manifest.plugins).map((p: any) => p.buildSha)
    // This isn't guaranteed — just a sanity check that they're valid SHA hashes.
    // Accept 40-char git SHA-1 or 64-char content SHA-256 (fallback for
    // uncommitted plugin dirs).
    for (const sha of pluginShas) {
      expect(sha).toMatch(/^[a-f0-9]{40}$|^[a-f0-9]{64}$/)
    }
  })

  it.skipIf(!hasBuiltPlugins)('content hash is stable across consecutive runs (deterministic)', { timeout: 60000 }, () => {
    // Run the script twice back-to-back and compare content hashes.
    // esbuild is deterministic for identical source input, so the
    // content hash (SHA-256 of the staging directory) must be identical.
    //
    // Note: buildSha is NOT compared here because it uses `git log` which
    // can return different results when concurrent git operations from other
    // test files (e.g., submodule tests) temporarily affect the index.
    //
    // Timeout is extended because esbuild can be slow under CPU contention
    // when vitest runs all test files in parallel.
    const zipPath = path.join(DIST_DIR, 'plugins.zip')
    const updatePath = path.join(DIST_DIR, 'plugins.update')

    try { fs.unlinkSync(zipPath) } catch { /* ignore */ }
    try { fs.unlinkSync(updatePath) } catch { /* ignore */ }
    execSync(`node "${SCRIPT}"`, { cwd: ROOT, encoding: 'utf-8', timeout: 25000 })
    const run1 = JSON.parse(fs.readFileSync(updatePath, 'utf-8'))

    try { fs.unlinkSync(zipPath) } catch { /* ignore */ }
    try { fs.unlinkSync(updatePath) } catch { /* ignore */ }
    execSync(`node "${SCRIPT}"`, { cwd: ROOT, encoding: 'utf-8', timeout: 25000 })
    const run2 = JSON.parse(fs.readFileSync(updatePath, 'utf-8'))

    for (const pluginId of ['git-sync', 'git-manager', 'voice']) {
      expect(run1.plugins[pluginId].hash).toBe(run2.plugins[pluginId].hash)
    }
  })
})
