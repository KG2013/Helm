# 当前实现状态

核对日期：2026-10-03。本文以本仓库代码为依据；[架构基线](../design/architecture-v0.md) 和 accepted ADR 表达目标，不代表 P0 已完成。

## 已建立的骨架

| 模块 | 当前代码行为 | 尚未完成 / 验证边界 |
|---|---|---|
| Workspace | pnpm monorepo，TypeScript，锁定依赖版本 | 桌面安装包和跨平台分发未验证 |
| Runtime | 创建 Task/Session/Run，状态转换，推进、暂停、恢复、取消；Runtime 维护带 nonce/动作哈希/策略版本/有效期的 typed approval；版本化 Tool Registry、`workspace.inspect`、Coding read/edit/patch/test/diff、可选 Docker Coding Sandbox、Office DOCX/XLSX/PDF Profiles/Policy/Worker Client/Verifier、bounded Context/Tool schema/ToolResult、UsageLedger、Episode/release gate、owner/lease、ArtifactStore、Provider request IDs 和 Run cancellation signal | Docker daemon/image 未配置时 Coding 仍按 fail-closed；reviewer 限额和跨恢复预算仍未完整实现 |
| Event Ledger | 内存账本和原生 Node `node:sqlite` 账本；schema v1 migration、WAL/事务、append-only sequence、durable task/session/run/checkpoint/receipt/verification projections | 原生 SQLite 使用 Node 22 experimental API；跨客户端 ownership 和分布式锁不在 T2 |
| 元数据恢复 | 第二 Runtime 可重开并 replay Task/Session/Run；checkpoint、pending approval、known receipt、unknown-side-effect reconciliation、SQLite 原子 owner lease、shutdown 安全暂停和 JSONL 脱敏导出可恢复；CLI/Desktop 使用独立 owner 标识并可重连控制 | 完整打包应用重启后的长任务现场回归仍需单独执行 |
| Policy / Executor | 默认 deny；显式 allow 后执行；未配置执行器会失败；ask 记录原始 ToolCall、workspace scope 并等待 typed approval；approve 续行原 Run，deny 不调用 executor；`workspace.inspect` 与 Coding read/edit/patch/test/diff 使用版本化 Profile、路径守卫和 bounded 输出；写入与测试通过可选 Docker Sandbox，后端缺失时 fail-closed | 目标环境 Docker image/daemon smoke、跨客户端 ownership 和复杂 patch 冲突处理待补 |
| 执行回执 | 失败且 receipt.sideEffect 为 unknown 时进入 needs_reconciliation；tool receipt/observation 写入事件账本；inspect receipt 含 profile、`sideEffect:none`、稳定 `workspace://` Artifact 引用和 hash | 对账入口和完整异常路径待补 |
| Budget | 循环入口检查步骤和本次 run() 调用耗时；Provider request 带剩余 timeout，cancel 会 abort 在途 Provider；UsageLedger 去重 requestId 并对 Token/费用超限硬暂停 | 跨恢复计时、reviewer 限额未执行 |
| Verifier | 非空文本 passed，空文本 unknown 并暂停；`WorkspaceInspectVerifier` 要求成功 inspect receipt、版本 Profile、稳定 URI 和 hash；`CodingVerifier` 要求 read、edit/patch、passing test、diff 与 Coding Artifact 回执后才 passed；`OfficeVerifier` 按 DOCX/XLSX/PDF evidence checks 放行，缺渲染/OCR/覆盖率/范围证据返回 UNKNOWN；release gate 拒绝失败、未知副作用、泄漏或未对账 Episode | 真实 coding sandbox 之外，LLM Judge 仍只作为未来的 advisory 层 |
| Provider | OpenAI-compatible adapter 支持 structured messages/Context/Tool schema/ToolResult、request/attempt/trace、usage/cost、AbortSignal/timeout、retryable failure taxonomy；DeepSeek/Zhipu/Kimi fixture 共享合同；Kimi Code 可通过 Keychain-backed `getApiKey` 调用 | DeepSeek/智谱未真实联调；当前 `stream()` 是 unary fallback chunks，真实 SSE 流式仍待补 |
| CLI | Runtime → JSON 汇总；`inspect [path]`、`HELM_TASK_KIND=coding` 和 `HELM_TASK_KIND=office` 走对应 Runtime Tool Registry/Policy/Executor/Verifier 语义；`HELM_STATE_DB` 接入 SQLite；`HELM_PROVIDER=deepseek|zhipu|kimi` 读取对应 Keychain 配置；`HELM_CODING_SANDBOX=docker` 启用受限 Coding backend；`control`、`approve`、`export`、`--jsonl` 共用 Runtime 的 Run/Artifact/Approval/Verification projection、Episode 和脱敏 JSONL | Docker image/daemon 和 DeepSeek/智谱真实凭据需在目标环境验证 |
| Desktop | 三栏对话优先 UI；Renderer 通过 typed preload/IPC 提交、控制和审批 Run；Main 默认打开 userData SQLite，按事件与快照投影消息、Approval、Verification、Trace 和 Episode；`HELM_TASK_KIND=coding|office` 接入对应 Runtime（Coding 缺 Sandbox 时 fail-closed，Office 使用真实 JSONL worker）；快照与 `run-export` 共用 Runtime 的 Run/Artifact/Approval/Verification projection | Renderer 仍未把 Coding diff/test 做成独立细节面板；完整打包重启回归待补 |
| IPC | runtime-info、run-start、run-snapshot、run-control、run-approval、run-event；Main 做来源/请求/workspace 校验并转发带 runId/sequence 的脱敏事件 | IPC event forwarding 目前只面向当前窗口；跨窗口 UI 订阅和完整打包重启回归待实现 |
| Python worker | stdio JSONL health/inspect；bounded DOCX 生成并检查 package/content，若有 `soffice`/`libreoffice` 则在临时目录执行有界 PDF 转换和页数检查；XLSX 单元格/范围读写并做 bounded workbook fingerprint（值/公式类型/样式/合并/defined names）与 target/scope snapshot；PDF text-layer 分页来源与 coverage，若有 `pdftoppm`/`tesseract` 则执行带 confidence 的逐页 OCR；Artifact hash、source Run、worker version、checks、limitations 和 workspace path guard | 外部依赖缺失时仍按 UNKNOWN 阻断交付；未做像素级视觉比较 |

Keychain、受限 shell、真实工件存储和 Office Runtime verifier 已接入；Electron renderer sandbox 仍不等于工具执行 sandbox。Office 的 OCR/渲染依赖缺失时必须保留 UNKNOWN，不得把文本非空当作通过。

## 验证记录

骨架验证使用 Node.js 22.23.1、pnpm 10.34.5、Python 3.9.6。维护本表时只记录实际执行的结果。

| 检查 | 已验证结果 | 实际覆盖 |
|---|---|---|
| `pnpm build` | 通过 | Runtime、Provider、CLI 输出及桌面 TypeScript/Vite/esbuild 构建 |
| `pnpm test` | 通过 | Runtime 当前 47 项、Provider 7 项、Desktop IPC 6 项；SQLite、Provider、Coding、Office 和 Projection 合同使用本地 fixture，Kimi 真实请求单独记录 |
| `pnpm typecheck` | 通过 | Runtime、Provider、CLI；桌面检查在 build 中 |
| Worker health / inspect | 返回成功结构化回执 | inspect 仅验证文件元数据 |
| 桌面开发预览 | 前序已启动 Vite/Electron 并预览界面 | 预览本身不证明 IPC；真实模型、审批、工件或打包版本端到端测试待后续 |
| Desktop IPC handler tests | 6 项通过 | 通过 public Main IPC handler composition 验证控制、inspect artifact、重连/回放、审批 allow/approve/deny、脱敏 provider failure、budget、UNKNOWN 与 needs_reconciliation |
| Electron production smoke | 通过（Mock）+ Kimi Code real request 通过 | 构建后的真实 Electron Main/Preload/Renderer 验证 API allowlist、安全开关、连续 Run、事件序号、消息与 Verification；另以 `HELM_PROVIDER=kimi` 验证 Keychain-backed 真实请求 |
| CLI 源码及构建产物启动 | Mock Run 返回 completed；`inspect .` 返回 completed、inspect verification passed、结构化 Artifact receipt | 不代表执行了用户目标中的写入、编码或 Office 操作 |
| Document Worker contract | 9 项 Python tests 通过；DOCX package/content 与可选有界渲染检查、XLSX 指定单元格读写与 bounded workbook fingerprint、target/scope checks、越界路径拒绝、扫描 PDF 的 OCR unavailable/unknown 与可用工具 fixture；Runtime Office fixture 8 项覆盖真实 Python JSONL client、Runtime E2E 和 symlink guard | CLI/Desktop 尚未统一展示 Office Artifact/Verification；OCR 仍取决于目标环境工具，DOCX 仅验证有界转换和页数，不代表像素级视觉对比 |

Runtime 当前 47 项测试覆盖状态机、SQLite migration/事务/跨实例序号与原子 lease、重启 replay、checkpoint、approval hydrate/绑定过期、known/unknown receipt recovery、owner/lease shutdown、Provider-driven inspect Context/ToolResult、成功与失败 UsageLedger、ArtifactStore 大输出、Episode trace/release gate、Token/latency/retry/cache budgets、Experience Candidate、成对 Context compaction、Coding read/edit/test/diff、Office DOCX/XLSX/PDF Worker Client/Policy/Verifier、Projection、sandbox fail-closed、在途取消，以及 inspect 安全边界。Provider 的 7 项测试覆盖三家 capability fixture、结构化请求、usage/cost、HTTP 分类、取消/超时、预取消和 normalized stream chunks。Desktop IPC 的 6 项测试覆盖公开 handler 的控制、inspect artifact、Episode 导出、审批和失败/未知分支；Electron production smoke 还验证真实窗口边界。Kimi Code CLI 与 Electron 请求均使用 Keychain 中的用户凭据并成功返回，但这只证明文本请求连通性，不代表 Office 或完整编码任务验收。

后续测试目标见 [公共测试接口](../design/test-seams.md)，实施顺序见 [下一步计划](next-steps.md)。
