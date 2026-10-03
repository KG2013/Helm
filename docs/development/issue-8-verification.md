# Issue #8 验收证据

Issue：T3 Provider-neutral Context and Tool contract

## 代码边界

- `ProviderRequest` 统一承载结构化 messages、bounded Context envelope、Tool schemas、Tool Results、request/attempt/trace IDs、AbortSignal/timeout、usage/cost 和 retryable failure taxonomy。
- `OpenAICompatibleProvider` 将 DeepSeek、智谱 GLM、Kimi 的 wire format 收敛到同一 adapter；Provider 不拥有 Task 状态、Approval 或本地权限。
- `providerCatalog` 与 `createProviderFromEnv` 为三家 provider 提供稳定 ID、endpoint/model/keychain service 配置；密钥只由 CLI/Desktop 组合层读取。
- `stream()` 支持 normalized unary fallback 和 OpenAI-compatible SSE text/tool deltas；Runtime 仍以 bounded `complete()` 为默认执行入口。

## 验证

```text
pnpm --filter @helm/providers exec tsx --test test/provider.test.ts
pnpm --filter @helm/providers build
pnpm --filter @helm/cli build
pnpm --filter @helm/desktop build
```

Provider suite 8/8 通过，覆盖三家 capability/tool fixtures、结构化 Context/ToolResult、usage/cost、request IDs、HTTP 分类、取消、timeout、unary fallback 和 SSE tool deltas。Kimi Code Keychain-backed 文本 smoke 已在前一验证记录中通过；DeepSeek/智谱真实凭据调用不在本机宣称完成，使用相同 adapter 和 fixture 合同。
