# Helm Providers

`@helm/providers` 提供一个无厂商锁定的 OpenAI-compatible HTTP transport seam，并登记 DeepSeek、智谱 GLM、Kimi 三个稳定的 Helm provider id。适配器接收 Runtime 的结构化消息、Context、Tool schema 和 ToolResult，记录 request/attempt/trace、usage/cost，并把 HTTP、取消、超时和传输错误归一为可重试分类。当前测试使用 fake fetch；三家真实 API fixture 已分开于 Kimi 的文本 Keychain 冒烟，真实流式 SSE 仍未接入。

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
