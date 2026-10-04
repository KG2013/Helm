# Issue #20：DeepSeek/智谱 Provider 联调切片

核对日期：2026-10-04。

本切片把 DeepSeek、智谱 GLM 的真实 Provider 路径接到 Runtime 的流式 seam，同时保留确定性 fixture 和真实环境边界：

- Provider catalog 为 DeepSeek、智谱启用 SSE 能力；Kimi 继续使用 unary fallback。Runtime 对声明 `streaming` 的 Provider 消费 `ProviderChunk`，汇总文本、工具调用增量、usage 和失败分类，再进入同一 `step.proposal`、UsageLedger 和 Verifier 流程。
- `createProviderFromEnv` 的 Keychain resolver 为空或读取失败时 fail-closed，不发起 HTTP 请求，返回不含凭据的认证诊断。凭据只在适配器请求头中短暂使用，事件与 Receipt 不保存 API Key 或 Authorization header。
- `step.proposal` 与 `usage.recorded` 增加有界 `providerTrace`/`requestSummary`：仅记录模型、transport、消息/上下文/工具数量、目标和输入字符数、耗时、重试次数及错误分类，不复制消息、文件、请求体或响应体。
- Provider fixture 覆盖三家 catalog、工具合同、SSE 文本/工具 delta、取消、超时、认证、限流和凭据缺失；Runtime fixture 验证 SSE 结果经过同一 Runtime 状态机并保留脱敏 trace。

## 验证边界

本机未配置 `com.helm.provider.deepseek` 或 `com.helm.provider.zhipu` Keychain 条目，且没有执行真实 API 请求；因此真实文本、工具调用、供应商 SSE、限流和认证 smoke 仍标为未验证，不能据 fixture 结果宣称真实联调通过。真实 smoke 需要在配置凭据的目标环境单独记录，并与 fixture 结果分开。
