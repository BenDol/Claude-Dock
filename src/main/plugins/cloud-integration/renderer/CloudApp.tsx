import React, { useState, useEffect, useCallback } from 'react'
import { getDockApi } from '@dock-renderer/lib/ipc-bridge'
import { useSettingsStore } from '@dock-renderer/stores/settings-store'
import { applyThemeToDocument } from '@dock-renderer/lib/theme'
import type { CloudPage, CloudProviderInfo, CloudProviderId } from '../../../../shared/cloud-types'
import Sidebar from './components/Sidebar'
import Dashboard from './components/Dashboard'
import KubernetesPage from './components/KubernetesPage'
import ClusterDetailPage from './components/ClusterDetailPage'
import WorkloadDetailPage from './components/WorkloadDetailPage'
import SetupWizard from './components/SetupWizard'
import './cloud-styles.css'

const searchParams = new URLSearchParams(window.location.search)
const projectDir = decodeURIComponent(searchParams.get('projectDir') || '')

const PROVIDERS: { id: CloudProviderId; label: string }[] = [
  { id: 'gcp', label: 'Google Cloud' },
  { id: 'aws', label: 'AWS' },
  { id: 'azure', label: 'Azure' },
  { id: 'digitalocean', label: 'DigitalOcean' }
]

export default function CloudApp() {
  const loadSettings = useSettingsStore((s) => s.load)
  const [page, setPage] = useState<CloudPage>({ view: 'dashboard' })
  const [provider, setProvider] = useState<CloudProviderInfo | null>(null)
  const [allProviders, setAllProviders] = useState<CloudProviderInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [providerDropdownOpen, setProviderDropdownOpen] = useState(false)
  const [needsSetup, setNeedsSetup] = useState(false)

  useEffect(() => {
    loadSettings().then(() => {
      applyThemeToDocument(useSettingsStore.getState().settings)
    })
  }, [loadSettings])

  // Block Ctrl+A from selecting all page text (browser default)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'a' && !e.shiftKey && !e.altKey) {
        const tag = (e.target as HTMLElement)?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA') return
        e.preventDefault()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Zoom: Ctrl+MouseWheel and Ctrl++/- with persistence
  useEffect(() => {
    const ZOOM_KEY = 'cloud-zoom'
    const MIN_ZOOM = 0.5
    const MAX_ZOOM = 2.0
    const STEP = 0.1

    const saved = localStorage.getItem(ZOOM_KEY)
    let zoom = saved ? parseFloat(saved) : 1
    if (isNaN(zoom) || zoom < MIN_ZOOM || zoom > MAX_ZOOM) zoom = 1
    document.documentElement.style.zoom = String(zoom)

    const applyZoom = (z: number) => {
      zoom = Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z)) * 100) / 100
      document.documentElement.style.zoom = String(zoom)
      localStorage.setItem(ZOOM_KEY, String(zoom))
    }

    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      applyZoom(zoom + (e.deltaY < 0 ? STEP : -STEP))
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.ctrlKey) return
      if (e.key === '=' || e.key === '+') { e.preventDefault(); applyZoom(zoom + STEP) }
      else if (e.key === '-') { e.preventDefault(); applyZoom(zoom - STEP) }
      else if (e.key === '0') { e.preventDefault(); applyZoom(1) }
    }

    window.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('wheel', onWheel)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  // Esc to hide: close/hide the window when Escape is pressed and no dropdown is open
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (document.querySelector('.cloud-dropdown-backdrop')) return
      getDockApi().win.close()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const loadProvider = useCallback(async () => {
    try {
      const api = getDockApi()
      const [active, all] = await Promise.all([
        api.cloudIntegration.getActiveProvider(projectDir),
        api.cloudIntegration.getProviders()
      ])
      setProvider(active)
      setAllProviders(all)

      // Check if setup is needed
      if (active && !active.available) {
        setNeedsSetup(true)
        setPage({ view: 'setup' })
      }
    } catch { /* ignore */ }
    setLoading(false)
  }, [])

  useEffect(() => {
    loadProvider()
  }, [loadProvider])

  const switchProvider = useCallback(async (id: CloudProviderId) => {
    setProviderDropdownOpen(false)
    setLoading(true)
    try {
      const api = getDockApi()
      await api.plugins.setSetting(projectDir, 'cloud-integration', 'provider', id)
      const newProvider = await api.cloudIntegration.getActiveProvider(projectDir)
      setProvider(newProvider)

      if (newProvider && !newProvider.available) {
        setNeedsSetup(true)
        setPage({ view: 'setup' })
      } else {
        setNeedsSetup(false)
        setPage({ view: 'dashboard' })
      }
    } catch { /* ignore */ }
    setLoading(false)
  }, [])

  const navigate = useCallback((p: CloudPage) => {
    setPage(p)
  }, [])

  const onSetupComplete = useCallback(() => {
    setNeedsSetup(false)
    setPage({ view: 'dashboard' })
    loadProvider()
  }, [loadProvider])

  const openConsole = useCallback(async (section: string, params?: Record<string, string>) => {
    const url = await getDockApi().cloudIntegration.getConsoleUrl(projectDir, section, params)
    if (url) getDockApi().app.openExternal(url)
  }, [])

  const api = getDockApi()

  if (loading) {
    return <div className="cloud-app cloud-loading">Loading cloud integration...</div>
  }

  return (
    <div className="cloud-app">
      {/* ── Titlebar (matches git-manager pattern) ── */}
      <div className="cloud-titlebar" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
        <div className="cloud-titlebar-left" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          {provider && (
            <span className="cloud-provider-icon-small" dangerouslySetInnerHTML={{ __html: provider.icon }} />
          )}
          <div className="cloud-provider-select-wrap">
            <button
              className="cloud-provider-select-btn"
              onClick={() => setProviderDropdownOpen(!providerDropdownOpen)}
            >
              {provider ? PROVIDERS.find((p) => p.id === provider.id)?.label || provider.name : 'Select Provider'}
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M6 9l6 6 6-6"/></svg>
            </button>
            {providerDropdownOpen && (
              <>
                <div className="cloud-dropdown-backdrop" onClick={() => setProviderDropdownOpen(false)} />
                <div className="cloud-provider-dropdown">
                  {PROVIDERS.map((p) => {
                    const info = allProviders.find((ap) => ap.id === p.id)
                    const isActive = provider?.id === p.id
                    return (
                      <button
                        key={p.id}
                        className={`cloud-provider-dropdown-item ${isActive ? 'active' : ''}`}
                        onClick={() => switchProvider(p.id)}
                      >
                        {info && <span className="cloud-provider-dropdown-icon" dangerouslySetInnerHTML={{ __html: info.icon }} />}
                        <span className="cloud-provider-dropdown-label">{p.label}</span>
                        {info && (
                          <span className={`cloud-provider-dropdown-status ${info.available ? 'connected' : ''}`}>
                            {info.available ? 'Ready' : 'Setup needed'}
                          </span>
                        )}
                        {isActive && <span className="cloud-provider-dropdown-check">&#10003;</span>}
                      </button>
                    )
                  })}
                </div>
              </>
            )}
          </div>
        </div>

        <div className="cloud-titlebar-center" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties} />

        <div className="cloud-win-controls" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <button className="win-btn win-minimize" onClick={() => api.win.minimize()}>&#x2015;</button>
          <button className="win-btn win-maximize" onClick={() => api.win.maximize()}>&#9744;</button>
          <button className="win-btn win-close" onClick={() => api.win.close()}>&#10005;</button>
        </div>
      </div>

      {/* ── Body ── */}
      <div className="cloud-body">
        <Sidebar
          currentPage={page}
          onNavigate={navigate}
          provider={provider}
          needsSetup={needsSetup}
        />
        <div className="cloud-content">
          {page.view === 'setup' && (
            <SetupWizard
              projectDir={projectDir}
              providerId={provider?.id || 'gcp'}
              onComplete={onSetupComplete}
            />
          )}
          {page.view === 'dashboard' && (
            <Dashboard projectDir={projectDir} provider={provider} onNavigate={navigate} onOpenConsole={openConsole} />
          )}
          {page.view === 'kubernetes' && (
            <KubernetesPage
              projectDir={projectDir}
              tab={page.tab}
              onNavigate={navigate}
              onOpenConsole={openConsole}
            />
          )}
          {page.view === 'cluster-detail' && (
            <ClusterDetailPage
              projectDir={projectDir}
              clusterName={page.clusterName}
              onNavigate={navigate}
              onOpenConsole={openConsole}
            />
          )}
          {page.view === 'workload-detail' && (
            <WorkloadDetailPage
              projectDir={projectDir}
              clusterName={page.clusterName}
              namespace={page.namespace}
              workloadName={page.workloadName}
              kind={page.kind}
              onNavigate={navigate}
              onOpenConsole={openConsole}
            />
          )}
        </div>
      </div>
    </div>
  )
}
