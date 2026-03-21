/**
 * Azure provider stub.
 * TODO: Implement using `az` CLI (aks, etc.)
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

const AZURE_ICON = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9.1 3.7L3 13.5l3.8 6.8h14.7L13.3 3.7H9.1z" fill="#0089D6"/><path d="M12.4 6.8L8.6 13l4.4 7.3H6.8L3 13.5 12.4 6.8z" fill="#0078D4"/><path d="M12.4 6.8L21.5 20.3h-8.5L8.6 13l3.8-6.2z" fill="#5EA0EF"/></svg>`

export class AzureProvider implements CloudProvider {
  readonly id: CloudProviderId = 'azure'
  readonly name = 'Microsoft Azure'
  readonly consoleBaseUrl = 'https://portal.azure.com'

  getIcon(): string {
    return AZURE_ICON
  }

  async checkAuth(): Promise<boolean> {
    // TODO: Check `az account show`
    return false
  }

  async getProject(): Promise<CloudProject> {
    throw new Error('Azure provider not yet implemented')
  }

  async getKubernetesSummary(): Promise<CloudKubernetesSummary> {
    throw new Error('Azure provider not yet implemented')
  }

  async getClusters(): Promise<CloudCluster[]> {
    throw new Error('Azure provider not yet implemented')
  }

  async getClusterDetail(_clusterName: string): Promise<CloudClusterDetail> {
    throw new Error('Azure provider not yet implemented')
  }

  async getWorkloads(_clusterName?: string): Promise<CloudWorkload[]> {
    throw new Error('Azure provider not yet implemented')
  }

  async getWorkloadDetail(
    _clusterName: string,
    _namespace: string,
    _workloadName: string,
    _kind: string
  ): Promise<CloudWorkloadDetail> {
    throw new Error('Azure provider not yet implemented')
  }

  async getSetupStatus(): Promise<CloudSetupStatus> {
    return {
      providerId: this.id, providerName: this.name, icon: this.getIcon(),
      steps: [
        { id: 'install-cli', title: 'Install Azure CLI', description: 'Download and install the Azure CLI.', command: 'https://aka.ms/installazurecliwindows', helpUrl: 'https://learn.microsoft.com/en-us/cli/azure/install-azure-cli', helpLabel: 'Install Azure CLI', verifiable: true },
        { id: 'login', title: 'Sign in to Azure', description: 'Authenticate with your Azure account.', command: 'az login', helpUrl: 'https://learn.microsoft.com/en-us/cli/azure/authenticate-azure-cli', helpLabel: 'Authentication docs', verifiable: true },
        { id: 'install-kubectl', title: 'Install kubectl', description: 'Install kubectl for AKS cluster management.', command: 'az aks install-cli', helpUrl: 'https://learn.microsoft.com/en-us/azure/aks/learn/quick-kubernetes-deploy-cli', helpLabel: 'AKS quickstart', verifiable: true }
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
        return `${this.consoleBaseUrl}/#home`
      case 'clusters':
      case 'cluster':
        return `${this.consoleBaseUrl}/#browse/Microsoft.ContainerService%2FmanagedClusters`
      case 'workloads':
      case 'workload':
        return `${this.consoleBaseUrl}/#browse/Microsoft.ContainerService%2FmanagedClusters`
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
