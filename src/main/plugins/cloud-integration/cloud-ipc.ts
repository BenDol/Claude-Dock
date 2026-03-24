/**
 * IPC handler registration for the cloud-integration plugin.
 */

import { ipcMain } from 'electron'
import { IPC } from '../../../shared/ipc-channels'
import type { CloudProviderId, CloudProviderInfo, CloudDashboardData } from '../../../shared/cloud-types'
import { getProvider, getAllProviders } from './providers'
import { CloudWindowManager } from './cloud-window'
import { getServices } from './services'

const svc = () => getServices()

export function registerCloudIpc(): void {
  // Open the cloud integration window
  ipcMain.handle(IPC.CLOUD_OPEN, async (_e, projectDir: string) => {
    await CloudWindowManager.getInstance().open(projectDir)
  })

  // Get all available providers with auth status
  ipcMain.handle(IPC.CLOUD_GET_PROVIDERS, async (): Promise<CloudProviderInfo[]> => {
    const providers = getAllProviders()
    const results: CloudProviderInfo[] = []
    for (const p of providers) {
      try {
        const available = await p.checkAuth()
        results.push(p.toInfo(available))
      } catch (err) {
        svc().logError('[cloud-integration] checkAuth failed for ' + p.id, err)
        results.push(p.toInfo(false))
      }
    }
    return results
  })

  // Get the currently active provider
  ipcMain.handle(IPC.CLOUD_GET_ACTIVE_PROVIDER, async (_e, projectDir: string): Promise<CloudProviderInfo | null> => {
    const providerId = svc().getPluginSetting(projectDir, 'cloud-integration', 'provider') as CloudProviderId | undefined
    const id = providerId || 'gcp'
    const provider = getProvider(id)
    if (!provider) return null
    try {
      const available = await provider.checkAuth()
      return provider.toInfo(available)
    } catch {
      return provider.toInfo(false)
    }
  })

  // Set the active provider
  ipcMain.handle(IPC.CLOUD_SET_PROVIDER, async (_e, _projectDir: string, providerId: CloudProviderId) => {
    // Provider change is persisted via plugin settings on the renderer side
    const provider = getProvider(providerId)
    return provider ? provider.toInfo(await provider.checkAuth()) : null
  })

  // Get dashboard data
  ipcMain.handle(IPC.CLOUD_GET_DASHBOARD, async (_e, projectDir: string): Promise<CloudDashboardData | null> => {
    const provider = getActiveProvider(projectDir)
    if (!provider) return null

    try {
      const [project, kubernetes, available] = await Promise.all([
        provider.getProject(),
        provider.getKubernetesSummary(),
        provider.checkAuth()
      ])

      return {
        provider: provider.toInfo(available),
        project,
        kubernetes
      }
    } catch (err) {
      svc().logError('[cloud-integration] getDashboard failed', err)
      return null
    }
  })

  // Get clusters
  ipcMain.handle(IPC.CLOUD_GET_CLUSTERS, async (_e, projectDir: string) => {
    const provider = getActiveProvider(projectDir)
    if (!provider) return { data: [], error: 'No cloud provider configured' }
    try {
      return { data: await provider.getClusters() }
    } catch (err: any) {
      svc().logError('[cloud-integration] getClusters failed', err)
      return { data: [], error: err.message || 'Failed to fetch clusters', authExpired: !!err.authExpired }
    }
  })

  // Get cluster detail
  ipcMain.handle(IPC.CLOUD_GET_CLUSTER_DETAIL, async (_e, projectDir: string, clusterName: string) => {
    const provider = getActiveProvider(projectDir)
    if (!provider) return null
    try {
      return await provider.getClusterDetail(clusterName)
    } catch (err) {
      svc().logError('[cloud-integration] getClusterDetail failed', err)
      return null
    }
  })

  // Get workloads
  ipcMain.handle(IPC.CLOUD_GET_WORKLOADS, async (_e, projectDir: string, clusterName?: string) => {
    const provider = getActiveProvider(projectDir)
    if (!provider) return { data: [], error: 'No cloud provider configured' }
    try {
      return { data: await provider.getWorkloads(clusterName) }
    } catch (err: any) {
      svc().logError('[cloud-integration] getWorkloads failed', err)
      return { data: [], error: err.message || 'Failed to fetch workloads', authExpired: !!err.authExpired, resolution: err.resolution || undefined }
    }
  })

  // Get workload detail
  ipcMain.handle(
    IPC.CLOUD_GET_WORKLOAD_DETAIL,
    async (_e, projectDir: string, clusterName: string, namespace: string, workloadName: string, kind: string) => {
      const provider = getActiveProvider(projectDir)
      if (!provider) return null
      try {
        return await provider.getWorkloadDetail(clusterName, namespace, workloadName, kind)
      } catch (err) {
        svc().logError('[cloud-integration] getWorkloadDetail failed', err)
        return null
      }
    }
  )

  // Get console URL for a section
  ipcMain.handle(
    IPC.CLOUD_GET_CONSOLE_URL,
    async (_e, projectDir: string, section: string, params?: Record<string, string>) => {
      const provider = getActiveProvider(projectDir)
      if (!provider) return null
      return provider.getConsoleUrl(section as any, params)
    }
  )

  // Check authentication status
  ipcMain.handle(IPC.CLOUD_CHECK_AUTH, async (_e, projectDir: string) => {
    const provider = getActiveProvider(projectDir)
    if (!provider) return false
    try {
      return await provider.checkAuth()
    } catch {
      return false
    }
  })

  // Run a setup/auth command in the dock's shell panel
  ipcMain.handle(IPC.CLOUD_REAUTH, async (_e, projectDir: string, customCommand?: string) => {
    if (customCommand) {
      svc().log('[cloud-integration] reauth: running custom command:', customCommand, 'for', projectDir)
      return svc().runInDockShell(projectDir, customCommand)
    }
    const provider = getActiveProvider(projectDir)
    if (!provider) {
      svc().logError('[cloud-integration] reauth: no provider configured')
      return false
    }
    const command = provider.id === 'gcp' ? 'gcloud auth login'
      : provider.id === 'aws' ? 'aws sso login'
      : provider.id === 'azure' ? 'az login'
      : provider.id === 'digitalocean' ? 'doctl auth login'
      : null
    if (!command) {
      svc().logError('[cloud-integration] reauth: no auth command for provider', provider.id)
      return false
    }
    svc().log('[cloud-integration] reauth: running', command, 'for', projectDir)
    return svc().runInDockShell(projectDir, command)
  })

  // Get setup wizard status for a provider
  ipcMain.handle(IPC.CLOUD_GET_SETUP_STATUS, async (_e, projectDir: string, providerId?: string) => {
    const id = providerId || (svc().getPluginSetting(projectDir, 'cloud-integration', 'provider') as string) || 'gcp'
    const provider = getProvider(id as any)
    if (!provider) return null
    try {
      return await provider.getSetupStatus()
    } catch (err) {
      svc().logError('[cloud-integration] getSetupStatus failed', err)
      return null
    }
  })

  svc().log('[cloud-integration] IPC handlers registered')
}

export function disposeCloudIpc(): void {
  const channels = [
    IPC.CLOUD_OPEN,
    IPC.CLOUD_GET_PROVIDERS,
    IPC.CLOUD_GET_ACTIVE_PROVIDER,
    IPC.CLOUD_SET_PROVIDER,
    IPC.CLOUD_GET_DASHBOARD,
    IPC.CLOUD_GET_CLUSTERS,
    IPC.CLOUD_GET_CLUSTER_DETAIL,
    IPC.CLOUD_GET_WORKLOADS,
    IPC.CLOUD_GET_WORKLOAD_DETAIL,
    IPC.CLOUD_GET_CONSOLE_URL,
    IPC.CLOUD_CHECK_AUTH,
    IPC.CLOUD_REAUTH,
    IPC.CLOUD_GET_SETUP_STATUS
  ]
  for (const ch of channels) {
    try { ipcMain.removeHandler(ch) } catch { /* ignore */ }
  }
}

function getActiveProvider(projectDir: string) {
  const providerId = svc().getPluginSetting(projectDir, 'cloud-integration', 'provider') as CloudProviderId | undefined
  return getProvider(providerId || 'gcp')
}
