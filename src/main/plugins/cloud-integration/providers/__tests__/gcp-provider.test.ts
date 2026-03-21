import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockExecFile } = vi.hoisted(() => ({
  mockExecFile: vi.fn()
}))

vi.mock('child_process', () => ({
  execFile: mockExecFile
}))

vi.mock('util', () => ({
  promisify: (fn: any) => fn
}))

import { GcpProvider } from '../gcp-provider'

// Helper to make mockExecFile resolve with stdout
function mockCmd(stdout: string) {
  return { stdout }
}

function mockCmdJson(data: unknown) {
  return { stdout: JSON.stringify(data) }
}

describe('GcpProvider', () => {
  let provider: GcpProvider

  beforeEach(() => {
    vi.clearAllMocks()
    provider = new GcpProvider()
  })

  describe('metadata', () => {
    it('should have correct id and name', () => {
      expect(provider.id).toBe('gcp')
      expect(provider.name).toBe('Google Cloud Platform')
      expect(provider.consoleBaseUrl).toBe('https://console.cloud.google.com')
    })

    it('should return SVG icon', () => {
      const icon = provider.getIcon()
      expect(icon).toContain('<svg')
      expect(icon).toContain('</svg>')
    })
  })

  describe('checkAuth', () => {
    it('should return true when gcloud has active account', async () => {
      mockExecFile.mockResolvedValueOnce(mockCmd('user@example.com'))
      const result = await provider.checkAuth()
      expect(result).toBe(true)
      expect(mockExecFile).toHaveBeenCalledWith(
        'gcloud',
        ['auth', 'list', '--filter=status:ACTIVE', '--format=value(account)'],
        expect.objectContaining({ timeout: 30000 })
      )
    })

    it('should return false when gcloud has no active account', async () => {
      mockExecFile.mockResolvedValueOnce(mockCmd(''))
      const result = await provider.checkAuth()
      expect(result).toBe(false)
    })

    it('should return false when gcloud command fails', async () => {
      mockExecFile.mockRejectedValueOnce(new Error('command not found'))
      const result = await provider.checkAuth()
      expect(result).toBe(false)
    })
  })

  describe('getProject', () => {
    it('should return project info from gcloud config', async () => {
      mockExecFile
        .mockResolvedValueOnce(mockCmd('my-project-id'))   // project
        .mockResolvedValueOnce(mockCmd('us-central1'))     // region

      const project = await provider.getProject()
      expect(project.id).toBe('my-project-id')
      expect(project.name).toBe('my-project-id')
      expect(project.region).toBe('us-central1')
    })

    it('should handle missing region gracefully', async () => {
      mockExecFile
        .mockResolvedValueOnce(mockCmd('my-project'))
        .mockResolvedValueOnce(mockCmd(''))

      const project = await provider.getProject()
      expect(project.id).toBe('my-project')
      expect(project.region).toBeUndefined()
    })
  })

  describe('getClusters', () => {
    it('should parse gcloud container clusters list output', async () => {
      // First call: getProjectId
      mockExecFile.mockResolvedValueOnce(mockCmd('my-project'))
      // Second call: clusters list
      mockExecFile.mockResolvedValueOnce(mockCmdJson([
        {
          name: 'prod-cluster',
          status: 'RUNNING',
          location: 'us-central1-a',
          currentNodeCount: 3,
          currentMasterVersion: '1.28.5',
          endpoint: '35.202.100.1',
          createTime: '2025-01-01T00:00:00Z'
        },
        {
          name: 'staging-cluster',
          status: 'PROVISIONING',
          zone: 'us-east1-b',
          currentNodeCount: 1,
          currentMasterVersion: '1.27.10',
          createTime: '2025-06-01T00:00:00Z'
        }
      ]))

      const clusters = await provider.getClusters()
      expect(clusters).toHaveLength(2)

      expect(clusters[0].name).toBe('prod-cluster')
      expect(clusters[0].status).toBe('RUNNING')
      expect(clusters[0].location).toBe('us-central1-a')
      expect(clusters[0].nodeCount).toBe(3)
      expect(clusters[0].version).toBe('1.28.5')
      expect(clusters[0].endpoint).toBe('35.202.100.1')
      expect(clusters[0].consoleUrl).toContain('my-project')
      expect(clusters[0].consoleUrl).toContain('prod-cluster')

      expect(clusters[1].name).toBe('staging-cluster')
      expect(clusters[1].status).toBe('PROVISIONING')
      expect(clusters[1].location).toBe('us-east1-b')
    })

    it('should handle empty cluster list', async () => {
      mockExecFile.mockResolvedValueOnce(mockCmd('my-project'))
      mockExecFile.mockResolvedValueOnce(mockCmdJson([]))

      const clusters = await provider.getClusters()
      expect(clusters).toHaveLength(0)
    })
  })

  describe('getClusterDetail', () => {
    it('should combine gcloud cluster data with kubectl data', async () => {
      // getProjectId
      mockExecFile.mockResolvedValueOnce(mockCmd('my-project'))
      // clusters list (filtered)
      mockExecFile.mockResolvedValueOnce(mockCmdJson([{
        name: 'prod-cluster',
        status: 'RUNNING',
        location: 'us-central1-a',
        currentNodeCount: 2,
        currentMasterVersion: '1.28.5',
        endpoint: '35.202.100.1',
        createTime: '2025-01-01T00:00:00Z'
      }]))
      // get-credentials
      mockExecFile.mockResolvedValueOnce(mockCmd(''))
      // kubectl get nodes
      mockExecFile.mockResolvedValueOnce(mockCmdJson({
        items: [{
          metadata: {
            name: 'gke-node-1',
            labels: {
              'node.kubernetes.io/instance-type': 'e2-medium',
              'topology.kubernetes.io/zone': 'us-central1-a'
            }
          },
          status: {
            conditions: [{ type: 'Ready', status: 'True' }],
            nodeInfo: { kubeletVersion: 'v1.28.5' }
          }
        }]
      }))
      // kubectl get namespaces
      mockExecFile.mockResolvedValueOnce(mockCmdJson({
        items: [
          { metadata: { name: 'default' } },
          { metadata: { name: 'kube-system' } }
        ]
      }))
      // kubectl get pods (non-json, just line count)
      mockExecFile.mockResolvedValueOnce(mockCmd('ns1 pod1 1/1 Running 0 1d\nns1 pod2 1/1 Running 0 2d'))

      const detail = await provider.getClusterDetail('prod-cluster')
      expect(detail.name).toBe('prod-cluster')
      expect(detail.status).toBe('RUNNING')
      expect(detail.nodes).toHaveLength(1)
      expect(detail.nodes[0].name).toBe('gke-node-1')
      expect(detail.nodes[0].status).toBe('Ready')
      expect(detail.nodes[0].machineType).toBe('e2-medium')
      expect(detail.namespaces).toEqual(['default', 'kube-system'])
      expect(detail.totalPods).toBe(2)
    })

    it('should throw when cluster not found', async () => {
      mockExecFile.mockResolvedValueOnce(mockCmd('my-project'))
      mockExecFile.mockResolvedValueOnce(mockCmdJson([]))

      await expect(provider.getClusterDetail('nonexistent')).rejects.toThrow('not found')
    })
  })

  describe('getWorkloads', () => {
    it('should fetch and merge deployments, statefulsets, daemonsets, and jobs', async () => {
      // getProjectId
      mockExecFile.mockResolvedValueOnce(mockCmd('my-project'))

      // kubectl get deployments
      mockExecFile.mockResolvedValueOnce(mockCmdJson({
        items: [{
          metadata: { name: 'web-app', namespace: 'default', creationTimestamp: '2025-01-01T00:00:00Z' },
          spec: { replicas: 3, template: { spec: { containers: [{ image: 'nginx:latest' }] } } },
          status: {
            readyReplicas: 3,
            conditions: [
              { type: 'Available', status: 'True' },
              { type: 'Progressing', status: 'True', reason: 'NewReplicaSetAvailable' }
            ]
          }
        }]
      }))

      // kubectl get statefulsets
      mockExecFile.mockResolvedValueOnce(mockCmdJson({
        items: [{
          metadata: { name: 'redis', namespace: 'cache', creationTimestamp: '2025-02-01T00:00:00Z' },
          spec: { replicas: 1, template: { spec: { containers: [{ image: 'redis:7' }] } } },
          status: { readyReplicas: 1 }
        }]
      }))

      // kubectl get daemonsets
      mockExecFile.mockResolvedValueOnce(mockCmdJson({ items: [] }))

      // kubectl get jobs
      mockExecFile.mockResolvedValueOnce(mockCmdJson({ items: [] }))

      const workloads = await provider.getWorkloads()
      expect(workloads).toHaveLength(2)

      const deployment = workloads.find((w) => w.name === 'web-app')!
      expect(deployment.kind).toBe('Deployment')
      expect(deployment.status).toBe('Active')
      expect(deployment.readyReplicas).toBe(3)
      expect(deployment.desiredReplicas).toBe(3)
      expect(deployment.images).toContain('nginx:latest')

      const statefulset = workloads.find((w) => w.name === 'redis')!
      expect(statefulset.kind).toBe('StatefulSet')
      expect(statefulset.readyReplicas).toBe(1)
    })

    it('should handle kubectl failures gracefully and return partial results', async () => {
      mockExecFile.mockResolvedValueOnce(mockCmd('my-project'))
      // Deployments succeed
      mockExecFile.mockResolvedValueOnce(mockCmdJson({
        items: [{
          metadata: { name: 'app', namespace: 'default', creationTimestamp: '2025-01-01T00:00:00Z' },
          spec: { replicas: 1, template: { spec: { containers: [{ image: 'app:1' }] } } },
          status: { readyReplicas: 1, conditions: [] }
        }]
      }))
      // StatefulSets fail
      mockExecFile.mockRejectedValueOnce(new Error('connection refused'))
      // DaemonSets fail
      mockExecFile.mockRejectedValueOnce(new Error('connection refused'))
      // Jobs fail
      mockExecFile.mockRejectedValueOnce(new Error('connection refused'))

      const workloads = await provider.getWorkloads()
      expect(workloads).toHaveLength(1)
      expect(workloads[0].name).toBe('app')
    })
  })

  describe('getWorkloadDetail', () => {
    it('should return workload with pods and conditions', async () => {
      // getProjectId
      mockExecFile.mockResolvedValueOnce(mockCmd('my-project'))
      // clusters list for credentials
      mockExecFile.mockResolvedValueOnce(mockCmdJson([{
        name: 'prod', location: 'us-central1-a'
      }]))
      // get-credentials
      mockExecFile.mockResolvedValueOnce(mockCmd(''))
      // kubectl get deployment
      mockExecFile.mockResolvedValueOnce(mockCmdJson({
        metadata: {
          name: 'web-app',
          namespace: 'default',
          creationTimestamp: '2025-01-01T00:00:00Z',
          labels: { app: 'web' },
          annotations: { 'deployment.kubernetes.io/revision': '5' }
        },
        spec: {
          replicas: 3,
          strategy: { type: 'RollingUpdate' },
          selector: { matchLabels: { app: 'web' } },
          template: { spec: { containers: [{ image: 'nginx:1.25' }] } }
        },
        status: {
          readyReplicas: 2,
          conditions: [
            { type: 'Available', status: 'True', lastTransitionTime: '2025-01-01T00:00:00Z' },
            { type: 'Progressing', status: 'True', reason: 'NewReplicaSetAvailable', lastTransitionTime: '2025-01-01T00:00:00Z' }
          ]
        }
      }))
      // kubectl get pods
      mockExecFile.mockResolvedValueOnce(mockCmdJson({
        items: [
          {
            metadata: { name: 'web-app-abc-123', namespace: 'default', creationTimestamp: '2025-01-01T00:00:00Z' },
            spec: { nodeName: 'node-1' },
            status: {
              phase: 'Running',
              podIP: '10.0.0.1',
              containerStatuses: [{
                name: 'nginx',
                image: 'nginx:1.25',
                state: { running: { startedAt: '2025-01-01T00:00:00Z' } },
                ready: true,
                restartCount: 0
              }]
            }
          },
          {
            metadata: { name: 'web-app-abc-456', namespace: 'default', creationTimestamp: '2025-01-01T00:00:00Z' },
            spec: { nodeName: 'node-2' },
            status: {
              phase: 'Running',
              podIP: '10.0.0.2',
              containerStatuses: [{
                name: 'nginx',
                image: 'nginx:1.25',
                state: { waiting: { reason: 'CrashLoopBackOff' } },
                ready: false,
                restartCount: 5
              }]
            }
          }
        ]
      }))

      const detail = await provider.getWorkloadDetail('prod', 'default', 'web-app', 'Deployment')
      expect(detail.name).toBe('web-app')
      expect(detail.namespace).toBe('default')
      expect(detail.kind).toBe('Deployment')
      expect(detail.readyReplicas).toBe(2)
      expect(detail.desiredReplicas).toBe(3)
      expect(detail.strategy).toBe('RollingUpdate')
      expect(detail.images).toContain('nginx:1.25')
      expect(detail.labels).toEqual({ app: 'web' })
      expect(detail.conditions).toHaveLength(2)

      expect(detail.pods).toHaveLength(2)
      expect(detail.pods[0].name).toBe('web-app-abc-123')
      expect(detail.pods[0].status).toBe('Running')
      expect(detail.pods[0].containers[0].ready).toBe(true)

      expect(detail.pods[1].name).toBe('web-app-abc-456')
      expect(detail.pods[1].status).toBe('CrashLoopBackOff')
      expect(detail.pods[1].containers[0].ready).toBe(false)
      expect(detail.pods[1].restarts).toBe(5)
    })
  })

  describe('getConsoleUrl', () => {
    it('should return correct GCP console URLs', async () => {
      // Set project id
      mockExecFile.mockResolvedValueOnce(mockCmd('test-project'))
      mockExecFile.mockResolvedValueOnce(mockCmd(''))
      await provider.getProject()

      expect(provider.getConsoleUrl('dashboard')).toContain('home/dashboard?project=test-project')
      expect(provider.getConsoleUrl('clusters')).toContain('kubernetes/list/overview?project=test-project')
      expect(provider.getConsoleUrl('workloads')).toContain('kubernetes/workload/overview?project=test-project')
      expect(provider.getConsoleUrl('cluster', { name: 'my-cluster', location: 'us-east1' }))
        .toContain('kubernetes/clusters/details/us-east1/my-cluster')
      expect(provider.getConsoleUrl('workload', { name: 'web', namespace: 'prod' }))
        .toContain('kubernetes/deployment/prod/web')
    })
  })

  describe('getKubernetesSummary', () => {
    it('should aggregate cluster and pod data', async () => {
      // getProjectId
      mockExecFile.mockResolvedValueOnce(mockCmd('my-project'))
      // getClusters
      mockExecFile.mockResolvedValueOnce(mockCmdJson([
        { name: 'c1', status: 'RUNNING', location: 'us-central1-a', currentNodeCount: 3, currentMasterVersion: '1.28', createTime: '' },
        { name: 'c2', status: 'ERROR', location: 'us-east1-b', currentNodeCount: 1, currentMasterVersion: '1.27', createTime: '' }
      ]))
      // kubectl get pods (for total count)
      mockExecFile.mockResolvedValueOnce(mockCmd('ns pod1 1/1 Running 0 1d\nns pod2 1/1 Running 0 2d\nns pod3 0/1 Pending 0 1m'))

      const summary = await provider.getKubernetesSummary()
      expect(summary.clusterCount).toBe(2)
      expect(summary.healthyClusters).toBe(1)
      expect(summary.unhealthyClusters).toBe(1)
      expect(summary.totalNodes).toBe(4)
      expect(summary.totalPods).toBe(3)
    })

    it('should return zeros when gcloud fails', async () => {
      mockExecFile.mockRejectedValueOnce(new Error('not authenticated'))

      const summary = await provider.getKubernetesSummary()
      expect(summary.clusterCount).toBe(0)
      expect(summary.totalNodes).toBe(0)
      expect(summary.totalPods).toBe(0)
    })
  })
})
