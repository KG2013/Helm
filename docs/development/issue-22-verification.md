# Issue #22 验证记录：Electron 打包重启与多窗口恢复

核对日期：2026-10-04。

## 已实现

- Main 进程用 `DesktopWindowRegistry` 管理窗口生命周期；每个窗口按 Run 授权接收事件，按 `runId/sequence` 去重并丢弃过期序号，窗口关闭后立即注销。
- IPC source gate 接受已注册的 Electron 窗口，Run 控制/审批/导出/对账要求窗口先取得该 Run 授权；重连窗口读取合法 workspace 的 `runSnapshot` 时授权并触发 `Runtime.recoverRun`。
- `recoverRun` 在 snapshot 重连时补齐已有 receipt/observation，未确认的 tool call 保持 `needs_reconciliation`，不会重新执行已确认动作。
- 增加 packaged Electron 两次启动共享 SQLite 的 smoke；第二次启动读取同一 Run、状态和去重后的事件序列。

## 验证

- `pnpm --filter @helm/desktop test`：10/10 通过，覆盖窗口授权、事件去重、重连 snapshot 和既有 IPC 回归。
- `pnpm --filter @helm/desktop build`、`pnpm build`、`pnpm typecheck`：通过。
- `pnpm --filter @helm/desktop test:electron`：需要本机 Electron 可启动且构建产物存在；其中 packaged restart smoke 与原 production UI smoke 分开报告。

## 边界

窗口重载期间不缓存渲染器事件；重连必须通过 `runSnapshot` 从 SQLite 补齐。当前 smoke 使用本地 MockProvider 的快速 Run，未宣称真实长时 Provider、跨平台安装包或多机分布式窗口验证通过；真实未知副作用仍必须由 Runtime reconciliation 证据闸门解决。
