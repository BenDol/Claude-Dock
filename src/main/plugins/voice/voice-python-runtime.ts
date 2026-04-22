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
import type {
  VoiceGpuCapability,
  VoiceSetupProgress
} from '../../../shared/voice-types'

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

/**
 * Fetch the sidecar `.sha256` that python-build-standalone publishes alongside
 * each release asset (e.g. `<asset>.tar.gz.sha256`). Returns the hex digest or
 * null if the sidecar is unreachable / malformed.
 *
 * Note: a sidecar fetched from the same origin as the asset only protects
 * against *transport* corruption (truncation, mid-flight bit flips). It does
 * not defend against an origin compromise — for that you need a hash pinned
 * in source. We fall back to sidecar verification when `rel.sha256` is empty
 * so fresh checkouts still install, but pinning stays the long-term goal.
 */
async function fetchSidecarSha256(url: string): Promise<string | null> {
  const sidecar = `${url}.sha256`
  try {
    const controller = new AbortController()
    const t = setTimeout(() => controller.abort(), 15_000)
    try {
      const resp = await net.fetch(sidecar, { redirect: 'follow', signal: controller.signal })
      if (!resp.ok) return null
      const body = (await resp.text()).trim()
      // Sidecars can be either "<hex>" or "<hex>  <filename>"
      const m = body.match(/^([0-9a-fA-F]{64})\b/)
      return m ? m[1].toLowerCase() : null
    } finally {
      clearTimeout(t)
    }
  } catch {
    return null
  }
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

  // Integrity verification. Preferred path: pinned SHA-256 in source (strongest).
  // Fallback: sidecar `.sha256` fetched from the same release (catches
  // transport corruption). Opt-out only via explicit env var for recovery.
  // TODO(security): pin real SHA-256 values for each platform release so the
  //   install is protected against a compromised GitHub origin as well as
  //   transport corruption. Values live at <url>.sha256 on the release page.
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
    onProgress({ step: 'download-python', pct: 96, message: 'Fetching sidecar checksum…' })
    const sidecar = await fetchSidecarSha256(rel.url)
    if (!sidecar) {
      try { fs.unlinkSync(tmpArchive) } catch { /* ignore */ }
      throw new Error(
        `no pinned sha256 for ${releaseKey()} and sidecar checksum unreachable at ${rel.url}.sha256. ` +
        `Check your network / proxy, or set DOCK_VOICE_SKIP_CHECKSUM=1 to override (not recommended).`
      )
    }
    onProgress({ step: 'download-python', pct: 97, message: 'Verifying checksum…' })
    const got = await sha256OfFile(tmpArchive)
    if (got.toLowerCase() !== sidecar) {
      try { fs.unlinkSync(tmpArchive) } catch { /* ignore */ }
      throw new Error(`sidecar checksum mismatch: expected ${sidecar} got ${got}`)
    }
    svc().log(`[voice-runtime] verified download against sidecar ${sidecar}`)
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
 *
 * `timeoutMs` bounds the total run so a hung pip (slow mirror, network stall,
 * wedged child on Windows) can't block the caller forever. On timeout the
 * child is SIGTERMed then SIGKILLed after a short grace and the resolved code
 * is null with `timedOut: true`.
 */
function spawnStreaming(
  cmd: string,
  args: string[],
  onLine: (line: string, stream: 'stdout' | 'stderr') => void,
  opts: { timeoutMs?: number } = {}
): Promise<{ code: number | null; timedOut?: boolean }> {
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

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null
    let killHandle: ReturnType<typeof setTimeout> | null = null
    let timedOut = false
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true
        try { child.kill('SIGTERM') } catch { /* ignore */ }
        killHandle = setTimeout(() => {
          try { child.kill('SIGKILL') } catch { /* ignore */ }
        }, 3000)
      }, opts.timeoutMs)
    }

    child.on('error', (err) => {
      if (timeoutHandle) clearTimeout(timeoutHandle)
      if (killHandle) clearTimeout(killHandle)
      reject(err)
    })
    child.on('close', (code) => {
      if (timeoutHandle) clearTimeout(timeoutHandle)
      if (killHandle) clearTimeout(killHandle)
      resolve({ code, timedOut })
    })
  })
}

/** Wall-clock cap for `pip install nvidia-cublas-cu12 nvidia-cudnn-cu12` (~600MB). */
const GPU_INSTALL_TIMEOUT_MS = 15 * 60_000

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

  const required = ['mcp', 'sounddevice', 'numpy', 'faster_whisper', 'pyperclip', 'pynput']

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

/* ------------------------------------------------------------------ */
/* GPU / CUDA runtime                                                 */
/* ------------------------------------------------------------------ */

/**
 * Names of the PyPI packages that ship CUDA runtime DLLs. Both are needed —
 * ctranslate2 loads cuBLAS eagerly and cuDNN lazily on the first forward pass.
 * `-cu12` suffix pins CUDA 12.x; faster-whisper ≥1.1 requires cuDNN 9 which
 * only ships in the cu12 wheels.
 */
export const GPU_PIP_PACKAGES = ['nvidia-cublas-cu12', 'nvidia-cudnn-cu12'] as const

/** Minimum driver version supporting CUDA 12. Below this, the wheels can't load even with DLLs present. */
const MIN_NVIDIA_DRIVER = 525

/**
 * Architectures NVIDIA publishes cu12 wheels for. `nvidia-cublas-cu12` /
 * `nvidia-cudnn-cu12` are only available as `win_amd64` and
 * `manylinux_2_17_x86_64` — no ARM, no 32-bit. ARM-NVIDIA hardware (Jetson,
 * Grace Hopper) ships its own system-wide CUDA toolkit and is out of scope
 * here because even Nvidia's CPython wheels can't reach it. Detect the host
 * arch so we skip offering an install that would definitely fail.
 */
const GPU_SUPPORTED_ARCHES = new Set(['x64'])

/** Cache detection for the lifetime of the process — nvidia-smi doesn't change mid-session. */
let gpuCapabilityCache: VoiceGpuCapability | null = null

/**
 * Probe for an NVIDIA GPU via `nvidia-smi`. Works on Windows + Linux (x86_64)
 * when the NVIDIA driver is installed; returns `{ hasNvidiaGpu: false }` on
 * any other host (macOS, ARM, AMD-only, non-NVIDIA Intel, driver missing)
 * without throwing.
 *
 * Cached per-process. Pass `force` to re-probe if the user has just installed
 * a driver and wants to retry without restarting Dock.
 */
export async function detectGpuCapability(force = false): Promise<VoiceGpuCapability> {
  if (!force && gpuCapabilityCache) return gpuCapabilityCache

  // Quick short-circuit on macOS — Apple Silicon + Metal isn't something
  // faster-whisper supports without extra wheels, and there's no nvidia-smi.
  if (process.platform === 'darwin') {
    const result: VoiceGpuCapability = {
      hasNvidiaGpu: false,
      gpuName: null,
      driverVersion: null,
      cudaVersion: null,
      error: 'macOS is not a supported GPU platform for faster-whisper'
    }
    gpuCapabilityCache = result
    return result
  }

  // Non-x64 architectures have no published cu12 wheels. Detect the host has
  // an NVIDIA GPU (for diagnostics) but mark as unavailable so we don't offer
  // an install that will definitely fail.
  if (!GPU_SUPPORTED_ARCHES.has(process.arch)) {
    const result: VoiceGpuCapability = {
      hasNvidiaGpu: false,
      gpuName: null,
      driverVersion: null,
      cudaVersion: null,
      error:
        `GPU acceleration requires x86_64 — this host is ${process.arch}. ` +
        `NVIDIA does not publish cu12 wheels for ARM / 32-bit platforms.`
    }
    gpuCapabilityCache = result
    svc().log(`[voice-runtime-gpu] skipping GPU detection on unsupported arch=${process.arch}`)
    return result
  }

  try {
    const { stdout, code } = await execFileAsync(
      'nvidia-smi',
      ['--query-gpu=name,driver_version', '--format=csv,noheader'],
      { timeout: 5000 }
    )
    if (code !== 0) {
      const result: VoiceGpuCapability = {
        hasNvidiaGpu: false,
        gpuName: null,
        driverVersion: null,
        cudaVersion: null,
        error: `nvidia-smi exit ${code}`
      }
      gpuCapabilityCache = result
      return result
    }
    const firstLine = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || ''
    const [rawName, rawDriver] = firstLine.split(',').map((s) => s.trim())
    const driverVersion = rawDriver || null

    // nvidia-smi prints CUDA in the header of the plain-text form; query-gpu
    // doesn't expose it. A second call is cheap (~40ms) and surfaces it.
    let cudaVersion: string | null = null
    try {
      const plain = await execFileAsync('nvidia-smi', [], { timeout: 5000 })
      const m = plain.stdout.match(/CUDA Version:\s*([\d.]+)/)
      if (m) cudaVersion = m[1]
    } catch { /* non-fatal */ }

    // A too-old driver can't load the cu12 wheels even after install. Flag it
    // as unavailable so we don't offer an install that will definitely fail.
    const major = Number(driverVersion?.split('.')[0])
    if (Number.isFinite(major) && major > 0 && major < MIN_NVIDIA_DRIVER) {
      const result: VoiceGpuCapability = {
        hasNvidiaGpu: false,
        gpuName: rawName || null,
        driverVersion,
        cudaVersion,
        error: `NVIDIA driver ${driverVersion} is too old — CUDA 12 wheels require ${MIN_NVIDIA_DRIVER}+`
      }
      gpuCapabilityCache = result
      svc().log(`[voice-runtime-gpu] detected old driver ${driverVersion}; rejecting`)
      return result
    }

    const result: VoiceGpuCapability = {
      hasNvidiaGpu: true,
      gpuName: rawName || null,
      driverVersion,
      cudaVersion,
      error: null
    }
    gpuCapabilityCache = result
    svc().log(`[voice-runtime-gpu] detected ${rawName || 'NVIDIA GPU'} driver=${driverVersion} cuda=${cudaVersion}`)
    return result
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const result: VoiceGpuCapability = {
      hasNvidiaGpu: false,
      gpuName: null,
      driverVersion: null,
      cudaVersion: null,
      // ENOENT is the common case — nvidia-smi isn't on PATH, meaning no
      // NVIDIA driver. Distinguish in the log but keep the message clean.
      error: message.includes('ENOENT')
        ? 'nvidia-smi not found — no NVIDIA driver installed'
        : message
    }
    gpuCapabilityCache = result
    return result
  }
}

/** Drop the detection cache so the next call reprobes (e.g. after driver install). */
export function invalidateGpuCapability(): void {
  gpuCapabilityCache = null
}

/**
 * Check whether the voice venv has the GPU runtime pip packages installed.
 * Fast — just imports both modules in a subprocess with `-c "import X"`.
 */
export async function isGpuRuntimeInstalled(): Promise<boolean> {
  const py = getVenvPython()
  if (!fs.existsSync(py)) return false
  for (const pkg of GPU_PIP_PACKAGES) {
    // PyPI distribution name has dashes; module name has dots and underscores:
    //   nvidia-cublas-cu12 -> nvidia.cublas
    //   nvidia-cudnn-cu12  -> nvidia.cudnn
    const mod = pkg.replace(/^nvidia-/, 'nvidia.').replace(/-cu12$/, '')
    const { code } = await execFileAsync(py, ['-c', `import ${mod}`], { timeout: 15_000 })
    if (code !== 0) return false
  }
  return true
}

/**
 * Install the CUDA runtime pip packages into the voice venv. Streams progress
 * via the callback, same protocol as `installDependencies()`. Returns a
 * structured result — callers should log but *not* fail the overall voice
 * setup if this fails, since CPU transcription still works.
 */
export async function installGpuRuntime(
  onProgress: (p: VoiceSetupProgress) => void
): Promise<{ ok: boolean; error?: string }> {
  const py = getVenvPython()
  if (!fs.existsSync(py)) {
    return { ok: false, error: `venv python missing at ${py}` }
  }
  onProgress({ step: 'install-gpu', pct: 5, message: 'Installing GPU acceleration (~600MB)…' })
  let currentPackage = ''
  try {
    const { code, timedOut } = await spawnStreaming(
      py,
      ['-m', 'pip', 'install', '--no-input', ...GPU_PIP_PACKAGES],
      (line, stream) => {
        svc().log(`[voice-runtime-gpu] pip[${stream}] ${line}`)
        const m = line.match(/^(?:Collecting|Downloading|Installing collected packages:)\s+(.+)$/)
        if (m) {
          currentPackage = m[1].split(/\s+/)[0]
          onProgress({
            step: 'install-gpu',
            pct: 50,
            message: `Installing ${currentPackage}…`,
            detail: line
          })
        } else {
          onProgress({
            step: 'install-gpu',
            pct: 50,
            message: currentPackage
              ? `Installing ${currentPackage}…`
              : 'Installing GPU acceleration (~600MB)…',
            detail: line
          })
        }
      },
      { timeoutMs: GPU_INSTALL_TIMEOUT_MS }
    )
    if (timedOut) {
      return {
        ok: false,
        error: `pip install timed out after ${GPU_INSTALL_TIMEOUT_MS / 60_000} minutes — network stall or hung process`
      }
    }
    if (code !== 0) {
      return { ok: false, error: `pip install failed (exit ${code})` }
    }
    onProgress({ step: 'install-gpu', pct: 100, message: 'GPU libraries installed.' })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Probe whether the venv can actually load `WhisperModel` on `device='cuda'`.
 * This is a stronger test than `isGpuRuntimeInstalled()` — the pip packages
 * can be present but still fail if the driver/GPU disagree with cu12 (e.g.
 * architecture too old, cuDNN 9 vs. 8 mismatch, DLL search path issues).
 *
 * Runs `tiny` for speed — it's ~75MB, cached after first fetch.
 */
/**
 * Sentinel pair wrapping the JSON result of the verify probe. faster-whisper /
 * ctranslate2 emit progress and warning text to stdout on some platforms, and a
 * naive "last line starting with {" heuristic breaks when any warning contains
 * a brace. The sentinels make extraction unambiguous.
 */
const PROBE_SENTINEL_OPEN = '<<<VOICE_GPU_PROBE>>>'
const PROBE_SENTINEL_CLOSE = '<<<VOICE_GPU_PROBE_END>>>'

export async function verifyGpuRuntime(): Promise<{ ok: boolean; error?: string }> {
  const py = getVenvPython()
  if (!fs.existsSync(py)) return { ok: false, error: 'venv python missing' }

  // `pythonDir` is the directory containing `src/cuda_setup.py`. Adding it to
  // sys.path lets `from src.cuda_setup import ...` resolve just like
  // server.py / hotkey_daemon.py / dictation_daemon.py do at runtime.
  const pythonDir = svc().paths.pythonDir
  const probe = `
import json
import sys
import traceback

_OPEN = ${JSON.stringify(PROBE_SENTINEL_OPEN)}
_CLOSE = ${JSON.stringify(PROBE_SENTINEL_CLOSE)}

def _emit(obj):
    sys.stdout.write(_OPEN + json.dumps(obj, default=str) + _CLOSE + "\\n")
    sys.stdout.flush()

try:
    import os
    python_dir = ${JSON.stringify(pythonDir)}
    if python_dir not in sys.path:
        sys.path.insert(0, python_dir)
    from src.cuda_setup import setup_cuda_dll_paths
    setup_result = setup_cuda_dll_paths()
    import ctranslate2
    n = ctranslate2.get_cuda_device_count()
    if n <= 0:
        _emit({'ok': False, 'error': 'ctranslate2 reports 0 CUDA devices', 'setup': setup_result})
        sys.exit(0)
    from faster_whisper import WhisperModel
    m = WhisperModel('tiny', device='cuda', compute_type='int8_float16')
    # Run a tiny silent-audio inference so we exercise the same lazy-load
    # code path (cudnn_*, cublasLt*) that production transcription uses.
    # Construction alone isn't enough — ctranslate2 defers some CUDA DLL
    # loads until the first forward pass, and those loads use legacy
    # LoadLibrary calls that can fail even when the model built cleanly.
    # See src/cuda_setup.py for why we ctypes.CDLL-preload the nvidia DLLs.
    try:
        import numpy as np
        silent = np.zeros(16000, dtype=np.float32)
        segs, _ = m.transcribe(silent, language='en', without_timestamps=True)
        for _ in segs:
            pass
    except Exception as e:
        _emit({
            'ok': False,
            'error': f'inference probe failed: {type(e).__name__}: {e}',
            'traceback': traceback.format_exc(),
            'setup': setup_result
        })
        sys.exit(0)
    del m
    _emit({'ok': True, 'cudaDevices': n, 'setup': setup_result})
except Exception as e:
    _emit({
        'ok': False,
        'error': f'{type(e).__name__}: {e}',
        'traceback': traceback.format_exc()
    })
`
  const { code, stdout, stderr } = await execFileAsync(py, ['-c', probe], {
    timeout: 180_000 // first tiny-model download can take 30-60s on slow links
  })
  if (code !== 0) {
    return { ok: false, error: stderr || `probe exited ${code}` }
  }
  try {
    const openIdx = stdout.lastIndexOf(PROBE_SENTINEL_OPEN)
    const closeIdx = stdout.lastIndexOf(PROBE_SENTINEL_CLOSE)
    if (openIdx < 0 || closeIdx < 0 || closeIdx <= openIdx) {
      return {
        ok: false,
        error: `probe output missing sentinels (stdout head: ${stdout.slice(0, 200)})`
      }
    }
    const json = stdout.slice(openIdx + PROBE_SENTINEL_OPEN.length, closeIdx)
    const parsed = JSON.parse(json) as {
      ok: boolean
      error?: string
      cudaDevices?: number
      setup?: unknown
    }
    if (parsed.ok) {
      svc().log(`[voice-runtime-gpu] verify ok — cudaDevices=${parsed.cudaDevices ?? '?'}`)
      return { ok: true }
    }
    svc().log(
      `[voice-runtime-gpu] verify failed: ${parsed.error ?? 'unknown'} ` +
      `setup=${JSON.stringify(parsed.setup)}`
    )
    return { ok: false, error: parsed.error ?? 'verify probe failed' }
  } catch (err) {
    return {
      ok: false,
      error: `failed to parse probe output: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}

/**
 * Uninstall the GPU pip packages. Used when the user explicitly opts out
 * of GPU acceleration (frees ~600MB) or as part of a clean reinstall path.
 */
export async function uninstallGpuRuntime(): Promise<{ ok: boolean; error?: string }> {
  const py = getVenvPython()
  if (!fs.existsSync(py)) return { ok: false, error: 'venv python missing' }
  const { code, stderr } = await execFileAsync(
    py,
    ['-m', 'pip', 'uninstall', '-y', ...GPU_PIP_PACKAGES],
    { timeout: 60_000 }
  )
  if (code !== 0) return { ok: false, error: stderr || `pip uninstall exit ${code}` }
  return { ok: true }
}

