import * as fs from 'fs'
import * as fsP from 'fs/promises'
import * as path from 'path'
import { app, clipboard } from 'electron'
import { log, logError } from './logger'

const PASTE_DIR_NAME = 'file-paste'
const MAX_AGE_MS = 24 * 60 * 60 * 1000 // 24 hours

function getPasteBaseDir(): string {
  return path.join(app.getPath('userData'), PASTE_DIR_NAME)
}

function getTodayDir(): string {
  const date = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
  return path.join(getPasteBaseDir(), date)
}

/**
 * Check the system clipboard for copied files or images.
 * On Windows, files copied from Explorer appear with the 'FileNameW' clipboard format.
 * Only reports image=true when no files and no text are on the clipboard.
 */
export function getClipboardFiles(): { files: string[]; image: boolean } {
  try {
    const formats = clipboard.availableFormats()
    const files: string[] = []

    // Windows: files copied from Explorer have 'FileNameW' format.
    // This is the definitive signal — plain text that happens to look like a
    // path (e.g. copied from a code editor) must NOT be intercepted.
    if (formats.includes('FileNameW')) {
      try {
        const buf = clipboard.readBuffer('FileNameW')
        if (buf.length > 0) {
          // FileNameW is UTF-16LE with null terminator(s)
          const decoded = buf.toString('utf16le').replace(/\0+$/, '')
          if (decoded && fs.existsSync(decoded)) {
            files.push(decoded)
          }
        }
      } catch (e) {
        log(`[file-paste] FileNameW read error: ${e}`)
      }
    }

    if (files.length > 0) {
      return { files, image: false }
    }

    // Only check for clipboard image when no files and no useful text is present.
    // clipboard.readImage() can be expensive for large images, so skip it when
    // the clipboard clearly has text content (the common case for normal paste).
    const hasText = clipboard.readText()?.trim()
    if (!hasText) {
      try {
        const img = clipboard.readImage()
        if (!img.isEmpty()) {
          return { files: [], image: true }
        }
      } catch (e) {
        log(`[file-paste] image read error: ${e}`)
      }
    }

    return { files: [], image: false }
  } catch (e) {
    logError(`[file-paste] clipboard check error: ${e}`)
    return { files: [], image: false }
  }
}

/**
 * Copy source files to the temp paste directory.
 * Files are named with a timestamp prefix to avoid collisions.
 */
export async function copyFilesToTemp(
  sourcePaths: string[]
): Promise<{ tempPaths: string[]; errors: string[] }> {
  const dir = getTodayDir()
  await fsP.mkdir(dir, { recursive: true })

  const tempPaths: string[] = []
  const errors: string[] = []
  const ts = Date.now()

  for (const src of sourcePaths) {
    try {
      const basename = path.basename(src)
      const dest = path.join(dir, `${ts}-${basename}`)
      const stat = await fsP.stat(src)
      if (stat.isDirectory()) {
        errors.push(`${basename}: directories are not supported`)
        continue
      }
      await fsP.copyFile(src, dest)
      tempPaths.push(dest)
      log(`[file-paste] copied ${basename} -> ${dest}`)
    } catch (e) {
      const basename = path.basename(src)
      errors.push(`${basename}: ${e}`)
      logError(`[file-paste] copy error for ${src}: ${e}`)
    }
  }

  return { tempPaths, errors }
}

/**
 * Save a clipboard image (screenshot) to the temp paste directory as PNG.
 */
export async function saveClipboardImageToTemp(): Promise<{ tempPath: string } | null> {
  try {
    const img = clipboard.readImage()
    if (img.isEmpty()) return null

    const dir = getTodayDir()
    await fsP.mkdir(dir, { recursive: true })

    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const filename = `clipboard-${ts}.png`
    const dest = path.join(dir, filename)

    const pngBuffer = img.toPNG()
    await fsP.writeFile(dest, pngBuffer)
    log(`[file-paste] saved clipboard image -> ${dest}`)

    return { tempPath: dest }
  } catch (e) {
    logError(`[file-paste] image save error: ${e}`)
    return null
  }
}

/**
 * Remove paste subdirectories older than 24 hours.
 * Called on app startup, follows the logger rotation pattern.
 */
export function cleanOldPastedFiles(): void {
  const baseDir = getPasteBaseDir()
  if (!fs.existsSync(baseDir)) return

  try {
    const entries = fs.readdirSync(baseDir)
    const now = Date.now()

    for (const entry of entries) {
      const entryPath = path.join(baseDir, entry)
      try {
        // Directories are named YYYY-MM-DD — use the name, not mtime
        // (mtime changes when files are added, making it unreliable for age)
        const dateMatch = /^\d{4}-\d{2}-\d{2}$/.test(entry)
        if (dateMatch) {
          const dirDate = new Date(entry + 'T00:00:00').getTime()
          if (!isNaN(dirDate) && now - dirDate > MAX_AGE_MS) {
            fs.rmSync(entryPath, { recursive: true, force: true })
            log(`[file-paste] cleaned old paste dir: ${entry}`)
          }
        } else {
          // Unexpected entry — clean if older than 24h by mtime as fallback
          const stat = fs.statSync(entryPath)
          if (stat.isDirectory() && now - stat.mtimeMs > MAX_AGE_MS) {
            fs.rmSync(entryPath, { recursive: true, force: true })
            log(`[file-paste] cleaned unknown paste dir: ${entry}`)
          }
        }
      } catch {
        // best-effort cleanup
      }
    }
  } catch {
    // base dir might not exist yet
  }
}
