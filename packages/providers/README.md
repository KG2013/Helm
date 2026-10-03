# Helm Providers

`@helm/providers` 提供一个无厂商锁定的 OpenAI-compatible HTTP transport seam，并登记 DeepSeek、智谱 GLM、Kimi 三个稳定的 Helm provider id。适配器接收 Runtime 的结构化消息、Context、Tool schema 和 ToolResult，记录 request/attempt/trace、usage/cost，并把 HTTP、取消、超时和传输错误归一为可重试分类。三家 provider 使用同一配置解析器；凭据仍由 CLI/Desktop 组合层从 Keychain 解析，未配置凭据时请求会按认证失败处理。

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

CLI 和 Desktop 设置 `HELM_PROVIDER=deepseek|zhipu|kimi` 后，会从对应的 Keychain service 读取凭据。默认 endpoint/model 可用 `HELM_<PROVIDER>_BASE_URL`、`HELM_<PROVIDER>_MODEL` 和 `HELM_<PROVIDER>_KEYCHAIN_SERVICE` 覆盖；也支持通用的 `HELM_PROVIDER_*` 覆盖。真实 provider smoke 与 fixture 结果必须分开记录。
