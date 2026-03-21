import type { DockPlugin } from '../plugin'
import type { PluginEventBus } from '../plugin-events'
import type { PluginSettingDef } from '../../../shared/plugin-types'
import { registerCloudIpc, disposeCloudIpc } from './cloud-ipc'
import { CloudWindowManager } from './cloud-window'
import { getServices } from './services'

// Re-export setServices so standalone builds can receive service injection from the host app
export { setServices } from './services'

export class CloudIntegrationPlugin implements DockPlugin {
  readonly id = 'cloud-integration'
  readonly name = 'Cloud Integration'
  readonly description = 'Dashboard for cloud providers (GCP, AWS, Azure, DigitalOcean) with Kubernetes cluster and workload management'
  readonly defaultEnabled = false
  get version(): string {
    try { return require('electron').app.getVersion() } catch { return '0.0.0' }
  }
  readonly lazyLoad = true
  readonly settingsSchema: PluginSettingDef[] = [
    {
      key: 'provider',
      label: 'Cloud provider (gcp, aws, azure, digitalocean)',
      type: 'string',
      defaultValue: 'gcp'
    }
  ]

  register(bus: PluginEventBus): void {
    registerCloudIpc()

    bus.on('project:postClose', this.id, ({ projectDir }) => {
      CloudWindowManager.getInstance().close(projectDir)
    })

    bus.on('plugin:disabled', this.id, ({ projectDir, pluginId }) => {
      if (pluginId === this.id) {
        CloudWindowManager.getInstance().close(projectDir)
      }
    })

    getServices().log('[cloud-integration] plugin registered')
  }

  dispose(): void {
    disposeCloudIpc()
    CloudWindowManager.getInstance().closeAll()
  }
}
