# Issue #46：Connector 与 Browser 状态持久化及重启恢复

核对日期：2026-10-05。

## 已实现

- `ConnectorRegistry` 和 `BrowserFixtureRegistry` 在 Runtime 创建时启动 EventStore replay，并通过 `Runtime.ready()` 作为 CLI/Desktop 的启动闸门。
- Connector profile、loopback target 的版本与 after hash 会在新 Runtime 中恢复；原始字段值不写入账本，重启后仍可执行 hash/version read-after-write 验证。
- Connector 的 ActionGateway receipt 可在重启后回放，重复 write 不再次调用 loopback adapter。
- Browser context/profile、导航 URL/origin、截图引用、context lifecycle 和最近一次 DOM hash 会恢复；已完成动作可幂等回放，关闭 context 仍需显式 reconnect。
- Connector profile 的 scope 写入事件前经过脱敏，token/secret 等字段不会进入 ledger/export。

## 验证

```text
pnpm --filter @helm/runtime test       # 101/101
pnpm build                             # passed
pnpm typecheck                         # passed
pnpm --filter @helm/desktop test       # 12/12
pnpm --filter @helm/desktop test:electron  # 2/2
git diff --check                       # passed
```

重启回归覆盖 InMemory EventStore 的新 Registry 实例；真实 SQLite/Electron packaged smoke 仍保持独立证据边界，未知副作用没有通过“仅存在元数据”被提升为成功。
