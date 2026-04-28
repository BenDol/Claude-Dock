/**
 * Provider preset catalog + factory.
 *
 * Each preset captures the minimum the UI needs to configure a provider:
 * default endpoint, default model, and whether an API key is required.
 * The orchestrator calls `createProvider(id, config)` to get an LLMProvider
 * instance tuned to the selected backend.
 *
 * Anthropic access is API-key only — see the `'anthropic'` preset below.
 * Subscription-based backends (the bundled `claude` CLI, the
 * `@anthropic-ai/claude-agent-sdk` passthrough) were removed in favour of
 * direct HTTPS to api.anthropic.com.
 */

import type { CoordinatorProviderId, CoordinatorProviderPreset } from '../../../../shared/coordinator-types'
import type { LLMProvider, ProviderConfig } from './provider'
import { createOpenAICompatProvider } from './openai-compat'
import { createAnthropicProvider } from './anthropic'
import { createGeminiProvider } from './gemini'
import { createOllamaProvider } from './ollama'

export const PROVIDER_PRESETS: Record<CoordinatorProviderId, CoordinatorProviderPreset> = {
  groq: {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    requiresApiKey: true,
    docsUrl: 'https://console.groq.com/keys'
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4.1-mini',
    requiresApiKey: true,
    docsUrl: 'https://platform.openai.com/api-keys'
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'meta-llama/llama-3.3-70b-instruct',
    requiresApiKey: true,
    docsUrl: 'https://openrouter.ai/keys'
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    requiresApiKey: true,
    docsUrl: 'https://platform.deepseek.com/api_keys'
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    defaultModel: 'claude-haiku-4-5-20251001',
    requiresApiKey: true,
    docsUrl: 'https://console.anthropic.com/settings/keys'
  },
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    defaultModel: 'gemini-2.5-flash',
    requiresApiKey: true,
    docsUrl: 'https://aistudio.google.com/apikey'
  },
  ollama: {
    id: 'ollama',
    label: 'Ollama (local)',
    baseUrl: 'http://localhost:11434',
    defaultModel: 'llama3.3',
    requiresApiKey: false,
    docsUrl: 'https://ollama.com/download'
  },
  'openai-compat': {
    id: 'openai-compat',
    label: 'OpenAI-compatible (custom)',
    defaultModel: '',
    requiresApiKey: false
  }
}

export function listProviderPresets(): CoordinatorProviderPreset[] {
  return Object.values(PROVIDER_PRESETS)
}

export function getPreset(id: CoordinatorProviderId): CoordinatorProviderPreset {
  return PROVIDER_PRESETS[id]
}

export function createProvider(
  id: CoordinatorProviderId,
  config: ProviderConfig
): LLMProvider {
  switch (id) {
    case 'groq':
    case 'openai':
    case 'openrouter':
    case 'deepseek':
    case 'openai-compat':
      return createOpenAICompatProvider(id, config)
    case 'anthropic':
      return createAnthropicProvider(config)
    case 'gemini':
      return createGeminiProvider(config)
    case 'ollama':
      return createOllamaProvider(config)
    default: {
      const _exhaustive: never = id
      throw new Error(`Unknown provider id: ${_exhaustive}`)
    }
  }
}
