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

const { sha, fullSha, date } = getBuildInfo()
const isDev = process.env.NODE_ENV !== 'production'
const updateProfile = process.env.UPDATE_PROFILE || 'latest'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: {
      __BUILD_SHA__: JSON.stringify(fullSha),
      __DEV__: JSON.stringify(isDev),
      __UPDATE_PROFILE__: JSON.stringify(updateProfile)
    },
    build: {
      outDir: 'out/main'
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
