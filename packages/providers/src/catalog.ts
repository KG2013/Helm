export type SupportedProvider = 'deepseek' | 'zhipu' | 'kimi'

export interface ProviderCatalogEntry {
  id: SupportedProvider
  label: string
  defaultBaseUrl: string
  defaultModel: string
  defaultKeychainService: string
  streaming: boolean
}

/**
 * Vendor names are stable Helm identifiers. Endpoint URLs and models remain
 * user configuration so this catalog does not bake in stale account defaults.
 */
export const providerCatalog: Readonly<Record<SupportedProvider, ProviderCatalogEntry>> = {
  deepseek: { id: 'deepseek', label: 'DeepSeek', defaultBaseUrl: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-chat', defaultKeychainService: 'com.helm.provider.deepseek', streaming: true },
  zhipu: { id: 'zhipu', label: '智谱 GLM', defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4', defaultModel: 'glm-4-flash', defaultKeychainService: 'com.helm.provider.zhipu', streaming: true },
  kimi: { id: 'kimi', label: 'Kimi', defaultBaseUrl: 'https://api.kimi.com/coding/v1', defaultModel: 'kimi-for-coding', defaultKeychainService: 'com.helm.provider.kimi-code', streaming: false },
}

export interface ProviderEnvironment {
  HELM_PROVIDER?: string
  HELM_PROVIDER_BASE_URL?: string
  HELM_PROVIDER_MODEL?: string
  HELM_PROVIDER_KEYCHAIN_SERVICE?: string
  [key: string]: string | undefined
}

export function providerConfigFromEnv(env: ProviderEnvironment = {}): { entry: ProviderCatalogEntry; model: string; baseUrl: string; keychainService: string } | undefined {
  const id = env.HELM_PROVIDER?.toLowerCase() as SupportedProvider | undefined
  if (!id || !(id in providerCatalog)) return undefined
  const entry = providerCatalog[id]
  const prefix = `HELM_${id.toUpperCase()}`
  return {
    entry,
    model: env[`${prefix}_MODEL`] ?? env.HELM_PROVIDER_MODEL ?? entry.defaultModel,
    baseUrl: env[`${prefix}_BASE_URL`] ?? env.HELM_PROVIDER_BASE_URL ?? entry.defaultBaseUrl,
    keychainService: env[`${prefix}_KEYCHAIN_SERVICE`] ?? env.HELM_PROVIDER_KEYCHAIN_SERVICE ?? entry.defaultKeychainService,
  }
}
