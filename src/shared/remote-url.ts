export type GitProvider = 'github' | 'gitlab' | 'bitbucket' | 'azure' | 'sourcehut' | 'codeberg' | 'gitea' | 'generic'

/** Extract owner/repo from a git remote URL. Returns null if unparseable. */
export function parseOwnerRepo(remoteUrl: string): { owner: string; repo: string } | null {
  const cleaned = remoteUrl.trim().replace(/\.git$/, '')

  // SSH: git@github.com:owner/repo
  const sshMatch = cleaned.match(/^(?:ssh:\/\/)?(?:[^@]+@)?[^:/]+[:/](.+)$/)
  if (sshMatch && !cleaned.startsWith('http')) {
    const parts = sshMatch[1].split('/')
    if (parts.length >= 2) {
      return { owner: parts[parts.length - 2], repo: parts[parts.length - 1] }
    }
  }

  // HTTPS: https://github.com/owner/repo
  try {
    const url = new URL(cleaned)
    const segments = url.pathname.replace(/^\/+|\/+$/g, '').split('/')
    if (segments.length >= 2) {
      return { owner: segments[segments.length - 2], repo: segments[segments.length - 1] }
    }
  } catch {
    // not a valid URL
  }
  return null
}

/** Detect the git hosting provider from a remote URL. */
export function detectProvider(remoteUrl: string): GitProvider {
  const normalized = remoteUrl.trim().replace(/\.git$/, '').toLowerCase()

  // Extract hostname from SSH or HTTPS
  let host = ''
  const sshMatch = normalized.match(/^(?:ssh:\/\/)?(?:[^@]+@)?([^:/]+)/)
  const httpMatch = normalized.match(/^https?:\/\/([^/]+)/)
  if (httpMatch) host = httpMatch[1]
  else if (sshMatch && !normalized.startsWith('http')) host = sshMatch[1]

  if (host.includes('github')) return 'github'
  if (host === 'gitlab.com' || host.includes('gitlab')) return 'gitlab'
  if (host === 'bitbucket.org' || host.includes('bitbucket')) return 'bitbucket'
  if (host === 'dev.azure.com' || host.endsWith('.visualstudio.com')) return 'azure'
  if (host === 'git.sr.ht') return 'sourcehut'
  if (host === 'codeberg.org') return 'codeberg'
  if (host.includes('gitea') || host.includes('forgejo')) return 'gitea'
  return 'generic'
}

/**
 * Convert a git remote URL to a web URL for viewing a specific commit.
 * Supports GitHub, GitLab, Bitbucket, Azure DevOps, Gitea, Codeberg, SourceHut, Forgejo.
 */
export function remoteUrlToCommitUrl(remoteUrl: string, hash: string): string | null {
  // Normalize: strip trailing .git
  let url = remoteUrl.trim().replace(/\.git$/, '')

  // Convert SSH to HTTPS
  // git@host:user/repo -> https://host/user/repo
  const sshMatch = url.match(/^(?:ssh:\/\/)?(?:[^@]+@)?([^:/]+)[:/](.+)$/)
  if (sshMatch && !url.startsWith('http')) {
    url = `https://${sshMatch[1]}/${sshMatch[2]}`
  }

  if (!url.startsWith('http')) return null

  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase()
    const path = parsed.pathname.replace(/^\/+|\/+$/g, '')

    // Azure DevOps: dev.azure.com/org/project/_git/repo
    if (host === 'dev.azure.com' || host.endsWith('.visualstudio.com')) {
      return `${parsed.origin}/${path}/commit/${hash}`
    }

    // SourceHut: git.sr.ht/~user/repo
    if (host === 'git.sr.ht') {
      return `${parsed.origin}/${path}/commit/${hash}`
    }

    // GitLab (self-hosted or gitlab.com): uses /-/commit/
    if (host === 'gitlab.com' || host.includes('gitlab')) {
      return `${parsed.origin}/${path}/-/commit/${hash}`
    }

    // Bitbucket: uses /commits/ (not /commit/)
    if (host === 'bitbucket.org' || host.includes('bitbucket')) {
      return `${parsed.origin}/${path}/commits/${hash}`
    }

    // GitHub, Gitea, Codeberg, Forgejo, and generic: /commit/
    return `${parsed.origin}/${path}/commit/${hash}`
  } catch {
    return null
  }
}
