import { describe, it, expect } from 'vitest'
import { remoteUrlToCommitUrl, detectProvider } from '../remote-url'

const HASH = 'abc123def456'

describe('remoteUrlToCommitUrl', () => {
  describe('GitHub', () => {
    it('HTTPS URL', () => {
      expect(remoteUrlToCommitUrl('https://github.com/user/repo.git', HASH))
        .toBe(`https://github.com/user/repo/commit/${HASH}`)
    })

    it('HTTPS URL without .git', () => {
      expect(remoteUrlToCommitUrl('https://github.com/user/repo', HASH))
        .toBe(`https://github.com/user/repo/commit/${HASH}`)
    })

    it('SSH URL', () => {
      expect(remoteUrlToCommitUrl('git@github.com:user/repo.git', HASH))
        .toBe(`https://github.com/user/repo/commit/${HASH}`)
    })

    it('SSH URL without .git', () => {
      expect(remoteUrlToCommitUrl('git@github.com:user/repo', HASH))
        .toBe(`https://github.com/user/repo/commit/${HASH}`)
    })
  })

  describe('GitLab', () => {
    it('HTTPS URL', () => {
      expect(remoteUrlToCommitUrl('https://gitlab.com/user/repo.git', HASH))
        .toBe(`https://gitlab.com/user/repo/-/commit/${HASH}`)
    })

    it('SSH URL', () => {
      expect(remoteUrlToCommitUrl('git@gitlab.com:user/repo.git', HASH))
        .toBe(`https://gitlab.com/user/repo/-/commit/${HASH}`)
    })

    it('self-hosted GitLab', () => {
      expect(remoteUrlToCommitUrl('https://gitlab.mycompany.com/team/project.git', HASH))
        .toBe(`https://gitlab.mycompany.com/team/project/-/commit/${HASH}`)
    })
  })

  describe('Bitbucket', () => {
    it('HTTPS URL', () => {
      expect(remoteUrlToCommitUrl('https://bitbucket.org/user/repo.git', HASH))
        .toBe(`https://bitbucket.org/user/repo/commits/${HASH}`)
    })

    it('SSH URL', () => {
      expect(remoteUrlToCommitUrl('git@bitbucket.org:user/repo.git', HASH))
        .toBe(`https://bitbucket.org/user/repo/commits/${HASH}`)
    })
  })

  describe('Azure DevOps', () => {
    it('dev.azure.com HTTPS URL', () => {
      expect(remoteUrlToCommitUrl('https://dev.azure.com/org/project/_git/repo', HASH))
        .toBe(`https://dev.azure.com/org/project/_git/repo/commit/${HASH}`)
    })

    it('visualstudio.com HTTPS URL', () => {
      expect(remoteUrlToCommitUrl('https://org.visualstudio.com/project/_git/repo', HASH))
        .toBe(`https://org.visualstudio.com/project/_git/repo/commit/${HASH}`)
    })
  })

  describe('SourceHut', () => {
    it('HTTPS URL', () => {
      expect(remoteUrlToCommitUrl('https://git.sr.ht/~user/repo', HASH))
        .toBe(`https://git.sr.ht/~user/repo/commit/${HASH}`)
    })
  })

  describe('Codeberg / Gitea / Forgejo', () => {
    it('Codeberg HTTPS URL', () => {
      expect(remoteUrlToCommitUrl('https://codeberg.org/user/repo.git', HASH))
        .toBe(`https://codeberg.org/user/repo/commit/${HASH}`)
    })

    it('self-hosted Gitea', () => {
      expect(remoteUrlToCommitUrl('https://gitea.example.com/org/repo.git', HASH))
        .toBe(`https://gitea.example.com/org/repo/commit/${HASH}`)
    })
  })

  describe('SSH variations', () => {
    it('ssh:// protocol prefix', () => {
      expect(remoteUrlToCommitUrl('ssh://git@github.com/user/repo.git', HASH))
        .toBe(`https://github.com/user/repo/commit/${HASH}`)
    })

    it('custom SSH user', () => {
      expect(remoteUrlToCommitUrl('deploy@gitlab.com:user/repo.git', HASH))
        .toBe(`https://gitlab.com/user/repo/-/commit/${HASH}`)
    })
  })

  describe('edge cases', () => {
    it('returns null for local file path', () => {
      expect(remoteUrlToCommitUrl('/path/to/repo', HASH)).toBeNull()
    })

    it('returns null for empty string', () => {
      expect(remoteUrlToCommitUrl('', HASH)).toBeNull()
    })

    it('handles whitespace around URL', () => {
      expect(remoteUrlToCommitUrl('  https://github.com/user/repo.git  ', HASH))
        .toBe(`https://github.com/user/repo/commit/${HASH}`)
    })

    it('handles nested groups (GitLab)', () => {
      expect(remoteUrlToCommitUrl('https://gitlab.com/group/subgroup/repo.git', HASH))
        .toBe(`https://gitlab.com/group/subgroup/repo/-/commit/${HASH}`)
    })
  })
})

describe('detectProvider', () => {
  it('detects GitHub HTTPS', () => {
    expect(detectProvider('https://github.com/user/repo.git')).toBe('github')
  })

  it('detects GitHub SSH', () => {
    expect(detectProvider('git@github.com:user/repo.git')).toBe('github')
  })

  it('detects GitLab HTTPS', () => {
    expect(detectProvider('https://gitlab.com/user/repo.git')).toBe('gitlab')
  })

  it('detects self-hosted GitLab', () => {
    expect(detectProvider('https://gitlab.mycompany.com/team/repo.git')).toBe('gitlab')
  })

  it('detects Bitbucket HTTPS', () => {
    expect(detectProvider('https://bitbucket.org/user/repo.git')).toBe('bitbucket')
  })

  it('detects Bitbucket SSH', () => {
    expect(detectProvider('git@bitbucket.org:user/repo.git')).toBe('bitbucket')
  })

  it('detects Azure DevOps', () => {
    expect(detectProvider('https://dev.azure.com/org/project/_git/repo')).toBe('azure')
  })

  it('detects Azure DevOps visualstudio.com', () => {
    expect(detectProvider('https://org.visualstudio.com/project/_git/repo')).toBe('azure')
  })

  it('detects SourceHut', () => {
    expect(detectProvider('https://git.sr.ht/~user/repo')).toBe('sourcehut')
  })

  it('detects Codeberg', () => {
    expect(detectProvider('https://codeberg.org/user/repo.git')).toBe('codeberg')
  })

  it('detects Gitea self-hosted', () => {
    expect(detectProvider('https://gitea.example.com/org/repo.git')).toBe('gitea')
  })

  it('detects Forgejo', () => {
    expect(detectProvider('https://forgejo.example.com/org/repo.git')).toBe('gitea')
  })

  it('returns generic for unknown host', () => {
    expect(detectProvider('https://myserver.com/repo.git')).toBe('generic')
  })

  it('returns generic for local path', () => {
    expect(detectProvider('/path/to/repo')).toBe('generic')
  })
})
