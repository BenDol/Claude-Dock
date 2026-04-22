/**
 * Factory that wires real app singletons into the VoiceServices interface.
 * The only file in the voice/ directory that imports app singletons directly.
 */

import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { log, logError } from '../../logger'
import { getSettings } from '../../settings-store'
import { getWindowState, saveWindowState } from '../../window-state-store'
import { broadcastPluginWindowState } from '../plugin-window-broadcast'
import { resolveRendererOverride } from '../plugin-renderer-utils'
import { NotificationManager } from '../../notification-manager'
import type { VoiceServices, VoiceNotificationPayload } from './services'

/**
 * Files we expect to find in the resolved python/ tree. Missing any of these
 * is a packaging/install drift bug, not a user config issue — the TS bundle
 * and the on-disk python/ directory were built at different commits.
 *
 * The list intentionally includes recent-feature files under src/ (not just
 * top-level scripts). A stale bundle frequently still has the top-level
 * scripts but is missing newer modules those scripts import — e.g. an old
 * install that predates the pynput refactor has `hotkey_daemon.py` but no
 * `src/hotkey_parser.py`, and the venv requirements drove a pynput install
 * that the old daemon can't use (it still `import keyboard`), producing a
 * restart loop with "'keyboard' package not installed — exiting". Adding
 * these structural markers lets the integrity check flag the drift before
 * we spawn a daemon that is guaranteed to crash.
 */
export const EXPECTED_PYTHON_SCRIPTS = [
  'server.py',
  'hotkey_daemon.py',
  'dictation_daemon.py',
  'requirements.txt',
  // Introduced with the pynput cross-platform hotkey refactor. Absence means
  // hotkey_daemon.py on disk still imports `keyboard` while the venv was
  // provisioned against the newer pynput-based requirements.txt.
  'src/hotkey_parser.py',
  // Introduced with the CUDA auto-install feature. Absence means the GPU
  // verify probe's `from src.cuda_setup import setup_cuda_dll_paths` fails
  // with ModuleNotFoundError right after a successful pip install.
  'src/cuda_setup.py'
] as const

export interface PythonIntegrityReport {
  pythonDir: string
  source: 'override' | 'packaged' | 'dev'
  missing: string[]
  present: string[]
}

function resolveBundledPythonDir(): string {
  return resolveBundledPythonDirWithSource().dir
}

function resolveBundledPythonDirWithSource(): { dir: string; source: 'override' | 'packaged' | 'dev' } {
  // Plugin updates can deliver an updated python/ tree alongside the JS
  // bundle (see scripts/generate-plugin-archive.js `extraDirs`). When the
  // plugin-updater has installed an override for voice, prefer its python/
  // directory — otherwise the on-disk Python (shipped with the original
  // app install) goes out of sync with the freshly-updated TS bundle that
  // drives it, producing mismatches like `VoiceRecorder.__init__() got an
  // unexpected keyword argument 'device'`.
  const overridePython = path.join(
    app.getPath('userData'),
    'plugin-overrides',
    'voice',
    'python'
  )
  if (fs.existsSync(overridePython)) {
    return { dir: overridePython, source: 'override' }
  }
  // In packaged builds the Python runtime ships via electron-builder's
  // `extraResources`, which copies src/main/plugins/voice/python/ into
  // <install>/resources/voice-python/. `asarUnpack` was attempted first but
  // silently failed to extract the tree on install (the files stayed inside
  // app.asar), so `extraResources` is the reliable path. For dev builds the
  // `copyVoicePythonPlugin` step in electron.vite.config.ts still copies the
  // same tree to <bundle>/voice-python/ alongside __dirname.
  if (app.isPackaged) {
    return { dir: path.join(process.resourcesPath, 'voice-python'), source: 'packaged' }
  }
  return { dir: path.join(__dirname, 'voice-python'), source: 'dev' }
}

/**
 * Inspect the resolved python directory and report any missing expected
 * scripts. Callers use this to surface packaging/install drift at startup
 * and to produce actionable error messages at call sites.
 */
export function verifyBundledPythonIntegrity(): PythonIntegrityReport {
  const { dir, source } = resolveBundledPythonDirWithSource()
  const missing: string[] = []
  const present: string[] = []
  for (const name of EXPECTED_PYTHON_SCRIPTS) {
    if (fs.existsSync(path.join(dir, name))) {
      present.push(name)
    } else {
      missing.push(name)
    }
  }
  return { pythonDir: dir, source, missing, present }
}

/**
 * Short remediation hint suitable for appending to user-visible error
 * messages. Phrasing differs by source so the user isn't told to "reinstall"
 * when they're running `electron-vite dev` locally.
 */
export function repairHintForSource(source: PythonIntegrityReport['source']): string {
  switch (source) {
    case 'override':
      return 'Plugin override is incomplete — reset voice in Settings → Plugins → Updates, or delete %APPDATA%/claude-dock/plugin-overrides/voice.'
    case 'packaged':
      return 'Installed app is out of sync with its TS bundle — reinstall the latest Claude Dock.'
    case 'dev':
      return 'Dev build is missing the script — run `npx electron-vite build` (or restart `electron-vite dev`) to refresh out/main/voice-python/.'
  }
}

function voiceDataDir(): string {
  return path.join(app.getPath('userData'), 'voice')
}

export function createBundledServices(): VoiceServices {
  const mapLevel = (l: VoiceNotificationPayload['level']): 'info' | 'success' | 'warning' | 'error' => {
    switch (l) {
      case 'warn': return 'warning'
      case 'error': return 'error'
      default: return 'info'
    }
  }

  return {
    log,
    logError,

    getSettings: () => getSettings() as unknown as { theme: { mode: string } },

    getWindowState,
    saveWindowState,
    broadcastPluginWindowState,

    notify: (payload) => {
      try {
        NotificationManager.getInstance().notify({
          title: payload.title,
          message: payload.body,
          type: mapLevel(payload.level),
          source: 'voice',
          projectDir: payload.projectDir ?? undefined
        })
      } catch (err) {
        logError('[voice] notify failed', err)
      }
    },

    getVoiceDataDir: voiceDataDir,

    paths: {
      preload: path.join(__dirname, '../preload/index.js'),
      rendererHtml: path.join(__dirname, '../renderer/index.html'),
      rendererUrl: process.env.ELECTRON_RENDERER_URL,
      rendererOverrideHtml: resolveRendererOverride('voice'),
      pythonDir: resolveBundledPythonDir()
    }
  }
}
