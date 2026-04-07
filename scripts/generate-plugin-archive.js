/**
 * Generates plugins.zip and plugins.update manifest from built plugin bundles.
 *
 * Runs after `electron-vite build` in CI. For each built-in plugin:
 * 1. Builds a standalone CommonJS bundle using esbuild
 * 2. Generates a plugin.json manifest
 * 3. Computes SHA-256 content hash (stable — only changes when plugin code changes)
 * 4. Creates dist/plugins.zip and dist/plugins.update
 *
 * Key design: The content hash and per-plugin buildSha are derived exclusively
 * from the plugin's own source directory, so they only change when that plugin's
 * code actually changes — not on every repo commit.
 *
 * Note: Standalone plugin builds are done here (not in electron.vite.config.ts)
 * because adding extra rollup entry points to the main config causes code splitting
 * that breaks __dirname-based path resolution in the packaged app.
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const DIST_DIR = path.join(ROOT, 'dist')
const STAGING_DIR = path.join(DIST_DIR, 'plugins-staging')
const SRC_PLUGINS = path.join(ROOT, 'src', 'main', 'plugins')

// Built-in plugins to package
const BUILTIN_PLUGINS = [
  { id: 'git-sync', srcDir: 'git-sync', entry: 'git-sync-plugin.ts' },
  { id: 'git-manager', srcDir: 'git-manager', entry: 'git-manager-plugin.ts',
    rendererEntry: 'src/main/plugins/git-manager/renderer/standalone-entry.tsx' },
  { id: 'cloud-integration', srcDir: 'cloud-integration', entry: 'cloud-integration-plugin.ts' },
  { id: 'test-runner', srcDir: 'test-runner', entry: 'test-runner-plugin.ts' },
  { id: 'memory', srcDir: 'memory', entry: 'memory-plugin.ts',
    rendererEntry: 'src/main/plugins/memory/renderer/standalone-entry.tsx' },
  // workspace renders inside the dock window (not its own BrowserWindow),
  // so renderer changes require a full app update — cannot be hot-updated.
  { id: 'workspace', srcDir: 'workspace', entry: 'workspace-plugin.ts', requiresAppUpdate: true }
]

/**
 * Hash the contents of a directory deterministically.
 * Only includes file names and contents — no timestamps, no metadata.
 */
function hashDirectory(dirPath) {
  const hash = crypto.createHash('sha256')
  const entries = fs.readdirSync(dirPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name)
    if (entry.isFile()) {
      hash.update(entry.name)
      hash.update(fs.readFileSync(fullPath))
    } else if (entry.isDirectory()) {
      hash.update(entry.name)
      hash.update(hashDirectory(fullPath))
    }
  }
  return hash.digest('hex')
}

/**
 * Get the last git commit SHA that modified files in the given directory.
 * Falls back to hashing the source if git is unavailable.
 */
function getPluginBuildSha(srcDir) {
  try {
    return execSync(`git log -1 --format=%H -- "${srcDir}"`, { encoding: 'utf-8' }).trim()
  } catch {
    return hashDirectory(srcDir)
  }
}

/**
 * Get the Unix epoch (seconds) of the last commit that modified files in the given directory.
 * Used by the updater to determine if a plugin was modified after the app was built.
 */
function getPluginCommitEpoch(srcDir) {
  try {
    return parseInt(execSync(`git log -1 --format=%ct -- "${srcDir}"`, { encoding: 'utf-8' }).trim(), 10)
  } catch {
    return 0
  }
}

function extractPluginMetadata(srcDir, pluginId) {
  const pluginFiles = fs.readdirSync(srcDir).filter(f => f.endsWith('-plugin.ts'))
  if (pluginFiles.length === 0) {
    console.warn(`  No *-plugin.ts found in ${srcDir}, using defaults`)
    return { name: pluginId, description: '' }
  }

  const content = fs.readFileSync(path.join(srcDir, pluginFiles[0]), 'utf-8')
  const nameMatch = content.match(/readonly\s+name\s*=\s*'([^']+)'/)
  const descMatch = content.match(/readonly\s+description\s*=\s*'([^']+)'/)

  return {
    name: nameMatch ? nameMatch[1] : pluginId,
    description: descMatch ? descMatch[1] : ''
  }
}

/**
 * Build a standalone CommonJS bundle for a plugin using esbuild.
 * This runs as a separate build step so it doesn't affect the main vite output.
 */
function buildStandalonePlugin(entryPath, outPath) {
  // esbuild is available as a dependency of electron-vite
  execSync(
    `npx esbuild "${entryPath}" --bundle --platform=node --format=cjs --outfile="${outPath}" --external:electron --external:child_process --external:fs --external:path --external:os --external:crypto --external:https --external:http --external:net --external:tls --external:url --external:stream --external:util --external:events --external:buffer`,
    { cwd: ROOT, encoding: 'utf-8', stdio: 'pipe' }
  )
}

function main() {
  console.log('Generating plugin archive...')

  // Get repo-wide build info (for the top-level manifest only)
  let repoBuildSha = 'unknown'
  let buildDate = new Date().toISOString().slice(0, 10)
  try {
    repoBuildSha = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim()
    buildDate = execSync('git log -1 --format=%cd --date=short', { encoding: 'utf-8' }).trim()
  } catch { /* fallback to defaults */ }

  // Get app version from package.json
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'))
  const appVersion = pkg.version

  // Clean and create staging directory
  if (fs.existsSync(STAGING_DIR)) {
    fs.rmSync(STAGING_DIR, { recursive: true })
  }
  fs.mkdirSync(STAGING_DIR, { recursive: true })

  const manifest = {
    schemaVersion: 1,
    buildSha: repoBuildSha,
    buildDate,
    plugins: {}
  }

  for (const plugin of BUILTIN_PLUGINS) {
    console.log(`  Processing ${plugin.id}...`)

    const srcDir = path.join(SRC_PLUGINS, plugin.srcDir)
    const entryPath = path.join(srcDir, plugin.entry)

    if (!fs.existsSync(entryPath)) {
      console.warn(`  Entry file not found: ${entryPath}, skipping`)
      continue
    }

    const meta = extractPluginMetadata(srcDir, plugin.id)
    const pluginBuildSha = getPluginBuildSha(srcDir)
    const pluginCommitEpoch = getPluginCommitEpoch(srcDir)

    // Create plugin staging directory
    const pluginStaging = path.join(STAGING_DIR, plugin.id)
    fs.mkdirSync(pluginStaging, { recursive: true })

    // Build standalone bundle — skip for plugins marked requiresAppUpdate
    const outPath = path.join(pluginStaging, 'index.js')
    let requiresAppUpdate = !!plugin.requiresAppUpdate
    if (requiresAppUpdate) {
      console.log(`  ${plugin.id}: marked as requiresAppUpdate — skipping standalone build`)
      fs.writeFileSync(outPath, `// Requires full app update — standalone build not applicable\nmodule.exports = {};\n`)
    } else {
      try {
        buildStandalonePlugin(entryPath, outPath)
        console.log(`  Built standalone bundle for ${plugin.id}`)
      } catch {
        console.log(`  ${plugin.id}: standalone build failed — marking as requiresAppUpdate`)
        fs.writeFileSync(outPath, `// Standalone build not available — update via full app update\nmodule.exports = {};\n`)
        requiresAppUpdate = true
      }
    }

    // Build standalone renderer bundle if this plugin has a rendererEntry
    if (plugin.rendererEntry) {
      const rendererEntryPath = path.join(ROOT, plugin.rendererEntry)
      if (fs.existsSync(rendererEntryPath)) {
        const rendererStaging = path.join(pluginStaging, 'renderer')
        fs.mkdirSync(rendererStaging, { recursive: true })

        try {
          const dockRendererAlias = path.join(ROOT, 'src', 'renderer', 'src')
          execSync(
            `npx esbuild "${rendererEntryPath}" --bundle --platform=browser --format=iife --jsx=automatic --loader:.css=css --alias:@dock-renderer=${dockRendererAlias} --outfile="${path.join(rendererStaging, 'bundle.js')}"`,
            { cwd: ROOT, encoding: 'utf-8', stdio: 'pipe' }
          )
          console.log(`  Built standalone renderer bundle for ${plugin.id}`)

          // Copy standalone HTML shell
          const htmlSrc = path.join(path.dirname(rendererEntryPath), 'standalone-index.html')
          if (fs.existsSync(htmlSrc)) {
            fs.copyFileSync(htmlSrc, path.join(rendererStaging, 'index.html'))
          } else {
            console.warn(`  standalone-index.html not found at ${htmlSrc}`)
          }
        } catch (err) {
          console.warn(`  ${plugin.id}: renderer build failed — override renderer will not be available`)
          console.warn(`  ${err.message || err}`)
          // Clean up partial renderer dir
          if (fs.existsSync(rendererStaging)) {
            fs.rmSync(rendererStaging, { recursive: true })
          }
        }
      }
    }

    // Generate plugin.json — does NOT contain buildSha so hash stays stable
    const pluginJson = {
      id: plugin.id,
      name: meta.name,
      version: appVersion,
      description: meta.description,
      defaultEnabled: false,
      main: 'index.js'
    }
    fs.writeFileSync(
      path.join(pluginStaging, 'plugin.json'),
      JSON.stringify(pluginJson, null, 2)
    )

    // Compute content hash of staging dir (index.js + plugin.json).
    // This hash is STABLE — it only changes when the actual plugin code changes,
    // not when the git commit SHA or build metadata changes.
    const contentHash = hashDirectory(pluginStaging)

    // Write meta.json (for override loading) — NOT included in contentHash above
    fs.writeFileSync(
      path.join(pluginStaging, 'meta.json'),
      JSON.stringify({ version: appVersion, buildSha: pluginBuildSha, hash: contentHash, installedAt: 0 }, null, 2)
    )

    // Use the stable content hash (excludes meta.json) in the manifest so that
    // update detection is based on actual code changes, not build metadata.
    manifest.plugins[plugin.id] = {
      version: appVersion,
      buildSha: pluginBuildSha,
      commitEpoch: pluginCommitEpoch,
      hash: contentHash,
      archivePath: `${plugin.id}/`,
      changelog: '',
      minAppVersion: undefined,
      requiresAppUpdate
    }

    console.log(`  ${plugin.id}: v${appVersion}, pluginSha=${pluginBuildSha.slice(0, 7)}, epoch=${pluginCommitEpoch}, hash=${contentHash.slice(0, 12)}...`)
  }

  // Create plugins.zip
  const zipPath = path.join(DIST_DIR, 'plugins.zip')
  console.log(`Creating ${zipPath}...`)

  if (process.platform === 'win32') {
    execSync(
      `powershell -NoProfile -Command "Compress-Archive -Path '${STAGING_DIR}/*' -DestinationPath '${zipPath}' -Force"`,
      { stdio: 'inherit' }
    )
  } else {
    execSync(`cd "${STAGING_DIR}" && zip -r "${zipPath}" .`, { stdio: 'inherit' })
  }

  // Write plugins.update manifest
  const manifestPath = path.join(DIST_DIR, 'plugins.update')
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  console.log(`Written ${manifestPath}`)

  // Clean up staging
  fs.rmSync(STAGING_DIR, { recursive: true })

  console.log('Plugin archive generation complete.')
}

main()
