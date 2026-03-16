import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'child_process'

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
const updateProfile = process.env.UPDATE_PROFILE || 'latest'
const debugDefault = updateProfile === 'bleeding-edge'

// Per-plugin build SHAs: only change when the plugin's own source directory is modified
const pluginBuildShas: Record<string, string> = {
  'git-sync': getPluginBuildSha('src/main/plugins/git-sync'),
  'git-manager': getPluginBuildSha('src/main/plugins/git-manager')
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: {
      __BUILD_SHA__: JSON.stringify(fullSha),
      __DEV__: JSON.stringify(isDev),
      __UPDATE_PROFILE__: JSON.stringify(updateProfile),
      __DEBUG_DEFAULT__: JSON.stringify(debugDefault),
      __PLUGIN_BUILD_SHAS__: JSON.stringify(pluginBuildShas)
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
    build: {
      outDir: 'out/preload'
    }
  },
  renderer: {
    plugins: [react()],
    define: {
      __BUILD_SHA__: JSON.stringify(sha),
      __BUILD_DATE__: JSON.stringify(date),
      __DEV__: JSON.stringify(isDev)
    },
    build: {
      outDir: 'out/renderer'
    }
  }
})
