import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'child_process'
import { resolve } from 'path'
import * as fs from 'fs'
import * as path from 'path'

/**
 * Copies the voice plugin's Python runtime into the main-process build output.
 *
 * The Python scripts are spawned as a subprocess at runtime, so they must
 * travel with every build — not just packaged installers. By landing them in
 * out/main/voice-python/, they get bundled into app.asar (unpacked via
 * electron-builder's asarUnpack rule) and are available to `electron-vite dev`
 * as well. This replaces the earlier extraResources-only strategy, which
 * silently dropped the Python bundle when electron-builder wasn't part of the
 * build pipeline.
 */
function copyVoicePythonPlugin() {
  return {
    name: 'dock-copy-voice-python',
    closeBundle() {
      const src = path.resolve(__dirname, 'src/main/plugins/voice/python')
      const dst = path.resolve(__dirname, 'out/main/voice-python')
      if (!fs.existsSync(src)) {
        throw new Error(`[copy-voice-python] source missing: ${src}`)
      }
      fs.rmSync(dst, { recursive: true, force: true })
      fs.cpSync(src, dst, { recursive: true })
    }
  }
}

/**
 * Copies the Claude Dock MCP server script into the main-process build output.
 *
 * `resources/claude-dock-mcp.cjs` ships to production via electron-builder's
 * `extraResources` — but NSIS upgrades have been observed to silently skip
 * replacing individual `extraResources` files (same failure class as the
 * voice-python stale-bundle bug). The result: app.asar gets the fresh TS
 * bundle that expects new server behavior (e.g. DOCK_MCP_TOOLSET partitioning),
 * but the on-disk .cjs is still from the original install and ignores the
 * new env vars.
 *
 * Mirroring the voice-python strategy, we land a second copy inside app.asar
 * at `out/main/bundled/claude-dock-mcp.cjs`. Because app.asar is replaced
 * atomically by NSIS as a single blob, that copy is guaranteed to match the
 * TS bundle. `getMcpServerSourcePath()` in linked-mode.ts self-heals by
 * extracting the asar-bundled copy into userData whenever the two disagree.
 */
function copyMcpScriptPlugin() {
  return {
    name: 'dock-copy-mcp-script',
    closeBundle() {
      const src = path.resolve(__dirname, 'resources/claude-dock-mcp.cjs')
      const dstDir = path.resolve(__dirname, 'out/main/bundled')
      const dst = path.join(dstDir, 'claude-dock-mcp.cjs')
      if (!fs.existsSync(src)) {
        throw new Error(`[copy-mcp-script] source missing: ${src}`)
      }
      fs.mkdirSync(dstDir, { recursive: true })
      fs.copyFileSync(src, dst)
    }
  }
}

function getBuildInfo() {
  try {
    const sha = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim()
    const fullSha = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim()
    const date = execSync('git log -1 --format=%cd --date=short', { encoding: 'utf-8' }).trim()
    return { sha, fullSha, date }
  } catch {
    return { sha: 'unknown', fullSha: 'unknown', date: new Date().toISOString().slice(0, 10) }
  }
}

/**
 * Get the last git commit SHA that modified files in the given directory.
 * This produces a stable per-plugin SHA that only changes when that plugin's
 * source code actually changes, avoiding false update notifications.
 */
function getPluginBuildSha(pluginSrcDir: string): string {
  try {
    return execSync(`git log -1 --format=%H -- "${pluginSrcDir}"`, { encoding: 'utf-8' }).trim()
  } catch {
    return 'unknown'
  }
}

const { sha, fullSha, date } = getBuildInfo()
const isDev = process.env.PRODUCTION_BUILD !== '1'
const envProfile = (process.env.DOCK_ENV_PROFILE || (isDev ? 'dev' : 'uat')) as 'dev' | 'uat' | 'prod'
// When packaging without an explicit UPDATE_PROFILE, infer from env profile:
// uat→bleeding-edge, prod→latest. Dev still defaults to 'latest' but the auto-updater
// is gated off entirely in dev builds.
const defaultUpdateProfile = envProfile === 'uat' ? 'bleeding-edge' : 'latest'
const updateProfile = process.env.UPDATE_PROFILE || defaultUpdateProfile
const debugDefault = updateProfile === 'bleeding-edge'

// Unix epoch (seconds) of the HEAD commit — used to determine if plugin updates
// in the manifest are newer than what's bundled in this app build
let appBuildEpoch = Math.floor(Date.now() / 1000)
try {
  appBuildEpoch = parseInt(execSync('git log -1 --format=%ct', { encoding: 'utf-8' }).trim(), 10)
} catch { /* fallback to current time */ }

// Per-plugin build SHAs: only change when the plugin's own source directory is modified
const pluginBuildShas: Record<string, string> = {
  'git-manager': getPluginBuildSha('src/main/plugins/git-manager'),
  'cloud-integration': getPluginBuildSha('src/main/plugins/cloud-integration'),
  'test-runner': getPluginBuildSha('src/main/plugins/test-runner'),
  'workspace': getPluginBuildSha('src/main/plugins/workspace'),
  'memory': getPluginBuildSha('src/main/plugins/memory'),
  'voice': getPluginBuildSha('src/main/plugins/voice')
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), copyVoicePythonPlugin(), copyMcpScriptPlugin()],
    define: {
      __BUILD_SHA__: JSON.stringify(fullSha),
      __DEV__: JSON.stringify(isDev),
      __UPDATE_PROFILE__: JSON.stringify(updateProfile),
      __ENV_PROFILE__: JSON.stringify(envProfile),
      __DEBUG_DEFAULT__: JSON.stringify(debugDefault),
      __PLUGIN_BUILD_SHAS__: JSON.stringify(pluginBuildShas),
      __APP_BUILD_EPOCH__: JSON.stringify(appBuildEpoch)
    },
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: {
          index: 'src/main/index.ts',
          'pty-host': 'src/main/pty-host.ts'
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    define: {
      __ENV_PROFILE__: JSON.stringify(envProfile)
    },
    build: {
      outDir: 'out/preload'
    }
  },
  renderer: {
    plugins: [react()],
    resolve: {
      alias: {
        '@dock-renderer': resolve(__dirname, 'src/renderer/src'),
        '@plugins': resolve(__dirname, 'src/main/plugins')
      }
    },
    define: {
      __BUILD_SHA__: JSON.stringify(sha),
      __BUILD_DATE__: JSON.stringify(date),
      __DEV__: JSON.stringify(isDev),
      __ENV_PROFILE__: JSON.stringify(envProfile)
    },
    build: {
      outDir: 'out/renderer'
    }
  }
})
