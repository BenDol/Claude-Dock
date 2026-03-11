import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as os from 'os'

describe('shell utilities', () => {
  const originalPlatform = process.platform
  const originalEnv = { ...process.env }

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
    process.env = { ...originalEnv }
    vi.resetModules()
  })

  describe('getDefaultShell', () => {
    it('returns COMSPEC on Windows', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      process.env.COMSPEC = 'C:\\Windows\\System32\\cmd.exe'
      const { getDefaultShell } = await import('../util/shell')
      expect(getDefaultShell()).toBe('C:\\Windows\\System32\\cmd.exe')
    })

    it('falls back to cmd.exe when COMSPEC is unset on Windows', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      delete process.env.COMSPEC
      const { getDefaultShell } = await import('../util/shell')
      expect(getDefaultShell()).toBe('cmd.exe')
    })

    it('returns SHELL on Unix', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' })
      process.env.SHELL = '/usr/bin/zsh'
      const { getDefaultShell } = await import('../util/shell')
      expect(getDefaultShell()).toBe('/usr/bin/zsh')
    })

    it('falls back to /bin/bash when SHELL is unset on Unix', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' })
      delete process.env.SHELL
      const { getDefaultShell } = await import('../util/shell')
      expect(getDefaultShell()).toBe('/bin/bash')
    })
  })

  describe('getShellArgs', () => {
    it('returns ["-NoLogo"] for PowerShell on Windows', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      const { getShellArgs } = await import('../util/shell')
      expect(getShellArgs('C:\\Windows\\PowerShell\\powershell.exe')).toEqual(['-NoLogo'])
    })

    it('returns ["-NoLogo"] for pwsh', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      const { getShellArgs } = await import('../util/shell')
      expect(getShellArgs('pwsh.exe')).toEqual(['-NoLogo'])
    })

    it('returns [] for cmd.exe on Windows', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      const { getShellArgs } = await import('../util/shell')
      expect(getShellArgs('cmd.exe')).toEqual([])
    })

    it('returns ["-l"] on Unix for login shell', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' })
      const { getShellArgs } = await import('../util/shell')
      expect(getShellArgs('/bin/bash')).toEqual(['-l'])
    })
  })

  describe('getDefaultCwd', () => {
    it('returns the user home directory', async () => {
      const { getDefaultCwd } = await import('../util/shell')
      expect(getDefaultCwd()).toBe(os.homedir())
    })
  })
})
