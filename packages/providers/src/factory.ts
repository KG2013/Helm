import { OpenAICompatibleProvider, type OpenAICompatibleProviderOptions } from './openai-compatible.js'
import { providerConfigFromEnv, type ProviderEnvironment } from './catalog.js'

export function createProviderFromEnv(options: {
  env?: ProviderEnvironment
  getApiKey?: (keychainService: string) => Promise<string | undefined> | string | undefined
  fetchImpl?: OpenAICompatibleProviderOptions['fetchImpl']
}): OpenAICompatibleProvider | undefined {
  const config = providerConfigFromEnv(options.env)
  if (!config) return undefined
  return new OpenAICompatibleProvider({
    id: config.entry.id,
    model: config.model,
    baseUrl: config.baseUrl,
    getApiKey: options.getApiKey ? () => options.getApiKey!(config.keychainService) : undefined,
    fetchImpl: options.fetchImpl,
  })
}
