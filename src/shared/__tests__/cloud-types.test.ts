import { describe, it, expect } from 'vitest'
import type {
  CloudProviderId,
  CloudProviderInfo,
  CloudDashboardData,
  CloudProject,
  CloudKubernetesSummary,
  CloudCluster,
  CloudClusterDetail,
  CloudWorkload,
  CloudWorkloadDetail,
  CloudPod,
  CloudContainer,
  CloudNode,
  WorkloadCondition,
  ClusterStatus,
  WorkloadStatus,
  WorkloadKind,
  CloudPage,
  CloudIntegrationSettings
} from '../cloud-types'

describe('Cloud Types (type safety)', () => {
  it('CloudProviderId should accept valid provider IDs', () => {
    const ids: CloudProviderId[] = ['gcp', 'aws', 'azure', 'digitalocean']
    expect(ids).toHaveLength(4)
  })

  it('ClusterStatus should have expected values', () => {
    const statuses: ClusterStatus[] = ['RUNNING', 'PROVISIONING', 'STOPPING', 'ERROR', 'DEGRADED', 'UNKNOWN']
    expect(statuses).toHaveLength(6)
  })

  it('WorkloadStatus should have expected values', () => {
    const statuses: WorkloadStatus[] = ['Active', 'Progressing', 'Degraded', 'Failed', 'Completed', 'Suspended', 'Unknown']
    expect(statuses).toHaveLength(7)
  })

  it('WorkloadKind should have expected values', () => {
    const kinds: WorkloadKind[] = ['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob', 'ReplicaSet']
    expect(kinds).toHaveLength(6)
  })

  it('CloudPage should represent all navigation states', () => {
    const pages: CloudPage[] = [
      { view: 'dashboard' },
      { view: 'kubernetes', tab: 'overview' },
      { view: 'kubernetes', tab: 'clusters' },
      { view: 'kubernetes', tab: 'workloads' },
      { view: 'cluster-detail', clusterName: 'test' },
      { view: 'workload-detail', clusterName: 'c', namespace: 'ns', workloadName: 'w', kind: 'Deployment' }
    ]
    expect(pages).toHaveLength(6)
  })

  it('CloudProviderInfo should have correct shape', () => {
    const info: CloudProviderInfo = {
      id: 'gcp',
      name: 'Google Cloud Platform',
      icon: '<svg/>',
      available: true,
      consoleBaseUrl: 'https://console.cloud.google.com'
    }
    expect(info.id).toBe('gcp')
    expect(info.available).toBe(true)
  })

  it('CloudCluster should have correct shape', () => {
    const cluster: CloudCluster = {
      name: 'test-cluster',
      status: 'RUNNING',
      location: 'us-central1-a',
      nodeCount: 3,
      version: '1.28.5',
      createdAt: '2025-01-01T00:00:00Z',
      consoleUrl: 'https://example.com'
    }
    expect(cluster.name).toBe('test-cluster')
    expect(cluster.status).toBe('RUNNING')
  })

  it('CloudWorkload should have correct shape', () => {
    const workload: CloudWorkload = {
      name: 'web-app',
      namespace: 'default',
      kind: 'Deployment',
      status: 'Active',
      clusterName: 'prod',
      readyReplicas: 3,
      desiredReplicas: 3,
      createdAt: '2025-01-01T00:00:00Z',
      images: ['nginx:latest'],
      consoleUrl: 'https://example.com'
    }
    expect(workload.kind).toBe('Deployment')
    expect(workload.readyReplicas).toBe(workload.desiredReplicas)
  })

  it('CloudPod should have correct shape with containers', () => {
    const container: CloudContainer = {
      name: 'nginx',
      image: 'nginx:1.25',
      status: 'Running',
      ready: true,
      restarts: 0
    }
    const pod: CloudPod = {
      name: 'web-app-abc-123',
      namespace: 'default',
      status: 'Running',
      restarts: 0,
      age: '5d',
      node: 'node-1',
      ip: '10.0.0.1',
      containers: [container]
    }
    expect(pod.containers).toHaveLength(1)
    expect(pod.containers[0].ready).toBe(true)
  })

  it('CloudClusterDetail should extend CloudCluster', () => {
    const detail: CloudClusterDetail = {
      name: 'test',
      status: 'RUNNING',
      location: 'us-central1',
      nodeCount: 2,
      version: '1.28',
      createdAt: '',
      consoleUrl: '',
      nodes: [],
      namespaces: ['default', 'kube-system'],
      totalPods: 10
    }
    expect(detail.namespaces).toContain('default')
    expect(detail.totalPods).toBe(10)
  })

  it('CloudWorkloadDetail should extend CloudWorkload', () => {
    const detail: CloudWorkloadDetail = {
      name: 'web',
      namespace: 'default',
      kind: 'Deployment',
      status: 'Active',
      clusterName: 'prod',
      readyReplicas: 1,
      desiredReplicas: 1,
      createdAt: '',
      images: [],
      consoleUrl: '',
      pods: [],
      labels: { app: 'web' },
      annotations: {},
      conditions: []
    }
    expect(detail.labels).toHaveProperty('app')
    expect(detail.pods).toHaveLength(0)
  })

  it('CloudIntegrationSettings should have correct shape', () => {
    const settings: CloudIntegrationSettings = {
      provider: 'gcp',
      gcpProjectId: 'my-project'
    }
    expect(settings.provider).toBe('gcp')
  })

  it('WorkloadCondition should have correct shape', () => {
    const condition: WorkloadCondition = {
      type: 'Available',
      status: 'True',
      reason: 'MinimumReplicasAvailable',
      message: 'Deployment has 3 available replicas',
      lastTransition: '2025-01-01T00:00:00Z'
    }
    expect(condition.type).toBe('Available')
    expect(condition.status).toBe('True')
  })

  it('CloudDashboardData should have correct shape', () => {
    const data: CloudDashboardData = {
      provider: { id: 'gcp', name: 'GCP', icon: '', available: true, consoleBaseUrl: '' },
      project: { id: 'p', name: 'p' },
      kubernetes: { clusterCount: 0, totalNodes: 0, totalPods: 0, healthyClusters: 0, unhealthyClusters: 0 }
    }
    expect(data.provider.id).toBe('gcp')
    expect(data.kubernetes.clusterCount).toBe(0)
  })
})
