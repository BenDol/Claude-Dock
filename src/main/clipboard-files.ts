import * as fs from 'fs'
import * as fsP from 'fs/promises'
import * as path from 'path'
import { execSync } from 'child_process'
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
/**
 * Try to read file paths from a named clipboard buffer format.
 * Returns decoded paths or empty array on failure.
 */
function tryReadFileBuffer(format: string, encoding: BufferEncoding): string[] {
  try {
    const buf = clipboard.readBuffer(format)
    if (buf.length === 0) return []
    const decoded = buf.toString(encoding).replace(/\0+$/, '')
    if (decoded && fs.existsSync(decoded)) return [decoded]
  } catch { /* format not readable */ }
  return []
}

/**
 * Parse a CF_HDROP buffer (DROPFILES structure) into file paths.
 * Layout: 20-byte header, then null-terminated paths, double-null at end.
 */
function parseCfHdrop(buf: Buffer): string[] {
  if (buf.length < 20) return []
  const pFiles = buf.readUInt32LE(0) // offset to file list
  const fWide = buf.readUInt32LE(16)  // 1 = Unicode, 0 = ANSI
  if (pFiles >= buf.length) return []

  const paths: string[] = []
  const encoding: BufferEncoding = fWide ? 'utf16le' : 'utf8'
  const nullSize = fWide ? 2 : 1

  let offset = pFiles
  while (offset < buf.length) {
    // Find next null terminator
    let end = offset
    if (fWide) {
      while (end + 1 < buf.length && (buf[end] !== 0 || buf[end + 1] !== 0)) end += 2
    } else {
      while (end < buf.length && buf[end] !== 0) end++
    }
    if (end === offset) break // double-null = end of list
    const p = buf.subarray(offset, end).toString(encoding)
    if (p) paths.push(p)
    offset = end + nullSize
  }
  return paths.filter((p) => fs.existsSync(p))
}

/**
 * Windows fallback: use PowerShell to read file drop list from clipboard.
 * This is slower (~50-100ms) but works reliably when Electron's native
 * clipboard format names don't match what we expect.
 */
function getClipboardFilesViaPowerShell(): string[] {
  try {
    const cmd = 'powershell.exe -NoProfile -Command "(Get-Clipboard -Format FileDropList) -join [char]10"'
    const output = execSync(cmd, { encoding: 'utf8', timeout: 3000, windowsHide: true }).trim()
    if (!output) return []
    const files = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    return files.filter((f) => fs.existsSync(f))
  } catch {
    return []
  }
}

export function getClipboardFiles(): { files: string[]; image: boolean } {
  try {
    const formats = clipboard.availableFormats()
    log(`[file-paste] clipboard formats: ${formats.join(', ')}`)
    let files: string[] = []

    // Read clipboard text once — reused for guards below
    const clipText = clipboard.readText()?.trim() || ''

    if (process.platform === 'win32') {
      // Windows: files copied from Explorer may use several format names.
      // Try native buffer reads first (fast), then PowerShell fallback (reliable).

      // CF_HDROP — contains all copied file paths in a DROPFILES structure
      if (formats.includes('CF_HDROP')) {
        try {
          const buf = clipboard.readBuffer('CF_HDROP')
          files = parseCfHdrop(buf)
          if (files.length > 0) log(`[file-paste] CF_HDROP: ${files.length} file(s)`)
        } catch (e) {
          log(`[file-paste] CF_HDROP read error: ${e}`)
        }
      }

      // FileNameW — single file path as UTF-16LE
      if (files.length === 0 && formats.includes('FileNameW')) {
        files = tryReadFileBuffer('FileNameW', 'utf16le')
      }

      // FileName — single file path as ANSI
      if (files.length === 0 && formats.includes('FileName')) {
        files = tryReadFileBuffer('FileName', 'utf8')
      }

      // PowerShell fallback — handles cases where Electron doesn't expose
      // expected format names. Only runs when buffer reads found nothing
      // AND the clipboard has no text (avoids running on normal text paste).
      if (files.length === 0 && !clipText) {
        files = getClipboardFilesViaPowerShell()
        if (files.length > 0) log(`[file-paste] PowerShell fallback: ${files.length} file(s)`)
      }
    }

    // macOS: file copies use text/uri-list with file:// URIs
    if (process.platform === 'darwin' && files.length === 0) {
      if (formats.includes('text/uri-list')) {
        try {
          const text = clipboard.readBuffer('text/uri-list').toString('utf8')
          const uris = text.split(/\r?\n/).filter((l) => l.startsWith('file://'))
          files = uris.map((u) => decodeURIComponent(new URL(u).pathname))
            .filter((p) => fs.existsSync(p))
        } catch (e) {
          log(`[file-paste] text/uri-list read error: ${e}`)
        }
      }
    }

    if (files.length > 0) {
      return { files, image: false }
    }

    // Only check for clipboard image when no files and no useful text is present.
    // clipboard.readImage() can be expensive for large images, so skip it when
    // the clipboard clearly has text content (the common case for normal paste).
    if (!clipText) {
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
