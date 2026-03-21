import React, { useState, useEffect, useCallback } from 'react'
import { getDockApi } from '../../../lib/ipc-bridge'
import { useSettingsStore } from '../../../stores/settings-store'
import { applyThemeToDocument } from '../../../lib/theme'
import type { CloudPage, CloudProviderInfo } from '../../../../../shared/cloud-types'
import Sidebar from './components/Sidebar'
import Dashboard from './components/Dashboard'
import KubernetesPage from './components/KubernetesPage'
import ClusterDetailPage from './components/ClusterDetailPage'
import WorkloadDetailPage from './components/WorkloadDetailPage'
import './cloud-styles.css'

const searchParams = new URLSearchParams(window.location.search)
const projectDir = decodeURIComponent(searchParams.get('projectDir') || '')

export default function CloudApp() {
  const loadSettings = useSettingsStore((s) => s.load)
  const [page, setPage] = useState<CloudPage>({ view: 'dashboard' })
  const [provider, setProvider] = useState<CloudProviderInfo | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadSettings().then(() => {
      applyThemeToDocument(useSettingsStore.getState().settings)
    })
  }, [loadSettings])

  const loadProvider = useCallback(async () => {
    try {
      const p = await getDockApi().cloudIntegration.getActiveProvider(projectDir)
      setProvider(p)
    } catch { /* ignore */ }
    setLoading(false)
  }, [])

  useEffect(() => {
    loadProvider()
  }, [loadProvider])

  const navigate = useCallback((p: CloudPage) => setPage(p), [])

  const openConsole = useCallback(async (section: string, params?: Record<string, string>) => {
    const url = await getDockApi().cloudIntegration.getConsoleUrl(projectDir, section, params)
    if (url) getDockApi().app.openExternal(url)
  }, [])

  if (loading) {
    return <div className="cloud-app cloud-loading">Loading cloud integration...</div>
  }

  return (
    <div className="cloud-app">
      <div className="cloud-titlebar" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
        <span className="cloud-titlebar-title">
          {provider ? provider.name : 'Cloud Integration'}
        </span>
        <div className="cloud-titlebar-buttons" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <button onClick={() => getDockApi().win.minimize()} className="cloud-titlebar-btn">&#x2500;</button>
          <button onClick={() => getDockApi().win.maximize()} className="cloud-titlebar-btn">&#x25A1;</button>
          <button onClick={() => getDockApi().win.close()} className="cloud-titlebar-btn cloud-titlebar-close">&#x2715;</button>
        </div>
      </div>
      <div className="cloud-body">
        <Sidebar currentPage={page} onNavigate={navigate} provider={provider} />
        <div className="cloud-content">
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
