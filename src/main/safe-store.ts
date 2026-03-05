import Store from 'electron-store'
import * as fs from 'fs'

const MAX_RETRIES = 3
const BASE_DELAY_MS = 50

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Wraps a store write operation with try/catch and exponential backoff retry.
 * Never throws - logs errors and returns false on failure.
 */
export async function safeWrite(fn: () => void): Promise<boolean> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      fn()
      return true
    } catch (err) {
      const isLastAttempt = attempt === MAX_RETRIES
      if (isLastAttempt) {
        console.error('[safe-store] Write failed after retries:', err)
        return false
      }
      const delay = BASE_DELAY_MS * Math.pow(2, attempt)
      console.warn(`[safe-store] Write failed (attempt ${attempt + 1}), retrying in ${delay}ms:`, err)
      await sleep(delay)
    }
  }
  return false
}

/**
 * Synchronous version of safeWrite for cases where we can't await.
 * Retries synchronously (no delay between retries).
 */
export function safeWriteSync(fn: () => void): boolean {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      fn()
      return true
    } catch (err) {
      if (attempt === MAX_RETRIES) {
        console.error('[safe-store] Sync write failed after retries:', err)
        return false
      }
      console.warn(`[safe-store] Sync write failed (attempt ${attempt + 1}), retrying:`, err)
    }
  }
  return false
}

/**
 * Safely reads from a store. Returns undefined on failure instead of throwing.
 */
export function safeRead<T>(fn: () => T): T | undefined {
  try {
    return fn()
  } catch (err) {
    console.error('[safe-store] Read failed:', err)
    return undefined
  }
}

/**
 * Creates an electron-store instance that recovers from corrupt JSON files.
 * If the store file is corrupt, it backs it up and starts fresh.
 */
export function createSafeStore<T extends Record<string, unknown>>(
  opts: ConstructorParameters<typeof Store<T>>[0]
): Store<T> {
  try {
    return new Store<T>(opts)
  } catch (err) {
    console.error(`[safe-store] Store "${opts?.name}" is corrupt, resetting:`, err)
    // Try to back up and recreate
    try {
      const testStore = new Store<T>({ ...opts, defaults: opts?.defaults })
      const storePath = testStore.path
      testStore.clear()
      return testStore
    } catch {
      // If even that fails, try deleting the file and recreating
      try {
        const tmpStore = new Store({ name: opts?.name || 'unknown' })
        const storePath = tmpStore.path
        if (fs.existsSync(storePath)) {
          const backupPath = storePath + '.corrupt.' + Date.now()
          fs.renameSync(storePath, backupPath)
          console.warn(`[safe-store] Backed up corrupt store to ${backupPath}`)
        }
      } catch {
        // Last resort - ignore
      }
      return new Store<T>(opts)
    }
  }
}
