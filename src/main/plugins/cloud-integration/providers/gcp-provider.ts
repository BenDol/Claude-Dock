/**
 * Google Cloud Platform provider implementation.
 * Uses the `gcloud` CLI to fetch cluster and workload data.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import type { CloudProvider } from './cloud-provider'
import { getServices } from '../services'
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
  WorkloadKind,
  CloudSetupStatus
} from '../../../../shared/cloud-types'

const execFileAsync = promisify(execFile)

const GCP_ICON = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12.19 5.88l2.75-2.75.14-.93L12.19 0C7.16 0 3 4.07 2.87 9.06l.78-.67 2.75-.43s.14-.24.21-.23c1.05-1.9 3.06-3.17 5.38-2.85z" fill="#EA4335"/><path d="M19.25 9.06c-.57-2.13-1.9-3.96-3.68-5.18l-3.38 3.38c1.54.62 2.75 1.94 3.14 3.58v.45c1.24 0 2.25 1.01 2.25 2.25s-1.01 2.25-2.25 2.25H12.2l-.45.46v2.7l.45.45h3.13c2.75.04 5.04-2.14 5.08-4.89.02-1.82-1-3.5-2.56-4.4l-.6-1.05z" fill="#4285F4"/><path d="M9.07 19.4h3.13v-3.15H9.07c-.32 0-.63-.07-.91-.21l-.63.2-1.8 1.8-.16.63C6.72 19.24 7.85 19.4 9.07 19.4z" fill="#34A853"/><path d="M9.07 9.72C6.32 9.74 4.08 11.99 4.1 14.74c.01 1.57.75 3.05 2.01 3.98l2.59-2.59c-1.07-.49-1.54-1.75-1.06-2.82.49-1.07 1.75-1.54 2.82-1.06.48.22.86.6 1.06 1.06L14.1 10.7c-1.33-1.27-3.13-1-5.03-.98z" fill="#FBBC05"/></svg>`

/** Timeout for gcloud commands in ms */
const CMD_TIMEOUT = 30_000

const TAG = '[cloud-integration:gcp]'
function svcLog(...args: unknown[]): void { try { getServices().log(TAG, ...args) } catch { /* services not ready */ } }
function svcLogError(...args: unknown[]): void { try { getServices().logError(TAG, ...args) } catch { /* services not ready */ } }

/** Patterns that indicate expired/invalid auth tokens */
const AUTH_ERROR_PATTERNS = [
  'invalid_grant',
  'token has been expired or revoked',
  'refreshing your current auth tokens',
  'please run:.*gcloud auth login',
  'request had invalid authentication credentials',
  'not authorized'
]

/** Check if an error message indicates an auth/token problem */
function isAuthError(message: string): boolean {
  const lower = message.toLowerCase()
  return AUTH_ERROR_PATTERNS.some((p) => lower.includes(p.toLowerCase()) || new RegExp(p, 'i').test(lower))
}

/** Tagged error that carries an authExpired flag for the IPC layer */
export class CloudAuthError extends Error {
  readonly authExpired = true
  constructor(message: string) {
    super(message)
    this.name = 'CloudAuthError'
  }
}

async function gcloud(...args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('gcloud', args, {
      timeout: CMD_TIMEOUT,
      windowsHide: true,
      shell: process.platform === 'win32' // gcloud is a .cmd on Windows
    })
    return stdout.trim()
  } catch (err: any) {
    const msg = err.stderr || err.message || ''
    if (isAuthError(msg)) {
      throw new CloudAuthError('Your Google Cloud credentials have expired. Please re-authenticate.')
    }
    throw new Error(`gcloud ${args.join(' ')} failed: ${err.message}`)
  }
}

async function gcloudJson<T>(...args: string[]): Promise<T> {
  const raw = await gcloud(...args, '--format=json')
  return JSON.parse(raw)
}

/** Patterns indicating the GKE auth plugin is missing */
const GKE_PLUGIN_MISSING_PATTERNS = [
  'gke-gcloud-auth-plugin',
  'executable gke-gcloud-auth-plugin'
]

function isGkePluginMissing(message: string): boolean {
  const lower = message.toLowerCase()
  return GKE_PLUGIN_MISSING_PATTERNS.some((p) => lower.includes(p.toLowerCase()))
}

/** Tagged error for missing GKE auth plugin */
export class GkePluginMissingError extends Error {
  readonly gkePluginMissing = true
  constructor() {
    super('The gke-gcloud-auth-plugin is required for kubectl to authenticate with GKE clusters. Run: gcloud components install gke-gcloud-auth-plugin')
    this.name = 'GkePluginMissingError'
  }
}

async function kubectl(...args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('kubectl', args, {
      timeout: CMD_TIMEOUT,
      windowsHide: true
    })
    return stdout.trim()
  } catch (err: any) {
    const msg = err.stderr || err.message || ''
    if (isGkePluginMissing(msg)) {
      throw new GkePluginMissingError()
    }
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
      const authed = account.length > 0
      svcLog('checkAuth:', authed ? `authenticated as ${account}` : 'no active account')
      return authed
    } catch (e: any) {
      svcLogError('checkAuth failed:', e.message)
      return false
    }
  }

  async reauthenticate(): Promise<boolean> {
    // Auth is handled by the IPC layer running the command in the dock's shell panel
    return false
  }

  async getProject(): Promise<CloudProject> {
    if (!this.projectId) {
      this.projectId = await gcloud('config', 'get-value', 'project')
      svcLog('resolved project:', this.projectId)
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
    } catch (e: any) {
      svcLog('getDefaultRegion: not set or unavailable')
      return undefined
    }
  }

  private async getProjectId(): Promise<string> {
    if (!this.projectId) {
      this.projectId = await gcloud('config', 'get-value', 'project')
      svcLog('resolved project:', this.projectId)
    }
    return this.projectId
  }

  async getKubernetesSummary(): Promise<CloudKubernetesSummary> {
    svcLog('getKubernetesSummary: fetching...')
    try {
      const clusters = await this.getClusters()
      const healthy = clusters.filter((c) => c.status === 'RUNNING').length
      const totalNodes = clusters.reduce((sum, c) => sum + c.nodeCount, 0)

      // Best-effort pod count — configure kubectl for each cluster and sum pods
      let totalPods = 0
      for (const cluster of clusters) {
        try {
          const pid = await this.getProjectId()
          await gcloud('container', 'clusters', 'get-credentials', cluster.name, `--location=${cluster.location}`, `--project=${pid}`)
          const raw = await kubectl('get', 'pods', '--all-namespaces', '--no-headers')
          const count = raw.split('\n').filter((l) => l.trim()).length
          totalPods += count
          svcLog(`getKubernetesSummary: cluster "${cluster.name}" has ${count} pods`)
        } catch (e: any) {
          svcLogError(`getKubernetesSummary: failed to get pods for cluster "${cluster.name}":`, e.message)
        }
      }

      svcLog(`getKubernetesSummary: ${clusters.length} clusters, ${totalNodes} nodes, ${totalPods} pods`)
      return {
        clusterCount: clusters.length,
        totalNodes,
        totalPods,
        healthyClusters: healthy,
        unhealthyClusters: clusters.length - healthy
      }
    } catch (e: any) {
      svcLogError('getKubernetesSummary: failed entirely:', e.message)
      return { clusterCount: 0, totalNodes: 0, totalPods: 0, healthyClusters: 0, unhealthyClusters: 0 }
    }
  }

  async getClusters(): Promise<CloudCluster[]> {
    const projectId = await this.getProjectId()
    svcLog(`getClusters: listing clusters for project "${projectId}"`)
    const raw = await gcloudJson<any[]>('container', 'clusters', 'list')
    svcLog(`getClusters: found ${raw.length} cluster(s)`)

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
    svcLog(`getClusterDetail: fetching "${clusterName}"`)
    const projectId = await this.getProjectId()
    const clusters = await gcloudJson<any[]>('container', 'clusters', 'list', `--filter=name=${clusterName}`)
    if (clusters.length === 0) throw new Error(`Cluster "${clusterName}" not found`)

    const c = clusters[0]
    const location = c.location || c.zone || ''

    // Get credentials for this cluster so kubectl works
    try {
      await gcloud('container', 'clusters', 'get-credentials', clusterName, `--location=${location}`, `--project=${projectId}`)
      svcLog(`getClusterDetail: kubectl configured for "${clusterName}"`)
    } catch (e: any) {
      svcLog(`getClusterDetail: get-credentials skipped for "${clusterName}" (may already be configured):`, e.message)
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
      svcLog(`getClusterDetail: ${nodes.length} node(s) for "${clusterName}"`)
    } catch (e: any) {
      svcLogError(`getClusterDetail: kubectl get nodes failed for "${clusterName}":`, e.message)
    }

    try {
      const nsRaw = await kubectlJson<any>('get', 'namespaces')
      namespaces = (nsRaw.items || []).map((ns: any) => ns.metadata.name)
      svcLog(`getClusterDetail: ${namespaces.length} namespace(s) for "${clusterName}"`)
    } catch (e: any) {
      svcLogError(`getClusterDetail: kubectl get namespaces failed for "${clusterName}":`, e.message)
    }

    try {
      const podsRaw = await kubectl('get', 'pods', '--all-namespaces', '--no-headers')
      const podLines = podsRaw.split('\n').filter((l) => l.trim())
      totalPods = podLines.length
      svcLog(`getClusterDetail: ${totalPods} pod(s) for "${clusterName}"`)
    } catch (e: any) {
      svcLogError(`getClusterDetail: kubectl get pods failed for "${clusterName}":`, e.message)
    }

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

    // If no specific cluster, iterate all clusters so kubectl is properly configured for each
    if (!clusterName) {
      svcLog('getWorkloads: fetching workloads across all clusters')
      const clusters = await this.getClusters()
      if (clusters.length === 0) {
        svcLog('getWorkloads: no clusters found, returning empty')
        return []
      }

      const allWorkloads: CloudWorkload[] = []
      for (const cluster of clusters) {
        try {
          const w = await this.getWorkloads(cluster.name)
          allWorkloads.push(...w)
        } catch (e: any) {
          // Propagate setup errors (missing plugin) so the UI can show resolution
          if ((e as any).gkePluginMissing || (e as any).authExpired) throw e
          svcLogError(`getWorkloads: failed for cluster "${cluster.name}":`, e.message)
        }
      }
      svcLog(`getWorkloads: found ${allWorkloads.length} total workload(s) across ${clusters.length} cluster(s)`)
      return allWorkloads
    }

    svcLog(`getWorkloads: fetching for cluster "${clusterName}"`)

    // Get credentials for the specified cluster
    const clusters = await gcloudJson<any[]>('container', 'clusters', 'list', `--filter=name=${clusterName}`)
    if (clusters.length > 0) {
      const loc = clusters[0].location || clusters[0].zone
      svcLog(`getWorkloads: configuring kubectl for "${clusterName}" in ${loc}`)
      await gcloud('container', 'clusters', 'get-credentials', clusterName, `--location=${loc}`, `--project=${projectId}`)
    } else {
      svcLogError(`getWorkloads: cluster "${clusterName}" not found in gcloud clusters list`)
      return []
    }

    const workloads: CloudWorkload[] = []

    // Fetch deployments
    try {
      const deps = await kubectlJson<any>('get', 'deployments', '--all-namespaces')
      const count = deps.items?.length || 0
      for (const d of deps.items || []) {
        workloads.push(this.mapDeployment(d, clusterName, projectId))
      }
      svcLog(`getWorkloads: ${count} deployment(s) in "${clusterName}"`)
    } catch (e: any) { svcLogError(`getWorkloads: kubectl get deployments failed for "${clusterName}":`, e.message) }

    // Fetch statefulsets
    try {
      const sts = await kubectlJson<any>('get', 'statefulsets', '--all-namespaces')
      const count = sts.items?.length || 0
      for (const s of sts.items || []) {
        workloads.push(this.mapStatefulSet(s, clusterName, projectId))
      }
      if (count > 0) svcLog(`getWorkloads: ${count} statefulset(s) in "${clusterName}"`)
    } catch (e: any) { svcLogError(`getWorkloads: kubectl get statefulsets failed for "${clusterName}":`, e.message) }

    // Fetch daemonsets
    try {
      const ds = await kubectlJson<any>('get', 'daemonsets', '--all-namespaces')
      const count = ds.items?.length || 0
      for (const d of ds.items || []) {
        workloads.push(this.mapDaemonSet(d, clusterName, projectId))
      }
      if (count > 0) svcLog(`getWorkloads: ${count} daemonset(s) in "${clusterName}"`)
    } catch (e: any) { svcLogError(`getWorkloads: kubectl get daemonsets failed for "${clusterName}":`, e.message) }

    // Fetch jobs
    try {
      const jobs = await kubectlJson<any>('get', 'jobs', '--all-namespaces')
      const count = jobs.items?.length || 0
      for (const j of jobs.items || []) {
        workloads.push(this.mapJob(j, clusterName, projectId))
      }
      if (count > 0) svcLog(`getWorkloads: ${count} job(s) in "${clusterName}"`)
    } catch (e: any) { svcLogError(`getWorkloads: kubectl get jobs failed for "${clusterName}":`, e.message) }

    svcLog(`getWorkloads: ${workloads.length} total workload(s) for "${clusterName}"`)
    return workloads
  }

  async getWorkloadDetail(
    clusterName: string,
    namespace: string,
    workloadName: string,
    kind: string
  ): Promise<CloudWorkloadDetail> {
    svcLog(`getWorkloadDetail: ${kind}/${workloadName} in ${namespace} on "${clusterName}"`)
    const projectId = await this.getProjectId()

    // Ensure we have credentials
    const clusters = await gcloudJson<any[]>('container', 'clusters', 'list', `--filter=name=${clusterName}`)
    if (clusters.length > 0) {
      const loc = clusters[0].location || clusters[0].zone
      try {
        await gcloud('container', 'clusters', 'get-credentials', clusterName, `--location=${loc}`, `--project=${projectId}`)
      } catch (e: any) {
        svcLog(`getWorkloadDetail: get-credentials skipped (may already be configured):`, e.message)
      }
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
        svcLog(`getWorkloadDetail: ${pods.length} pod(s) for ${kind}/${workloadName}`)
      } catch (e: any) {
        svcLogError(`getWorkloadDetail: kubectl get pods failed for ${kind}/${workloadName}:`, e.message)
      }
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

  async getSetupStatus(): Promise<CloudSetupStatus> {
    svcLog('getSetupStatus: checking setup steps...')
    const steps = [
      {
        id: 'install-cli',
        title: 'Install Google Cloud CLI',
        description: 'The gcloud CLI is required to communicate with GCP. Download and install it, then restart your terminal.',
        command: 'https://cloud.google.com/sdk/docs/install',
        helpUrl: 'https://cloud.google.com/sdk/docs/install',
        helpLabel: 'Download Google Cloud CLI',
        verifiable: true
      },
      {
        id: 'authenticate',
        title: 'Authenticate with GCP',
        description: 'Sign in to your Google Cloud account. This will open a browser window for authentication.',
        command: 'gcloud auth login',
        helpUrl: 'https://cloud.google.com/sdk/gcloud/reference/auth/login',
        helpLabel: 'Authentication docs',
        verifiable: true
      },
      {
        id: 'set-project',
        title: 'Set active project',
        description: 'Select the GCP project you want to manage. Replace PROJECT_ID with your project ID.',
        command: 'gcloud config set project PROJECT_ID',
        helpUrl: 'https://console.cloud.google.com/projectselector2',
        helpLabel: 'View your projects',
        verifiable: true
      },
      {
        id: 'install-kubectl',
        title: 'Install kubectl',
        description: 'kubectl is required for Kubernetes cluster management. Install it via gcloud components.',
        command: 'gcloud components install kubectl',
        helpUrl: 'https://cloud.google.com/kubernetes-engine/docs/how-to/cluster-access-for-kubectl',
        helpLabel: 'kubectl setup docs',
        verifiable: true
      }
    ]

    // Check which steps are complete
    let currentStep = 0

    // Step 0: Is gcloud installed?
    try {
      await gcloud('version')
      currentStep = 1
    } catch {
      return { providerId: this.id, providerName: this.name, icon: this.getIcon(), steps, currentStep, complete: false }
    }

    // Step 1: Is the user authenticated?
    try {
      const account = await gcloud('auth', 'list', '--filter=status:ACTIVE', '--format=value(account)')
      if (account.length > 0) currentStep = 2
      else return { providerId: this.id, providerName: this.name, icon: this.getIcon(), steps, currentStep, complete: false }
    } catch {
      return { providerId: this.id, providerName: this.name, icon: this.getIcon(), steps, currentStep, complete: false }
    }

    // Step 2: Is a project set?
    try {
      const project = await gcloud('config', 'get-value', 'project')
      if (project && project !== '(unset)') {
        this.projectId = project
        currentStep = 3
      } else {
        return { providerId: this.id, providerName: this.name, icon: this.getIcon(), steps, currentStep, complete: false }
      }
    } catch {
      return { providerId: this.id, providerName: this.name, icon: this.getIcon(), steps, currentStep, complete: false }
    }

    // Step 3: Is kubectl installed?
    try {
      await execFileAsync('kubectl', ['version', '--client', '--short'], { timeout: CMD_TIMEOUT, windowsHide: true })
      currentStep = 4
    } catch {
      return { providerId: this.id, providerName: this.name, icon: this.getIcon(), steps, currentStep, complete: false }
    }

    svcLog(`getSetupStatus: all steps complete`)
    return { providerId: this.id, providerName: this.name, icon: this.getIcon(), steps, currentStep, complete: true }
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
