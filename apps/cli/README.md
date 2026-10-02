# Helm CLI

CLI 与桌面端共用 `@helm/runtime`。默认命令使用 `MockProvider` 和 `InMemoryEventStore` 验证 Task → Session → Run → Event Ledger → Verification；设置 `HELM_PROVIDER=kimi` 后会从 macOS Keychain 读取 Kimi Code Key，并通过 `OpenAICompatibleProvider` 发起真实请求。

```bash
pnpm --filter @helm/cli dev -- run "inspect the Helm workspace"
pnpm --filter @helm/cli build
pnpm --filter @helm/cli start -- run "produce a local report"
pnpm --filter @helm/cli start -- inspect README.md

# Kimi Code（Keychain service: com.helm.provider.kimi-code, account: helm）
HELM_PROVIDER=kimi pnpm --filter @helm/cli start -- run "summarize the Helm runtime"
```

当前 Kimi Code 默认使用 `https://api.kimi.com/coding/v1` 与 `kimi-for-coding`；可用 `HELM_KIMI_BASE_URL` 和 `HELM_KIMI_MODEL` 覆盖。Key 只从 Keychain 读取，不写入事件账本。
