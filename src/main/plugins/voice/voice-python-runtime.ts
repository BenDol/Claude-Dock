/**
 * Python runtime management for the Voice plugin.
 *
 * Responsibilities:
 *   1. Detect a usable system Python (>= 3.10)
 *   2. Otherwise download an isolated python-build-standalone release
 *   3. Create a venv under <userData>/voice/venv
 *   4. Install requirements.txt into the venv
 *   5. Verify critical imports
 *
 * All steps stream progress via the provided callback so the UI can render
 * a responsive setup wizard. Every subprocess and error is logged — never
 * silently swallowed.
 */

import { app, net } from 'electron'
import { execFile, spawn, ChildProcess } from 'child_process'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { getServices } from './services'
import type { VoiceSetupProgress } from '../../../shared/voice-types'

const svc = () => getServices()

/* ------------------------------------------------------------------ */
/* Python version gate                                                */
/* ------------------------------------------------------------------ */

const MIN_MAJOR = 3
const MIN_MINOR = 10

function parseVersion(stdout: string): { major: number; minor: number; patch: number } | null {
  const m = stdout.trim().match(/Python\s+(\d+)\.(\d+)(?:\.(\d+))?/)
  if (!m) return null
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: m[3] ? Number(m[3]) : 0
  }
}

function versionMeetsMin(v: { major: number; minor: number }): boolean {
  if (v.major > MIN_MAJOR) return true
  if (v.major < MIN_MAJOR) return false
  return v.minor >= MIN_MINOR
}

interface DetectedPython {
  path: string
  version: string
}

function execFileAsync(
  cmd: string,
  args: string[],
  opts: { timeout?: number; env?: NodeJS.ProcessEnv } = {}
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        timeout: opts.timeout ?? 15000,
        env: opts.env ?? process.env,
        windowsHide: true
      },
      (err, stdout, stderr) => {
        const code = err && typeof (err as NodeJS.ErrnoException).code === 'number'
          ? (err as unknown as { code: number }).code
          : err
            ? 1
            : 0
        resolve({ stdout: String(stdout), stderr: String(stderr), code })
      }
    )
  })
}

export async function detectSystemPython(): Promise<DetectedPython | null> {
  const candidates: Array<[string, string[]]> = []
  if (process.platform === 'win32') {
    // `py` launcher is common on Windows — try explicit versions first.
    candidates.push(['py', ['-3.12']])
    candidates.push(['py', ['-3.11']])
    candidates.push(['py', ['-3.10']])
    candidates.push(['py', ['-3']])
    candidates.push(['python', []])
    candidates.push(['python3', []])
  } else {
    candidates.push(['python3.12', []])
    candidates.push(['python3.11', []])
    candidates.push(['python3.10', []])
    candidates.push(['python3', []])
    candidates.push(['python', []])
  }

  for (const [cmd, prefixArgs] of candidates) {
    try {
      const { stdout, stderr, code } = await execFileAsync(cmd, [...prefixArgs, '--version'])
      if (code !== 0) continue
      const output = stdout.trim() || stderr.trim()
      const parsed = parseVersion(output)
      if (!parsed || !versionMeetsMin(parsed)) continue

      // Resolve the full absolute path so later subprocess calls don't
      // rely on PATH lookups at a different point in time.
      const resolved = await execFileAsync(cmd, [
        ...prefixArgs,
        '-c',
        'import sys;print(sys.executable)'
      ])
      if (resolved.code !== 0) continue
      const pyPath = resolved.stdout.trim()
      if (!pyPath || !fs.existsSync(pyPath)) continue

      svc().log(`[voice-runtime] detected ${output} at ${pyPath}`)
      return { path: pyPath, version: output }
    } catch (err) {
      svc().log(`[voice-runtime] candidate ${cmd} failed: ${String(err)}`)
    }
  }

  svc().log('[voice-runtime] no suitable system Python found')
  return null
}

/* ------------------------------------------------------------------ */
/* Embedded python-build-standalone download                          */
/* ------------------------------------------------------------------ */

/**
 * Pinned python-build-standalone release.
 *
 * These tarballs come from https://github.com/astral-sh/python-build-standalone/releases
 * and are `install_only` builds — minimal Python with no other tooling.
 *
 * Update both `version` and `sha256` together when bumping. Checksums are
 * published alongside each asset on the release page (*.sha256 files).
 */
interface EmbeddedRelease {
  version: string
  url: string
  sha256: string
  /** Path inside the extracted archive that contains `bin/` or root python.exe. */
  rootSubdir: string
}

const EMBEDDED_RELEASES: Record<string, EmbeddedRelease> = {
  'win32-x64': {
    version: '3.11.9',
    url: 'https://github.com/astral-sh/python-build-standalone/releases/download/20240726/cpython-3.11.9+20240726-x86_64-pc-windows-msvc-install_only.tar.gz',
    sha256: '',
    rootSubdir: 'python'
  },
  'darwin-arm64': {
    version: '3.11.9',
    url: 'https://github.com/astral-sh/python-build-standalone/releases/download/20240726/cpython-3.11.9+20240726-aarch64-apple-darwin-install_only.tar.gz',
    sha256: '',
    rootSubdir: 'python'
  },
  'darwin-x64': {
    version: '3.11.9',
    url: 'https://github.com/astral-sh/python-build-standalone/releases/download/20240726/cpython-3.11.9+20240726-x86_64-apple-darwin-install_only.tar.gz',
    sha256: '',
    rootSubdir: 'python'
  },
  'linux-x64': {
    version: '3.11.9',
    url: 'https://github.com/astral-sh/python-build-standalone/releases/download/20240726/cpython-3.11.9+20240726-x86_64-unknown-linux-gnu-install_only.tar.gz',
    sha256: '',
    rootSubdir: 'python'
  }
}

function releaseKey(): string {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  return `${process.platform}-${arch}`
}

function getEmbeddedRelease(): EmbeddedRelease | null {
  return EMBEDDED_RELEASES[releaseKey()] ?? null
}

const DOWNLOAD_TIMEOUT_MS = 5 * 60_000

async function downloadToFile(
  url: string,
  outPath: string,
  onProgress: (pct: number, bytesDone: number, bytesTotal: number) => void
): Promise<void> {
  const tmpPath = outPath + '.part'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  try {
    const resp = await net.fetch(url, { redirect: 'follow', signal: controller.signal })
    if (!resp.ok) throw new Error(`download failed: HTTP ${resp.status}`)
    const total = Number(resp.headers.get('content-length') ?? '0')
    const body = resp.body
    if (!body) throw new Error('download failed: no response body')

    let received = 0
    const ws = fs.createWriteStream(tmpPath)
    const reader = body.getReader()
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (value) {
          received += value.byteLength
          ws.write(Buffer.from(value))
          if (total > 0) onProgress(Math.floor((received / total) * 100), received, total)
          else onProgress(0, received, 0)
        }
      }
    } finally {
      ws.end()
      await new Promise<void>((resolve) => ws.on('close', () => resolve()))
    }
    fs.renameSync(tmpPath, outPath)
  } catch (err) {
    try { fs.unlinkSync(tmpPath) } catch { /* ignore */ }
    if (controller.signal.aborted) {
      throw new Error(`download timed out after ${DOWNLOAD_TIMEOUT_MS / 1000}s: ${url}`)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

async function sha256OfFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const rs = fs.createReadStream(file)
    rs.on('data', (chunk) => hash.update(chunk))
    rs.on('end', () => resolve(hash.digest('hex')))
    rs.on('error', reject)
  })
}

async function extractTarGz(archive: string, destDir: string): Promise<void> {
  // Use system `tar` — available on Windows 10+, macOS, and all Linux distros.
  // Piping through tar avoids pulling a heavyweight JS tar dep.
  fs.mkdirSync(destDir, { recursive: true })
  const { code, stderr } = await execFileAsync('tar', ['-xzf', archive, '-C', destDir], {
    timeout: 120_000
  })
  if (code !== 0) throw new Error(`tar extract failed: ${stderr}`)
}

export async function installEmbeddedPython(
  onProgress: (p: VoiceSetupProgress) => void
): Promise<{ path: string }> {
  const rel = getEmbeddedRelease()
  if (!rel) throw new Error(`no embedded python available for ${releaseKey()}`)

  const dataDir = svc().getVoiceDataDir()
  const pyDir = path.join(dataDir, 'python')
  fs.mkdirSync(dataDir, { recursive: true })

  onProgress({ step: 'download-python', pct: 0, message: `Downloading Python ${rel.version}…` })

  const tmpArchive = path.join(dataDir, `python-${rel.version}.tar.gz`)
  await downloadToFile(rel.url, tmpArchive, (pct, done, total) => {
    onProgress({
      step: 'download-python',
      pct: Math.min(pct, 95),
      message: `Downloading Python ${rel.version}…`,
      detail: total > 0
        ? `${(done / 1_000_000).toFixed(1)} / ${(total / 1_000_000).toFixed(1)} MB`
        : `${(done / 1_000_000).toFixed(1)} MB`
    })
  })

  // Require a pinned sha256 unless the user explicitly opts out via env var.
  // TODO: pin real SHA-256 values from the python-build-standalone release
  //       assets (each .tar.gz has a matching .sha256 file on the GitHub release).
  if (rel.sha256) {
    onProgress({ step: 'download-python', pct: 96, message: 'Verifying checksum…' })
    const got = await sha256OfFile(tmpArchive)
    if (got.toLowerCase() !== rel.sha256.toLowerCase()) {
      try { fs.unlinkSync(tmpArchive) } catch { /* ignore */ }
      throw new Error(`checksum mismatch: expected ${rel.sha256} got ${got}`)
    }
  } else if (process.env.DOCK_VOICE_SKIP_CHECKSUM === '1') {
    svc().log('[voice-runtime] DOCK_VOICE_SKIP_CHECKSUM=1 — skipping checksum verification')
  } else {
    try { fs.unlinkSync(tmpArchive) } catch { /* ignore */ }
    throw new Error(
      `no pinned sha256 for ${releaseKey()} — refusing to install unverified Python runtime. ` +
      `Set DOCK_VOICE_SKIP_CHECKSUM=1 to override (not recommended).`
    )
  }

  onProgress({ step: 'download-python', pct: 98, message: 'Extracting Python runtime…' })

  // Clean slate extract.
  try { fs.rmSync(pyDir, { recursive: true, force: true }) } catch { /* ignore */ }
  await extractTarGz(tmpArchive, dataDir)
  try { fs.unlinkSync(tmpArchive) } catch { /* ignore */ }

  const extractedRoot = path.join(dataDir, rel.rootSubdir)
  if (!fs.existsSync(extractedRoot)) {
    throw new Error(`expected extracted dir ${extractedRoot} not found`)
  }
  if (extractedRoot !== pyDir) {
    // Rename to a stable directory name.
    try { fs.renameSync(extractedRoot, pyDir) } catch (err) {
      throw new Error(`rename ${extractedRoot} -> ${pyDir} failed: ${String(err)}`)
    }
  }

  const pyPath = process.platform === 'win32'
    ? path.join(pyDir, 'python.exe')
    : path.join(pyDir, 'bin', 'python3')
  if (!fs.existsSync(pyPath)) {
    throw new Error(`python binary not found at ${pyPath} after extract`)
  }

  onProgress({ step: 'download-python', pct: 100, message: 'Python installed.' })
  svc().log(`[voice-runtime] embedded python ready at ${pyPath}`)
  return { path: pyPath }
}

/* ------------------------------------------------------------------ */
/* venv + pip                                                         */
/* ------------------------------------------------------------------ */

export function getVenvDir(): string {
  return path.join(svc().getVoiceDataDir(), 'venv')
}

export function getVenvPython(): string {
  const venv = getVenvDir()
  return process.platform === 'win32'
    ? path.join(venv, 'Scripts', 'python.exe')
    : path.join(venv, 'bin', 'python')
}

export function getVenvPip(): string {
  const venv = getVenvDir()
  return process.platform === 'win32'
    ? path.join(venv, 'Scripts', 'pip.exe')
    : path.join(venv, 'bin', 'pip')
}

export async function createVenv(basePython: string): Promise<void> {
  const venv = getVenvDir()
  fs.mkdirSync(path.dirname(venv), { recursive: true })
  // Remove any stale venv first — safer than trying to repair a broken one.
  // Failure here MUST be fatal: layering a fresh `python -m venv` on top of a
  // partially-removed directory produces a corrupted venv where some files
  // (e.g. site-packages/pip) are missing while others linger from the old
  // install. We previously logged-and-continued, which left the user with a
  // half-broken environment that silently failed `verifyInstall`.
  //
  // Windows specifically suffers from transient ENOTEMPTY/EBUSY during
  // recursive deletes of large trees (pycache files briefly hold their
  // parent dir busy). `maxRetries`/`retryDelay` give the FS a chance to
  // settle before we give up — the value is conservative because the
  // alternative is a hard user-facing failure.
  if (fs.existsSync(venv)) {
    try {
      fs.rmSync(venv, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 200
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      svc().logError(`[voice-runtime] could not remove stale venv: ${msg}`)
      throw new Error(
        `Could not remove existing venv at ${venv} — likely a Python process is still holding files open. ` +
        `Close any running voice daemon / Claude CLI sessions and retry. (${msg})`
      )
    }
  }

  svc().log(`[voice-runtime] creating venv at ${venv} (base=${basePython})`)
  const { code, stdout, stderr } = await execFileAsync(
    basePython,
    ['-m', 'venv', venv],
    { timeout: 90_000 }
  )
  if (code !== 0) {
    svc().logError('[voice-runtime] venv creation failed', { stdout, stderr })
    throw new Error(`venv creation failed (exit ${code}): ${stderr || stdout}`)
  }
}

/**
 * Stream subprocess output line-by-line to a handler. Used for pip install
 * so the UI can show "installing numpy…" / "installing faster-whisper…".
 */
function spawnStreaming(
  cmd: string,
  args: string[],
  onLine: (line: string, stream: 'stdout' | 'stderr') => void
): Promise<{ code: number | null }> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawn(cmd, args, { windowsHide: true })
    } catch (err) {
      reject(err)
      return
    }
    const feed = (stream: 'stdout' | 'stderr') => {
      let buf = ''
      return (chunk: Buffer) => {
        buf += chunk.toString('utf8')
        let idx: number
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).replace(/\r$/, '')
          buf = buf.slice(idx + 1)
          if (line) onLine(line, stream)
        }
      }
    }
    child.stdout?.on('data', feed('stdout'))
    child.stderr?.on('data', feed('stderr'))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code }))
  })
}

export async function installDependencies(
  requirementsPath: string,
  onProgress: (p: VoiceSetupProgress) => void
): Promise<void> {
  const pip = getVenvPython()
  if (!fs.existsSync(pip)) throw new Error(`venv python missing at ${pip}`)
  if (!fs.existsSync(requirementsPath)) throw new Error(`requirements.txt not found: ${requirementsPath}`)

  // We deliberately do NOT run `pip install --upgrade pip` here — on Windows
  // the upgrade can race with the running pip launcher and leave the venv
  // with `pip.exe` present but the `pip` *module* missing from site-packages,
  // which then breaks every subsequent `python -m pip ...` call. The bundled
  // pip that ships with `python -m venv` is more than recent enough for our
  // requirements.
  onProgress({ step: 'install-deps', pct: 5, message: 'Installing dependencies…' })
  let currentPackage = ''
  const { code } = await spawnStreaming(
    pip,
    ['-m', 'pip', 'install', '--no-input', '-r', requirementsPath],
    (line, stream) => {
      svc().log(`[voice-runtime] pip[${stream}] ${line}`)
      const m = line.match(/^(?:Collecting|Downloading|Installing collected packages:)\s+(.+)$/)
      if (m) {
        currentPackage = m[1].split(/\s+/)[0]
        onProgress({
          step: 'install-deps',
          pct: 50,
          message: `Installing ${currentPackage}…`,
          detail: line
        })
      } else {
        onProgress({
          step: 'install-deps',
          pct: 50,
          message: currentPackage ? `Installing ${currentPackage}…` : 'Installing dependencies…',
          detail: line
        })
      }
    }
  )
  if (code !== 0) {
    throw new Error(`pip install failed (exit ${code})`)
  }
  onProgress({ step: 'install-deps', pct: 100, message: 'Dependencies installed.' })
}

export async function verifyInstall(): Promise<{ ok: boolean; missing: string[] }> {
  const py = getVenvPython()
  if (!fs.existsSync(py)) return { ok: false, missing: ['<venv-python>'] }

  const required = ['mcp', 'sounddevice', 'numpy', 'faster_whisper', 'pyperclip']
  if (process.platform === 'win32') required.push('keyboard')

  const missing: string[] = []
  for (const mod of required) {
    const { code } = await execFileAsync(py, ['-c', `import ${mod}`], { timeout: 30_000 })
    if (code !== 0) missing.push(mod)
  }
  return { ok: missing.length === 0, missing }
}

export interface EnsureRuntimeResult {
  pythonPath: string
  venvPython: string
}

/**
 * High-level helper: ensure venv + deps are ready, installing an embedded
 * Python if no suitable system one is available. Progress is streamed.
 *
 * Idempotent: if an existing venv already passes `verifyInstall`, we skip
 * the wipe-and-reinstall entirely. Recreating a healthy venv on every app
 * launch is both wasteful and risky — the recursive delete races with
 * Windows' file system on `__pycache__` cleanup, and a partial wipe can
 * leave a corrupted environment behind.
 */
export async function ensureRuntime(
  requirementsPath: string,
  onProgress: (p: VoiceSetupProgress) => void
): Promise<EnsureRuntimeResult> {
  // Fast path: if the venv already exists and verifies cleanly, just use it.
  // We still want a `pythonPath` to report, but we don't need to reinstall.
  if (runtimeExists()) {
    onProgress({ step: 'verify', pct: 0, message: 'Checking existing install…' })
    const verify = await verifyInstall()
    if (verify.ok) {
      onProgress({ step: 'verify', pct: 100, message: 'Existing install is healthy.' })
      return { pythonPath: getVenvPython(), venvPython: getVenvPython() }
    }
    svc().log(`[voice-runtime] existing venv missing modules: ${verify.missing.join(', ')} — reinstalling`)
  }

  onProgress({ step: 'detect', pct: 0, message: 'Looking for Python 3.10+…' })
  let base = await detectSystemPython()
  let basePath: string

  if (base) {
    onProgress({ step: 'detect', pct: 100, message: `Found ${base.version}`, detail: base.path })
    basePath = base.path
  } else {
    onProgress({ step: 'detect', pct: 100, message: 'No suitable Python found — installing isolated runtime.' })
    const embedded = await installEmbeddedPython(onProgress)
    basePath = embedded.path
  }

  onProgress({ step: 'create-venv', pct: 0, message: 'Creating virtual environment…' })
  await createVenv(basePath)
  onProgress({ step: 'create-venv', pct: 100, message: 'Virtual environment ready.' })

  await installDependencies(requirementsPath, onProgress)

  onProgress({ step: 'verify', pct: 0, message: 'Verifying install…' })
  const verify = await verifyInstall()
  if (!verify.ok) {
    throw new Error(`install verification failed — missing: ${verify.missing.join(', ')}`)
  }
  onProgress({ step: 'verify', pct: 100, message: 'All modules import cleanly.' })

  return { pythonPath: basePath, venvPython: getVenvPython() }
}

/* ------------------------------------------------------------------ */
/* Teardown                                                           */
/* ------------------------------------------------------------------ */

export async function uninstallRuntime(): Promise<void> {
  const dataDir = svc().getVoiceDataDir()
  for (const sub of ['venv', 'python']) {
    const p = path.join(dataDir, sub)
    try {
      fs.rmSync(p, { recursive: true, force: true })
      svc().log(`[voice-runtime] removed ${p}`)
    } catch (err) {
      svc().logError(`[voice-runtime] failed to remove ${p}`, err)
    }
  }
}

/* ------------------------------------------------------------------ */
/* Diagnostics                                                        */
/* ------------------------------------------------------------------ */

export function runtimeExists(): boolean {
  return fs.existsSync(getVenvPython())
}

export function diagnosticReport(): string {
  const lines: string[] = []
  lines.push(`platform: ${process.platform} ${process.arch}`)
  lines.push(`home: ${os.homedir()}`)
  lines.push(`appData: ${app.getPath('userData')}`)
  lines.push(`voiceDir: ${svc().getVoiceDataDir()}`)
  lines.push(`venvPython: ${getVenvPython()} (exists: ${fs.existsSync(getVenvPython())})`)
  return lines.join('\n')
}

