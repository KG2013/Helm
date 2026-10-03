# Issue #14 验收证据

Issue：T9 Independent Runtime ownership and reconnect

## 代码边界

- Desktop/CLI 通过同一个 Runtime Facade、EventStore、Policy、Approval、Artifact 和 Verification 合同操作 Run；观察层断开不会改变执行权限。
- Runtime shutdown 将活动 Run 安全暂停并写入 `run.owner_released`，SQLite projection 保留 Run、Checkpoint、Approval、Receipt、Usage 和 budget。
- SQLite lease acquisition 是原子的；旧 owner 或未过期 lease 的客户端控制会被拒绝，lease 释放后新 Runtime 才能 claim。
- pending Approval 由新 Runtime 从事件账本 hydrate，重新校验 action hash、Tool Profile、Policy、principal、workspace 和 TTL 后才能执行。

## 验证

```text
pnpm --filter @helm/runtime exec tsx --test test/sqlite-store.test.ts
```

结果：SQLite 测试 9/9 通过，覆盖迁移、序列化 append、跨实例 lease、shutdown/reconnect、完成 Run 重开、独立子进程重开、独立子进程 claim owner 并解决 pending Approval，以及 unresolved tool call 的 reconciliation。

独立进程测试实际关闭第一 Runtime，重新打开同一个 SQLite 文件，恢复 Approval/Run/Checkpoint，并在第二进程完成工具和最终验证；这不是内存 mock 的重放。

## 限制

当前测试使用 Node 子进程作为独立 Runtime owner；Electron 打包重启和真实 CLI/桌面跨窗口连接仍属于相同 Runtime 合同上的集成环境验收，未宣称为本机完整打包测试。
