import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { log, logError } from './logger'

const bufferDir = (): string =>
  path.join(app.getPath('userData'), 'buffers')

function ensureDir(): void {
  fs.mkdirSync(bufferDir(), { recursive: true })
}

function bufferPath(sessionId: string): string {
  // Sanitize sessionId for filesystem safety
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
  return path.join(bufferDir(), `${safe}.buf`)
}

export function saveBuffer(sessionId: string, data: string): void {
  try {
    ensureDir()
    fs.writeFileSync(bufferPath(sessionId), data, 'utf8')
  } catch (err) {
    logError('buffer-store: save failed', err)
  }
}

export function loadBuffer(sessionId: string): string | null {
  try {
    const p = bufferPath(sessionId)
    if (fs.existsSync(p)) {
      return fs.readFileSync(p, 'utf8')
    }
  } catch (err) {
    logError('buffer-store: load failed', err)
  }
  return null
}

export function clearBuffer(sessionId: string): void {
  try {
    const p = bufferPath(sessionId)
    if (fs.existsSync(p)) {
      fs.unlinkSync(p)
    }
  } catch (err) {
    logError('buffer-store: clear failed', err)
  }
}

export function clearAllBuffers(): void {
  try {
    const dir = bufferDir()
    if (!fs.existsSync(dir)) return
    for (const file of fs.readdirSync(dir)) {
      if (file.endsWith('.buf')) {
        fs.unlinkSync(path.join(dir, file))
      }
    }
    log('buffer-store: cleared all buffers')
  } catch (err) {
    logError('buffer-store: clearAll failed', err)
  }
}
