import { execFile } from 'child_process'
import { promisify } from 'util'
import type { PrProvider } from './pr-provider'
import { detectProvider } from '../../../../shared/remote-url'
import type { GitProvider } from '../../../../shared/remote-url'
import { GitHubPrProvider } from './github-pr-provider'
import { GitLabMrProvider } from './gitlab-mr-provider'
import { BitbucketPrProvider } from './bitbucket-pr-provider'
import { getServices } from '../services'

const execFileAsync = promisify(execFile)

export class PrProviderRegistry {
  private static instance: PrProviderRegistry | null = null
  private cache = new Map<string, PrProvider | null>()

  static getInstance(): PrProviderRegistry {
    if (!PrProviderRegistry.instance) {
      PrProviderRegistry.instance = new PrProviderRegistry()
    }
    return PrProviderRegistry.instance
  }

  async resolve(projectDir: string): Promise<PrProvider | null> {
    if (this.cache.has(projectDir)) return this.cache.get(projectDir)!

    let remoteUrl: string | null = null
    try {
      const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
        cwd: projectDir,
        timeout: 5000
      })
      remoteUrl = stdout.trim()
    } catch {
      getServices().log('[pr-registry] no origin remote for', projectDir)
    }

    if (!remoteUrl) {
      this.cache.set(projectDir, null)
      return null
    }

    const gitProvider = detectProvider(remoteUrl)
    const provider = this.createProvider(gitProvider)
    getServices().log('[pr-registry] resolved provider for', projectDir, '->', provider?.name ?? 'none')
    this.cache.set(projectDir, provider)
    return provider
  }

  private createProvider(type: GitProvider): PrProvider | null {
    switch (type) {
      case 'github': return new GitHubPrProvider()
      case 'gitlab': return new GitLabMrProvider()
      case 'bitbucket': return new BitbucketPrProvider()
      default: return null
    }
  }

  invalidate(projectDir: string): void {
    this.cache.delete(projectDir)
  }
}
