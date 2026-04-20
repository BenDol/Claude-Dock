import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'child_process'
import { resolve } from 'path'

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
  'git-sync': getPluginBuildSha('src/main/plugins/git-sync'),
  'git-manager': getPluginBuildSha('src/main/plugins/git-manager'),
  'cloud-integration': getPluginBuildSha('src/main/plugins/cloud-integration'),
  'test-runner': getPluginBuildSha('src/main/plugins/test-runner'),
  'workspace': getPluginBuildSha('src/main/plugins/workspace'),
  'memory': getPluginBuildSha('src/main/plugins/memory')
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
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
