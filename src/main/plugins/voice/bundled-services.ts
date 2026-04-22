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

declare const __BUILD_SHA__: string

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

export type PythonDirSource = 'override' | 'packaged' | 'fallback' | 'dev'

export interface PythonIntegrityReport {
  pythonDir: string
  source: PythonDirSource
  missing: string[]
  present: string[]
}

/**
 * Pristine copy of the Python tree that electron-vite's `copyVoicePythonPlugin`
 * step lays into `out/main/voice-python/` on every build. Because the whole
 * `out/` tree is packed into `app.asar`, this copy rides inside a single
 * atomic blob — NSIS either replaces all of app.asar or none of it, so this
 * source is guaranteed to match the running TS bundle. Used as the self-heal
 * source when the on-disk `extraResources` copy drifts (see
 * `ensureFallbackExtracted`).
 */
function asarBundledPythonDir(): string {
  return path.join(__dirname, 'voice-python')
}

function fallbackPythonDir(): string {
  return path.join(app.getPath('userData'), 'voice-python-fallback')
}

const FALLBACK_STAMP_FILENAME = '.asar-source.json'

function currentBuildSha(): string {
  try {
    return typeof __BUILD_SHA__ === 'string' ? __BUILD_SHA__ : 'unknown'
  } catch {
    return 'unknown'
  }
}

function checkIntegrity(dir: string): { missing: string[]; present: string[] } {
  const missing: string[] = []
  const present: string[] = []
  for (const name of EXPECTED_PYTHON_SCRIPTS) {
    if (fs.existsSync(path.join(dir, name))) present.push(name)
    else missing.push(name)
  }
  return { missing, present }
}

/**
 * Recursively copy `src` → `dest` using only fs primitives that Electron's
 * asar shim transparently redirects (`statSync`, `readdirSync`,
 * `copyFileSync`). `fs.cpSync` with `recursive: true` internally opens the
 * source directory via `opendir`, which the shim does *not* cover — so a
 * src path that lives inside app.asar throws `ENOENT: opendir`. This
 * helper is that workaround.
 *
 * `filter` is applied per-path (directory OR file); returning false skips
 * that entry and, for directories, the entire subtree.
 */
function _copyDirRecursive(
  src: string,
  dest: string,
  filter?: (p: string) => boolean
): void {
  if (filter && !filter(src)) return
  const stat = fs.statSync(src)
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true })
    for (const entry of fs.readdirSync(src)) {
      _copyDirRecursive(path.join(src, entry), path.join(dest, entry), filter)
    }
  } else if (stat.isFile()) {
    fs.copyFileSync(src, dest)
  }
  // Silently skip other kinds (symlinks, etc.) — not expected inside the
  // voice-python tree and not worth the complexity of handling them here.
}

/**
 * Copy the asar-bundled Python tree into a writable userData directory so
 * we have a guaranteed-fresh source to feed to the daemons when the
 * `extraResources` copy is stale (the classic "NSIS couldn't replace a
 * locked .pyc so it silently skipped half the subdir" failure mode).
 *
 * Idempotent: stamped with the current app build SHA. Subsequent calls for
 * the same build skip the copy unless the extracted dir itself has been
 * tampered with. Returns null on unrecoverable failure so callers can fall
 * back to surfacing the error instead of pointing at an empty directory.
 */
function ensureFallbackExtracted(): string | null {
  const fallback = fallbackPythonDir()
  const stampPath = path.join(fallback, FALLBACK_STAMP_FILENAME)
  const sha = currentBuildSha()

  if (fs.existsSync(stampPath)) {
    try {
      const stamp = JSON.parse(fs.readFileSync(stampPath, 'utf-8')) as { buildSha?: string }
      if (stamp.buildSha === sha) {
        const check = checkIntegrity(fallback)
        if (check.missing.length === 0) return fallback
        log(
          `[voice] fallback python tree stamp matched buildSha=${sha} but integrity failed ` +
          `(missing=${check.missing.join(', ')}) — re-extracting`
        )
      } else {
        log(
          `[voice] fallback python tree built for ${stamp.buildSha ?? '?'}, current buildSha=${sha} — re-extracting`
        )
      }
    } catch (err) {
      logError('[voice] failed to read fallback stamp — re-extracting', err)
    }
  }

  const src = asarBundledPythonDir()
  if (!fs.existsSync(src)) {
    logError(`[voice] asar-bundled python source missing at ${src} — cannot self-heal`)
    return null
  }

  try {
    // Clean slate. maxRetries handles Windows' transient ENOTEMPTY/EBUSY
    // while __pycache__ holds its parent dir briefly busy after daemon exit.
    fs.rmSync(fallback, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    fs.mkdirSync(path.dirname(fallback), { recursive: true })
    // NOTE: can't use `fs.cpSync(src, ..., { recursive: true })` here — it
    // calls `opendir` internally which isn't covered by Electron's asar
    // shim, so a `src` that lives inside app.asar fails with
    // `ENOENT: opendir`. The manual recurse below uses only the shimmed
    // primitives (`readdirSync`, `statSync`, `copyFileSync`) which DO
    // transparently read from asar.
    _copyDirRecursive(src, fallback, (p) => {
      const name = path.basename(p)
      if (name === '__pycache__') return false
      if (name.endsWith('.pyc')) return false
      return true
    })
    const verify = checkIntegrity(fallback)
    if (verify.missing.length > 0) {
      logError(
        `[voice] self-heal extraction completed but integrity still failed ` +
        `(missing=${verify.missing.join(', ')}) — asar source may be truncated at ${src}`
      )
      return null
    }
    fs.writeFileSync(
      stampPath,
      JSON.stringify(
        { buildSha: sha, extractedAt: new Date().toISOString(), source: src },
        null,
        2
      )
    )
    log(
      `[voice] self-healed stale python tree — extracted asar-bundled copy ` +
      `from ${src} to ${fallback} (buildSha=${sha})`
    )
    return fallback
  } catch (err) {
    logError('[voice] self-heal extraction failed', err)
    return null
  }
}

function resolveBundledPythonDir(): string {
  return resolveBundledPythonDirWithSource().dir
}

function resolveBundledPythonDirWithSource(): { dir: string; source: PythonDirSource } {
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
    const check = checkIntegrity(overridePython)
    if (check.missing.length === 0) {
      return { dir: overridePython, source: 'override' }
    }
    // A stale override means the plugin-updater wrote a python/ tree from a
    // plugins.zip that's older than the app binary currently running. The
    // app's own asar-bundled copy is by definition fresher — fall through.
    log(
      `[voice] ignoring stale override at ${overridePython} ` +
      `(missing=${check.missing.join(', ')}) — falling through to packaged/fallback`
    )
  }

  // In packaged builds the Python runtime ships via electron-builder's
  // `extraResources`, which copies src/main/plugins/voice/python/ into
  // <install>/resources/voice-python/. `asarUnpack` was attempted first but
  // silently failed to extract the tree on install (the files stayed inside
  // app.asar), so `extraResources` is the reliable path. For dev builds the
  // `copyVoicePythonPlugin` step in electron.vite.config.ts still copies the
  // same tree to <bundle>/voice-python/ alongside __dirname.
  if (app.isPackaged) {
    const packaged = path.join(process.resourcesPath, 'voice-python')
    const check = checkIntegrity(packaged)
    if (check.missing.length === 0) {
      return { dir: packaged, source: 'packaged' }
    }
    // NSIS upgrades can silently leave `resources/voice-python/src/` stale
    // when Python holds any .pyc file inside it busy at upgrade time — the
    // top-level files get replaced but the locked subdirectory doesn't. The
    // asar-bundled copy is immune (asar is replaced atomically), so lay it
    // down on disk as a fallback and steer daemons to it.
    log(
      `[voice] packaged python tree is stale at ${packaged} ` +
      `(missing=${check.missing.join(', ')}) — attempting self-heal from asar-bundled copy`
    )
    const healed = ensureFallbackExtracted()
    if (healed) return { dir: healed, source: 'fallback' }
    // Self-heal failed. Return the stale packaged path so the downstream
    // integrity check produces its usual actionable error instead of a
    // misleading "fallback" label pointing at a directory that doesn't
    // contain what we claim.
    return { dir: packaged, source: 'packaged' }
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
  const { missing, present } = checkIntegrity(dir)
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
      return 'Installed app is out of sync with its TS bundle and self-heal from app.asar also failed — reinstall the latest Claude Dock.'
    case 'fallback':
      return 'Self-healed copy is incomplete — delete %APPDATA%/claude-dock/voice-python-fallback and restart the app.'
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
