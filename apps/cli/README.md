# Helm CLI

CLI 与桌面端共用 `@helm/runtime` 的目标架构。当前命令使用 `MockProvider` 和 `InMemoryEventStore` 验证 Task → Session → Run → Event Ledger → Verification 的本地闭环；它不会调用真实模型、文件工具或 SQLite。

```bash
pnpm --filter @helm/cli dev -- run "inspect the Helm workspace"
pnpm --filter @helm/cli build
pnpm --filter @helm/cli start -- run "produce a local report"
```

真实 DeepSeek、智谱、Kimi Provider、Keychain 凭据读取、JSONL 事件模式、运行控制子命令与受限工具执行将在后续切片接入。
