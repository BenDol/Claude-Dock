import React, { useEffect, useState, useRef, useCallback } from 'react'
import { getDockApi } from '../lib/ipc-bridge'
import PluginPanel from './PluginPanel'

const ZOOM_MIN = 0.5
const ZOOM_MAX = 2.0
const ZOOM_STEP = 0.1

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
type GitPhase = 'checking' | 'not-installed' | 'installing' | 'installed' | 'skipped' | 'error'
type ClaudePhase = 'checking' | 'not-installed' | 'installing' | 'installed' | 'skipped' | 'error'

const CLAUDE_DOCS_URL = 'https://code.claude.com/docs/en/overview'

type ClonePhase = 'idle' | 'input' | 'cloning' | 'error'

const Launcher: React.FC = () => {
  const [recentPaths, setRecentPaths] = useState<RecentPath[]>([])
  const [loading, setLoading] = useState(true)
  const [pluginPanelPath, setPluginPanelPath] = useState<string | null>(null)
  const [pluginSetupPath, setPluginSetupPath] = useState<string | null>(null)

  // Auto-open from taskbar jump list (--launch flag)
  const [autoOpenDir] = useState<string | null>(() => {
    const p = new URLSearchParams(window.location.search)
    const v = p.get('autoOpen')
    return v ? decodeURIComponent(v) : null
  })

  // Clone state
  const [clonePhase, setClonePhase] = useState<ClonePhase>('idle')
  const [cloneUrl, setCloneUrl] = useState('')
  const [cloneDest, setCloneDest] = useState('')
  const [cloneError, setCloneError] = useState('')
  const cloneInputRef = useRef<HTMLInputElement>(null)

  // Updater state
  const [updatePhase, setUpdatePhase] = useState<UpdatePhase>('checking')
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  const [downloadProgress, setDownloadProgress] = useState({ downloaded: 0, total: 0 })
  const [updateError, setUpdateError] = useState('')
  const progressCleanup = useRef<(() => void) | null>(null)
  const [autoUpdating, setAutoUpdating] = useState(false)
  const [waitingForIdle, setWaitingForIdle] = useState(false)

  // Telemetry consent
  const [telemetryPhase, setTelemetryPhase] = useState<'checking' | 'prompt' | 'resolved'>('checking')

  // Git install state
  const [gitPhase, setGitPhase] = useState<GitPhase>('checking')
  const [gitError, setGitError] = useState('')
  const gitFreshlyInstalled = useRef(false)

  // Claude CLI install state (starts as 'checking' but won't actually check until git resolves)
  const [claudePhase, setClaudePhase] = useState<ClaudePhase>('checking')
  const [claudeError, setClaudeError] = useState('')
  const [claudeVersion, setClaudeVersion] = useState('')

  // PATH check state (runs after Claude is detected/installed)
  const [pathPrompt, setPathPrompt] = useState<{ claudeDir: string } | null>(null)
  const [pathFixing, setPathFixing] = useState(false)
  const [pathFixResult, setPathFixResult] = useState<{ success: boolean; file?: string; error?: string } | null>(null)

  const autoUpdateRef = useRef(false)

  useEffect(() => {
    const api = getDockApi()

    // Start update check (skip if another instance is already installing)
    const doUpdateCheck = () => {
      api.settings.get().then((settings) => {
        const profile = settings.updater?.profile || 'latest'
        autoUpdateRef.current = __DEV__ ? false : (settings.updater?.autoUpdate ?? false)
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
    }

    api.updater.isLocked().then((locked) => {
      if (locked) {
        setUpdatePhase('skipped')
      } else {
        doUpdateCheck()
      }
    }).catch(() => {
      doUpdateCheck()
    })

    // Check telemetry consent
    api.settings.get().then((settings) => {
      if (settings.telemetry?.consentGiven) {
        setTelemetryPhase('resolved')
      } else {
        setTelemetryPhase('prompt')
      }
    }).catch(() => setTelemetryPhase('resolved'))

    // Check Git first (Claude check happens after git resolves via second useEffect)
    api.git.check()
      .then((status) => {
        setGitPhase(status.installed ? 'installed' : 'not-installed')
      })
      .catch(() => {
        setGitPhase('installed') // assume installed on error
      })

    api.app.getRecentPaths().then((paths) => {
      setRecentPaths(paths)
      setLoading(false)
    })

    return () => {
      progressCleanup.current?.()
    }
  }, [])

  // Auto-update: when update is available and autoUpdate is enabled, start automatically
  useEffect(() => {
    if (updatePhase === 'available' && autoUpdateRef.current && updateInfo) {
      setAutoUpdating(true)
      startDownload()
    }
    if (updatePhase === 'error' && autoUpdating) {
      setAutoUpdating(false)
    }
  }, [updatePhase])

  // Auto-update: when download completes, install automatically — but only if
  // no dock windows have recently active terminals (avoids killing active Claude sessions).
  // Terminals idle for >2 minutes won't block the update.
  useEffect(() => {
    if (updatePhase !== 'ready' || !autoUpdating) return

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const tryInstall = async () => {
      if (cancelled) return
      try {
        const active = await getDockApi().updater.hasActiveTerminals()
        if (cancelled) return
        if (!active) {
          setWaitingForIdle(false)
          doInstall()
        } else {
          // Terminals are active — wait and retry
          setWaitingForIdle(true)
          timer = setTimeout(tryInstall, 30_000)
        }
      } catch {
        // On error, install anyway (don't block updates indefinitely)
        if (!cancelled) { setWaitingForIdle(false); doInstall() }
      }
    }
    tryInstall()

    return () => {
      cancelled = true
      setWaitingForIdle(false)
      if (timer) clearTimeout(timer)
    }
  }, [updatePhase, autoUpdating])

  // When git is resolved (installed or skipped), trigger Claude CLI check
  useEffect(() => {
    if (gitPhase !== 'installed' && gitPhase !== 'skipped') return

    const api = getDockApi()
    setClaudePhase('checking')
    api.claude.checkInstall()
      .then((status) => {
        setClaudePhase(status.installed ? 'skipped' : 'not-installed')
        if (status.version) setClaudeVersion(status.version)
      })
      .catch(() => {
        setClaudePhase('skipped')
      })
  }, [gitPhase])

  // After Claude is resolved, check if claude is in shell PATH (macOS/Linux only)
  useEffect(() => {
    if (claudePhase !== 'installed' && claudePhase !== 'skipped') return
    // Only relevant when Claude IS installed but might not be in PATH
    if (claudePhase === 'installed' || claudePhase === 'skipped') {
      const api = getDockApi()
      api.settings.get().then((settings) => {
        if (settings.launcher?.skipPathPrompt) return
        api.claude.checkPath().then((status) => {
          if (!status.inPath && status.claudeDir) {
            setPathPrompt({ claudeDir: status.claudeDir })
          }
        }).catch(() => { /* ignore */ })
      }).catch(() => { /* ignore */ })
    }
  }, [claudePhase])

  // Zoom: Ctrl+Scroll, Ctrl++/-, Ctrl+0 to reset
  const applyZoom = useCallback((newZoom: number) => {
    const api = getDockApi()
    const clamped = Math.round(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, newZoom)) * 100) / 100
    api.launcher.setZoom(clamped)
    api.settings.get().then((s) => {
      api.settings.set({ launcher: { ...s.launcher, zoom: clamped } })
    })
  }, [])

  useEffect(() => {
    const handleWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      const api = getDockApi()
      const current = api.launcher.getZoom()
      const delta = e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP
      applyZoom(current + delta)
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.shiftKey || e.altKey) return
      const api = getDockApi()
      if (e.key === '=' || e.key === '+') {
        e.preventDefault()
        applyZoom(api.launcher.getZoom() + ZOOM_STEP)
      } else if (e.key === '-') {
        e.preventDefault()
        applyZoom(api.launcher.getZoom() - ZOOM_STEP)
      } else if (e.key === '0') {
        e.preventDefault()
        applyZoom(1.0)
      }
    }

    window.addEventListener('wheel', handleWheel, { passive: false })
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('wheel', handleWheel)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [applyZoom])

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

  const doInstall = async () => {
    if (autoOpenDir) {
      try { await getDockApi().updater.savePendingProject(autoOpenDir) } catch { /* best-effort */ }
    }
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

  const startGitInstall = async () => {
    setGitPhase('installing')
    setGitError('')
    try {
      const result = await getDockApi().git.install()
      if (result.success) {
        gitFreshlyInstalled.current = true
        setGitPhase('installed')
      } else {
        setGitError(result.error || 'Installation failed')
        setGitPhase('error')
      }
    } catch {
      setGitError('Installation failed unexpectedly')
      setGitPhase('error')
    }
  }

  const skipGitInstall = () => {
    setGitPhase('skipped')
  }

  const retryGitCheck = async () => {
    setGitPhase('checking')
    setGitError('')
    try {
      const status = await getDockApi().git.check()
      setGitPhase(status.installed ? 'installed' : 'not-installed')
    } catch {
      setGitPhase('installed')
    }
  }

  const startClaudeInstall = async () => {
    setClaudePhase('installing')
    setClaudeError('')
    try {
      const result = await getDockApi().claude.install()
      if (result.success) {
        setClaudePhase('installed')
      } else {
        setClaudeError(result.error || 'Installation failed')
        setClaudePhase('error')
      }
    } catch {
      setClaudeError('Installation failed unexpectedly')
      setClaudePhase('error')
    }
  }

  const skipClaudeInstall = () => {
    setClaudePhase('skipped')
  }

  const openClaudeDocs = () => {
    getDockApi().app.openExternal(CLAUDE_DOCS_URL)
  }

  const retryClaudeCheck = async () => {
    setClaudePhase('checking')
    setClaudeError('')
    try {
      const status = await getDockApi().claude.checkInstall()
      setClaudePhase(status.installed ? 'skipped' : 'not-installed')
    } catch {
      setClaudePhase('skipped')
    }
  }

  const handleFixPath = async () => {
    if (!pathPrompt) return
    setPathFixing(true)
    try {
      const result = await getDockApi().claude.fixPath(pathPrompt.claudeDir)
      setPathFixResult(result)
      if (result.success) {
        // Auto-dismiss after a moment
        setTimeout(() => { setPathPrompt(null); setPathFixResult(null) }, 3000)
      }
    } catch {
      setPathFixResult({ success: false, error: 'Unexpected error' })
    }
    setPathFixing(false)
  }

  const handleSkipPathFix = async () => {
    const api = getDockApi()
    const settings = await api.settings.get()
    await api.settings.set({ launcher: { ...settings.launcher, skipPathPrompt: true } })
    setPathPrompt(null)
  }

  const openPath = async (dir: string) => {
    const api = getDockApi()
    const configured = await api.plugins.isConfigured(dir)
    if (!configured) {
      setPluginSetupPath(dir)
      return
    }
    api.app.openDockPath(dir)
  }

  const finishPluginSetup = async () => {
    if (!pluginSetupPath) return
    const api = getDockApi()
    await api.plugins.markConfigured(pluginSetupPath)
    const dir = pluginSetupPath
    setPluginSetupPath(null)
    api.app.openDockPath(dir)
  }

  const browsePath = async () => {
    const dir = await getDockApi().app.pickDirectory()
    if (dir) {
      openPath(dir)
    }
  }

  const openCloneModal = () => {
    setCloneUrl('')
    setCloneDest('')
    setCloneError('')
    setClonePhase('input')
    setTimeout(() => cloneInputRef.current?.focus(), 50)
  }

  const pickCloneDest = async () => {
    const dir = await getDockApi().app.pickDirectory()
    if (dir) setCloneDest(dir)
  }

  const startClone = async () => {
    if (!cloneUrl.trim() || !cloneDest.trim()) return
    setClonePhase('cloning')
    setCloneError('')
    try {
      const result = await getDockApi().git.clone(cloneUrl.trim(), cloneDest.trim())
      if (result.success && result.clonedPath) {
        setClonePhase('idle')
        openPath(result.clonedPath)
      } else {
        setCloneError(result.error || 'Clone failed')
        setClonePhase('error')
      }
    } catch (err) {
      setCloneError(err instanceof Error ? err.message : 'Clone failed')
      setClonePhase('error')
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
  const showGitBanner = gitPhase !== 'installed' && gitPhase !== 'skipped'
  const showClaudeBanner = claudePhase !== 'skipped'

  const updateBlocking = autoOpenDir
    ? (updatePhase === 'checking' || updatePhase === 'available' || updatePhase === 'downloading' || updatePhase === 'ready')
    : autoUpdating

  const isBlocked = gitPhase === 'checking' || gitPhase === 'not-installed' || gitPhase === 'installing'
    || claudePhase === 'checking' || claudePhase === 'not-installed' || claudePhase === 'installing'
    || updateBlocking

  // Auto-open project from taskbar jump list once checks finish
  const autoOpenFired = useRef(false)
  useEffect(() => {
    if (autoOpenDir && !isBlocked && !loading && !autoOpenFired.current) {
      autoOpenFired.current = true
      openPath(autoOpenDir)
    }
  }, [isBlocked, loading, autoOpenDir])

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
          {claudeVersion && <p className="launcher-cli-version">{claudeVersion}</p>}
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
                  {autoUpdating ? (
                    <button className="updater-btn updater-btn-secondary" onClick={() => { setAutoUpdating(false); skipUpdate() }}>
                      Cancel
                    </button>
                  ) : (
                    <>
                      <button className="updater-btn updater-btn-primary" onClick={startDownload}>
                        Download & Update
                      </button>
                      <button className="updater-btn updater-btn-secondary" onClick={skipUpdate}>
                        {autoOpenDir ? 'Remind Me Later' : 'Skip'}
                      </button>
                    </>
                  )}
                </div>
              </>
            )}

            {updatePhase === 'downloading' && (
              <>
                <div className="updater-row">
                  <span className="updater-text">
                    {autoUpdating ? 'Automatically updating' : 'Downloading update'}... {progressPercent}%
                    <span className="updater-size">
                      {formatBytes(downloadProgress.downloaded)} / {formatBytes(downloadProgress.total)}
                    </span>
                  </span>
                </div>
                <div className="updater-progress-track">
                  <div className="updater-progress-bar" style={{ width: `${progressPercent}%` }} />
                </div>
                {autoUpdating && (
                  <div className="updater-actions">
                    <button className="updater-btn updater-btn-secondary" onClick={() => { setAutoUpdating(false); skipUpdate() }}>
                      Cancel
                    </button>
                  </div>
                )}
              </>
            )}

            {updatePhase === 'ready' && (
              <>
                <div className="updater-row">
                  <svg className="updater-icon updater-icon-success" width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M8 16A8 8 0 108 0a8 8 0 000 16zm3.78-9.72a.75.75 0 00-1.06-1.06L6.75 9.19 5.28 7.72a.75.75 0 00-1.06 1.06l2 2a.75.75 0 001.06 0l4.5-4.5z" />
                  </svg>
                  <span className="updater-text">
                    {autoUpdating
                      ? (waitingForIdle ? 'Waiting for terminals to go idle...' : 'Installing update...')
                      : 'Download complete. Ready to install.'}
                  </span>
                </div>
                <div className="updater-actions">
                  {autoUpdating ? (
                    <button className="updater-btn updater-btn-secondary" onClick={() => { setAutoUpdating(false); skipUpdate() }}>
                      Cancel
                    </button>
                  ) : (
                    <>
                      <button className="updater-btn updater-btn-primary" onClick={doInstall}>
                        Install & Restart
                      </button>
                      <button className="updater-btn updater-btn-secondary" onClick={skipUpdate}>
                        {autoOpenDir ? 'Remind Me Later' : 'Later'}
                      </button>
                    </>
                  )}
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

        {telemetryPhase === 'prompt' && (
          <div className="claude-setup-banner">
            <div className="updater-row">
              <svg className="updater-icon" width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 16A8 8 0 108 0a8 8 0 000 16zm.93-9.412l-1 4.705c-.07.34.029.533.304.533.194 0 .487-.07.686-.246l-.088.416c-.287.346-.92.598-1.465.598-.703 0-1.002-.422-.808-1.319l.738-3.468c.064-.293.006-.399-.287-.399l-.353.001.082-.382 2.17-.477h.015zM8 5.5a1 1 0 110-2 1 1 0 010 2z" />
              </svg>
              <span className="updater-text"><strong>Help Improve Claude Dock</strong></span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', padding: '4px 0 8px 22px', lineHeight: 1.5 }}>
              Share anonymous usage data to help improve Claude Dock.<br />
              <strong>Collected:</strong> session duration, feature usage flags, crash counts, OS platform.<br />
              <strong>Never collected:</strong> terminal content, file names, git data, IP addresses, or anything identifying.<br />
              You can opt out anytime in Settings.
            </div>
            <div className="updater-actions">
              <button className="updater-btn updater-btn-primary" onClick={() => {
                getDockApi().telemetry.setConsent(true)
                setTelemetryPhase('resolved')
              }}>
                Yes, Share Data
              </button>
              <button className="updater-btn updater-btn-secondary" onClick={() => {
                getDockApi().telemetry.setConsent(false)
                setTelemetryPhase('resolved')
              }}>
                No Thanks
              </button>
            </div>
          </div>
        )}

        {showGitBanner && (
          <div className="claude-setup-banner">
            {gitPhase === 'checking' && (
              <div className="updater-row">
                <div className="updater-spinner" />
                <span className="updater-text">Checking for Git...</span>
              </div>
            )}

            {gitPhase === 'not-installed' && (
              <>
                <div className="updater-row">
                  <svg className="updater-icon claude-setup-icon-warn" width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M8.22 1.754a.25.25 0 00-.44 0L1.698 13.132a.25.25 0 00.22.368h12.164a.25.25 0 00.22-.368L8.22 1.754zm-1.763-.707c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0114.082 15H1.918a1.75 1.75 0 01-1.543-2.575L6.457 1.047zM9 11a1 1 0 11-2 0 1 1 0 012 0zm-.25-5.25a.75.75 0 00-1.5 0v2.5a.75.75 0 001.5 0v-2.5z" />
                  </svg>
                  <span className="updater-text">
                    <strong>Git</strong> is not installed. It is required for Claude Code to work.
                  </span>
                </div>
                <div className="updater-actions">
                  <button className="updater-btn updater-btn-primary" onClick={startGitInstall}>
                    Install
                  </button>
                  <button className="updater-btn updater-btn-secondary" onClick={skipGitInstall}>
                    Skip
                  </button>
                </div>
              </>
            )}

            {gitPhase === 'installing' && (
              <div className="updater-row">
                <div className="updater-spinner" />
                <span className="updater-text">Installing Git — close the terminal window when finished.</span>
              </div>
            )}

            {gitPhase === 'error' && (
              <>
                <div className="updater-row">
                  <svg className="updater-icon updater-icon-error" width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M2.343 13.657A8 8 0 1113.657 2.343 8 8 0 012.343 13.657zM6.03 4.97a.75.75 0 00-1.06 1.06L6.94 8 4.97 9.97a.75.75 0 101.06 1.06L8 9.06l1.97 1.97a.75.75 0 101.06-1.06L9.06 8l1.97-1.97a.75.75 0 10-1.06-1.06L8 6.94 6.03 4.97z" />
                  </svg>
                  <span className="updater-text updater-text-error">
                    {gitError || 'Git installation failed'}
                  </span>
                </div>
                <div className="updater-actions">
                  <button className="updater-btn updater-btn-secondary" onClick={retryGitCheck}>
                    Retry
                  </button>
                  <button className="updater-btn updater-btn-secondary" onClick={skipGitInstall}>
                    Dismiss
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {showClaudeBanner && (
          <div className="claude-setup-banner">
            {claudePhase === 'checking' && (
              <div className="updater-row">
                <div className="updater-spinner" />
                <span className="updater-text">Checking for Claude CLI...</span>
              </div>
            )}

            {claudePhase === 'not-installed' && (
              <>
                <div className="updater-row">
                  <svg className="updater-icon claude-setup-icon-warn" width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M8.22 1.754a.25.25 0 00-.44 0L1.698 13.132a.25.25 0 00.22.368h12.164a.25.25 0 00.22-.368L8.22 1.754zm-1.763-.707c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0114.082 15H1.918a1.75 1.75 0 01-1.543-2.575L6.457 1.047zM9 11a1 1 0 11-2 0 1 1 0 012 0zm-.25-5.25a.75.75 0 00-1.5 0v2.5a.75.75 0 001.5 0v-2.5z" />
                  </svg>
                  <span className="updater-text">
                    <strong>Claude CLI</strong> is not installed. It is required for terminals to work.
                  </span>
                </div>
                <div className="updater-actions">
                  <button className="updater-btn updater-btn-primary" onClick={startClaudeInstall}>
                    Install
                  </button>
                  <button className="updater-btn updater-btn-secondary" onClick={openClaudeDocs}>
                    View Docs
                  </button>
                  <button className="updater-btn updater-btn-secondary" onClick={skipClaudeInstall}>
                    Skip
                  </button>
                </div>
              </>
            )}

            {claudePhase === 'installing' && (
              <div className="updater-row">
                <div className="updater-spinner" />
                <span className="updater-text">Installing Claude CLI — this may take a moment...</span>
              </div>
            )}

            {claudePhase === 'installed' && (
              <>
                <div className="updater-row">
                  <svg className="updater-icon updater-icon-success" width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M8 16A8 8 0 108 0a8 8 0 000 16zm3.78-9.72a.75.75 0 00-1.06-1.06L6.75 9.19 5.28 7.72a.75.75 0 00-1.06 1.06l2 2a.75.75 0 001.06 0l4.5-4.5z" />
                  </svg>
                  <span className="updater-text">Claude CLI installed successfully!</span>
                </div>
                <div className="updater-actions">
                  <button className="updater-btn updater-btn-secondary" onClick={skipClaudeInstall}>
                    Dismiss
                  </button>
                </div>
              </>
            )}

            {claudePhase === 'error' && gitFreshlyInstalled.current && (
              <>
                <div className="updater-row">
                  <svg className="updater-icon claude-setup-icon-warn" width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M8.22 1.754a.25.25 0 00-.44 0L1.698 13.132a.25.25 0 00.22.368h12.164a.25.25 0 00.22-.368L8.22 1.754zm-1.763-.707c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0114.082 15H1.918a1.75 1.75 0 01-1.543-2.575L6.457 1.047zM9 11a1 1 0 11-2 0 1 1 0 012 0zm-.25-5.25a.75.75 0 00-1.5 0v2.5a.75.75 0 001.5 0v-2.5z" />
                  </svg>
                  <span className="updater-text">
                    A restart is needed after installing Git for Claude CLI to install properly.
                  </span>
                </div>
                <div className="updater-actions">
                  <button className="updater-btn updater-btn-primary" onClick={() => getDockApi().app.relaunch()}>
                    Restart
                  </button>
                  <button className="updater-btn updater-btn-secondary" onClick={skipClaudeInstall}>
                    Dismiss
                  </button>
                </div>
              </>
            )}

            {claudePhase === 'error' && !gitFreshlyInstalled.current && (
              <>
                <div className="updater-row">
                  <svg className="updater-icon updater-icon-error" width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M2.343 13.657A8 8 0 1113.657 2.343 8 8 0 012.343 13.657zM6.03 4.97a.75.75 0 00-1.06 1.06L6.94 8 4.97 9.97a.75.75 0 101.06 1.06L8 9.06l1.97 1.97a.75.75 0 101.06-1.06L9.06 8l1.97-1.97a.75.75 0 10-1.06-1.06L8 6.94 6.03 4.97z" />
                  </svg>
                  <span className="updater-text updater-text-error">
                    {claudeError || 'Claude CLI installation failed'}
                  </span>
                </div>
                <div className="updater-actions">
                  <button className="updater-btn updater-btn-primary" onClick={openClaudeDocs}>
                    Install Manually
                  </button>
                  <button className="updater-btn updater-btn-secondary" onClick={() => getDockApi().debug.openLogs()}>
                    Open Log
                  </button>
                  <button className="updater-btn updater-btn-secondary" onClick={retryClaudeCheck}>
                    Retry
                  </button>
                  <button className="updater-btn updater-btn-secondary" onClick={skipClaudeInstall}>
                    Dismiss
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {pathPrompt && (
          <div className="claude-setup-banner">
            {pathFixResult?.success ? (
              <div className="updater-row">
                <svg className="updater-icon updater-icon-success" width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 16A8 8 0 108 0a8 8 0 000 16zm3.78-9.72a.75.75 0 00-1.06-1.06L6.75 9.19 5.28 7.72a.75.75 0 00-1.06 1.06l2 2a.75.75 0 001.06 0l4.5-4.5z" />
                </svg>
                <span className="updater-text">
                  PATH updated{pathFixResult.file ? ` in ${pathFixResult.file}` : ''}
                </span>
              </div>
            ) : pathFixResult?.error ? (
              <>
                <div className="updater-row">
                  <svg className="updater-icon updater-icon-error" width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M2.343 13.657A8 8 0 1113.657 2.343 8 8 0 012.343 13.657zM6.03 4.97a.75.75 0 00-1.06 1.06L6.94 8 4.97 9.97a.75.75 0 101.06 1.06L8 9.06l1.97 1.97a.75.75 0 101.06-1.06L9.06 8l1.97-1.97a.75.75 0 10-1.06-1.06L8 6.94 6.03 4.97z" />
                  </svg>
                  <span className="updater-text updater-text-error">{pathFixResult.error}</span>
                </div>
                <div className="updater-actions">
                  <button className="updater-btn updater-btn-secondary" onClick={() => { setPathPrompt(null); setPathFixResult(null) }}>
                    Dismiss
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="updater-row">
                  <svg className="updater-icon claude-setup-icon-warn" width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M8.22 1.754a.25.25 0 00-.44 0L1.698 13.132a.25.25 0 00.22.368h12.164a.25.25 0 00.22-.368L8.22 1.754zm-1.763-.707c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0114.082 15H1.918a1.75 1.75 0 01-1.543-2.575L6.457 1.047zM9 11a1 1 0 11-2 0 1 1 0 012 0zm-.25-5.25a.75.75 0 00-1.5 0v2.5a.75.75 0 001.5 0v-2.5z" />
                  </svg>
                  <span className="updater-text">
                    <strong>Claude CLI</strong> is not in your shell PATH. Add <code>{pathPrompt.claudeDir}</code> to PATH?
                  </span>
                </div>
                <div className="updater-actions">
                  <button className="updater-btn updater-btn-primary" onClick={handleFixPath} disabled={pathFixing}>
                    {pathFixing ? 'Adding...' : 'Yes, fix PATH'}
                  </button>
                  <button className="updater-btn updater-btn-secondary" onClick={handleSkipPathFix} disabled={pathFixing}>
                    No, don&#39;t ask again
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {recentPaths.length > 0 ? (
          <div className="launcher-list">
            {recentPaths.map((entry) => (
              <div key={entry.path} className="launcher-item-wrapper">
                <button
                  className="launcher-item"
                  onClick={() => openPath(entry.path)}
                  disabled={isBlocked}
                >
                  <div className="launcher-item-icon">
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M1.5 1h5l1 1H14.5a.5.5 0 01.5.5v11a.5.5 0 01-.5.5h-13a.5.5 0 01-.5-.5v-12A.5.5 0 011.5 1z" />
                    </svg>
                  </div>
                  <div className="launcher-item-info">
                    <span className="launcher-item-name">{entry.name}</span>
                    <span className="launcher-item-path" title={entry.path}>{entry.path}</span>
                  </div>
                  <span className="launcher-item-time">{formatTime(entry.lastOpened)}</span>
                  <button
                    className="launcher-item-plugins"
                    onClick={(e) => {
                      e.stopPropagation()
                      setPluginPanelPath(pluginPanelPath === entry.path ? null : entry.path)
                    }}
                    title="Plugins"
                  >
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M9.405 1.05c-.413-1.4-2.397-1.4-2.81 0l-.1.34a1.464 1.464 0 01-2.105.872l-.31-.17c-1.283-.698-2.686.705-1.987 1.987l.169.311c.446.82.023 1.841-.872 2.105l-.34.1c-1.4.413-1.4 2.397 0 2.81l.34.1a1.464 1.464 0 01.872 2.105l-.17.31c-.698 1.283.705 2.686 1.987 1.987l.311-.169a1.464 1.464 0 012.105.872l.1.34c.413 1.4 2.397 1.4 2.81 0l.1-.34a1.464 1.464 0 012.105-.872l.31.17c1.283.698 2.686-.705 1.987-1.987l-.169-.311a1.464 1.464 0 01.872-2.105l.34-.1c1.4-.413 1.4-2.397 0-2.81l-.34-.1a1.464 1.464 0 01-.872-2.105l.17-.31c.698-1.283-.705-2.686-1.987-1.987l-.311.169a1.464 1.464 0 01-2.105-.872l-.1-.34zM8 10.93a2.929 2.929 0 110-5.86 2.929 2.929 0 010 5.858z" />
                    </svg>
                  </button>
                  <button
                    className="launcher-item-remove"
                    onClick={(e) => removePath(e, entry.path)}
                    title="Remove from recent"
                  >
                    &times;
                  </button>
                </button>
                {pluginPanelPath === entry.path && (
                  <div className="launcher-plugin-panel">
                    <PluginPanel projectDir={entry.path} />
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="launcher-empty">
            <p className="launcher-empty-text">No recent projects</p>
            <p className="launcher-empty-hint">Open a folder to get started</p>
          </div>
        )}
        <div className="launcher-footer">
          <button
            className="launcher-browse-btn"
            onClick={browsePath}
            disabled={isBlocked}
          >
            Browse Folder...
          </button>
          <button
            className="launcher-clone-btn"
            onClick={openCloneModal}
            disabled={isBlocked}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style={{ marginRight: 5, verticalAlign: -2 }}>
              <path d="M2 2.5A2.5 2.5 0 014.5 0h8.75a.75.75 0 01.75.75v12.5a.75.75 0 01-.75.75h-2.5a.75.75 0 010-1.5h1.75v-2h-8a1 1 0 00-.714 1.7.75.75 0 01-1.072 1.05A2.495 2.495 0 012 11.5v-9zm10.5-1h-8a1 1 0 00-1 1v6.708A2.486 2.486 0 014.5 9h8V1.5zm-8 11a1 1 0 100-2 1 1 0 000 2z" />
            </svg>
            Clone Repository...
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

      {pluginSetupPath && (
        <div className="modal-overlay" onClick={() => setPluginSetupPath(null)}>
          <div className="plugin-setup-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="plugin-setup-title">Plugin Setup</h3>
            <p className="plugin-setup-subtitle">
              Enable plugins for <strong>{pluginSetupPath.split(/[/\\]/).pop()}</strong>
            </p>
            <div className="plugin-setup-body">
              <PluginPanel projectDir={pluginSetupPath} />
            </div>
            <div className="plugin-setup-footer">
              <button className="plugin-setup-done" onClick={finishPluginSetup}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {clonePhase !== 'idle' && (
        <div className="modal-overlay" onClick={() => clonePhase !== 'cloning' && setClonePhase('idle')}>
          <div className="clone-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="clone-modal-title">Clone Repository</h3>
            <div className="clone-modal-body">
              <label className="clone-field">
                <span className="clone-label">Repository URL</span>
                <input
                  ref={cloneInputRef}
                  type="text"
                  className="clone-input"
                  value={cloneUrl}
                  onChange={(e) => setCloneUrl(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && cloneDest) startClone() }}
                  placeholder="https://github.com/user/repo.git"
                  disabled={clonePhase === 'cloning'}
                />
              </label>
              <label className="clone-field">
                <span className="clone-label">Clone into</span>
                <div className="clone-dest-row">
                  <input
                    type="text"
                    className="clone-input clone-dest-input"
                    value={cloneDest}
                    onChange={(e) => setCloneDest(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && cloneUrl.trim()) startClone() }}
                    placeholder="Select destination folder..."
                    disabled={clonePhase === 'cloning'}
                  />
                  <button
                    className="clone-browse-btn"
                    onClick={pickCloneDest}
                    disabled={clonePhase === 'cloning'}
                  >
                    Browse
                  </button>
                </div>
              </label>
              {clonePhase === 'cloning' && (
                <div className="clone-progress">
                  <div className="updater-spinner" />
                  <span>Cloning repository...</span>
                </div>
              )}
              {clonePhase === 'error' && (
                <div className="clone-error">{cloneError}</div>
              )}
            </div>
            <div className="clone-modal-footer">
              <button
                className="clone-submit-btn"
                onClick={startClone}
                disabled={clonePhase === 'cloning' || !cloneUrl.trim() || !cloneDest.trim()}
              >
                {clonePhase === 'cloning' ? 'Cloning...' : 'Clone'}
              </button>
              <button
                className="clone-cancel-btn"
                onClick={() => setClonePhase('idle')}
                disabled={clonePhase === 'cloning'}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

declare const __DEV__: boolean

export default Launcher
