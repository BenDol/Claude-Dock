/**
 * Local LLM manager — app-level service managing a bundled llama-server process.
 *
 * Architecture:
 * - Spawns llama-server on first generate() call
 * - Communicates via OpenAI-compatible HTTP API (localhost)
 * - Auto-downloads the server binary and model on first use to {userData}/llm/
 * - Idles down after 5 minutes of inactivity
 * - Killed on app quit
 *
 * This is an app-level singleton, available to any plugin or feature.
 */

import { spawn, type ChildProcess } from 'child_process'
import * as http from 'http'
import * as https from 'https'
import * as fs from 'fs'
import * as path from 'path'
import * as net from 'net'
import * as os from 'os'
import { app, BrowserWindow } from 'electron'
import { log, logError } from './logger'
import { IPC } from '../shared/ipc-channels'

// -- Constants --

const MODEL_FILENAME = 'qwen2.5-coder-0.5b-instruct-q4_k_m.gguf'
const MODEL_URL = 'https://huggingface.co/Qwen/Qwen2.5-Coder-0.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-0.5b-instruct-q4_k_m.gguf'

// llama.cpp release binary — CPU-only server build
const LLAMA_RELEASE_TAG = 'b5460'
const SERVER_BIN_URLS: Record<string, string> = {
  'win32-x64': `https://github.com/ggerganov/llama.cpp/releases/download/${LLAMA_RELEASE_TAG}/llama-${LLAMA_RELEASE_TAG}-bin-win-cpu-x64.zip`,
  'darwin-arm64': `https://github.com/ggerganov/llama.cpp/releases/download/${LLAMA_RELEASE_TAG}/llama-${LLAMA_RELEASE_TAG}-bin-macos-arm64.zip`,
  'darwin-x64': `https://github.com/ggerganov/llama.cpp/releases/download/${LLAMA_RELEASE_TAG}/llama-${LLAMA_RELEASE_TAG}-bin-macos-x64.zip`,
  'linux-x64': `https://github.com/ggerganov/llama.cpp/releases/download/${LLAMA_RELEASE_TAG}/llama-${LLAMA_RELEASE_TAG}-bin-ubuntu-x64.zip`
}

const SERVER_READY_TIMEOUT = 60_000 // 60s — includes model load time on first start
const SERVER_IDLE_TIMEOUT = 5 * 60_000 // 5 minutes
const IDLE_CHECK_INTERVAL = 60_000 // check every minute
const HEALTH_POLL_INTERVAL = 500

function getLlmDir(): string {
  return path.join(app.getPath('userData'), 'llm')
}

export class LocalLlmManager {
  private static instance: LocalLlmManager | null = null

  private serverProcess: ChildProcess | null = null
  private serverPort = 0
  private lastRequestTime = 0
  private idleTimer: ReturnType<typeof setInterval> | null = null
  private downloadPromise: Promise<void> | null = null
  private serverDownloadPromise: Promise<void> | null = null
  private startupPromise: Promise<void> | null = null
  private shutdownRegistered = false
  private downloading = false
  private _downloadProgress = 0

  static getInstance(): LocalLlmManager {
    if (!LocalLlmManager.instance) {
      LocalLlmManager.instance = new LocalLlmManager()
    }
    return LocalLlmManager.instance
  }

  // -- Path resolution --

  getModelPath(): string {
    return path.join(getLlmDir(), MODEL_FILENAME)
  }

  getServerBinaryPath(): string {
    const binName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'
    // Packaged app: check bundled resources first
    if (app.isPackaged) {
      const bundled = path.join(process.resourcesPath, 'llm', binName)
      if (fs.existsSync(bundled)) return bundled
    }
    // Downloaded binary in userData
    return path.join(getLlmDir(), 'bin', binName)
  }

  // -- Status queries --

  isModelAvailable(): boolean {
    try {
      return fs.existsSync(this.getModelPath())
    } catch {
      return false
    }
  }

  isServerBinaryAvailable(): boolean {
    try {
      const binPath = this.getServerBinaryPath()
      if (!fs.existsSync(binPath)) return false
      // On Windows, verify companion DLLs exist (the exe is dynamically linked)
      if (process.platform === 'win32') {
        const binDir = path.dirname(binPath)
        const files = fs.readdirSync(binDir)
        const hasDlls = files.some((f) => f.endsWith('.dll'))
        if (!hasDlls) {
          log('[local-llm] Server binary found but companion DLLs missing — will re-download')
          return false
        }
      }
      return true
    } catch {
      return false
    }
  }

  isServerRunning(): boolean {
    return this.serverProcess !== null && this.serverProcess.exitCode === null
  }

  isDownloading(): boolean {
    return this.downloading
  }

  getDownloadProgress(): number {
    return this._downloadProgress
  }

  getStatus(): { modelAvailable: boolean; serverAvailable: boolean; serverRunning: boolean; downloading: boolean; downloadProgress: number } {
    return {
      modelAvailable: this.isModelAvailable(),
      serverAvailable: this.isServerBinaryAvailable(),
      serverRunning: this.isServerRunning(),
      downloading: this.downloading,
      downloadProgress: this._downloadProgress
    }
  }

  // -- Server binary download --

  async ensureServerBinary(): Promise<void> {
    if (this.isServerBinaryAvailable()) return
    if (this.serverDownloadPromise) return this.serverDownloadPromise

    this.serverDownloadPromise = this.performServerDownload()
    try {
      await this.serverDownloadPromise
    } finally {
      this.serverDownloadPromise = null
    }
  }

  private async performServerDownload(): Promise<void> {
    const platformKey = `${process.platform}-${process.arch}`
    const zipUrl = SERVER_BIN_URLS[platformKey]
    if (!zipUrl) {
      throw new Error(`No llama-server binary available for platform: ${platformKey}`)
    }

    const binDir = path.join(getLlmDir(), 'bin')
    fs.mkdirSync(binDir, { recursive: true })

    const zipPath = path.join(getLlmDir(), 'llama-server.zip')
    log(`[local-llm] Downloading llama-server for ${platformKey}...`)

    try {
      await this.downloadFile(zipUrl, zipPath, (pct) => {
        log(`[local-llm] Server binary download: ${pct}%`)
      })

      // Extract the llama-server binary from the zip
      await this.extractServerBinary(zipPath, binDir)
      log('[local-llm] Server binary installed')
    } finally {
      // Clean up zip
      try { fs.unlinkSync(zipPath) } catch { /* ignore */ }
    }
  }

  private async extractServerBinary(zipPath: string, destDir: string): Promise<void> {
    const binName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'

    if (process.platform === 'win32') {
      // Extract llama-server.exe AND all sibling files (DLLs it depends on).
      // The zip may have files at the root or inside a subdirectory — handle both.
      // We find the directory containing llama-server.exe and extract all files
      // from that same directory level flat into destDir.
      const { execFile } = await import('child_process')
      const escapedZip = zipPath.replace(/'/g, "''")
      const escapedDest = destDir.replace(/'/g, "''")
      await new Promise<void>((resolve, reject) => {
        execFile('powershell', [
          '-NoProfile', '-Command',
          `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
          `$zip = [System.IO.Compression.ZipFile]::OpenRead('${escapedZip}'); ` +
          `$server = $zip.Entries | Where-Object { $_.Name -eq '${binName}' } | Select-Object -First 1; ` +
          `if (-not $server) { $zip.Dispose(); throw 'Binary not found in archive' }; ` +
          `$idx = $server.FullName.LastIndexOf('/'); ` +
          `$dir = if ($idx -ge 0) { $server.FullName.Substring(0, $idx) } else { '' }; ` +
          `foreach ($e in $zip.Entries) { ` +
          `  if ($e.Name -eq '' -or $e.FullName.EndsWith('/')) { continue }; ` +
          `  $eIdx = $e.FullName.LastIndexOf('/'); ` +
          `  $eDir = if ($eIdx -ge 0) { $e.FullName.Substring(0, $eIdx) } else { '' }; ` +
          `  if ($eDir -eq $dir) { ` +
          `    $out = Join-Path '${escapedDest}' $e.Name; ` +
          `    [System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, $out, $true) ` +
          `  } ` +
          `}; ` +
          `$zip.Dispose()`
        ], { timeout: 60_000 }, (err) => {
          if (err) reject(new Error(`Failed to extract ${binName}: ${err.message}`))
          else resolve()
        })
      })
    } else {
      // Extract all files flat into destDir (strips directory structure)
      const { execFile } = await import('child_process')
      await new Promise<void>((resolve, reject) => {
        execFile('unzip', ['-jo', zipPath, '-d', destDir], { timeout: 60_000 }, (err) => {
          if (err) reject(new Error(`Failed to extract ${binName}: ${err.message}`))
          else {
            // Make binaries executable
            try {
              for (const f of fs.readdirSync(destDir)) {
                fs.chmodSync(path.join(destDir, f), 0o755)
              }
            } catch { /* ignore */ }
            resolve()
          }
        })
      })
    }

    // Verify the binary was extracted
    if (!fs.existsSync(path.join(destDir, binName))) {
      throw new Error(`${binName} not found in zip archive`)
    }
  }

  // -- Model download --

  async downloadModel(): Promise<void> {
    if (this.downloadPromise) return this.downloadPromise
    if (this.isModelAvailable()) return

    this.downloadPromise = this.performModelDownload()
    try {
      await this.downloadPromise
    } finally {
      this.downloadPromise = null
    }
  }

  private async performModelDownload(): Promise<void> {
    this.downloading = true
    this._downloadProgress = 0
    this.broadcastDownloadProgress(0)

    const llmDir = getLlmDir()
    fs.mkdirSync(llmDir, { recursive: true })

    const tempPath = this.getModelPath() + '.downloading'
    const finalPath = this.getModelPath()

    try {
      await this.downloadFile(MODEL_URL, tempPath, (progress) => {
        this._downloadProgress = progress
        this.broadcastDownloadProgress(progress)
      })
      fs.renameSync(tempPath, finalPath)
      this._downloadProgress = 100
      this.broadcastDownloadProgress(100)
      log(`[local-llm] Model downloaded to ${finalPath}`)
    } catch (err) {
      try { fs.unlinkSync(tempPath) } catch { /* ignore */ }
      this._downloadProgress = 0
      logError('[local-llm] Model download failed:', err)
      throw err
    } finally {
      this.downloading = false
    }
  }

  private broadcastDownloadProgress(progress: number): void {
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        win.webContents.send(IPC.LLM_DOWNLOAD_PROGRESS, progress)
      } catch { /* window may be destroyed */ }
    }
  }

  private downloadFile(url: string, dest: string, onProgress: (pct: number) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const follow = (targetUrl: string, redirects = 0) => {
        if (redirects > 5) { reject(new Error('Too many redirects')); return }

        const proto = targetUrl.startsWith('https') ? https : http
        const req = proto.get(targetUrl, (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume()
            follow(res.headers.location, redirects + 1)
            return
          }
          if (res.statusCode !== 200) {
            res.resume()
            reject(new Error(`Download failed: HTTP ${res.statusCode}`))
            return
          }

          const totalBytes = parseInt(res.headers['content-length'] || '0', 10)
          let receivedBytes = 0
          const fileStream = fs.createWriteStream(dest)

          res.on('data', (chunk: Buffer) => {
            receivedBytes += chunk.length
            if (totalBytes > 0) {
              onProgress(Math.round((receivedBytes / totalBytes) * 100))
            }
          })

          res.pipe(fileStream)
          fileStream.on('finish', () => { fileStream.close(); resolve() })
          fileStream.on('error', (err) => { fileStream.close(); reject(err) })
          res.on('error', reject)
        })
        req.on('error', reject)
        req.setTimeout(30_000, () => { req.destroy(); reject(new Error('Download connection timed out')) })
      }

      follow(url)
    })
  }

  // -- Server lifecycle --

  async ensureServer(): Promise<void> {
    if (this.isServerRunning()) {
      this.lastRequestTime = Date.now()
      return
    }

    if (this.startupPromise) return this.startupPromise

    this.startupPromise = this.performStartup()
    try {
      await this.startupPromise
    } finally {
      this.startupPromise = null
    }
  }

  private async performStartup(): Promise<void> {
    // Download server binary and model in parallel if needed
    const downloads: Promise<void>[] = []
    if (!this.isServerBinaryAvailable()) downloads.push(this.ensureServerBinary())
    if (!this.isModelAvailable()) downloads.push(this.downloadModel())
    if (downloads.length > 0) await Promise.all(downloads)

    const binPath = this.getServerBinaryPath()
    if (!fs.existsSync(binPath)) {
      throw new Error(`llama-server binary not found at ${binPath}`)
    }

    this.serverPort = await this.findFreePort()

    log(`[local-llm] Starting llama-server on port ${this.serverPort}`)

    const args = [
      '-m', this.getModelPath(),
      '--port', String(this.serverPort),
      '--ctx-size', '4096',
      '-ngl', '0',
      '--threads', String(Math.min(4, os.cpus().length)),
      '--log-disable'
    ]

    this.serverProcess = spawn(binPath, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true
    })

    // Capture stderr for diagnostics (llama-server logs to stderr)
    let stderrBuf = ''
    this.serverProcess.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stderrBuf += text
      // Keep only last 2KB for diagnostics
      if (stderrBuf.length > 2048) stderrBuf = stderrBuf.slice(-2048)
    })

    this.serverProcess.on('exit', (code) => {
      log(`[local-llm] Server exited with code ${code}${stderrBuf ? '\n' + stderrBuf.trim() : ''}`)
      this.serverProcess = null
      this.clearIdleTimer()
    })

    this.serverProcess.on('error', (err) => {
      logError('[local-llm] Server process error:', err)
      this.serverProcess = null
      this.clearIdleTimer()
    })

    this.serverProcess.stderr?.on('data', (data: Buffer) => {
      const text = data.toString().trim()
      if (text) log(`[local-llm] server: ${text.slice(0, 200)}`)
    })

    await this.waitForServer()

    this.lastRequestTime = Date.now()
    this.startIdleTimer()
    this.registerShutdownHook()

    log('[local-llm] Server ready')
  }

  private async waitForServer(): Promise<void> {
    const deadline = Date.now() + SERVER_READY_TIMEOUT
    while (Date.now() < deadline) {
      if (!this.serverProcess || this.serverProcess.exitCode !== null) {
        const code = this.serverProcess?.exitCode
        // 3221225781 = 0xC0000135 = STATUS_DLL_NOT_FOUND on Windows
        const isDllMissing = code === 3221225781 || code === -1073741515
        const hint = isDllMissing ? ' (missing DLLs — clearing bin directory for re-download)' : ''
        if (isDllMissing) {
          // Auto-fix: clear the bin dir so next attempt re-downloads with all DLLs
          try { fs.rmSync(path.dirname(this.getServerBinaryPath()), { recursive: true, force: true }) } catch { /* ignore */ }
        }
        throw new Error(`llama-server exited unexpectedly during startup (code ${code}${hint})`)
      }
      try {
        const ok = await this.healthCheck()
        if (ok) return
      } catch { /* not ready yet */ }
      await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL))
    }
    throw new Error(`llama-server did not become ready within ${SERVER_READY_TIMEOUT / 1000}s`)
  }

  private healthCheck(): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${this.serverPort}/health`, (res) => {
        res.resume()
        resolve(res.statusCode === 200)
      })
      req.on('error', () => resolve(false))
      req.setTimeout(2000, () => { req.destroy(); resolve(false) })
    })
  }

  private findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer()
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address()
        if (!addr || typeof addr === 'string') { srv.close(); reject(new Error('Could not find free port')); return }
        const port = addr.port
        srv.close(() => resolve(port))
      })
      srv.on('error', reject)
    })
  }

  private startIdleTimer(): void {
    if (this.idleTimer) return
    this.idleTimer = setInterval(() => {
      if (this.isServerRunning() && Date.now() - this.lastRequestTime > SERVER_IDLE_TIMEOUT) {
        log('[local-llm] Idle timeout — shutting down server')
        this.shutdown()
      }
    }, IDLE_CHECK_INTERVAL)
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearInterval(this.idleTimer)
      this.idleTimer = null
    }
  }

  private registerShutdownHook(): void {
    if (this.shutdownRegistered) return
    this.shutdownRegistered = true
    app.on('will-quit', () => this.shutdown())
  }

  shutdown(): void {
    this.clearIdleTimer()
    if (this.serverProcess) {
      try {
        this.serverProcess.kill()
      } catch { /* already dead */ }
      this.serverProcess = null
    }
  }

  // -- Inference --

  async generate(prompt: string): Promise<string> {
    await this.ensureServer()
    this.lastRequestTime = Date.now()

    const body = JSON.stringify({
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 200,
      stream: false
    })

    const response = await new Promise<string>((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: this.serverPort,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      }, (res) => {
        let data = ''
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => {
          try {
            const json = JSON.parse(data)
            if (res.statusCode !== 200) {
              reject(new Error(json?.error?.message || `llama-server returned ${res.statusCode}`))
              return
            }
            const text = json?.choices?.[0]?.message?.content || ''
            resolve(text)
          } catch {
            reject(new Error('Invalid JSON from llama-server'))
          }
        })
      })
      req.on('error', (e) => reject(e))
      req.setTimeout(30_000, () => { req.destroy(); reject(new Error('llama-server request timed out')) })
      req.write(body)
      req.end()
    })

    return response
  }
}
