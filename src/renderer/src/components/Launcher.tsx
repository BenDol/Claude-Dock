import React, { useEffect, useState } from 'react'
import { getDockApi } from '../lib/ipc-bridge'

interface RecentPath {
  path: string
  name: string
  lastOpened: number
}

const Launcher: React.FC = () => {
  const [recentPaths, setRecentPaths] = useState<RecentPath[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getDockApi()
      .app.getRecentPaths()
      .then((paths) => {
        setRecentPaths(paths)
        setLoading(false)
      })
  }, [])

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

  if (loading) {
    return (
      <div className="launcher">
        <div className="launcher-titlebar">
          <div className="launcher-titlebar-drag" />
          <div className="launcher-win-controls">
            <button className="win-btn win-close" onClick={() => getDockApi().win.close()}>&times;</button>
          </div>
        </div>
        <div className="loading">Loading...</div>
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
    </div>
  )
}

export default Launcher
