/**
 * Provider registry — maps provider IDs to their implementations.
 * Adding a new provider only requires adding it here and creating the class.
 */

import type { CloudProvider } from './cloud-provider'
import type { CloudProviderId } from '../../../../shared/cloud-types'
import { GcpProvider } from './gcp-provider'
import { AwsProvider } from './aws-provider'
import { AzureProvider } from './azure-provider'
import { DigitalOceanProvider } from './digitalocean-provider'

const providers = new Map<CloudProviderId, CloudProvider>()

function register(provider: CloudProvider): void {
  providers.set(provider.id, provider)
}

// Register all providers
register(new GcpProvider())
register(new AwsProvider())
register(new AzureProvider())
register(new DigitalOceanProvider())

export function getProvider(id: CloudProviderId): CloudProvider | undefined {
  return providers.get(id)
}

export function getAllProviders(): CloudProvider[] {
  return [...providers.values()]
}

export { type CloudProvider } from './cloud-provider'
