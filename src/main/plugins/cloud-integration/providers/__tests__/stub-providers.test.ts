import { describe, it, expect } from 'vitest'
import { AwsProvider } from '../aws-provider'
import { AzureProvider } from '../azure-provider'
import { DigitalOceanProvider } from '../digitalocean-provider'

describe('AWS Provider Stub', () => {
  const provider = new AwsProvider()

  it('should have correct metadata', () => {
    expect(provider.id).toBe('aws')
    expect(provider.name).toBe('Amazon Web Services')
    expect(provider.consoleBaseUrl).toBe('https://console.aws.amazon.com')
  })

  it('should return false for checkAuth (not implemented)', async () => {
    expect(await provider.checkAuth()).toBe(false)
  })

  it('should throw on getProject', async () => {
    await expect(provider.getProject()).rejects.toThrow('not yet implemented')
  })

  it('should throw on getKubernetesSummary', async () => {
    await expect(provider.getKubernetesSummary()).rejects.toThrow('not yet implemented')
  })

  it('should throw on getClusters', async () => {
    await expect(provider.getClusters()).rejects.toThrow('not yet implemented')
  })

  it('should throw on getClusterDetail', async () => {
    await expect(provider.getClusterDetail('test')).rejects.toThrow('not yet implemented')
  })

  it('should throw on getWorkloads', async () => {
    await expect(provider.getWorkloads()).rejects.toThrow('not yet implemented')
  })

  it('should throw on getWorkloadDetail', async () => {
    await expect(provider.getWorkloadDetail('c', 'ns', 'w', 'Deployment')).rejects.toThrow('not yet implemented')
  })

  it('should return valid console URLs', () => {
    expect(provider.getConsoleUrl('dashboard')).toContain('console.aws.amazon.com')
    expect(provider.getConsoleUrl('clusters')).toContain('eks')
    expect(provider.getConsoleUrl('workloads')).toContain('eks')
  })
})

describe('Azure Provider Stub', () => {
  const provider = new AzureProvider()

  it('should have correct metadata', () => {
    expect(provider.id).toBe('azure')
    expect(provider.name).toBe('Microsoft Azure')
    expect(provider.consoleBaseUrl).toBe('https://portal.azure.com')
  })

  it('should return false for checkAuth (not implemented)', async () => {
    expect(await provider.checkAuth()).toBe(false)
  })

  it('should throw on getProject', async () => {
    await expect(provider.getProject()).rejects.toThrow('not yet implemented')
  })

  it('should throw on getClusters', async () => {
    await expect(provider.getClusters()).rejects.toThrow('not yet implemented')
  })

  it('should return valid console URLs', () => {
    expect(provider.getConsoleUrl('dashboard')).toContain('portal.azure.com')
    expect(provider.getConsoleUrl('clusters')).toContain('ContainerService')
  })
})

describe('DigitalOcean Provider Stub', () => {
  const provider = new DigitalOceanProvider()

  it('should have correct metadata', () => {
    expect(provider.id).toBe('digitalocean')
    expect(provider.name).toBe('DigitalOcean')
    expect(provider.consoleBaseUrl).toBe('https://cloud.digitalocean.com')
  })

  it('should return false for checkAuth (not implemented)', async () => {
    expect(await provider.checkAuth()).toBe(false)
  })

  it('should throw on getProject', async () => {
    await expect(provider.getProject()).rejects.toThrow('not yet implemented')
  })

  it('should throw on getClusters', async () => {
    await expect(provider.getClusters()).rejects.toThrow('not yet implemented')
  })

  it('should return valid console URLs', () => {
    expect(provider.getConsoleUrl('dashboard')).toContain('cloud.digitalocean.com')
    expect(provider.getConsoleUrl('clusters')).toContain('kubernetes')
  })
})
