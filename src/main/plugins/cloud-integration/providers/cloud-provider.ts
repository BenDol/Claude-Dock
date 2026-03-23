/**
 * Abstract interface for cloud providers.
 * Each provider (GCP, AWS, Azure, DigitalOcean) implements this interface.
 * The plugin code only depends on this interface — never on a concrete provider.
 */

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

export interface CloudProvider {
  readonly id: CloudProviderId
  readonly name: string
  readonly consoleBaseUrl: string

  /** Get SVG icon markup for this provider */
  getIcon(): string

  /** Check if the provider's CLI is installed and authenticated */
  checkAuth(): Promise<boolean>

  /** Get info about the active project/account */
  getProject(): Promise<CloudProject>

  /** Get a summary of Kubernetes resources */
  getKubernetesSummary(): Promise<CloudKubernetesSummary>

  /** List all Kubernetes clusters */
  getClusters(): Promise<CloudCluster[]>

  /** Get detailed info for a specific cluster */
  getClusterDetail(clusterName: string): Promise<CloudClusterDetail>

  /** List workloads, optionally filtered by cluster */
  getWorkloads(clusterName?: string): Promise<CloudWorkload[]>

  /** Get detailed info for a specific workload */
  getWorkloadDetail(
    clusterName: string,
    namespace: string,
    workloadName: string,
    kind: string
  ): Promise<CloudWorkloadDetail>

  /** Get console URL for a specific section */
  getConsoleUrl(section: 'dashboard' | 'clusters' | 'workloads' | 'cluster' | 'workload', params?: Record<string, string>): string

  /** Get setup wizard status — steps, which are complete, etc. */
  getSetupStatus(): Promise<CloudSetupStatus>

  /** Re-authenticate with the provider (e.g. refresh expired tokens). Returns true on success. */
  reauthenticate(): Promise<boolean>

  /** Build provider info for the renderer */
  toInfo(available: boolean): CloudProviderInfo
}
