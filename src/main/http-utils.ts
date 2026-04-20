import * as https from 'https'
import * as http from 'http'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { ENV_PROFILE } from '../shared/env-profile'

const USER_AGENT = 'Claude-Dock-Updater'

function followRedirects(
  url: string,
  headers: Record<string, string>,
  handler: (res: http.IncomingMessage) => void,
  onError: (err: Error) => void
): void {
  const mod = url.startsWith('https') ? https : http
  mod
    .get(url, { headers }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const location = res.headers.location
        if (!location) return onError(new Error('Redirect without Location header'))
        return followRedirects(location, headers, handler, onError)
      }
      handler(res)
    })
    .on('error', onError)
}

export function fetchJSON<T>(url: string, extraHeaders?: Record<string, string>): Promise<T> {
  return new Promise((resolve, reject) => {
    followRedirects(
      url,
      { 'User-Agent': USER_AGENT, Accept: 'application/json', ...extraHeaders },
      (res) => {
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`))
        }
        let data = ''
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => {
          try { resolve(JSON.parse(data)) }
          catch (e) { reject(e) }
        })
        res.on('error', reject)
      },
      reject
    )
  })
}

export function fetchText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    followRedirects(
      url,
      { 'User-Agent': USER_AGENT, Accept: 'application/octet-stream' },
      (res) => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`))
        let data = ''
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => resolve(data.trim()))
        res.on('error', reject)
      },
      reject
    )
  })
}

export type ProgressCallback = (downloaded: number, total: number) => void

/**
 * Downloads a file from url to a temp directory, reporting progress.
 * Returns the path to the downloaded file.
 */
export function downloadFile(
  url: string,
  fileName: string,
  onProgress?: ProgressCallback,
  destDir?: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const dir = destDir || path.join(os.tmpdir(), `claude-dock-${ENV_PROFILE}-plugin-updates`)
    fs.mkdirSync(dir, { recursive: true })
    const filePath = path.join(dir, fileName)

    try { fs.unlinkSync(filePath) } catch { /* no-op */ }

    const file = fs.createWriteStream(filePath)

    followRedirects(
      url,
      { 'User-Agent': USER_AGENT },
      (res) => {
        if (res.statusCode !== 200) {
          file.close()
          fs.unlink(filePath, () => {})
          return reject(new Error(`Download failed: HTTP ${res.statusCode}`))
        }

        const total = parseInt(res.headers['content-length'] || '0', 10)
        let downloaded = 0

        res.on('data', (chunk: Buffer) => {
          downloaded += chunk.length
          onProgress?.(downloaded, total)
        })

        res.pipe(file)
        file.on('finish', () => {
          file.close()
          resolve(filePath)
        })
        file.on('error', (err) => {
          fs.unlink(filePath, () => {})
          reject(err)
        })
      },
      (err) => {
        file.close()
        fs.unlink(filePath, () => {})
        reject(err)
      }
    )
  })
}

/**
 * Extracts the hostname from a URL. Returns null if invalid.
 */
export function extractHostname(url: string): string | null {
  try {
    return new URL(url).hostname
  } catch {
    return null
  }
}
