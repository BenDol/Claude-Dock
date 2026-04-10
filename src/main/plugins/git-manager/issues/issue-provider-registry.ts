import { execFile } from 'child_process'
import { promisify } from 'util'
import type { IssueProvider } from './issue-provider'
import { detectProvider } from '../../../../shared/remote-url'
import type { GitProvider } from '../../../../shared/remote-url'
import { GitHubIssueProvider } from './github-issue-provider'
import { GitLabIssueProvider } from './gitlab-issue-provider'
import { getServices } from '../services'

const execFileAsync = promisify(execFile)

/**
 * Singleton registry that resolves an IssueProvider from a project's git remote.
 * Caches by projectDir; call invalidate() when the remote changes.
 */
export class IssueProviderRegistry {
  private static instance: IssueProviderRegistry | null = null
  private cache = new Map<string, IssueProvider | null>()

  static getInstance(): IssueProviderRegistry {
    if (!IssueProviderRegistry.instance) {
      IssueProviderRegistry.instance = new IssueProviderRegistry()
    }
    return IssueProviderRegistry.instance
  }

  async resolve(projectDir: string): Promise<IssueProvider | null> {
    if (this.cache.has(projectDir)) return this.cache.get(projectDir)!

    let remoteUrl: string | null = null
    try {
      const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
        cwd: projectDir,
        timeout: 5000
      })
      remoteUrl = stdout.trim()
    } catch {
      getServices().log('[issue-registry] no origin remote for', projectDir)
    }

    if (!remoteUrl) {
      this.cache.set(projectDir, null)
      return null
    }

    const gitProvider = detectProvider(remoteUrl)
    const provider = this.createProvider(gitProvider)
    getServices().log(
      '[issue-registry] resolved provider for',
      projectDir,
      '->',
      provider?.name ?? 'none'
    )
    this.cache.set(projectDir, provider)
    return provider
  }

  private createProvider(type: GitProvider): IssueProvider | null {
    switch (type) {
      case 'github': return new GitHubIssueProvider()
      case 'gitlab': return new GitLabIssueProvider()
      // Bitbucket is intentionally skipped for v1 — its native issue tracker
      // is disabled on new repos since 2022.
      default: return null
    }
  }

  invalidate(projectDir: string): void {
    this.cache.delete(projectDir)
  }

  invalidateAll(): void {
    this.cache.clear()
  }
}
