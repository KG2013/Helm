# Issue #7 验收证据

Issue：T2 SQLite Checkpoint and restart recovery

## 代码边界

- `SqliteEventStore` 提供 schema migration、WAL、事务、append-only sequence、durable projections、Checkpoint、Receipt、Verification 和脱敏 JSONL export。
- Runtime 重启时从 SQLite replay Task/Session/Run；已完成 Run 不再次调用 Provider 或执行 Tool，pending Approval 可恢复，未决 Tool Receipt 进入 `needs_reconciliation`。
- owner lease 使用 SQLite 原子决策，shutdown 会写入安全释放事件，避免 stale owner 控制恢复后的 Run。

## 验证

`packages/runtime/test/sqlite-store.test.ts` 覆盖：并发 append 序列、migration/projection/export、跨实例 lease、owner release、完成 Run 不重复执行、Approval 恢复、unknown side effect reconciliation，以及通过独立 Node/tsx 子进程重新打开同一 SQLite 文件并恢复 Run/Checkpoint/JSONL 历史。

```text
pnpm --filter @helm/runtime exec tsx --test test/sqlite-store.test.ts
```

结果：8/8 通过。Node.js 22 的 `node:sqlite` experimental warning 属于运行时限制，不改变 fail-closed 恢复语义。
