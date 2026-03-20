import { ipcMain } from 'electron'
import { IPC } from '../../../../shared/ipc-channels'
import { PrProviderRegistry } from './pr-provider-registry'
import { getServices } from '../services'
import type { PrState, PrCreateRequest } from '../../../../shared/pr-types'

const registry = PrProviderRegistry.getInstance()

export function registerPrIpc(): void {
  ipcMain.handle(IPC.PR_CHECK_AVAILABLE, async (_event, projectDir: string) => {
    const provider = await registry.resolve(projectDir)
    if (!provider) return false
    const available = await provider.isAvailable(projectDir)
    return available ? provider.providerKey : false
  })

  ipcMain.handle(IPC.PR_GET_SETUP_STATUS, async (_event, projectDir: string) => {
    const provider = await registry.resolve(projectDir)
    if (!provider) return { ready: false, providerName: 'Unknown', steps: [] }
    return provider.getSetupStatus(projectDir)
  })

  ipcMain.handle(IPC.PR_RUN_SETUP_ACTION, async (_event, projectDir: string, actionId: string, data?: Record<string, string>) => {
    const provider = await registry.resolve(projectDir)
    if (!provider) return { success: false, error: 'No PR provider' }
    return provider.runSetupAction(projectDir, actionId, data)
  })

  ipcMain.handle(IPC.PR_LIST, async (_event, projectDir: string, state?: PrState) => {
    const provider = await registry.resolve(projectDir)
    if (!provider) return []
    try {
      return await provider.listPrs(projectDir, state)
    } catch (err) {
      getServices().logError('[pr] listPrs failed:', err)
      return []
    }
  })

  ipcMain.handle(IPC.PR_GET, async (_event, projectDir: string, id: number) => {
    const provider = await registry.resolve(projectDir)
    if (!provider) return null
    return provider.getPr(projectDir, id)
  })

  ipcMain.handle(IPC.PR_CREATE, async (_event, projectDir: string, request: PrCreateRequest) => {
    const provider = await registry.resolve(projectDir)
    if (!provider) return { success: false, error: 'No PR provider available for this repository' }
    try {
      return await provider.createPr(projectDir, request)
    } catch (err) {
      getServices().logError('[pr] createPr failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Failed to create PR' }
    }
  })

  ipcMain.handle(IPC.PR_GET_DEFAULT_BRANCH, async (_event, projectDir: string) => {
    const provider = await registry.resolve(projectDir)
    if (!provider) return 'main'
    return provider.getDefaultBranch(projectDir)
  })

  ipcMain.handle(IPC.PR_GET_NEW_URL, async (_event, projectDir: string, sourceBranch: string, targetBranch: string) => {
    const provider = await registry.resolve(projectDir)
    if (!provider) return null
    return provider.getNewPrUrl(projectDir, sourceBranch, targetBranch)
  })

  getServices().log('[pr] IPC handlers registered')
}

export function disposePrIpc(): void {
  try { ipcMain.removeHandler(IPC.PR_CHECK_AVAILABLE) } catch { /* ok */ }
  try { ipcMain.removeHandler(IPC.PR_GET_SETUP_STATUS) } catch { /* ok */ }
  try { ipcMain.removeHandler(IPC.PR_RUN_SETUP_ACTION) } catch { /* ok */ }
  try { ipcMain.removeHandler(IPC.PR_LIST) } catch { /* ok */ }
  try { ipcMain.removeHandler(IPC.PR_GET) } catch { /* ok */ }
  try { ipcMain.removeHandler(IPC.PR_CREATE) } catch { /* ok */ }
  try { ipcMain.removeHandler(IPC.PR_GET_DEFAULT_BRANCH) } catch { /* ok */ }
  try { ipcMain.removeHandler(IPC.PR_GET_NEW_URL) } catch { /* ok */ }
}
