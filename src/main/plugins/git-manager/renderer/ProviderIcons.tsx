import React from 'react'
import type { GitProvider } from '../../../../shared/remote-url'

const GitHubIcon: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
  </svg>
)

const GitLabIcon: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
    <path d="M22.65 14.39L12 22.13 1.35 14.39a.84.84 0 01-.3-.94l1.22-3.78 2.44-7.51A.42.42 0 014.82 2a.43.43 0 01.58 0 .42.42 0 01.11.18l2.44 7.49h8.1l2.44-7.51A.42.42 0 0118.6 2a.43.43 0 01.58 0 .42.42 0 01.11.18l2.44 7.51L23 13.45a.84.84 0 01-.35.94z" />
  </svg>
)

const BitbucketIcon: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
    <path d="M.778 1.213a.768.768 0 00-.768.892l3.263 19.81c.084.5.515.868 1.022.873H19.95a.772.772 0 00.77-.646l3.27-20.03a.768.768 0 00-.768-.891zM14.52 15.53H9.522L8.17 8.466h7.561z" />
  </svg>
)

const AzureDevOpsIcon: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
    <path d="M0 8.877L2.247 5.91l8.405-3.416V.022l7.37 5.393L2.966 8.338v8.225L0 15.707zm24-4.45v14.651l-5.753 4.9-9.303-3.057v3.056l-5.978-7.416 15.057 1.39V2.476z" />
  </svg>
)

const SourceHutIcon: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
    <circle cx="12" cy="12" r="11" />
  </svg>
)

const CodebergIcon: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 1C5.925 1 1 5.925 1 12s4.925 11 11 11 11-4.925 11-11S18.075 1 12 1zm4.834 17.09L12 14.156 7.166 18.09 8.834 12 4 8.91l5.834-.001L12 3l2.166 5.91L20 8.91 15.166 12z" />
  </svg>
)

const GiteaIcon: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
    <path d="M4.186 2.592C3.07 3.636 2.49 5.04 2.49 6.906c0 3.24 1.89 5.448 5.466 6.544l.09.028c1.456.445 2.42.834 2.89 1.167.456.322.684.764.684 1.324 0 .624-.256 1.106-.765 1.452-.518.35-1.278.526-2.274.526-1.18 0-2.174-.255-2.987-.762a4.98 4.98 0 01-1.68-1.858l-.026-.048-2.32 1.652.026.05c.594 1.12 1.474 2.014 2.634 2.68 1.162.665 2.574 1.002 4.23 1.002 2.094 0 3.78-.504 5.04-1.506 1.264-1.004 1.9-2.368 1.9-4.088 0-1.476-.434-2.642-1.298-3.492-.862-.85-2.224-1.558-4.074-2.126l-.09-.028c-1.512-.466-2.524-.866-3.028-1.2-.488-.326-.732-.756-.732-1.29 0-.556.226-.994.68-1.316.458-.326 1.112-.49 1.96-.49 1.83 0 3.19.738 4.078 2.214l.028.046 2.164-1.526-.028-.048C14.35 4.056 12.534 2.8 10.286 2.42L12 .588 10.012.002 8.06 2.098c-.448-.042-.88-.064-1.282-.064-1.856 0-3.396.516-4.592 1.558z" />
  </svg>
)

const GenericWebIcon: React.FC = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <line x1="2" y1="12" x2="22" y2="12" />
    <path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" />
  </svg>
)

export const ProviderIcon: React.FC<{ provider: GitProvider }> = ({ provider }) => {
  switch (provider) {
    case 'github': return <GitHubIcon />
    case 'gitlab': return <GitLabIcon />
    case 'bitbucket': return <BitbucketIcon />
    case 'azure': return <AzureDevOpsIcon />
    case 'sourcehut': return <SourceHutIcon />
    case 'codeberg': return <CodebergIcon />
    case 'gitea': return <GiteaIcon />
    default: return <GenericWebIcon />
  }
}

export function providerLabel(provider: GitProvider): string {
  switch (provider) {
    case 'github': return 'GitHub'
    case 'gitlab': return 'GitLab'
    case 'bitbucket': return 'Bitbucket'
    case 'azure': return 'Azure DevOps'
    case 'sourcehut': return 'SourceHut'
    case 'codeberg': return 'Codeberg'
    case 'gitea': return 'Gitea'
    default: return 'Web'
  }
}
