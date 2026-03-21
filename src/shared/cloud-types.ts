/**
 * Shared types for the cloud-integration plugin.
 * Used by main process, preload, and renderer.
 */

// ── Cloud Providers ──────────────────────────────────────────────────────────

export type CloudProviderId = 'gcp' | 'aws' | 'azure' | 'digitalocean'

export interface CloudProviderInfo {
  id: CloudProviderId
  name: string
  /** SVG icon markup */
  icon: string
  /** Whether the provider's CLI is installed and authenticated */
  available: boolean
  /** Base URL for the web console */
  consoleBaseUrl: string
}

// ── Dashboard ────────────────────────────────────────────────────────────────

export interface CloudDashboardData {
  provider: CloudProviderInfo
  project: CloudProject
  kubernetes: CloudKubernetesSummary
}

export interface CloudProject {
  id: string
  name: string
  region?: string
}

export interface CloudKubernetesSummary {
  clusterCount: number
  totalNodes: number
  totalPods: number
  healthyClusters: number
  unhealthyClusters: number
}

// ── Kubernetes: Clusters ─────────────────────────────────────────────────────

export type ClusterStatus = 'RUNNING' | 'PROVISIONING' | 'STOPPING' | 'ERROR' | 'DEGRADED' | 'UNKNOWN'

export interface CloudCluster {
  name: string
  status: ClusterStatus
  location: string
  nodeCount: number
  version: string
  endpoint?: string
  createdAt: string
  /** Provider-specific console URL for this cluster */
  consoleUrl: string
}

export interface CloudClusterDetail extends CloudCluster {
  nodes: CloudNode[]
  namespaces: string[]
  totalPods: number
  /** CPU/memory if available */
  resourceUsage?: {
    cpuRequested: string
    cpuCapacity: string
    memoryRequested: string
    memoryCapacity: string
  }
}

export interface CloudNode {
  name: string
  status: 'Ready' | 'NotReady' | 'Unknown'
  machineType: string
  zone: string
  podCount: number
  version: string
}

// ── Kubernetes: Workloads ────────────────────────────────────────────────────

export type WorkloadKind = 'Deployment' | 'StatefulSet' | 'DaemonSet' | 'Job' | 'CronJob' | 'ReplicaSet'
export type WorkloadStatus = 'Active' | 'Progressing' | 'Degraded' | 'Failed' | 'Completed' | 'Suspended' | 'Unknown'

export interface CloudWorkload {
  name: string
  namespace: string
  kind: WorkloadKind
  status: WorkloadStatus
  clusterName: string
  readyReplicas: number
  desiredReplicas: number
  createdAt: string
  images: string[]
  /** Provider-specific console URL */
  consoleUrl: string
}

export interface CloudWorkloadDetail extends CloudWorkload {
  pods: CloudPod[]
  labels: Record<string, string>
  annotations: Record<string, string>
  strategy?: string
  conditions: WorkloadCondition[]
}

export interface CloudPod {
  name: string
  namespace: string
  status: 'Running' | 'Pending' | 'Succeeded' | 'Failed' | 'Unknown' | 'CrashLoopBackOff' | 'Terminating'
  restarts: number
  age: string
  node: string
  ip?: string
  containers: CloudContainer[]
}

export interface CloudContainer {
  name: string
  image: string
  status: 'Running' | 'Waiting' | 'Terminated'
  ready: boolean
  restarts: number
  reason?: string
}

export interface WorkloadCondition {
  type: string
  status: 'True' | 'False' | 'Unknown'
  reason?: string
  message?: string
  lastTransition: string
}

// ── Navigation ───────────────────────────────────────────────────────────────

export type CloudPage =
  | { view: 'dashboard' }
  | { view: 'kubernetes'; tab: 'overview' | 'clusters' | 'workloads' }
  | { view: 'cluster-detail'; clusterName: string }
  | { view: 'workload-detail'; clusterName: string; namespace: string; workloadName: string; kind: WorkloadKind }

// ── Settings ─────────────────────────────────────────────────────────────────

export interface CloudIntegrationSettings {
  provider: CloudProviderId
  gcpProjectId?: string
  awsRegion?: string
  azureSubscriptionId?: string
  digitaloceanToken?: string
}
