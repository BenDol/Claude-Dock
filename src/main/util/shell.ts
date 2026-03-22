import * as os from 'os'

export function getDefaultShell(): string {
  if (process.platform === 'win32') {
    return process.env.COMSPEC || 'cmd.exe'
  }
  return process.env.SHELL || '/bin/bash'
}

export function getShellArgs(shell: string): string[] {
  if (process.platform === 'win32') {
    // For PowerShell, no extra args needed
    if (shell.toLowerCase().includes('powershell') || shell.toLowerCase().includes('pwsh')) {
      return ['-NoLogo']
    }
    return []
  }
  return ['-l'] // login shell on Unix
}

export function getDefaultCwd(): string {
  return os.homedir()
}

/**
 * Resolve a shell preference ('default', 'bash', 'cmd', 'powershell', 'pwsh')
 * into an executable path and arguments.
 */
export function resolveShell(preference: string): { shell: string; args: string[] } {
  if (preference === 'default') {
    const shell = getDefaultShell()
    return { shell, args: getShellArgs(shell) }
  }

  if (process.platform === 'win32') {
    switch (preference) {
      case 'cmd':
        return { shell: process.env.COMSPEC || 'cmd.exe', args: [] }
      case 'powershell':
        return { shell: 'powershell.exe', args: ['-NoLogo'] }
      case 'pwsh':
        return { shell: 'pwsh.exe', args: ['-NoLogo'] }
      case 'bash': {
        // Try Git Bash first, then fall back to bash (WSL/MSYS)
        const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe'
        try {
          require('fs').accessSync(gitBash)
          return { shell: gitBash, args: ['--login'] }
        } catch {
          return { shell: 'bash.exe', args: ['--login'] }
        }
      }
    }
  }

  // Unix
  switch (preference) {
    case 'bash':
      return { shell: '/bin/bash', args: ['-l'] }
    case 'pwsh':
      return { shell: 'pwsh', args: ['-NoLogo'] }
    default:
      return { shell: preference, args: [] }
  }
}
