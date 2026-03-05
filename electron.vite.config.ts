import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'child_process'

function getBuildInfo() {
  try {
    const sha = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim()
    const date = execSync('git log -1 --format=%cd --date=short', { encoding: 'utf-8' }).trim()
    return { sha, date }
  } catch {
    return { sha: 'unknown', date: new Date().toISOString().slice(0, 10) }
  }
}

const { sha, date } = getBuildInfo()

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
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
      __BUILD_DATE__: JSON.stringify(date)
    },
    build: {
      outDir: 'out/renderer'
    }
  }
})
