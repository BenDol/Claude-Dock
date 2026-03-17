import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { log } from './logger'

const PENDING_FILE = 'pending-project.json'
const LOCK_FILE = 'update.lock'
const MAX_AGE_MS = 5 * 60 * 1000 // 5 minutes

interface PendingProject {
  dir: string
  timestamp: number
}

interface UpdateLock {
  pid: number
  timestamp: number
}

function getFilePath(name: string): string {
  return path.join(app.getPath('userData'), name)
}

// --- Pending project (consume-once) ---

export function savePendingProject(dir: string): void {
  const data: PendingProject = { dir, timestamp: Date.now() }
  const filePath = getFilePath(PENDING_FILE)
  try {
    fs.writeFileSync(filePath, JSON.stringify(data), 'utf8')
    log(`[pending-project] saved: ${dir}`)
  } catch (err) {
    log(`[pending-project] save failed: ${err}`)
  }
}

export function loadPendingProject(): string | null {
  const filePath = getFilePath(PENDING_FILE)
  try {
    if (!fs.existsSync(filePath)) return null
    const raw = fs.readFileSync(filePath, 'utf8')
    // Always delete the file (consume-once)
    try { fs.unlinkSync(filePath) } catch { /* ignore */ }
    const data: PendingProject = JSON.parse(raw)
    if (Date.now() - data.timestamp > MAX_AGE_MS) {
      log(`[pending-project] expired (age ${Math.round((Date.now() - data.timestamp) / 1000)}s)`)
      return null
    }
    if (!data.dir || !fs.existsSync(data.dir)) {
      log(`[pending-project] dir missing: ${data.dir}`)
      return null
    }
    log(`[pending-project] loaded: ${data.dir}`)
    return data.dir
  } catch (err) {
    log(`[pending-project] load failed: ${err}`)
    try { fs.unlinkSync(filePath) } catch { /* ignore */ }
    return null
  }
}

export function clearPendingProject(): void {
  try {
    fs.unlinkSync(getFilePath(PENDING_FILE))
  } catch { /* ignore */ }
}

// --- Update lock (PID-based) ---

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function acquireUpdateLock(): boolean {
  const filePath = getFilePath(LOCK_FILE)
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8')
      const lock: UpdateLock = JSON.parse(raw)
      if (lock.pid !== process.pid && isPidAlive(lock.pid)) {
        log(`[update-lock] held by PID ${lock.pid}`)
        return false
      }
    }
    const data: UpdateLock = { pid: process.pid, timestamp: Date.now() }
    fs.writeFileSync(filePath, JSON.stringify(data), 'utf8')
    log(`[update-lock] acquired by PID ${process.pid}`)
    return true
  } catch (err) {
    log(`[update-lock] acquire failed: ${err}`)
    return false
  }
}

export function releaseUpdateLock(): void {
  try {
    fs.unlinkSync(getFilePath(LOCK_FILE))
    log(`[update-lock] released`)
  } catch { /* ignore */ }
}

export function isUpdateLocked(): boolean {
  const filePath = getFilePath(LOCK_FILE)
  try {
    if (!fs.existsSync(filePath)) return false
    const raw = fs.readFileSync(filePath, 'utf8')
    const lock: UpdateLock = JSON.parse(raw)
    return lock.pid !== process.pid && isPidAlive(lock.pid)
  } catch {
    return false
  }
}

export function cleanStaleLock(): void {
  const filePath = getFilePath(LOCK_FILE)
  try {
    if (!fs.existsSync(filePath)) return
    const raw = fs.readFileSync(filePath, 'utf8')
    const lock: UpdateLock = JSON.parse(raw)
    const stale = !isPidAlive(lock.pid) || (Date.now() - lock.timestamp > MAX_AGE_MS)
    if (stale) {
      fs.unlinkSync(filePath)
      log(`[update-lock] cleaned stale lock (PID ${lock.pid}, age ${Math.round((Date.now() - lock.timestamp) / 1000)}s)`)
    }
  } catch { /* ignore */ }
}
