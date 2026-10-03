# Issue #15 验收证据

Issue：T10 P1 context compaction and Experience Candidate review

## 代码边界

- ContextAssembler 保留 Pinned/Recent/Cold source 与 version；ProviderContext 的 gaps 记录 compaction 丢弃、缩短和裁剪信息，ToolCall/ToolResult 成对删除。
- `ProviderRequest.context` 现在经过 Runtime 的 bounded/redacted event projection，最多保留最近 80 个事件并受字节上限约束；原始账本不会直接进入 Provider。
- UsageLedger 的 token、cost、latency、retry、cache budget 和 request-ID dedup 继续硬停止；Run 的 checkpoint/owner state 跨独立 Runtime 恢复。
- Experience Candidate 以事件账本持久化，可通过 Runtime 查询和按 ID 审核；候选包含 source Episode/Trace、applicability、validation/cost/approval state。Reviewer round budget 超限会拒绝后续审核。
- Candidate 只有显式 validation + approval + cost checks 才能 promotion；Runtime 不会自动改写 Skill、Memory、Policy 或 Harness。

## 验证

```text
pnpm --filter @helm/runtime build
pnpm --filter @helm/runtime exec tsx --test test/workspace-inspect.test.ts test/runtime.test.ts
```

结果：Runtime build 通过；组合测试 33/33 通过，覆盖 bounded/redacted ProviderRequest context、compaction gap、ToolCall/ToolResult 配对、Usage budget、独立 owner 恢复和 Candidate 查询/审核/round limit。

## 限制

Experience Candidate 当前通过 Runtime 事件账本查询，尚未提供独立候选列表 UI；生产行为仍保持显式审核后才可 promotion。Context 上限和 reviewer round 上限是可观测的硬边界，超限会保留 gap 或拒绝操作。
