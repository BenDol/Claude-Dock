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
