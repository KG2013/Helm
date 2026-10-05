# Issue #48 验证记录

核对日期：2026-10-05。

本 issue 补齐了两类横向安全门禁：

- SQLite 读取器把事件类型作为持久化字符串处理。新版本写入的未知事件会原样保留、脱敏导出，旧 reducer 忽略该事件并继续回放 Run；不会因为事件类型扩展而阻断 list/replay/export。
- `evaluateReleaseGate` 现在检查终态、验证证据、持久预算、通用 Action 审批/receipt、Agent 子结果、Connector/Browser reconciliation、A2A delivery 和凭据泄漏。成功结果缺少结构化 evidence、动作仍待审批、子 Agent 未完成、预算超限、queued/sent/unknown/failed 投递和未对账副作用都会返回可观察 reason 并阻断。

新增回归覆盖：

- SQLite 中注入未来事件后 list、replay、redacted export 仍成功，未知类型和私有字段处理保持可审计。
- Release Gate 对 pending action、Agent failure、budget overrun、Connector/Browser reconciliation gap 返回 blocked。
- 具备 evidence-backed action/reconciliation 和有效 A2A ack receipt hash 的完成案例可通过。
- Reconciliation 只有非空且满足 `type`/`summary` 结构的 evidence 才能 mark-known/failed。

验证命令：

```bash
pnpm test
pnpm build
pnpm typecheck
git diff --check
```

真实 Docker、Provider 和 Office/OCR 的环境证据仍由 #47 及后续目标环境验收提供；A2A 只验收本机 Loopback 状态，本 issue 只负责让缺失、失败和未知状态可靠地阻断交付。
