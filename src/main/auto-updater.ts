import * as https from 'https'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { app } from 'electron'
import { spawn } from 'child_process'

declare const __BUILD_SHA__: string
// test: force updater rebuild
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

/**
 * Detect whether this instance is a portable exe (vs NSIS-installed).
 * electron-builder sets PORTABLE_EXECUTABLE_FILE only for portable builds.
 */
function isPortableExe(): boolean {
  return !!process.env.PORTABLE_EXECUTABLE_FILE
}

function findPortableExeAsset(assets: GitHubAsset[]): GitHubAsset | undefined {
  // Prefer explicitly named .Portable.exe
  const named = assets.find((a) => a.name.toLowerCase().includes('.portable.') && a.name.endsWith('.exe'))
  if (named) return named
  // Fallback: any exe that isn't a setup installer or blockmap (backward compat with older releases)
  const portable = assets.find(
    (a) =>
      a.name.endsWith('.exe') &&
      !a.name.toLowerCase().includes('setup') &&
      !a.name.endsWith('.blockmap')
  )
  if (portable) return portable
  return assets.find((a) => a.name.endsWith('.exe') && !a.name.endsWith('.blockmap'))
}

function findPlatformAsset(assets: GitHubAsset[]): GitHubAsset | undefined {
  switch (process.platform) {
    case 'win32': {
      if (isPortableExe()) {
        return findPortableExeAsset(assets)
      }
      // NSIS install: prefer win-unpacked zip, fallback to portable exe for older releases
      const unpacked = assets.find((a) => a.name.toLowerCase().includes('win-unpacked') && a.name.endsWith('.zip'))
      if (unpacked) return unpacked
      return findPortableExeAsset(assets)
    }
    case 'darwin':
      return assets.find((a) => a.name.endsWith('.dmg'))
    case 'linux':
      return assets.find((a) => a.name.endsWith('.AppImage'))
    default:
      return undefined
  }
}

function getPlatformShaAsset(assets: GitHubAsset[]): GitHubAsset | undefined {
  const prefix = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux'
  return assets.find((a) => a.name === `${prefix}-sha.txt`)
}

function fetchText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'Claude-Dock-Updater', Accept: 'application/octet-stream' } }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return fetchText(res.headers.location!).then(resolve, reject)
        }
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`))
        let data = ''
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => resolve(data.trim()))
        res.on('error', reject)
      })
      .on('error', reject)
  })
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

    const asset = findPlatformAsset(release.assets)
    if (!asset) return noUpdate

    // Check platform-specific SHA file to avoid false updates when other platforms
    // have published to the release but this platform's asset is still from an older build
    const shaAsset = getPlatformShaAsset(release.assets)
    let remoteSha = ''
    if (shaAsset) {
      try {
        remoteSha = await fetchText(shaAsset.browser_download_url)
      } catch {
        // Fallback to release body SHA
      }
    }
    if (!remoteSha) {
      const shaMatch = release.body.match(/Commit:\s*([a-f0-9]+)/i)
      remoteSha = shaMatch ? shaMatch[1] : ''
    }

    if (
      !remoteSha ||
      __BUILD_SHA__.startsWith(remoteSha) ||
      remoteSha.startsWith(__BUILD_SHA__)
    ) {
      return noUpdate
    }

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
    if (isPortableExe()) {
      installWindowsPortable(downloadedFilePath, currentExe)
    } else {
      installWindowsNsis(downloadedFilePath, currentExe)
    }
  } else if (process.platform === 'darwin') {
    installMacOS(downloadedFilePath, currentExe)
  } else {
    installLinux(downloadedFilePath, currentExe)
  }
}

function installWindowsPortable(newExe: string, currentExe: string): void {
  const exeName = path.basename(currentExe)
  const scriptPath = path.join(os.tmpdir(), 'claude-dock-update', 'update.cmd')
  const script = [
    '@echo off',
    `taskkill /IM "${exeName}" >nul 2>&1`,
    'ping 127.0.0.1 -n 5 > nul',
    `taskkill /F /IM "${exeName}" >nul 2>&1`,
    'ping 127.0.0.1 -n 3 > nul',
    'set /a tries=0',
    ':copy_retry',
    `copy /Y "${newExe}" "${currentExe}" >nul 2>&1`,
    'if not errorlevel 1 goto copy_ok',
    'set /a tries+=1',
    'if %tries% GEQ 5 goto copy_fail',
    'ping 127.0.0.1 -n 3 > nul',
    'goto copy_retry',
    ':copy_ok',
    `start "" "${currentExe}"`,
    ':copy_fail',
    `del "${newExe}" >nul 2>&1`,
    '(goto) 2>nul & del "%~f0"'
  ].join('\r\n')

  fs.writeFileSync(scriptPath, script)
  spawn('cmd.exe', ['/c', scriptPath], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  app.quit()
}

function installWindowsNsis(zipPath: string, currentExe: string): void {
  const exeName = path.basename(currentExe)
  const installDir = path.dirname(currentExe)
  const scriptPath = path.join(os.tmpdir(), 'claude-dock-update', 'update.cmd')
  const script = [
    '@echo off',
    // Kill app processes
    `taskkill /IM "${exeName}" >nul 2>&1`,
    'ping 127.0.0.1 -n 5 > nul',
    `taskkill /F /IM "${exeName}" >nul 2>&1`,
    'ping 127.0.0.1 -n 3 > nul',
    // Extract zip over install directory with retry for file locking
    'set /a tries=0',
    ':extract_retry',
    `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${installDir}' -Force" >nul 2>&1`,
    'if not errorlevel 1 goto extract_ok',
    'set /a tries+=1',
    'if %tries% GEQ 5 goto extract_fail',
    'ping 127.0.0.1 -n 3 > nul',
    'goto extract_retry',
    ':extract_ok',
    `start "" "${currentExe}"`,
    ':extract_fail',
    `del "${zipPath}" >nul 2>&1`,
    '(goto) 2>nul & del "%~f0"'
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
  const appNameNoExt = appName.replace(/\.app$/, '')
  const appParent = path.dirname(appBundle)
  const mountPoint = path.join(os.tmpdir(), 'claude-dock-dmg')
  const updateDir = path.join(os.tmpdir(), 'claude-dock-update')
  const updateLogPath = path.join(updateDir, 'update.log')

  // Determine install destination — if running from a read-only volume
  // (e.g. a mounted DMG or non-writable dir), install to /Applications instead
  let destParent = appParent
  let destBundle = appBundle
  try {
    fs.accessSync(appParent, fs.constants.W_OK)
  } catch {
    destParent = '/Applications'
    destBundle = path.join('/Applications', appName)
  }

  fs.mkdirSync(updateDir, { recursive: true })

  const scriptPath = path.join(updateDir, 'update.sh')
  const script = [
    '#!/bin/bash',
    `LOG="${updateLogPath}"`,
    'log() { echo "$(date +%H:%M:%S) $1" >> "$LOG" 2>&1; }',
    '',
    'log "=== Claude Dock macOS update ==="',
    `log "App bundle: ${appBundle}"`,
    `log "Dest bundle: ${destBundle}"`,
    `log "DMG path: ${dmgPath}"`,
    `log "PID: $$"`,
    '',
    // Wait for the Electron process to fully exit
    `log "Waiting for ${appNameNoExt} to exit..."`,
    `for i in $(seq 1 30); do`,
    `  if ! pgrep -x "${appNameNoExt}" >/dev/null 2>&1; then break; fi`,
    '  sleep 0.5',
    'done',
    // Force kill any remaining instances
    `pkill -9 -x "${appNameNoExt}" 2>/dev/null || true`,
    'sleep 1',
    '',
    // Remove quarantine from the downloaded DMG itself
    `xattr -d com.apple.quarantine "${dmgPath}" 2>/dev/null || true`,
    '',
    // Mount DMG — abort if this fails (don't delete the old app!)
    `mkdir -p "${mountPoint}"`,
    'log "Mounting DMG..."',
    `if ! hdiutil attach "${dmgPath}" -mountpoint "${mountPoint}" -nobrowse -quiet 2>>"$LOG"; then`,
    '  log "ERROR: Failed to mount DMG — aborting update"',
    `  open "${destBundle}" 2>/dev/null`,
    '  exit 1',
    'fi',
    '',
    // Find the .app inside the DMG (don't assume same name)
    'log "Listing DMG contents:"',
    `ls -la "${mountPoint}/" >> "$LOG" 2>&1`,
    `SRC_APP=$(find "${mountPoint}" -maxdepth 1 -name "*.app" -print -quit)`,
    'if [ -z "$SRC_APP" ]; then',
    '  log "ERROR: No .app found in DMG — aborting"',
    `  hdiutil detach "${mountPoint}" -quiet 2>/dev/null`,
    `  open "${destBundle}" 2>/dev/null`,
    '  exit 1',
    'fi',
    'log "Found app in DMG: $SRC_APP"',
    '',
    // Now safe to replace
    `log "Removing old app bundle..."`,
    `rm -rf "${destBundle}" 2>>"$LOG"`,
    `if [ -d "${destBundle}" ]; then`,
    '  log "ERROR: Failed to remove old app (permission denied?) — aborting"',
    `  hdiutil detach "${mountPoint}" -quiet 2>/dev/null`,
    '  exit 1',
    'fi',
    '',
    'log "Copying new app from DMG..."',
    `if ! cp -R "$SRC_APP" "${destParent}/" 2>>"$LOG"; then`,
    '  log "ERROR: Failed to copy new app — aborting"',
    `  hdiutil detach "${mountPoint}" -quiet 2>/dev/null`,
    '  exit 1',
    'fi',
    '',
    // Remove quarantine attribute so Gatekeeper doesn't block the updated app
    'log "Removing quarantine attribute..."',
    `xattr -cr "${destBundle}" 2>/dev/null || true`,
    '',
    'log "Unmounting DMG..."',
    `hdiutil detach "${mountPoint}" -quiet 2>/dev/null`,
    `rm -f "${dmgPath}"`,
    '',
    `log "Launching updated app..."`,
    `if ! open "${destBundle}" 2>>"$LOG"; then`,
    '  log "ERROR: Failed to launch app"',
    '  exit 1',
    'fi',
    'log "Update complete."',
    `rm -f "$0"`
  ].join('\n')

  fs.writeFileSync(scriptPath, script, { mode: 0o755 })

  // Use nohup to ensure the script survives parent exit, redirect to log
  const logFd = fs.openSync(updateLogPath, 'a')
  spawn('nohup', ['/bin/bash', scriptPath], {
    detached: true,
    stdio: ['ignore', logFd, logFd]
  }).unref()
  fs.closeSync(logFd)

  // Small delay so the child process fully forks before we exit
  setTimeout(() => app.quit(), 300)
}

function installLinux(newAppImage: string, currentExe: string): void {
  const exeBasename = path.basename(currentExe)
  const scriptPath = path.join(os.tmpdir(), 'claude-dock-update', 'update.sh')
  const script = [
    '#!/bin/bash',
    // Gracefully close ALL instances
    `pkill -f "${exeBasename}" 2>/dev/null || true`,
    'sleep 3',
    // Force kill any remaining instances
    `pkill -9 -f "${exeBasename}" 2>/dev/null || true`,
    'sleep 1',
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
