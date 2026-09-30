export type SupportedProvider = 'deepseek' | 'zhipu' | 'kimi'

/**
 * Vendor names are stable Helm identifiers. Endpoint URLs and models remain
 * user configuration so this catalog does not bake in stale account defaults.
 */
export const providerCatalog: Readonly<Record<SupportedProvider, { id: SupportedProvider; label: string }>> = {
  deepseek: { id: 'deepseek', label: 'DeepSeek' },
  zhipu: { id: 'zhipu', label: '智谱 GLM' },
  kimi: { id: 'kimi', label: 'Kimi' },
}
