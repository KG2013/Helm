# Helm 公共测试 seam

实现阶段先验证公共接口，不锁定内部实现。

| seam | 行为 | 验证方式 |
|---|---|---|
| Runtime Facade | 创建 Task/Session/Run，推进、暂停、恢复、取消并查询状态 | Runtime 行为测试 |
| Event Ledger | 事件追加、状态投影、重启后 replay、未知事件拒绝 | 持久化契约测试 |
| Provider Adapter | 规范化请求、流式事件、工具调用和错误映射 | Mock provider contract test |
| Tool/Policy | schema、workspace path、allow/ask/deny、approval 和 receipt 顺序 | Policy 行为测试 |
| Verifier | coding/office verifier 产生通过、失败、UNKNOWN 及证据引用 | fixture tests |
| CLI | 人类输出与 JSON 事件输出调用同一个 Runtime contract | CLI smoke test |
| Desktop IPC | Renderer 只能通过 typed preload 请求 Runtime 操作 | Electron IPC smoke test |
