import { describe, it, expect } from 'vitest'
import { getProvider, getAllProviders } from '../index'

describe('Provider Registry', () => {
  it('should return all four providers', () => {
    const providers = getAllProviders()
    expect(providers).toHaveLength(4)
    const ids = providers.map((p) => p.id)
    expect(ids).toContain('gcp')
    expect(ids).toContain('aws')
    expect(ids).toContain('azure')
    expect(ids).toContain('digitalocean')
  })

  it('should return GCP provider by id', () => {
    const provider = getProvider('gcp')
    expect(provider).toBeDefined()
    expect(provider!.id).toBe('gcp')
    expect(provider!.name).toBe('Google Cloud Platform')
  })

  it('should return AWS provider by id', () => {
    const provider = getProvider('aws')
    expect(provider).toBeDefined()
    expect(provider!.id).toBe('aws')
    expect(provider!.name).toBe('Amazon Web Services')
  })

  it('should return Azure provider by id', () => {
    const provider = getProvider('azure')
    expect(provider).toBeDefined()
    expect(provider!.id).toBe('azure')
    expect(provider!.name).toBe('Microsoft Azure')
  })

  it('should return DigitalOcean provider by id', () => {
    const provider = getProvider('digitalocean')
    expect(provider).toBeDefined()
    expect(provider!.id).toBe('digitalocean')
    expect(provider!.name).toBe('DigitalOcean')
  })

  it('should return undefined for unknown provider', () => {
    const provider = getProvider('unknown' as any)
    expect(provider).toBeUndefined()
  })

  it('all providers should implement getIcon returning SVG', () => {
    for (const p of getAllProviders()) {
      const icon = p.getIcon()
      expect(icon).toContain('<svg')
      expect(icon).toContain('</svg>')
    }
  })

  it('all providers should implement toInfo', () => {
    for (const p of getAllProviders()) {
      const info = p.toInfo(true)
      expect(info.id).toBe(p.id)
      expect(info.name).toBe(p.name)
      expect(info.available).toBe(true)
      expect(info.icon).toContain('<svg')
      expect(info.consoleBaseUrl).toMatch(/^https:\/\//)

      const infoFalse = p.toInfo(false)
      expect(infoFalse.available).toBe(false)
    }
  })

  it('all providers should implement getConsoleUrl for all sections', () => {
    const sections = ['dashboard', 'clusters', 'workloads', 'cluster', 'workload'] as const
    for (const p of getAllProviders()) {
      for (const section of sections) {
        const url = p.getConsoleUrl(section, { name: 'test', namespace: 'default', location: 'us-central1-a' })
        expect(url).toMatch(/^https:\/\//)
      }
    }
  })
})
