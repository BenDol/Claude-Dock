/**
 * AWS provider stub.
 * TODO: Implement using `aws` CLI (eks, etc.)
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
  CloudWorkloadDetail
} from '../../../../shared/cloud-types'

const AWS_ICON = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6.76 11.03l-.56 2.6h1.13l-.57-2.6zm7.76-.47v1.17c0 .56-.07 1.04-.07 1.04h.03s.24-.46.53-.78l1.09-1.27h1.27l-1.4 1.47 1.5 2.2h-1.3l-.94-1.47-.4.44v1.03H13.6v-4.6h1.17l-.25.77z" fill="#F90"/><path d="M7.83 6.97C4.4 8.66 2.17 11.46 2.17 12c0 1.88 4.4 5.03 9.83 5.03 2.38 0 4.57-.53 6.27-1.4" stroke="#F90" stroke-width="1.2" fill="none"/><path d="M18.73 15.2c1.17-.93 1.87-2.03 1.87-2.87 0-2.97-4.73-5.37-10.57-5.37-.9 0-1.77.07-2.6.17" stroke="#F90" stroke-width="1.2" fill="none"/></svg>`

export class AwsProvider implements CloudProvider {
  readonly id: CloudProviderId = 'aws'
  readonly name = 'Amazon Web Services'
  readonly consoleBaseUrl = 'https://console.aws.amazon.com'

  getIcon(): string {
    return AWS_ICON
  }

  async checkAuth(): Promise<boolean> {
    // TODO: Check `aws sts get-caller-identity`
    return false
  }

  async getProject(): Promise<CloudProject> {
    throw new Error('AWS provider not yet implemented')
  }

  async getKubernetesSummary(): Promise<CloudKubernetesSummary> {
    throw new Error('AWS provider not yet implemented')
  }

  async getClusters(): Promise<CloudCluster[]> {
    throw new Error('AWS provider not yet implemented')
  }

  async getClusterDetail(_clusterName: string): Promise<CloudClusterDetail> {
    throw new Error('AWS provider not yet implemented')
  }

  async getWorkloads(_clusterName?: string): Promise<CloudWorkload[]> {
    throw new Error('AWS provider not yet implemented')
  }

  async getWorkloadDetail(
    _clusterName: string,
    _namespace: string,
    _workloadName: string,
    _kind: string
  ): Promise<CloudWorkloadDetail> {
    throw new Error('AWS provider not yet implemented')
  }

  getConsoleUrl(
    section: 'dashboard' | 'clusters' | 'workloads' | 'cluster' | 'workload',
    _params?: Record<string, string>
  ): string {
    switch (section) {
      case 'dashboard':
        return `${this.consoleBaseUrl}/console/home`
      case 'clusters':
      case 'cluster':
        return `${this.consoleBaseUrl}/eks/home#/clusters`
      case 'workloads':
      case 'workload':
        return `${this.consoleBaseUrl}/eks/home#/workloads`
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
