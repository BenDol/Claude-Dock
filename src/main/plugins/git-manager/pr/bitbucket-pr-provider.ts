import { execFile } from 'child_process'
import { promisify } from 'util'
import * as https from 'https'
import { safeStorage } from 'electron'
import type { PrProvider } from './pr-provider'
import type { PullRequest, PrState, PrCreateRequest, PrCreateResult } from '../../../../shared/pr-types'
import type { CiSetupStatus } from '../../../../shared/ci-types'
import { getServices } from '../services'
import { createSafeStore, safeRead } from '../../../safe-store'

const execFileAsync = promisify(execFile)

// Reuse the same credential store as the CI provider
let _credStore: ReturnType<typeof createSafeStore<Record<string, unknown>>> | null = null
function credStore() {
  if (!_credStore) _credStore = createSafeStore<Record<string, unknown>>({ name: 'ci-credentials' })
  return _credStore
}

function decryptValue(blob: string): string {
  if (!safeStorage.isEncryptionAvailable()) return blob
  try { return safeStorage.decryptString(Buffer.from(blob, 'base64')) } catch { return blob }
}

function getCredentials(): { username: string; password: string } | null {
  const u = safeRead(() => credStore().get('bb.username') as string | undefined)
  const p = safeRead(() => credStore().get('bb.token') as string | undefined)
  if (u && p) return { username: decryptValue(u), password: decryptValue(p) }
  return null
}

function buildAuthHeader(): string | null {
  const creds = getCredentials()
  if (!creds) return null
  return 'Basic ' + Buffer.from(`${creds.username}:${creds.password}`).toString('base64')
}

async function getRemoteSlug(projectDir: string): Promise<{ workspace: string; repo: string } | null> {
  try {
    const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], { cwd: projectDir, timeout: 5000 })
    const url = stdout.trim()
    const m = url.match(/bitbucket\.org[/:]([^/]+)\/([^/.]+)/)
    if (m) return { workspace: m[1], repo: m[2] }
  } catch { /* ignore */ }
  return null
}

function bbApi<T>(path: string, auth: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: 'api.bitbucket.org',
      path,
      headers: { Authorization: auth, Accept: 'application/json', 'User-Agent': 'Claude-Dock' }
    }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`))
        try { resolve(JSON.parse(data)) } catch { reject(new Error('Invalid JSON')) }
      })
    })
    req.on('error', reject)
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')) })
  })
}

function bbPost<T>(path: string, auth: string, body: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    const json = JSON.stringify(body)
    const req = https.request({
      method: 'POST',
      hostname: 'api.bitbucket.org',
      path,
      headers: {
        Authorization: auth,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(json),
        'User-Agent': 'Claude-Dock'
      }
    }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)) } catch { reject(new Error('Invalid JSON')) }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`))
        }
      })
    })
    req.on('error', reject)
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')) })
    req.write(json)
    req.end()
  })
}

function mapPr(raw: Record<string, unknown>): PullRequest {
  const state = ((raw.state as string) || '').toUpperCase()
  return {
    id: (raw.id as number) || 0,
    title: (raw.title as string) || '',
    state: state === 'MERGED' ? 'merged' : state === 'OPEN' ? 'open' : 'closed',
    sourceBranch: ((raw.source as Record<string, unknown>)?.branch as Record<string, unknown>)?.name as string || '',
    targetBranch: ((raw.destination as Record<string, unknown>)?.branch as Record<string, unknown>)?.name as string || '',
    author: ((raw.author as Record<string, unknown>)?.display_name as string) || '',
    url: (((raw.links as Record<string, unknown>)?.html as Record<string, unknown>)?.href as string) || '',
    createdAt: (raw.created_on as string) || '',
    updatedAt: (raw.updated_on as string) || '',
    isDraft: false,
    labels: [],
    reviewDecision: null,
    description: ((raw.description as string) || '').slice(0, 500)
  }
}

export class BitbucketPrProvider implements PrProvider {
  readonly name = 'Bitbucket Pull Requests'
  readonly providerKey = 'bitbucket'

  async isAvailable(projectDir: string): Promise<boolean> {
    const auth = buildAuthHeader()
    if (!auth) return false
    const slug = await getRemoteSlug(projectDir)
    if (!slug) return false
    try {
      await bbApi(`/2.0/repositories/${slug.workspace}/${slug.repo}`, auth)
      return true
    } catch {
      return false
    }
  }

  async getSetupStatus(projectDir: string): Promise<CiSetupStatus> {
    const steps: CiSetupStatus['steps'] = []
    const slug = await getRemoteSlug(projectDir)
    steps.push({
      id: 'remote-configured', label: 'Bitbucket remote configured',
      status: slug ? 'ok' : 'missing',
      helpText: 'This repository needs a Bitbucket remote.'
    })

    const creds = getCredentials()
    steps.push({
      id: 'credentials', label: 'Bitbucket credentials configured',
      status: creds ? 'ok' : 'missing',
      helpText: 'Configure username and app password in the CI tab setup.',
      credentialFields: [
        { id: 'username', label: 'Username', type: 'text', placeholder: 'your-username' },
        { id: 'token', label: 'App Password', type: 'password', placeholder: 'your-app-password' }
      ]
    })

    return { ready: !!slug && !!creds, providerName: this.name, steps }
  }

  async runSetupAction(): Promise<{ success: boolean; error?: string }> {
    return { success: false, error: 'Use the CI tab to configure Bitbucket credentials' }
  }

  async listPrs(projectDir: string, state?: PrState): Promise<PullRequest[]> {
    const auth = buildAuthHeader()
    const slug = await getRemoteSlug(projectDir)
    if (!auth || !slug) return []

    try {
      const stateParam = state === 'open' ? 'OPEN' : state === 'merged' ? 'MERGED' : state === 'closed' ? 'DECLINED' : 'OPEN'
      const data = await bbApi<{ values?: Array<Record<string, unknown>> }>(
        `/2.0/repositories/${slug.workspace}/${slug.repo}/pullrequests?state=${stateParam}&pagelen=50`,
        auth
      )
      return (data.values || []).map(mapPr)
    } catch (err) {
      getServices().logError('[pr-bitbucket] listPrs failed:', err)
      return []
    }
  }

  async getPr(projectDir: string, id: number): Promise<PullRequest | null> {
    const auth = buildAuthHeader()
    const slug = await getRemoteSlug(projectDir)
    if (!auth || !slug) return null

    try {
      const raw = await bbApi<Record<string, unknown>>(
        `/2.0/repositories/${slug.workspace}/${slug.repo}/pullrequests/${id}`,
        auth
      )
      return mapPr(raw)
    } catch (err) {
      getServices().logError('[pr-bitbucket] getPr failed:', err)
      return null
    }
  }

  async createPr(projectDir: string, req: PrCreateRequest): Promise<PrCreateResult> {
    const auth = buildAuthHeader()
    const slug = await getRemoteSlug(projectDir)
    if (!auth || !slug) {
      return { success: false, error: 'Bitbucket credentials not configured' }
    }

    try {
      const raw = await bbPost<Record<string, unknown>>(
        `/2.0/repositories/${slug.workspace}/${slug.repo}/pullrequests`,
        auth,
        {
          title: req.title,
          description: req.body,
          source: { branch: { name: req.sourceBranch } },
          destination: { branch: { name: req.targetBranch } }
        }
      )
      return { success: true, pr: mapPr(raw), url: mapPr(raw).url }
    } catch (err) {
      const url = await this.getNewPrUrl(projectDir, req.sourceBranch, req.targetBranch)
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Failed to create pull request',
        url: url || undefined
      }
    }
  }

  async getDefaultBranch(projectDir: string): Promise<string> {
    const auth = buildAuthHeader()
    const slug = await getRemoteSlug(projectDir)
    if (!auth || !slug) return 'main'

    try {
      const repo = await bbApi<Record<string, unknown>>(
        `/2.0/repositories/${slug.workspace}/${slug.repo}`,
        auth
      )
      return ((repo.mainbranch as Record<string, unknown>)?.name as string) || 'main'
    } catch {
      return 'main'
    }
  }

  async getNewPrUrl(projectDir: string, sourceBranch: string, targetBranch: string): Promise<string | null> {
    const slug = await getRemoteSlug(projectDir)
    if (!slug) return null
    return `https://bitbucket.org/${slug.workspace}/${slug.repo}/pull-requests/new?source=${encodeURIComponent(sourceBranch)}&dest=${encodeURIComponent(targetBranch)}`
  }
}
