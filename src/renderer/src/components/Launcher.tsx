import React, { useEffect, useState, useRef } from 'react'
import { getDockApi } from '../lib/ipc-bridge'

interface RecentPath {
  path: string
  name: string
  lastOpened: number
}

interface UpdateInfo {
  available: boolean
  version: string
  releaseNotes: string
  downloadUrl: string
  assetName: string
  assetSize: number
}

type UpdatePhase = 'checking' | 'available' | 'downloading' | 'ready' | 'skipped' | 'error'

const Launcher: React.FC = () => {
  const [recentPaths, setRecentPaths] = useState<RecentPath[]>([])
  const [loading, setLoading] = useState(true)

  // Updater state
  const [updatePhase, setUpdatePhase] = useState<UpdatePhase>('checking')
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  const [downloadProgress, setDownloadProgress] = useState({ downloaded: 0, total: 0 })
  const [updateError, setUpdateError] = useState('')
  const progressCleanup = useRef<(() => void) | null>(null)

  useEffect(() => {
    const api = getDockApi()

    // Start update check, then load recent paths
    api.settings.get().then((settings) => {
      const profile = settings.updater?.profile || 'latest'
      api.updater
        .check(profile)
        .then((info) => {
          setUpdateInfo(info)
          setUpdatePhase(info.available ? 'available' : 'skipped')
        })
        .catch(() => {
          setUpdatePhase('skipped')
        })
    }).catch(() => {
      setUpdatePhase('skipped')
    })

    api.app.getRecentPaths().then((paths) => {
      setRecentPaths(paths)
      setLoading(false)
    })

    return () => {
      progressCleanup.current?.()
    }
  }, [])

  const startDownload = async () => {
    if (!updateInfo) return
    const api = getDockApi()

    setUpdatePhase('downloading')
    setDownloadProgress({ downloaded: 0, total: updateInfo.assetSize })

    // Listen for progress events
    progressCleanup.current = api.updater.onProgress((downloaded, total) => {
      setDownloadProgress({ downloaded, total })
    })

    try {
      await api.updater.download(updateInfo.downloadUrl, updateInfo.assetName)
      progressCleanup.current?.()
      progressCleanup.current = null
      setUpdatePhase('ready')
    } catch (err) {
      progressCleanup.current?.()
      progressCleanup.current = null
      setUpdateError(err instanceof Error ? err.message : 'Download failed')
      setUpdatePhase('error')
    }
  }

  const doInstall = () => {
    getDockApi().updater.install().catch(() => {
      setUpdateError('Failed to install update')
      setUpdatePhase('error')
    })
  }

  const skipUpdate = () => {
    setUpdatePhase('skipped')
  }

  const retryCheck = async () => {
    setUpdatePhase('checking')
    setUpdateError('')
    try {
      const settings = await getDockApi().settings.get()
      const profile = settings.updater?.profile || 'latest'
      const info = await getDockApi().updater.check(profile)
      setUpdateInfo(info)
      setUpdatePhase(info.available ? 'available' : 'skipped')
    } catch {
      setUpdatePhase('skipped')
    }
  }

  const openPath = (dir: string) => {
    getDockApi().app.openDockPath(dir)
  }

  const browsePath = async () => {
    const dir = await getDockApi().app.pickDirectory()
    if (dir) {
      getDockApi().app.openDockPath(dir)
    }
  }

  const removePath = async (e: React.MouseEvent, dir: string) => {
    e.stopPropagation()
    await getDockApi().app.removeRecentPath(dir)
    setRecentPaths((prev) => prev.filter((p) => p.path !== dir))
  }

  const formatTime = (ts: number) => {
    const diff = Date.now() - ts
    const mins = Math.floor(diff / 60000)
    if (mins < 1) return 'Just now'
    if (mins < 60) return `${mins}m ago`
    const hours = Math.floor(mins / 60)
    if (hours < 24) return `${hours}h ago`
    const days = Math.floor(hours / 24)
    if (days < 30) return `${days}d ago`
    return new Date(ts).toLocaleDateString()
  }

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
  }

  const progressPercent = downloadProgress.total > 0
    ? Math.round((downloadProgress.downloaded / downloadProgress.total) * 100)
    : 0

  const showUpdateBanner = updatePhase !== 'skipped'

  if (loading && updatePhase === 'checking') {
    return (
      <div className="launcher">
        <div className="launcher-titlebar">
          <div className="launcher-titlebar-drag" />
          <div className="launcher-win-controls">
            <button className="win-btn win-close" onClick={() => getDockApi().win.close()}>&times;</button>
          </div>
        </div>
        <div className="loading">
          <div className="terminal-spinner" />
        </div>
      </div>
    )
  }

  return (
    <div className="launcher">
      <div className="launcher-titlebar">
        <div className="launcher-titlebar-drag" />
        <div className="launcher-win-controls">
          <button className="win-btn" onClick={() => getDockApi().win.minimize()}>&#x2013;</button>
          <button className="win-btn win-close" onClick={() => getDockApi().win.close()}>&times;</button>
        </div>
      </div>
      <div className="launcher-content">
        <div className="launcher-header">
          <h1 className="launcher-title">Claude Dock</h1>
          <p className="launcher-subtitle">Select a project to open</p>
        </div>

        {showUpdateBanner && (
          <div className="updater-banner">
            {updatePhase === 'checking' && (
              <div className="updater-row">
                <div className="updater-spinner" />
                <span className="updater-text">Checking for updates...</span>
              </div>
            )}

            {updatePhase === 'available' && updateInfo && (
              <>
                <div className="updater-row">
                  <svg className="updater-icon" width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM0 8a8 8 0 1116 0A8 8 0 010 8zm6.5-.25A.75.75 0 017.25 7h1a.75.75 0 01.75.75v2.75h.25a.75.75 0 010 1.5h-2a.75.75 0 010-1.5h.25v-2h-.25a.75.75 0 01-.75-.75zM8 6a1 1 0 100-2 1 1 0 000 2z" />
                  </svg>
                  <span className="updater-text">
                    Update available: <strong>{updateInfo.version}</strong>
                    <span className="updater-size">({formatBytes(updateInfo.assetSize)})</span>
                  </span>
                </div>
                <div className="updater-actions">
                  <button className="updater-btn updater-btn-primary" onClick={startDownload}>
                    Download & Update
                  </button>
                  <button className="updater-btn updater-btn-secondary" onClick={skipUpdate}>
                    Skip
                  </button>
                </div>
              </>
            )}

            {updatePhase === 'downloading' && (
              <>
                <div className="updater-row">
                  <span className="updater-text">
                    Downloading update... {progressPercent}%
                    <span className="updater-size">
                      {formatBytes(downloadProgress.downloaded)} / {formatBytes(downloadProgress.total)}
                    </span>
                  </span>
                </div>
                <div className="updater-progress-track">
                  <div className="updater-progress-bar" style={{ width: `${progressPercent}%` }} />
                </div>
              </>
            )}

            {updatePhase === 'ready' && (
              <>
                <div className="updater-row">
                  <svg className="updater-icon updater-icon-success" width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M8 16A8 8 0 108 0a8 8 0 000 16zm3.78-9.72a.75.75 0 00-1.06-1.06L6.75 9.19 5.28 7.72a.75.75 0 00-1.06 1.06l2 2a.75.75 0 001.06 0l4.5-4.5z" />
                  </svg>
                  <span className="updater-text">Download complete. Ready to install.</span>
                </div>
                <div className="updater-actions">
                  <button className="updater-btn updater-btn-primary" onClick={doInstall}>
                    Install & Restart
                  </button>
                  <button className="updater-btn updater-btn-secondary" onClick={skipUpdate}>
                    Later
                  </button>
                </div>
              </>
            )}

            {updatePhase === 'error' && (
              <>
                <div className="updater-row">
                  <svg className="updater-icon updater-icon-error" width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M2.343 13.657A8 8 0 1113.657 2.343 8 8 0 012.343 13.657zM6.03 4.97a.75.75 0 00-1.06 1.06L6.94 8 4.97 9.97a.75.75 0 101.06 1.06L8 9.06l1.97 1.97a.75.75 0 101.06-1.06L9.06 8l1.97-1.97a.75.75 0 10-1.06-1.06L8 6.94 6.03 4.97z" />
                  </svg>
                  <span className="updater-text updater-text-error">
                    {updateError || 'Update check failed'}
                  </span>
                </div>
                <div className="updater-actions">
                  <button className="updater-btn updater-btn-secondary" onClick={retryCheck}>
                    Retry
                  </button>
                  <button className="updater-btn updater-btn-secondary" onClick={skipUpdate}>
                    Dismiss
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        <div className="launcher-list">
          {recentPaths.map((entry) => (
            <button
              key={entry.path}
              className="launcher-item"
              onClick={() => openPath(entry.path)}
            >
              <div className="launcher-item-icon">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M1.5 1h5l1 1H14.5a.5.5 0 01.5.5v11a.5.5 0 01-.5.5h-13a.5.5 0 01-.5-.5v-12A.5.5 0 011.5 1z" />
                </svg>
              </div>
              <div className="launcher-item-info">
                <span className="launcher-item-name">{entry.name}</span>
                <span className="launcher-item-path">{entry.path}</span>
              </div>
              <span className="launcher-item-time">{formatTime(entry.lastOpened)}</span>
              <button
                className="launcher-item-remove"
                onClick={(e) => removePath(e, entry.path)}
                title="Remove from recent"
              >
                &times;
              </button>
            </button>
          ))}
        </div>
        <div className="launcher-footer">
          <button className="launcher-browse-btn" onClick={browsePath}>
            Browse Folder...
          </button>
        </div>
      </div>
      <div className="launcher-bottom-bar">
        <span className="launcher-author">
          By{' '}
          <a className="footer-link" onClick={() => getDockApi().app.openExternal('https://github.com/BenDol')}>
            Ben Dol
          </a>
        </span>
        <a className="launcher-sponsor-btn" onClick={() => getDockApi().app.openExternal('https://github.com/sponsors/BenDol')}>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M4.25 2.5c-1.336 0-2.75 1.164-2.75 3 0 2.15 1.58 4.144 3.365 5.682A20.6 20.6 0 008 13.393a20.6 20.6 0 003.135-2.211C12.92 9.644 14.5 7.65 14.5 5.5c0-1.836-1.414-3-2.75-3-1.373 0-2.609.986-3.029 2.456a.749.749 0 01-1.442 0C6.859 3.486 5.623 2.5 4.25 2.5z" /></svg>
          {' '}Sponsor
        </a>
      </div>
    </div>
  )
}

export default Launcher
