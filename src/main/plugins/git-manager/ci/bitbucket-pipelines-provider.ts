import { execFile } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import path from 'path'
import https from 'https'
import { safeStorage, shell } from 'electron'
import type { CiProvider } from './ci-provider'
import type { CiWorkflow, CiWorkflowRun, CiJob, CiSetupStatus, LogSection } from '../../../../shared/ci-types'
import { parseOwnerRepo } from '../../../../shared/remote-url'
import { getServices } from '../services'

const execFileAsync = promisify(execFile)

/** Sentinel username indicating Bearer token auth (new API tokens) vs Basic auth (legacy app passwords) */
const BEARER_USERNAME = 'x-token-auth'

/**
 * Credential store using OS-level encryption (DPAPI on Windows, Keychain on macOS, libsecret on Linux).
 * Values are stored as base64-encoded encrypted blobs — only the current OS user can decrypt.
 * Lazy-initialized because createSafeStore comes from services (not available at import time).
 */
let _credStore: ReturnType<typeof getServices extends () => infer S ? S['createSafeStore'] : never> | null = null
function credStore(): any {
  if (!_credStore) {
    _credStore = getServices().createSafeStore<Record<string, unknown>>({ name: 'ci-credentials' })
  }
  return _credStore
}

function encryptValue(value: string): string {
  if (!safeStorage.isEncryptionAvailable()) return value
  return safeStorage.encryptString(value).toString('base64')
}

function decryptValue(blob: string): string {
  if (!safeStorage.isEncryptionAvailable()) return blob
  try {
    return safeStorage.decryptString(Buffer.from(blob, 'base64'))
  } catch {
    // If decryption fails (e.g. migrated from old unencrypted store), return raw value
    return blob
  }
}

function getBitbucketCredentials(): { username: string; password: string } | null {
  const usernameBlob = credStore().get('bb.username') as string | undefined
  const tokenBlob = credStore().get('bb.token') as string | undefined
  if (usernameBlob && tokenBlob) {
    return { username: decryptValue(usernameBlob), password: decryptValue(tokenBlob) }
  }
  return null
}

function storeBitbucketCredentials(username: string, token: string): void {
  credStore().set('bb.username', encryptValue(username))
  credStore().set('bb.token', encryptValue(token))
}

function clearBitbucketCredentials(): void {
  credStore().delete('bb.username')
  credStore().delete('bb.token')
}

/** Build the Authorization header — Bearer for API tokens, Basic for legacy app passwords */
function buildAuthHeader(auth: { username: string; password: string }): string {
  if (auth.username === BEARER_USERNAME) {
    return `Bearer ${auth.password}`
  }
  return 'Basic ' + Buffer.from(`${auth.username}:${auth.password}`).toString('base64')
}

function bbApi(path: string, auth: { username: string; password: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.bitbucket.org',
      path: `/2.0/${path}`,
      method: 'GET',
      headers: {
        'Authorization': buildAuthHeader(auth),
        'Accept': 'application/json',
        'User-Agent': 'claude-dock'
      },
      timeout: 30_000
    }, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(body)
        } else {
          reject(new Error(`Bitbucket API ${res.statusCode}: ${body.slice(0, 500)}`))
        }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('Bitbucket API timeout')) })
    req.end()
  })
}

function bbApiPost(path: string, auth: { username: string; password: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.bitbucket.org',
      path: `/2.0/${path}`,
      method: 'POST',
      headers: {
        'Authorization': buildAuthHeader(auth),
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'claude-dock'
      },
      timeout: 30_000
    }, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(body)
        } else {
          reject(new Error(`Bitbucket API ${res.statusCode}: ${body.slice(0, 500)}`))
        }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('Bitbucket API timeout')) })
    req.end()
  })
}

async function getRemoteSlug(projectDir: string): Promise<{ owner: string; repo: string } | null> {
  try {
    const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
      cwd: projectDir,
      timeout: 5000
    })
    return parseOwnerRepo(stdout.trim())
  } catch {
    return null
  }
}

function parseMatrixJobName(name: string): { matrixKey: string | null; matrixValues: Record<string, string> | null } {
  const match = name.match(/^(.+?)\s*\((.+)\)$/)
  if (!match) return { matrixKey: null, matrixValues: null }

  const key = match[1].trim()
  const vals = match[2].split(',').map((v) => v.trim())
  const matrixValues: Record<string, string> = {}
  for (let i = 0; i < vals.length; i++) {
    matrixValues[String(i)] = vals[i]
  }
  return { matrixKey: key, matrixValues }
}

function mapBbStatus(state: string): CiWorkflowRun['status'] {
  switch (state?.toUpperCase()) {
    case 'IN_PROGRESS': case 'RUNNING': return 'in_progress'
    case 'PENDING': return 'queued'
    case 'COMPLETED': case 'SUCCESSFUL': case 'FAILED': case 'ERROR': case 'STOPPED': return 'completed'
    default: return 'queued'
  }
}

function mapBbConclusion(state: string, result?: string): CiWorkflowRun['conclusion'] {
  const r = (result || state || '').toUpperCase()
  if (r === 'SUCCESSFUL') return 'success'
  if (r === 'FAILED' || r === 'ERROR') return 'failure'
  if (r === 'STOPPED') return 'cancelled'
  return null
}

function mapBbJobStatus(state: string): CiJob['status'] {
  switch (state?.toUpperCase()) {
    case 'IN_PROGRESS': case 'RUNNING': return 'in_progress'
    case 'PENDING': return 'queued'
    case 'COMPLETED': case 'SUCCESSFUL': case 'FAILED': case 'ERROR': case 'STOPPED': return 'completed'
    default: return 'queued'
  }
}

function mapBbJobConclusion(state: string, result?: string): CiJob['conclusion'] {
  const r = (result || state || '').toUpperCase()
  if (r === 'SUCCESSFUL') return 'success'
  if (r === 'FAILED' || r === 'ERROR') return 'failure'
  if (r === 'STOPPED') return 'cancelled'
  return null
}

async function generatePipelinesYml(projectDir: string): Promise<string> {
  const exists = async (name: string) => {
    try { await fs.promises.access(path.join(projectDir, name)); return true } catch { return false }
  }

  if (await exists('package.json')) {
    return `image: node:20

pipelines:
  default:
    - step:
        name: Build and Test
        caches:
          - node
        script:
          - npm ci
          - npm run build
          - npm test
`
  }

  if (await exists('requirements.txt') || await exists('pyproject.toml') || await exists('setup.py')) {
    return `image: python:3.12

pipelines:
  default:
    - step:
        name: Build and Test
        caches:
          - pip
        script:
          - pip install -r requirements.txt
          - python -m pytest
`
  }

  if (await exists('go.mod')) {
    return `image: golang:1.22

pipelines:
  default:
    - step:
        name: Build and Test
        caches:
          - docker
        script:
          - go build ./...
          - go test ./...
`
  }

  if (await exists('build.gradle') || await exists('build.gradle.kts') || await exists('pom.xml')) {
    const isGradle = await exists('build.gradle') || await exists('build.gradle.kts')
    return isGradle
      ? `image: gradle:8-jdk17

pipelines:
  default:
    - step:
        name: Build and Test
        caches:
          - gradle
        script:
          - gradle build
`
      : `image: maven:3-eclipse-temurin-17

pipelines:
  default:
    - step:
        name: Build and Test
        caches:
          - maven
        script:
          - mvn -B verify
`
  }

  if (await exists('Cargo.toml')) {
    return `image: rust:latest

pipelines:
  default:
    - step:
        name: Build and Test
        caches:
          - docker
        script:
          - cargo build
          - cargo test
`
  }

  // Generic fallback
  return `image: atlassian/default-image:4

pipelines:
  default:
    - step:
        name: Build
        script:
          - echo "Add your build steps here"
`
}

// Maps hashed step ID → { stepUuid, runId } for log retrieval
const bbStepLookup = new Map<number, { stepUuid: string; runId: number }>()

export class BitbucketPipelinesProvider implements CiProvider {
  readonly name = 'Bitbucket Pipelines'
  readonly providerKey = 'bitbucket'

  async getSetupStatus(projectDir: string): Promise<CiSetupStatus> {
    const steps: CiSetupStatus['steps'] = []

    // Step 1: Bitbucket remote
    const slug = await getRemoteSlug(projectDir)
    const hasRemote = slug !== null
    steps.push({
      id: 'remote-configured',
      label: 'Bitbucket remote configured',
      status: hasRemote ? 'ok' : 'missing',
      helpText: 'This repository needs a Bitbucket remote. Add one with git remote add origin <url>.'
    })

    // Step 2: API credentials
    let hasAuth = false
    if (hasRemote) {
      const creds = getBitbucketCredentials()
      getServices().logInfo('[ci-bitbucket] creds found:', !!creds, creds ? `user=${creds.username} authType=${creds.username === BEARER_USERNAME ? 'Bearer' : 'Basic'}` : '')
      if (creds) {
        // Verify credentials work
        try {
          const apiPath = `repositories/${slug!.owner}/${slug!.repo}`
          getServices().logInfo('[ci-bitbucket] verifying via API:', apiPath, 'auth:', buildAuthHeader(creds).slice(0, 15) + '...')
          await bbApi(apiPath, creds)
          hasAuth = true
          getServices().logInfo('[ci-bitbucket] API verification succeeded')
        } catch (err) {
          // Credentials exist but are invalid — clear them
          getServices().logError('[ci-bitbucket] API verification failed:', err)
          clearBitbucketCredentials()
        }
      }
    }
    steps.push({
      id: 'api-authenticated',
      label: 'Bitbucket API credentials configured',
      status: !hasRemote ? 'missing' : hasAuth ? 'ok' : 'missing',
      helpText: 'Create an Atlassian API token, then enter your Bitbucket username and the token below.',
      helpUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens',
      actionId: 'store-credentials',
      actionLabel: 'Create API token',
      credentialFields: [
        { id: 'username', label: 'Username', type: 'text', placeholder: 'Bitbucket username' },
        { id: 'token', label: 'API Token', type: 'password', placeholder: 'Atlassian API token' }
      ]
    })

    // Step 3: Pipelines enabled
    let pipelinesEnabled = false
    let hasYml = false
    if (hasAuth) {
      // Check remote API
      try {
        const body = await bbApi(`repositories/${slug!.owner}/${slug!.repo}/pipelines_config`, getBitbucketCredentials() as { username: string; password: string })
        const config = JSON.parse(body)
        pipelinesEnabled = config.enabled === true
      } catch {
        // If the endpoint errors, pipelines might not be configured
      }
      // Check local file — if yml exists, consider it ready (will auto-enable on push)
      try {
        await fs.promises.access(path.join(projectDir, 'bitbucket-pipelines.yml'))
        hasYml = true
      } catch { /* doesn't exist */ }
    }

    const pipelinesReady = pipelinesEnabled || hasYml
    steps.push({
      id: 'pipelines-enabled',
      label: 'Bitbucket Pipelines enabled',
      status: !hasAuth ? 'missing' : pipelinesReady ? 'ok' : 'missing',
      helpText: hasYml && !pipelinesEnabled
        ? 'bitbucket-pipelines.yml found. Commit and push to activate Pipelines.'
        : 'Add a bitbucket-pipelines.yml to your repository to enable Pipelines.',
      helpUrl: 'https://support.atlassian.com/bitbucket-cloud/docs/get-started-with-bitbucket-pipelines/',
      actionId: hasYml ? undefined : 'generate-pipelines-yml',
      actionLabel: 'Generate bitbucket-pipelines.yml'
    })

    return {
      ready: hasRemote && hasAuth && pipelinesReady,
      providerName: this.name,
      steps
    }
  }

  async runSetupAction(_projectDir: string, actionId: string, data?: Record<string, string>): Promise<{ success: boolean; error?: string }> {
    getServices().logInfo('[ci-bitbucket] runSetupAction:', actionId, 'data keys:', data ? Object.keys(data) : 'none')
    if (actionId === 'store-credentials' && data?.token) {
      const token = data.token
      const username = data.username?.trim() || ''
      const slug = await getRemoteSlug(_projectDir)

      if (!slug) {
        return { success: false, error: 'No Bitbucket remote configured' }
      }

      // Try auth methods in order:
      // 1. Basic auth with username:token (Atlassian API tokens)
      // 2. Bearer token (Bitbucket workspace/repo access tokens)
      const attempts: { label: string; auth: { username: string; password: string } }[] = []
      if (username) {
        attempts.push({ label: 'Basic (username:token)', auth: { username, password: token } })
      }
      attempts.push({ label: 'Bearer', auth: { username: BEARER_USERNAME, password: token } })

      for (const attempt of attempts) {
        getServices().logInfo('[ci-bitbucket] trying', attempt.label, 'auth:', buildAuthHeader(attempt.auth).slice(0, 15) + '...')
        try {
          await bbApi(`repositories/${slug.owner}/${slug.repo}`, attempt.auth)
          getServices().logInfo('[ci-bitbucket]', attempt.label, 'auth succeeded')

          // Store the working credentials
          storeBitbucketCredentials(attempt.auth.username, attempt.auth.password)
          getServices().logInfo('[ci-bitbucket] credentials stored')
          return { success: true }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : 'API verification failed'
          getServices().logInfo('[ci-bitbucket]', attempt.label, 'auth failed:', errMsg)

          // 403 = auth worked but missing scopes — parse and show which scopes are needed
          if (errMsg.includes('403')) {
            clearBitbucketCredentials()
            try {
              const jsonStart = errMsg.indexOf('{')
              if (jsonStart !== -1) {
                const body = JSON.parse(errMsg.slice(jsonStart))
                const required = body?.error?.detail?.required
                if (required && Array.isArray(required)) {
                  return { success: false, error: `Token is missing required scopes: ${required.join(', ')}` }
                }
              }
            } catch { /* parse failed, fall through */ }
            return { success: false, error: 'Token is missing required scopes — ensure repository and pipeline read access' }
          }
          // 401 = bad credentials, try next auth method
        }
      }

      clearBitbucketCredentials()
      getServices().logError('[ci-bitbucket] all auth methods failed')
      return { success: false, error: 'Authentication failed — check your username and token' }
    }
    if (actionId === 'store-credentials') {
      getServices().logInfo('[ci-bitbucket] no token provided, opening help URL')
      await shell.openExternal('https://id.atlassian.com/manage-profile/security/api-tokens')
      return { success: true }
    }
    if (actionId === 'generate-pipelines-yml') {
      const ymlPath = path.join(_projectDir, 'bitbucket-pipelines.yml')
      try {
        await fs.promises.access(ymlPath)
        return { success: false, error: 'bitbucket-pipelines.yml already exists' }
      } catch { /* doesn't exist, good */ }

      // Detect project type for a smarter starter template
      const template = await generatePipelinesYml(_projectDir)
      try {
        await fs.promises.writeFile(ymlPath, template, 'utf-8')
        getServices().logInfo('[ci-bitbucket] generated bitbucket-pipelines.yml')
        return { success: true }
      } catch (err) {
        getServices().logError('[ci-bitbucket] failed to write pipelines yml:', err)
        return { success: false, error: err instanceof Error ? err.message : 'Failed to write file' }
      }
    }
    return { success: false, error: 'Unknown action' }
  }

  async isAvailable(projectDir: string): Promise<boolean> {
    try {
      const slug = await getRemoteSlug(projectDir)
      if (!slug) return false
      const creds = getBitbucketCredentials()
      if (!creds) return false
      // Quick check: try to list pipelines
      await bbApi(`repositories/${slug.owner}/${slug.repo}/pipelines/?pagelen=1`, creds)
      return true
    } catch (err) {
      getServices().log('[ci-bitbucket] not available:', err instanceof Error ? err.message : err)
      return false
    }
  }

  async getWorkflows(_projectDir: string): Promise<CiWorkflow[]> {
    // Bitbucket has no workflow concept — return a single synthetic workflow
    return [{
      id: 0,
      name: 'All Pipelines',
      path: '',
      state: 'active'
    }]
  }

  async getWorkflowRuns(projectDir: string, _workflowId: number, page: number, perPage: number): Promise<CiWorkflowRun[]> {
    try {
      const slug = await getRemoteSlug(projectDir)
      if (!slug) return []
      const creds = getBitbucketCredentials()
      if (!creds) return []

      const body = await bbApi(
        `repositories/${slug.owner}/${slug.repo}/pipelines/?pagelen=${perPage}&page=${page}&sort=-created_on`,
        creds
      )
      const data = JSON.parse(body)
      return ((data.values as Array<Record<string, unknown>>) || []).map((p) => mapPipeline(p, slug))
    } catch (err) {
      getServices().logError('[ci-bitbucket] getWorkflowRuns failed:', err)
      return []
    }
  }

  async getActiveRuns(projectDir: string): Promise<CiWorkflowRun[]> {
    try {
      const slug = await getRemoteSlug(projectDir)
      if (!slug) return []
      const creds = getBitbucketCredentials()
      if (!creds) return []

      // Bitbucket API supports status filter via status query param
      const runningBody = await bbApi(
        `repositories/${slug.owner}/${slug.repo}/pipelines/?pagelen=50&sort=-created_on&status=BUILDING&status=PENDING`,
        creds
      )
      const data = JSON.parse(runningBody)
      return ((data.values as Array<Record<string, unknown>>) || []).map((p) => mapPipeline(p, slug))
    } catch (err) {
      getServices().logError('[ci-bitbucket] getActiveRuns failed:', err)
      return []
    }
  }

  async getRun(projectDir: string, runId: number): Promise<CiWorkflowRun | null> {
    try {
      const slug = await getRemoteSlug(projectDir)
      if (!slug) return null
      const creds = getBitbucketCredentials()
      if (!creds) return null

      const body = await bbApi(
        `repositories/${slug.owner}/${slug.repo}/pipelines/${runId}`,
        creds
      )
      return mapPipeline(JSON.parse(body), slug)
    } catch (err) {
      getServices().logError('[ci-bitbucket] getRun failed:', err)
      return null
    }
  }

  async getRunJobs(projectDir: string, runId: number): Promise<CiJob[]> {
    try {
      const slug = await getRemoteSlug(projectDir)
      if (!slug) return []
      const creds = getBitbucketCredentials()
      if (!creds) return []

      const body = await bbApi(
        `repositories/${slug.owner}/${slug.repo}/pipelines/${runId}/steps/?pagelen=100`,
        creds
      )
      const data = JSON.parse(body)
      return ((data.values as Array<Record<string, unknown>>) || []).map((step) => {
        const name = (step.name as string) || 'Step'
        const { matrixKey, matrixValues } = parseMatrixJobName(name)
        const state = ((step.state as Record<string, unknown>)?.name as string) || 'PENDING'
        const result = ((step.state as Record<string, unknown>)?.result as Record<string, unknown>)?.name as string || ''
        const startedOn = (step.started_on as string) || null
        const completedOn = (step.completed_on as string) || null
        const stepUuid = (step.uuid as string) || ''
        const hashedId = hashStepUuid(stepUuid || name)
        // Store mapping for log retrieval
        if (stepUuid) {
          bbStepLookup.set(hashedId, { stepUuid, runId })
        }
        return {
          id: hashedId,
          name,
          status: mapBbJobStatus(state),
          conclusion: mapBbJobConclusion(state, result),
          startedAt: startedOn,
          completedAt: completedOn,
          steps: [], // Bitbucket doesn't expose sub-step data
          matrixKey,
          matrixValues
        }
      })
    } catch (err) {
      getServices().logError('[ci-bitbucket] getRunJobs failed:', err)
      return []
    }
  }

  async cancelRun(projectDir: string, runId: number): Promise<void> {
    const slug = await getRemoteSlug(projectDir)
    if (!slug) throw new Error('No Bitbucket remote')
    const creds = getBitbucketCredentials()
    if (!creds) throw new Error('No Bitbucket credentials')

    await bbApiPost(
      `repositories/${slug.owner}/${slug.repo}/pipelines/${runId}/stopPipeline`,
      creds
    )
  }

  async rerunFailedJobs(projectDir: string, runId: number): Promise<void> {
    // Bitbucket doesn't support re-running failed steps — re-trigger the pipeline
    const slug = await getRemoteSlug(projectDir)
    if (!slug) throw new Error('No Bitbucket remote')
    const creds = getBitbucketCredentials()
    if (!creds) throw new Error('No Bitbucket credentials')

    // Get the original pipeline to find its target
    const body = await bbApi(
      `repositories/${slug.owner}/${slug.repo}/pipelines/${runId}`,
      creds
    )
    const pipeline = JSON.parse(body)
    const branch = (pipeline.target as Record<string, unknown>)?.ref_name as string
    if (!branch) throw new Error('Cannot determine branch for rerun')

    // Trigger a new pipeline on the same branch
    await new Promise<void>((resolve, reject) => {
      const authHeader = buildAuthHeader(creds)
      const postBody = JSON.stringify({
        target: {
          ref_type: 'branch',
          type: 'pipeline_ref_target',
          ref_name: branch
        }
      })
      const req = https.request({
        hostname: 'api.bitbucket.org',
        path: `/2.0/repositories/${slug.owner}/${slug.repo}/pipelines/`,
        method: 'POST',
        headers: {
          'Authorization': authHeader,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postBody),
          'User-Agent': 'claude-dock'
        },
        timeout: 30_000
      }, (res) => {
        let body = ''
        res.on('data', (chunk) => { body += chunk })
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) resolve()
          else reject(new Error(`Bitbucket API ${res.statusCode}: ${body.slice(0, 500)}`))
        })
      })
      req.on('error', reject)
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
      req.write(postBody)
      req.end()
    })
  }

  async getJobLog(projectDir: string, jobId: number): Promise<string> {
    try {
      const slug = await getRemoteSlug(projectDir)
      if (!slug) return ''
      const creds = getBitbucketCredentials()
      if (!creds) return ''

      const info = bbStepLookup.get(jobId)
      if (!info) {
        getServices().log('[ci-bitbucket] no step UUID mapping for jobId', jobId)
        return ''
      }

      const body = await bbApi(
        `repositories/${slug.owner}/${slug.repo}/pipelines/${info.runId}/steps/${info.stepUuid}/log`,
        creds
      )
      return body
    } catch (err) {
      getServices().logError('[ci-bitbucket] getJobLog failed:', err)
      return ''
    }
  }

  async getRunUrl(projectDir: string, runId: number): Promise<string> {
    const slug = await getRemoteSlug(projectDir)
    if (!slug) return ''
    return `https://bitbucket.org/${slug.owner}/${slug.repo}/pipelines/results/${runId}`
  }

  parseLogSections(rawLog: string): LogSection[] {
    // Bitbucket logs are plain text — split into a single section
    const lines = rawLog.split('\n')
    return [{ name: '', lines, collapsed: false }]
  }
}

function mapPipeline(p: Record<string, unknown>, slug: { owner: string; repo: string }): CiWorkflowRun {
  const state = ((p.state as Record<string, unknown>)?.name as string) || 'PENDING'
  const result = ((p.state as Record<string, unknown>)?.result as Record<string, unknown>)?.name as string || ''
  const target = p.target as Record<string, unknown> | undefined
  const branch = (target?.ref_name as string) || ''
  const sha = ((target?.commit as Record<string, unknown>)?.hash as string) || ''
  const buildNumber = (p.build_number as number) || 0
  const pipelineUuid = (p.uuid as string) || ''

  return {
    id: buildNumber,
    name: branch ? `Pipeline #${buildNumber}` : 'Pipeline',
    workflowId: 0,
    headBranch: branch,
    headSha: sha,
    status: mapBbStatus(state),
    conclusion: mapBbConclusion(state, result),
    createdAt: (p.created_on as string) || '',
    updatedAt: (p.completed_on as string) || (p.created_on as string) || '',
    url: `https://bitbucket.org/${slug.owner}/${slug.repo}/pipelines/results/${buildNumber}`,
    event: (target?.ref_type as string) || 'push',
    runNumber: buildNumber,
    runAttempt: 1,
    actor: ((p.creator as Record<string, unknown>)?.display_name as string) ||
           ((p.creator as Record<string, unknown>)?.username as string) || ''
  }
}

/** Convert a UUID string to a stable numeric ID for our CiJob interface */
function hashStepUuid(uuid: string): number {
  let hash = 0
  for (let i = 0; i < uuid.length; i++) {
    const char = uuid.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash // Convert to 32-bit integer
  }
  return Math.abs(hash)
}
