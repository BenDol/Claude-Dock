import { execFile } from 'child_process'
import { promisify } from 'util'
import type { CiProvider } from './ci-provider'
import { detectProvider } from '../../../../shared/remote-url'
import type { GitProvider } from '../../../../shared/remote-url'
import { GitHubActionsProvider } from './github-actions-provider'
import { GitLabCiProvider } from './gitlab-ci-provider'
import { BitbucketPipelinesProvider } from './bitbucket-pipelines-provider'
import { log } from '../../../logger'

const execFileAsync = promisify(execFile)

export class CiProviderRegistry {
  private static instance: CiProviderRegistry | null = null
  private cache = new Map<string, CiProvider | null>()

  static getInstance(): CiProviderRegistry {
    if (!CiProviderRegistry.instance) {
      CiProviderRegistry.instance = new CiProviderRegistry()
    }
    return CiProviderRegistry.instance
  }

  async resolve(projectDir: string): Promise<CiProvider | null> {
    if (this.cache.has(projectDir)) return this.cache.get(projectDir)!

    let remoteUrl: string | null = null
    try {
      const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
        cwd: projectDir,
        timeout: 5000
      })
      remoteUrl = stdout.trim()
    } catch {
      log('[ci-registry] no origin remote for', projectDir)
    }

    if (!remoteUrl) {
      this.cache.set(projectDir, null)
      return null
    }

    const gitProvider = detectProvider(remoteUrl)
    const provider = this.createProvider(gitProvider)
    log('[ci-registry] resolved provider for', projectDir, '->', provider?.name ?? 'none')
    this.cache.set(projectDir, provider)
    return provider
  }

  private createProvider(type: GitProvider): CiProvider | null {
    switch (type) {
      case 'github': return new GitHubActionsProvider()
      case 'gitlab': return new GitLabCiProvider()
      case 'bitbucket': return new BitbucketPipelinesProvider()
      default: return null
    }
  }

  invalidate(projectDir: string): void {
    this.cache.delete(projectDir)
  }
}
