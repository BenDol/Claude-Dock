/**
 * Google Cloud Platform provider implementation.
 * Uses the `gcloud` CLI to fetch cluster and workload data.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
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
  CloudNode,
  CloudPod,
  CloudContainer,
  WorkloadCondition,
  ClusterStatus,
  WorkloadStatus,
  WorkloadKind
} from '../../../../shared/cloud-types'

const execFileAsync = promisify(execFile)

const GCP_ICON = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12.19 5.88l2.75-2.75.14-.93L12.19 0C7.16 0 3 4.07 2.87 9.06l.78-.67 2.75-.43s.14-.24.21-.23c1.05-1.9 3.06-3.17 5.38-2.85z" fill="#EA4335"/><path d="M19.25 9.06c-.57-2.13-1.9-3.96-3.68-5.18l-3.38 3.38c1.54.62 2.75 1.94 3.14 3.58v.45c1.24 0 2.25 1.01 2.25 2.25s-1.01 2.25-2.25 2.25H12.2l-.45.46v2.7l.45.45h3.13c2.75.04 5.04-2.14 5.08-4.89.02-1.82-1-3.5-2.56-4.4l-.6-1.05z" fill="#4285F4"/><path d="M9.07 19.4h3.13v-3.15H9.07c-.32 0-.63-.07-.91-.21l-.63.2-1.8 1.8-.16.63C6.72 19.24 7.85 19.4 9.07 19.4z" fill="#34A853"/><path d="M9.07 9.72C6.32 9.74 4.08 11.99 4.1 14.74c.01 1.57.75 3.05 2.01 3.98l2.59-2.59c-1.07-.49-1.54-1.75-1.06-2.82.49-1.07 1.75-1.54 2.82-1.06.48.22.86.6 1.06 1.06L14.1 10.7c-1.33-1.27-3.13-1-5.03-.98z" fill="#FBBC05"/></svg>`

/** Timeout for gcloud commands in ms */
const CMD_TIMEOUT = 30_000

async function gcloud(...args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('gcloud', args, {
      timeout: CMD_TIMEOUT,
      windowsHide: true
    })
    return stdout.trim()
  } catch (err: any) {
    throw new Error(`gcloud ${args.join(' ')} failed: ${err.message}`)
  }
}

async function gcloudJson<T>(...args: string[]): Promise<T> {
  const raw = await gcloud(...args, '--format=json')
  return JSON.parse(raw)
}

async function kubectl(...args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('kubectl', args, {
      timeout: CMD_TIMEOUT,
      windowsHide: true
    })
    return stdout.trim()
  } catch (err: any) {
    throw new Error(`kubectl ${args.join(' ')} failed: ${err.message}`)
  }
}

async function kubectlJson<T>(...args: string[]): Promise<T> {
  const raw = await kubectl(...args, '-o', 'json')
  return JSON.parse(raw)
}

function mapClusterStatus(status: string): ClusterStatus {
  const map: Record<string, ClusterStatus> = {
    RUNNING: 'RUNNING',
    PROVISIONING: 'PROVISIONING',
    STOPPING: 'STOPPING',
    ERROR: 'ERROR',
    DEGRADED: 'DEGRADED',
    RECONCILING: 'RUNNING'
  }
  return map[status] ?? 'UNKNOWN'
}

function mapWorkloadStatus(conditions: any[], readyReplicas: number, desiredReplicas: number): WorkloadStatus {
  if (!conditions || conditions.length === 0) {
    if (desiredReplicas === 0) return 'Suspended'
    return readyReplicas === desiredReplicas ? 'Active' : 'Unknown'
  }

  const available = conditions.find((c: any) => c.type === 'Available')
  const progressing = conditions.find((c: any) => c.type === 'Progressing')

  if (available?.status === 'False') return 'Degraded'
  if (progressing?.status === 'True' && progressing?.reason === 'NewReplicaSetAvailable') return 'Active'
  if (progressing?.status === 'True') return 'Progressing'
  if (readyReplicas === desiredReplicas && desiredReplicas > 0) return 'Active'
  if (readyReplicas < desiredReplicas) return 'Degraded'
  return 'Active'
}

function mapPodStatus(pod: any): CloudPod['status'] {
  const phase = pod.status?.phase
  if (pod.metadata?.deletionTimestamp) return 'Terminating'

  const containerStatuses = pod.status?.containerStatuses || []
  for (const cs of containerStatuses) {
    if (cs.state?.waiting?.reason === 'CrashLoopBackOff') return 'CrashLoopBackOff'
  }

  const map: Record<string, CloudPod['status']> = {
    Running: 'Running',
    Pending: 'Pending',
    Succeeded: 'Succeeded',
    Failed: 'Failed'
  }
  return map[phase] ?? 'Unknown'
}

function calcAge(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}

export class GcpProvider implements CloudProvider {
  readonly id: CloudProviderId = 'gcp'
  readonly name = 'Google Cloud Platform'
  readonly consoleBaseUrl = 'https://console.cloud.google.com'

  private projectId: string | null = null

  getIcon(): string {
    return GCP_ICON
  }

  async checkAuth(): Promise<boolean> {
    try {
      const account = await gcloud('auth', 'list', '--filter=status:ACTIVE', '--format=value(account)')
      return account.length > 0
    } catch {
      return false
    }
  }

  async getProject(): Promise<CloudProject> {
    if (!this.projectId) {
      this.projectId = await gcloud('config', 'get-value', 'project')
    }
    return {
      id: this.projectId,
      name: this.projectId,
      region: await this.getDefaultRegion()
    }
  }

  private async getDefaultRegion(): Promise<string | undefined> {
    try {
      const region = await gcloud('config', 'get-value', 'compute/region')
      return region || undefined
    } catch {
      return undefined
    }
  }

  private async getProjectId(): Promise<string> {
    if (!this.projectId) {
      this.projectId = await gcloud('config', 'get-value', 'project')
    }
    return this.projectId
  }

  async getKubernetesSummary(): Promise<CloudKubernetesSummary> {
    try {
      const clusters = await this.getClusters()
      const healthy = clusters.filter((c) => c.status === 'RUNNING').length
      const totalNodes = clusters.reduce((sum, c) => sum + c.nodeCount, 0)

      // Best-effort pod count
      let totalPods = 0
      try {
        const raw = await kubectl('get', 'pods', '--all-namespaces', '--no-headers')
        totalPods = raw.split('\n').filter((l) => l.trim()).length
      } catch { /* kubectl might not be configured for all clusters */ }

      return {
        clusterCount: clusters.length,
        totalNodes,
        totalPods,
        healthyClusters: healthy,
        unhealthyClusters: clusters.length - healthy
      }
    } catch {
      return { clusterCount: 0, totalNodes: 0, totalPods: 0, healthyClusters: 0, unhealthyClusters: 0 }
    }
  }

  async getClusters(): Promise<CloudCluster[]> {
    const projectId = await this.getProjectId()
    const raw = await gcloudJson<any[]>('container', 'clusters', 'list')

    return raw.map((c: any) => ({
      name: c.name,
      status: mapClusterStatus(c.status),
      location: c.location || c.zone || '',
      nodeCount: c.currentNodeCount || 0,
      version: c.currentMasterVersion || '',
      endpoint: c.endpoint,
      createdAt: c.createTime || '',
      consoleUrl: `${this.consoleBaseUrl}/kubernetes/clusters/details/${c.location || c.zone}/${c.name}/details?project=${projectId}`
    }))
  }

  async getClusterDetail(clusterName: string): Promise<CloudClusterDetail> {
    const projectId = await this.getProjectId()
    const clusters = await gcloudJson<any[]>('container', 'clusters', 'list', `--filter=name=${clusterName}`)
    if (clusters.length === 0) throw new Error(`Cluster "${clusterName}" not found`)

    const c = clusters[0]
    const location = c.location || c.zone || ''

    // Get credentials for this cluster so kubectl works
    try {
      await gcloud('container', 'clusters', 'get-credentials', clusterName, `--location=${location}`)
    } catch {
      // May already be configured
    }

    let nodes: CloudNode[] = []
    let namespaces: string[] = []
    let totalPods = 0

    try {
      const nodesRaw = await kubectlJson<any>('get', 'nodes')
      nodes = (nodesRaw.items || []).map((n: any) => {
        const ready = n.status?.conditions?.find((c: any) => c.type === 'Ready')
        return {
          name: n.metadata.name,
          status: ready?.status === 'True' ? 'Ready' as const : 'NotReady' as const,
          machineType: n.metadata.labels?.['node.kubernetes.io/instance-type'] || n.metadata.labels?.['beta.kubernetes.io/instance-type'] || 'unknown',
          zone: n.metadata.labels?.['topology.kubernetes.io/zone'] || n.metadata.labels?.['failure-domain.beta.kubernetes.io/zone'] || '',
          podCount: 0,
          version: n.status?.nodeInfo?.kubeletVersion || ''
        }
      })
    } catch { /* cluster may not be reachable */ }

    try {
      const nsRaw = await kubectlJson<any>('get', 'namespaces')
      namespaces = (nsRaw.items || []).map((ns: any) => ns.metadata.name)
    } catch { /* ignore */ }

    try {
      const podsRaw = await kubectl('get', 'pods', '--all-namespaces', '--no-headers')
      const podLines = podsRaw.split('\n').filter((l) => l.trim())
      totalPods = podLines.length

      // Count pods per node
      for (const line of podLines) {
        const parts = line.trim().split(/\s+/)
        // kubectl output: NAMESPACE NAME READY STATUS RESTARTS AGE NODE (when using -o wide)
        // Without -o wide we don't get node, so skip node counting in basic mode
      }
    } catch { /* ignore */ }

    return {
      name: c.name,
      status: mapClusterStatus(c.status),
      location,
      nodeCount: c.currentNodeCount || 0,
      version: c.currentMasterVersion || '',
      endpoint: c.endpoint,
      createdAt: c.createTime || '',
      consoleUrl: `${this.consoleBaseUrl}/kubernetes/clusters/details/${location}/${c.name}/details?project=${projectId}`,
      nodes,
      namespaces,
      totalPods,
      resourceUsage: undefined
    }
  }

  async getWorkloads(clusterName?: string): Promise<CloudWorkload[]> {
    const projectId = await this.getProjectId()

    // If a cluster is specified, get credentials first
    if (clusterName) {
      const clusters = await gcloudJson<any[]>('container', 'clusters', 'list', `--filter=name=${clusterName}`)
      if (clusters.length > 0) {
        const loc = clusters[0].location || clusters[0].zone
        try {
          await gcloud('container', 'clusters', 'get-credentials', clusterName, `--location=${loc}`)
        } catch { /* may already be configured */ }
      }
    }

    const workloads: CloudWorkload[] = []

    // Fetch deployments
    try {
      const deps = await kubectlJson<any>('get', 'deployments', '--all-namespaces')
      for (const d of deps.items || []) {
        workloads.push(this.mapDeployment(d, clusterName || 'current', projectId))
      }
    } catch { /* ignore */ }

    // Fetch statefulsets
    try {
      const sts = await kubectlJson<any>('get', 'statefulsets', '--all-namespaces')
      for (const s of sts.items || []) {
        workloads.push(this.mapStatefulSet(s, clusterName || 'current', projectId))
      }
    } catch { /* ignore */ }

    // Fetch daemonsets
    try {
      const ds = await kubectlJson<any>('get', 'daemonsets', '--all-namespaces')
      for (const d of ds.items || []) {
        workloads.push(this.mapDaemonSet(d, clusterName || 'current', projectId))
      }
    } catch { /* ignore */ }

    // Fetch jobs
    try {
      const jobs = await kubectlJson<any>('get', 'jobs', '--all-namespaces')
      for (const j of jobs.items || []) {
        workloads.push(this.mapJob(j, clusterName || 'current', projectId))
      }
    } catch { /* ignore */ }

    return workloads
  }

  async getWorkloadDetail(
    clusterName: string,
    namespace: string,
    workloadName: string,
    kind: string
  ): Promise<CloudWorkloadDetail> {
    const projectId = await this.getProjectId()

    // Ensure we have credentials
    const clusters = await gcloudJson<any[]>('container', 'clusters', 'list', `--filter=name=${clusterName}`)
    if (clusters.length > 0) {
      const loc = clusters[0].location || clusters[0].zone
      try {
        await gcloud('container', 'clusters', 'get-credentials', clusterName, `--location=${loc}`)
      } catch { /* may already be configured */ }
    }

    const resourceType = kind.toLowerCase() + 's'
    const raw = await kubectlJson<any>('get', resourceType, workloadName, '-n', namespace)

    // Get pods that belong to this workload
    const selector = Object.entries(raw.spec?.selector?.matchLabels || {})
      .map(([k, v]) => `${k}=${v}`)
      .join(',')

    let pods: CloudPod[] = []
    if (selector) {
      try {
        const podsRaw = await kubectlJson<any>('get', 'pods', '-n', namespace, `-l=${selector}`)
        pods = (podsRaw.items || []).map((p: any) => this.mapPod(p))
      } catch { /* ignore */ }
    }

    const conditions: WorkloadCondition[] = (raw.status?.conditions || []).map((c: any) => ({
      type: c.type,
      status: c.status,
      reason: c.reason || undefined,
      message: c.message || undefined,
      lastTransition: c.lastTransitionTime || ''
    }))

    const readyReplicas = raw.status?.readyReplicas || 0
    const desiredReplicas = raw.spec?.replicas || 0

    return {
      name: workloadName,
      namespace,
      kind: kind as WorkloadKind,
      status: mapWorkloadStatus(raw.status?.conditions, readyReplicas, desiredReplicas),
      clusterName,
      readyReplicas,
      desiredReplicas,
      createdAt: raw.metadata?.creationTimestamp || '',
      images: this.extractImages(raw),
      consoleUrl: `${this.consoleBaseUrl}/kubernetes/deployment/${namespace}/${workloadName}/overview?project=${projectId}`,
      pods,
      labels: raw.metadata?.labels || {},
      annotations: raw.metadata?.annotations || {},
      strategy: raw.spec?.strategy?.type || raw.spec?.updateStrategy?.type || undefined,
      conditions
    }
  }

  getConsoleUrl(
    section: 'dashboard' | 'clusters' | 'workloads' | 'cluster' | 'workload',
    params?: Record<string, string>
  ): string {
    const project = this.projectId || ''
    switch (section) {
      case 'dashboard':
        return `${this.consoleBaseUrl}/home/dashboard?project=${project}`
      case 'clusters':
        return `${this.consoleBaseUrl}/kubernetes/list/overview?project=${project}`
      case 'workloads':
        return `${this.consoleBaseUrl}/kubernetes/workload/overview?project=${project}`
      case 'cluster':
        return `${this.consoleBaseUrl}/kubernetes/clusters/details/${params?.location || ''}/${params?.name || ''}/details?project=${project}`
      case 'workload':
        return `${this.consoleBaseUrl}/kubernetes/deployment/${params?.namespace || ''}/${params?.name || ''}/overview?project=${project}`
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

  // ── Private mapping helpers ──────────────────────────────────────────────

  private mapDeployment(d: any, clusterName: string, projectId: string): CloudWorkload {
    const ready = d.status?.readyReplicas || 0
    const desired = d.spec?.replicas || 0
    return {
      name: d.metadata.name,
      namespace: d.metadata.namespace,
      kind: 'Deployment',
      status: mapWorkloadStatus(d.status?.conditions, ready, desired),
      clusterName,
      readyReplicas: ready,
      desiredReplicas: desired,
      createdAt: d.metadata.creationTimestamp || '',
      images: this.extractImages(d),
      consoleUrl: `${this.consoleBaseUrl}/kubernetes/deployment/${d.metadata.namespace}/${d.metadata.name}/overview?project=${projectId}`
    }
  }

  private mapStatefulSet(s: any, clusterName: string, projectId: string): CloudWorkload {
    const ready = s.status?.readyReplicas || 0
    const desired = s.spec?.replicas || 0
    return {
      name: s.metadata.name,
      namespace: s.metadata.namespace,
      kind: 'StatefulSet',
      status: mapWorkloadStatus([], ready, desired),
      clusterName,
      readyReplicas: ready,
      desiredReplicas: desired,
      createdAt: s.metadata.creationTimestamp || '',
      images: this.extractImages(s),
      consoleUrl: `${this.consoleBaseUrl}/kubernetes/statefulset/${s.metadata.namespace}/${s.metadata.name}/overview?project=${projectId}`
    }
  }

  private mapDaemonSet(d: any, clusterName: string, projectId: string): CloudWorkload {
    const ready = d.status?.numberReady || 0
    const desired = d.status?.desiredNumberScheduled || 0
    return {
      name: d.metadata.name,
      namespace: d.metadata.namespace,
      kind: 'DaemonSet',
      status: ready === desired && desired > 0 ? 'Active' : 'Degraded',
      clusterName,
      readyReplicas: ready,
      desiredReplicas: desired,
      createdAt: d.metadata.creationTimestamp || '',
      images: this.extractImages(d),
      consoleUrl: `${this.consoleBaseUrl}/kubernetes/daemonset/${d.metadata.namespace}/${d.metadata.name}/overview?project=${projectId}`
    }
  }

  private mapJob(j: any, clusterName: string, projectId: string): CloudWorkload {
    const succeeded = j.status?.succeeded || 0
    const failed = j.status?.failed || 0
    let status: WorkloadStatus = 'Active'
    if (succeeded > 0) status = 'Completed'
    else if (failed > 0) status = 'Failed'
    else if (j.status?.active) status = 'Progressing'

    return {
      name: j.metadata.name,
      namespace: j.metadata.namespace,
      kind: 'Job',
      status,
      clusterName,
      readyReplicas: succeeded,
      desiredReplicas: j.spec?.completions || 1,
      createdAt: j.metadata.creationTimestamp || '',
      images: this.extractImages(j),
      consoleUrl: `${this.consoleBaseUrl}/kubernetes/job/${j.metadata.namespace}/${j.metadata.name}/overview?project=${projectId}`
    }
  }

  private mapPod(p: any): CloudPod {
    const containers: CloudContainer[] = (p.status?.containerStatuses || []).map((cs: any) => ({
      name: cs.name,
      image: cs.image,
      status: cs.state?.running ? 'Running' as const
        : cs.state?.waiting ? 'Waiting' as const
          : 'Terminated' as const,
      ready: cs.ready || false,
      restarts: cs.restartCount || 0,
      reason: cs.state?.waiting?.reason || cs.state?.terminated?.reason || undefined
    }))

    const totalRestarts = containers.reduce((sum, c) => sum + c.restarts, 0)

    return {
      name: p.metadata.name,
      namespace: p.metadata.namespace,
      status: mapPodStatus(p),
      restarts: totalRestarts,
      age: calcAge(p.metadata.creationTimestamp || new Date().toISOString()),
      node: p.spec?.nodeName || '',
      ip: p.status?.podIP || undefined,
      containers
    }
  }

  private extractImages(resource: any): string[] {
    const containers = resource.spec?.template?.spec?.containers || resource.spec?.containers || []
    return containers.map((c: any) => c.image).filter(Boolean)
  }
}
