/**
 * Local LLM manager — app-level service managing a bundled llama-server process.
 *
 * Architecture:
 * - Spawns llama-server on first generate() call
 * - Communicates via OpenAI-compatible HTTP API (localhost)
 * - Auto-downloads the model on first use to {userData}/models/
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
const SERVER_READY_TIMEOUT = 60_000 // 60s — includes model load time on first start
const SERVER_IDLE_TIMEOUT = 5 * 60_000 // 5 minutes
const IDLE_CHECK_INTERVAL = 60_000 // check every minute
const HEALTH_POLL_INTERVAL = 500

export class LocalLlmManager {
  private static instance: LocalLlmManager | null = null

  private serverProcess: ChildProcess | null = null
  private serverPort = 0
  private lastRequestTime = 0
  private idleTimer: ReturnType<typeof setInterval> | null = null
  private downloadPromise: Promise<void> | null = null
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

  getModelDir(): string {
    return path.join(app.getPath('userData'), 'models')
  }

  getModelPath(): string {
    return path.join(this.getModelDir(), MODEL_FILENAME)
  }

  getServerBinaryPath(): string {
    const binName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'llm', binName)
    }
    // Dev mode
    return path.join(app.getAppPath(), 'resources', 'llm',
      process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux',
      binName)
  }

  // -- Status queries --

  isModelAvailable(): boolean {
    try {
      return fs.existsSync(this.getModelPath())
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

  getStatus(): { modelAvailable: boolean; serverRunning: boolean; downloading: boolean; downloadProgress: number } {
    return {
      modelAvailable: this.isModelAvailable(),
      serverRunning: this.isServerRunning(),
      downloading: this.downloading,
      downloadProgress: this._downloadProgress
    }
  }

  // -- Model download --

  async downloadModel(): Promise<void> {
    // Return existing download promise if one is in progress
    if (this.downloadPromise) return this.downloadPromise

    if (this.isModelAvailable()) return

    this.downloadPromise = this.performDownload()
    try {
      await this.downloadPromise
    } finally {
      this.downloadPromise = null
    }
  }

  private async performDownload(): Promise<void> {
    this.downloading = true
    this._downloadProgress = 0
    this.broadcastDownloadProgress(0)

    const modelDir = this.getModelDir()
    fs.mkdirSync(modelDir, { recursive: true })

    const tempPath = this.getModelPath() + '.downloading'
    const finalPath = this.getModelPath()

    try {
      await this.downloadFile(MODEL_URL, tempPath, (progress) => {
        this._downloadProgress = progress
        this.broadcastDownloadProgress(progress)
      })
      // Rename temp → final atomically
      fs.renameSync(tempPath, finalPath)
      this._downloadProgress = 100
      this.broadcastDownloadProgress(100)
      log(`[local-llm] Model downloaded to ${finalPath}`)
    } catch (err) {
      // Clean up partial download
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
          // Follow redirects
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
    // Already running
    if (this.isServerRunning()) {
      this.lastRequestTime = Date.now()
      return
    }

    // Return existing startup promise if one is in progress
    if (this.startupPromise) return this.startupPromise

    this.startupPromise = this.performStartup()
    try {
      await this.startupPromise
    } finally {
      this.startupPromise = null
    }
  }

  private async performStartup(): Promise<void> {
    // Download model if needed
    if (!this.isModelAvailable()) {
      await this.downloadModel()
    }

    // Verify binary exists
    const binPath = this.getServerBinaryPath()
    if (!fs.existsSync(binPath)) {
      throw new Error(`llama-server binary not found at ${binPath}`)
    }

    // Find a free port
    this.serverPort = await this.findFreePort()

    log(`[local-llm] Starting llama-server on port ${this.serverPort}`)

    const args = [
      '-m', this.getModelPath(),
      '--port', String(this.serverPort),
      '--ctx-size', '4096',
      '-ngl', '0', // CPU only
      '--threads', String(Math.min(4, os.cpus().length)),
      '--log-disable'
    ]

    this.serverProcess = spawn(binPath, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true
    })

    this.serverProcess.on('exit', (code) => {
      log(`[local-llm] Server exited with code ${code}`)
      this.serverProcess = null
      this.clearIdleTimer()
    })

    this.serverProcess.on('error', (err) => {
      logError('[local-llm] Server process error:', err)
      this.serverProcess = null
      this.clearIdleTimer()
    })

    // Log stderr for debugging
    this.serverProcess.stderr?.on('data', (data: Buffer) => {
      const text = data.toString().trim()
      if (text) log(`[local-llm] server: ${text.slice(0, 200)}`)
    })

    // Wait for server readiness
    await this.waitForServer()

    this.lastRequestTime = Date.now()
    this.startIdleTimer()
    this.registerShutdownHook()

    log('[local-llm] Server ready')
  }

  private async waitForServer(): Promise<void> {
    const deadline = Date.now() + SERVER_READY_TIMEOUT
    while (Date.now() < deadline) {
      // Fail fast if the process exited
      if (!this.serverProcess || this.serverProcess.exitCode !== null) {
        throw new Error('llama-server exited unexpectedly during startup')
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
