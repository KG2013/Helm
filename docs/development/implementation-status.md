# 当前实现状态

核对日期：2026-10-03。本文以本仓库代码为依据；[架构基线](../design/architecture-v0.md) 和 accepted ADR 表达目标，不代表 P0 已完成。

## 已建立的骨架

| 模块 | 当前代码行为 | 尚未完成 / 验证边界 |
|---|---|---|
| Workspace | pnpm monorepo，TypeScript，锁定依赖版本 | 桌面安装包和跨平台分发未验证 |
| Runtime | 创建 Task/Session/Run，状态转换，推进、暂停、恢复、取消；Runtime 维护 pending approval 与 approval resolution；版本化 Tool Registry、`workspace.inspect`、Coding read/edit/patch/test/diff、bounded Context/Tool schema/ToolResult、Provider request IDs 和 Run cancellation signal | 跨客户端 Runtime ownership/lease、Office verifier 与 CLI/Desktop Coding 工作台投影待补 |
| Event Ledger | 内存账本和原生 Node `node:sqlite` 账本；schema v1 migration、WAL/事务、append-only sequence、durable task/session/run/checkpoint/receipt/verification projections | 原生 SQLite 使用 Node 22 experimental API；跨客户端 ownership 和分布式锁不在 T2 |
| 元数据恢复 | 第二 Runtime 可重开并 replay Task/Session/Run；checkpoint、pending approval、known receipt 和 unknown side-effect reconciliation 可恢复；JSONL 导出默认脱敏 | 应用级 Runtime 独立 owner、lease、跨客户端 reconnect 待 T9/#14 |
| Policy / Executor | 默认 deny；显式 allow 后执行；未配置执行器会失败；ask 记录原始 ToolCall、workspace scope 并等待 typed approval；approve 续行原 Run，deny 不调用 executor；`workspace.inspect` 与 Coding read/edit/patch/test/diff 使用版本化 Profile、路径守卫和 bounded 输出；写入与测试在 sandbox 缺失时 fail-closed | 真实 sandbox 适配、跨客户端 ownership 和复杂 patch 冲突处理待补 |
| 执行回执 | 失败且 receipt.sideEffect 为 unknown 时进入 needs_reconciliation；tool receipt/observation 写入事件账本；inspect receipt 含 profile、`sideEffect:none`、稳定 `workspace://` Artifact 引用和 hash | 对账入口和完整异常路径待补 |
| Budget | 循环入口检查步骤和本次 run() 调用耗时；Provider request 带剩余 timeout，cancel 会 abort 在途 Provider | 跨恢复计时、Token/费用/reviewer 限额未执行 |
| Verifier | 非空文本 passed，空文本 unknown 并暂停；`WorkspaceInspectVerifier` 要求成功 inspect receipt、版本 Profile、稳定 URI 和 hash；`CodingVerifier` 要求 read、edit/patch、passing test、diff 与 Coding Artifact 回执后才 passed | CLI/Desktop Coding 工件展示和 Office verifier 待补 |
| Provider | OpenAI-compatible adapter 支持 structured messages/Context/Tool schema/ToolResult、request/attempt/trace、usage/cost、AbortSignal/timeout、retryable failure taxonomy；DeepSeek/Zhipu/Kimi fixture 共享合同；Kimi Code 可通过 Keychain-backed `getApiKey` 调用 | DeepSeek/智谱未真实联调；当前 `stream()` 是 unary fallback chunks，真实 SSE 流式仍待补 |
| CLI | Runtime → JSON 汇总；`inspect [path]` 走同一 Runtime Tool Registry/Policy/Executor/Verifier 语义；`HELM_STATE_DB` 接入 SQLite；`HELM_PROVIDER=kimi` 读取 Keychain 并调用 Kimi Code | 没有真实文件写入、人类输出/JSONL 事件模式、运行控制子命令；其他厂商未真实接入 |
| Desktop | 三栏对话优先 UI；Renderer 通过 typed preload/IPC 提交、控制和审批 Run；Main 默认打开 userData SQLite，按事件与快照投影消息、Approval、Verification 和 Trace；真实 Provider inspect 保留同一工具合同 | Runtime 独立 owner、真实写工具和完整 Diff/Artifact 仍未实现 |
| IPC | runtime-info、run-start、run-snapshot、run-control、run-approval、run-event；Main 做来源/请求/workspace 校验并转发带 runId/sequence 的脱敏事件 | 事件账本仍仅进程内；跨窗口/跨进程所有权和持久重连待实现 |
| Python worker | stdio JSONL health、inspect(path) 返回后缀/大小 | 当前只是协议骨架，尚未连接 Runtime；未实现 workspace path guard、sandbox、文档读写、OCR 或文件内容校验 |

Keychain、受限 shell、真实工件存储、Coding/Office verifier、Experience Candidate 均为后续实现。Electron 的 renderer sandbox 也不等于工具执行 sandbox。

## 验证记录

骨架验证使用 Node.js 22.23.1、pnpm 10.34.5、Python 3.9.6。维护本表时只记录实际执行的结果。

| 检查 | 已验证结果 | 实际覆盖 |
|---|---|---|
| `pnpm build` | 通过 | Runtime、Provider、CLI 输出及桌面 TypeScript/Vite/esbuild 构建 |
| `pnpm test` | 待本轮全仓复跑 | 当前 Runtime 25 项、Provider 7 项、Desktop IPC 6 项；SQLite、Provider 和 Coding 合同使用本地 fixture，Kimi 真实请求单独记录 |
| `pnpm typecheck` | 通过 | Runtime、Provider、CLI；桌面检查在 build 中 |
| Worker health / inspect | 返回成功结构化回执 | inspect 仅验证文件元数据 |
| 桌面开发预览 | 前序已启动 Vite/Electron 并预览界面 | 预览本身不证明 IPC；真实模型、审批、工件或打包版本端到端测试待后续 |
| Desktop IPC handler tests | 6 项通过 | 通过 public Main IPC handler composition 验证控制、inspect artifact、重连/回放、审批 allow/approve/deny、脱敏 provider failure、budget、UNKNOWN 与 needs_reconciliation |
| Electron production smoke | 通过（Mock）+ Kimi Code real request 通过 | 构建后的真实 Electron Main/Preload/Renderer 验证 API allowlist、安全开关、连续 Run、事件序号、消息与 Verification；另以 `HELM_PROVIDER=kimi` 验证 Keychain-backed 真实请求 |
| CLI 源码及构建产物启动 | Mock Run 返回 completed；`inspect .` 返回 completed、inspect verification passed、结构化 Artifact receipt | 不代表执行了用户目标中的写入、编码或 Office 操作 |

Runtime 的 25 项测试覆盖状态机、SQLite migration/事务/跨实例序号、重启 replay、checkpoint、approval hydrate、known/unknown receipt recovery、Provider-driven inspect Context/ToolResult、Coding read/edit/test/diff、sandbox fail-closed、在途取消，以及 inspect 安全边界。Provider 的 7 项测试覆盖三家 capability fixture、结构化请求、usage/cost、HTTP 分类、取消/超时、预取消和 normalized stream chunks。Desktop IPC 的 6 项测试覆盖公开 handler 的控制、inspect artifact、审批和失败/未知分支；Electron production smoke 还验证真实窗口边界。Kimi Code CLI 与 Electron 请求均使用 Keychain 中的用户凭据并成功返回，但这只证明文本请求连通性，不代表 Office 或完整编码任务验收。

后续测试目标见 [公共测试接口](../design/test-seams.md)，实施顺序见 [下一步计划](next-steps.md)。
