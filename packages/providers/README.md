# Helm Providers

`@helm/providers` 提供一个无厂商锁定的非流式 OpenAI-compatible HTTP transport seam，并登记 DeepSeek、智谱 GLM、Kimi 三个稳定的 Helm provider id。当前使用 fake fetch 做契约测试；三家真实 API、stream、工具 schema、上下文历史、Keychain 和 Runtime 接线尚未完成。

```ts
import { OpenAICompatibleProvider } from '@helm/providers'

const provider = new OpenAICompatibleProvider({
  id: 'deepseek',
  model: 'deepseek-chat',
  baseUrl: process.env.HELM_PROVIDER_BASE_URL!,
  getApiKey: () => loadKeyFromKeychain('helm/deepseek'),
})
```

密钥解析由桌面端/CLI 的组合层负责；Provider 包不写入 Keychain，也不把密钥存到事件账本。不同厂商的实际模型名和 endpoint 通过配置注入。
