# 当前实现状态

核对日期：2026-09-30。本文以本仓库代码为依据；[架构基线](../design/architecture-v0.md) 和 accepted ADR 表达目标，不代表 P0 已完成。

## 已建立的骨架

| 模块 | 当前代码行为 | 尚未完成 / 验证边界 |
|---|---|---|
| Workspace | pnpm monorepo，TypeScript，锁定依赖版本 | 桌面安装包和跨平台分发未验证 |
| Runtime | 创建 Task/Session/Run，状态转换，推进、暂停、恢复、取消方法 | 在途调用的中止、并发互斥和任意中间状态恢复尚不完整 |
| Event Ledger | 内存追加事件、Run 投影；SQLite store 接收注入的数据库接口 | 未接原生 SQLite；没有磁盘重启、事务或并发写入验证 |
| 元数据恢复 | 新 RuntimeFacade 从同一个内存 store 恢复 Task/Session，继续已暂停 Run | 不是退出应用后的持久恢复；checkpoint、JSONL 导出待实现 |
| Policy / Executor | 默认 deny；显式 allow 后执行；未配置执行器会失败 | ask 只暂停，还没有持久 Approval、精确批准和续执行协议 |
| 执行回执 | 失败且 receipt.sideEffect 为 unknown 时进入 needs_reconciliation | 普通抛错不会自动推断未知副作用；对账入口和完整异常路径待补 |
| Budget | 循环入口检查步骤和本次 run() 调用耗时 | 不会中止卡住的请求；跨恢复计时、Token/费用/reviewer 限额未执行 |
| Verifier | 非空文本 passed，空文本 unknown 并暂停 | 只验证演示输出存在，不证明 Coding/Office 任务达成 |
| Provider | 通用非流式 chat/completions 请求、首个 tool_call 映射、usage、HTTP 错误类；登记 deepseek/zhipu/kimi id | 没有三家真实 API 联调、工具 schema 下发、上下文/工具结果回传、流式和完整错误分类；getApiKey 只是回调接口 |
| CLI | MockProvider → Runtime → JSON 汇总 | 没有真实模型配置、文件操作、人类输出/JSONL 事件模式、运行控制子命令 |
| Desktop | 三栏 UI，中栏对话和执行卡片；隔离 Renderer 与 preload | 不依赖 Runtime；固定消息、定时器进度、输入清空和审批外观都是演示 |
| IPC | runtime-info、request-approval 占位 handler，run:event 订阅入口 | 没有创建 Run、发出运行事件、批准具体工具或取消任务的 IPC |
| Python worker | stdio JSONL health、inspect(path) 返回后缀/大小 | 当前只是协议骨架，尚未连接 Runtime；未实现 workspace path guard、sandbox、文档读写、OCR 或文件内容校验 |

Keychain、受限 shell、真实工件存储、Coding/Office verifier、Experience Candidate 均为后续实现。Electron 的 renderer sandbox 也不等于工具执行 sandbox。

## 验证记录

骨架验证使用 Node.js 22.23.1、pnpm 10.34.5、Python 3.9.6。维护本表时只记录实际执行的结果。

| 检查 | 已验证结果 | 实际覆盖 |
|---|---|---|
| `pnpm build` | 通过 | Runtime、Provider、CLI 输出及桌面 TypeScript/Vite/esbuild 构建 |
| `pnpm test` | 10 项通过 | Runtime 8 项、Provider 2 项；均使用本地测试与模拟响应 |
| `pnpm typecheck` | 通过 | Runtime、Provider、CLI；桌面检查在 build 中 |
| CLI 源码及构建产物启动 | Mock Run 返回 completed、文本 verification passed、9 个 Run 事件 | 不代表执行了用户目标中的实际操作 |
| Worker health / inspect | 返回成功结构化回执 | inspect 仅验证文件元数据 |
| 桌面开发预览 | 前序已启动 Vite/Electron 并预览界面 | 未完成真实 IPC、模型、审批、工件或打包版本端到端测试 |

Runtime 的 8 项测试覆盖状态机路径、内存回放与暂停/恢复、final 文本验收、注入工具回执、新 Facade 元数据恢复、未配置执行器失败、默认策略拒绝、显式未知副作用对账。Provider 的 2 项测试验证请求/文本/usage 映射及工具调用/HTTP 错误映射。

后续测试目标见 [公共测试接口](../design/test-seams.md)，实施顺序见 [下一步计划](next-steps.md)。
