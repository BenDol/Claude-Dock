/**
 * DigitalOcean provider stub.
 * TODO: Implement using `doctl` CLI (kubernetes, etc.)
 */

import type { CloudProvider } from './cloud-provider'
import type {
  CloudProviderId,
  CloudProviderInfo,
  CloudProject,
  CloudKubernetesSummary,
  CloudCluster,
  CloudClusterDetail,
  CloudWorkload,
  CloudWorkloadDetail,
  CloudSetupStatus
} from '../../../../shared/cloud-types'

const DO_ICON = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 2C6.48 2 2 6.48 2 12c0 4.5 2.98 8.3 7.08 9.54v-3.72H7v-2.14h2.08v-1.53c0-2.2 1.13-3.37 3.1-3.37.93 0 1.44.07 1.68.1v1.93h-1.34c-.87 0-1.18.43-1.18 1.3v1.57h2.48l-.34 2.14h-2.14v3.75C18.88 20.47 22 16.59 22 12c0-5.52-4.48-10-10-10z" fill="#0080FF"/></svg>`

export class DigitalOceanProvider implements CloudProvider {
  readonly id: CloudProviderId = 'digitalocean'
  readonly name = 'DigitalOcean'
  readonly consoleBaseUrl = 'https://cloud.digitalocean.com'

  getIcon(): string {
    return DO_ICON
  }

  async checkAuth(): Promise<boolean> {
    // TODO: Check `doctl auth list`
    return false
  }

  async getProject(): Promise<CloudProject> {
    throw new Error('DigitalOcean provider not yet implemented')
  }

  async getKubernetesSummary(): Promise<CloudKubernetesSummary> {
    throw new Error('DigitalOcean provider not yet implemented')
  }

  async getClusters(): Promise<CloudCluster[]> {
    throw new Error('DigitalOcean provider not yet implemented')
  }

  async getClusterDetail(_clusterName: string): Promise<CloudClusterDetail> {
    throw new Error('DigitalOcean provider not yet implemented')
  }

  async getWorkloads(_clusterName?: string): Promise<CloudWorkload[]> {
    throw new Error('DigitalOcean provider not yet implemented')
  }

  async getWorkloadDetail(
    _clusterName: string,
    _namespace: string,
    _workloadName: string,
    _kind: string
  ): Promise<CloudWorkloadDetail> {
    throw new Error('DigitalOcean provider not yet implemented')
  }

  async getSetupStatus(): Promise<CloudSetupStatus> {
    return {
      providerId: this.id, providerName: this.name, icon: this.getIcon(),
      steps: [
        { id: 'install-cli', title: 'Install doctl', description: 'Download and install the DigitalOcean CLI (doctl).', command: 'https://docs.digitalocean.com/reference/doctl/how-to/install/', helpUrl: 'https://docs.digitalocean.com/reference/doctl/how-to/install/', helpLabel: 'Install doctl', verifiable: true },
        { id: 'authenticate', title: 'Authenticate with DigitalOcean', description: 'Create an API token and authenticate.', command: 'doctl auth init', helpUrl: 'https://docs.digitalocean.com/reference/doctl/reference/auth/', helpLabel: 'Auth docs', verifiable: true },
        { id: 'install-kubectl', title: 'Install kubectl', description: 'Install kubectl and connect to your cluster.', command: 'doctl kubernetes cluster kubeconfig save CLUSTER_NAME', helpUrl: 'https://docs.digitalocean.com/products/kubernetes/how-to/connect-to-cluster/', helpLabel: 'Connect to cluster', verifiable: true }
      ],
      currentStep: 0, complete: false
    }
  }

  getConsoleUrl(
    section: 'dashboard' | 'clusters' | 'workloads' | 'cluster' | 'workload',
    _params?: Record<string, string>
  ): string {
    switch (section) {
      case 'dashboard':
        return `${this.consoleBaseUrl}/projects`
      case 'clusters':
      case 'cluster':
        return `${this.consoleBaseUrl}/kubernetes/clusters`
      case 'workloads':
      case 'workload':
        return `${this.consoleBaseUrl}/kubernetes/clusters`
    }
  }

  toInfo(available: boolean): CloudProviderInfo {
    return {
      id: this.id,
      name: this.name,
      icon: this.getIcon(),
      available,
      consoleBaseUrl: this.consoleBaseUrl
    }
  }
}
