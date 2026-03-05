import * as https from 'https'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { app } from 'electron'
import { spawn } from 'child_process'

declare const __BUILD_SHA__: string

const GITHUB_API = 'https://api.github.com/repos/BenDol/Claude-Dock/releases'

interface GitHubAsset {
  name: string
  browser_download_url: string
  size: number
}

interface GitHubRelease {
  tag_name: string
  name: string
  body: string
  prerelease: boolean
  draft: boolean
  assets: GitHubAsset[]
}

export interface UpdateInfo {
  available: boolean
  version: string
  releaseNotes: string
  downloadUrl: string
  assetName: string
  assetSize: number
}

const noUpdate: UpdateInfo = {
  available: false,
  version: '',
  releaseNotes: '',
  downloadUrl: '',
  assetName: '',
  assetSize: 0
}

function fetchJSON<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'Claude-Dock-Updater', Accept: 'application/json' } }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return fetchJSON<T>(res.headers.location!).then(resolve, reject)
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`GitHub API returned HTTP ${res.statusCode}`))
        }
        let data = ''
        res.on('data', (chunk) => {
          data += chunk
        })
        res.on('end', () => {
          try {
            resolve(JSON.parse(data))
          } catch (e) {
            reject(e)
          }
        })
        res.on('error', reject)
      })
      .on('error', reject)
  })
}

function findPlatformAsset(assets: GitHubAsset[]): GitHubAsset | undefined {
  switch (process.platform) {
    case 'win32': {
      // Prefer portable exe (no "setup" in name), exclude blockmap files
      const portable = assets.find(
        (a) =>
          a.name.endsWith('.exe') &&
          !a.name.toLowerCase().includes('setup') &&
          !a.name.endsWith('.blockmap')
      )
      if (portable) return portable
      // Fallback to any exe (not blockmap, not setup)
      return assets.find((a) => a.name.endsWith('.exe') && !a.name.endsWith('.blockmap'))
    }
    case 'darwin':
      return assets.find((a) => a.name.endsWith('.dmg'))
    case 'linux':
      return assets.find((a) => a.name.endsWith('.AppImage'))
    default:
      return undefined
  }
}

function parseVersion(tag: string): number[] | null {
  const m = tag.match(/v?(\d+)\.(\d+)\.(\d+)/)
  if (!m) return null
  return [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])]
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return 0
}

export async function checkForUpdate(profile: string): Promise<UpdateInfo> {
  const releases = await fetchJSON<GitHubRelease[]>(GITHUB_API)

  if (profile === 'bleeding-edge') {
    const release = releases.find((r) => r.tag_name === 'bleeding-edge')
    if (!release) return noUpdate

    // Extract commit SHA from release body
    const shaMatch = release.body.match(/Commit:\s*([a-f0-9]+)/i)
    const remoteSha = shaMatch ? shaMatch[1] : ''

    if (
      !remoteSha ||
      __BUILD_SHA__.startsWith(remoteSha) ||
      remoteSha.startsWith(__BUILD_SHA__)
    ) {
      return noUpdate
    }

    const asset = findPlatformAsset(release.assets)
    if (!asset) return noUpdate

    return {
      available: true,
      version: `bleeding-edge (${remoteSha.slice(0, 7)})`,
      releaseNotes: release.body,
      downloadUrl: asset.browser_download_url,
      assetName: asset.name,
      assetSize: asset.size
    }
  }

  if (profile === 'latest') {
    const currentVersion = parseVersion(app.getVersion())

    let best: GitHubRelease | null = null
    let bestVer: number[] | null = null

    for (const r of releases) {
      if (r.prerelease || r.draft) continue
      const v = parseVersion(r.tag_name)
      if (!v) continue
      if (!bestVer || compareVersions(v, bestVer) > 0) {
        bestVer = v
        best = r
      }
    }

    if (!best || !bestVer || !currentVersion) return noUpdate
    if (compareVersions(bestVer, currentVersion) <= 0) return noUpdate

    const asset = findPlatformAsset(best.assets)
    if (!asset) return noUpdate

    return {
      available: true,
      version: best.tag_name,
      releaseNotes: best.body,
      downloadUrl: asset.browser_download_url,
      assetName: asset.name,
      assetSize: asset.size
    }
  }

  // Specific release tag/name
  const release = releases.find((r) => r.tag_name === profile || r.name === profile)
  if (!release) return noUpdate

  const targetVer = parseVersion(release.tag_name)
  const currentVer = parseVersion(app.getVersion())
  if (targetVer && currentVer && compareVersions(targetVer, currentVer) === 0) return noUpdate

  const asset = findPlatformAsset(release.assets)
  if (!asset) return noUpdate

  return {
    available: true,
    version: release.tag_name,
    releaseNotes: release.body,
    downloadUrl: asset.browser_download_url,
    assetName: asset.name,
    assetSize: asset.size
  }
}

export type ProgressCallback = (downloaded: number, total: number) => void

export function downloadUpdate(
  url: string,
  assetName: string,
  onProgress: ProgressCallback
): Promise<string> {
  return new Promise((resolve, reject) => {
    const tempDir = path.join(os.tmpdir(), 'claude-dock-update')
    fs.mkdirSync(tempDir, { recursive: true })
    const filePath = path.join(tempDir, assetName)

    // Remove old download if present
    try {
      fs.unlinkSync(filePath)
    } catch {
      /* no-op */
    }

    const file = fs.createWriteStream(filePath)

    function follow(downloadUrl: string): void {
      https
        .get(
          downloadUrl,
          { headers: { 'User-Agent': 'Claude-Dock-Updater' } },
          (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
              return follow(res.headers.location!)
            }
            if (res.statusCode !== 200) {
              file.close()
              fs.unlink(filePath, () => {})
              return reject(new Error(`Download failed: HTTP ${res.statusCode}`))
            }

            const total = parseInt(res.headers['content-length'] || '0', 10)
            let downloaded = 0

            res.on('data', (chunk: Buffer) => {
              downloaded += chunk.length
              onProgress(downloaded, total)
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
          }
        )
        .on('error', (err) => {
          file.close()
          fs.unlink(filePath, () => {})
          reject(err)
        })
    }

    follow(url)
  })
}

let downloadedFilePath: string | null = null

export function setDownloadedPath(p: string): void {
  downloadedFilePath = p
}

export function getDownloadedPath(): string | null {
  return downloadedFilePath
}

export function installAndRestart(): void {
  if (!downloadedFilePath) throw new Error('No downloaded update')

  const currentExe = app.getPath('exe')

  if (process.platform === 'win32') {
    installWindows(downloadedFilePath, currentExe)
  } else if (process.platform === 'darwin') {
    installMacOS(downloadedFilePath, currentExe)
  } else {
    installLinux(downloadedFilePath, currentExe)
  }
}

function installWindows(newExe: string, currentExe: string): void {
  // Create a batch script that waits for us to exit, replaces the exe, and relaunches
  const scriptPath = path.join(os.tmpdir(), 'claude-dock-update', 'update.cmd')
  const script = [
    '@echo off',
    // Wait for the current process to exit
    `ping 127.0.0.1 -n 4 > nul`,
    // Copy new exe over current
    `copy /Y "${newExe}" "${currentExe}"`,
    // Launch the updated exe
    `start "" "${currentExe}"`,
    // Clean up temp files
    `del "${newExe}"`,
    `(goto) 2>nul & del "%~f0"`
  ].join('\r\n')

  fs.writeFileSync(scriptPath, script)
  spawn('cmd.exe', ['/c', scriptPath], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  app.quit()
}

function installMacOS(dmgPath: string, currentExe: string): void {
  // currentExe is like /Applications/Claude Dock.app/Contents/MacOS/Claude Dock
  // We need to replace the .app bundle
  const appBundle = path.resolve(currentExe, '..', '..', '..')
  const appName = path.basename(appBundle)
  const appParent = path.dirname(appBundle)
  const mountPoint = path.join(os.tmpdir(), 'claude-dock-dmg')

  const scriptPath = path.join(os.tmpdir(), 'claude-dock-update', 'update.sh')
  const script = [
    '#!/bin/bash',
    'sleep 3',
    `mkdir -p "${mountPoint}"`,
    `hdiutil attach "${dmgPath}" -mountpoint "${mountPoint}" -nobrowse -quiet`,
    `rm -rf "${appBundle}"`,
    `cp -R "${mountPoint}/${appName}" "${appParent}/"`,
    `hdiutil detach "${mountPoint}" -quiet`,
    `rm -f "${dmgPath}"`,
    `open "${appBundle}"`,
    `rm -f "$0"`
  ].join('\n')

  fs.writeFileSync(scriptPath, script, { mode: 0o755 })
  spawn('/bin/bash', [scriptPath], { detached: true, stdio: 'ignore' }).unref()
  app.quit()
}

function installLinux(newAppImage: string, currentExe: string): void {
  const scriptPath = path.join(os.tmpdir(), 'claude-dock-update', 'update.sh')
  const script = [
    '#!/bin/bash',
    'sleep 3',
    `cp -f "${newAppImage}" "${currentExe}"`,
    `chmod +x "${currentExe}"`,
    `rm -f "${newAppImage}"`,
    `"${currentExe}" &`,
    `rm -f "$0"`
  ].join('\n')

  fs.writeFileSync(scriptPath, script, { mode: 0o755 })
  spawn('/bin/bash', [scriptPath], { detached: true, stdio: 'ignore' }).unref()
  app.quit()
}
