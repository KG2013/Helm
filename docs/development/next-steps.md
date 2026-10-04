# 下一步实施计划

更新日期：2026-10-03。架构已确认；#1–#4、T1/#6 至 T10/#15 的 Runtime 核心、Office worker、Episode/release gate、ownership/reconnect 和 Experience Candidate 已接入。当前剩余工作集中在真实 coding sandbox、厂商联调、目标环境 Office 依赖和打包重启回归。当前能力参见 [实现状态](implementation-status.md)。

## 1. 对话界面接入 Runtime：已完成（#1–#4）

目标：用户在中栏提交任务后，能够看到真实 Mock Run 的事件与结果，并能控制 Run、处理审批和识别失败/未知结果。

- 定义 typed IPC 的输入、响应、错误和事件类型，并在主进程校验请求。
- Main 组装 RuntimeFacade + 本地 SQLite 账本 + MockProvider，Renderer 仅通过 preload 调用；内存账本仍用于纯 Runtime fixture。
- 输入框追加真实用户消息；任务响应和执行卡片由 Runtime 事件驱动，移除定时器模拟进度。
- 提供 Run 查询、事件转发和重连补齐；用 Run id/sequence 防止消息串到其他会话或重复展示。
- 接通暂停/恢复/取消，处理重复启动与调用在途时的竞争。
- 审批绑定待执行动作，持有提案并记录决定；ask → approve 后继续原动作，而非重新向模型索取另一个提案。

完成条件已由 #1–#4 验证：桌面提交可追踪到 Task/Session/Run；运行状态、验收与 CLI 复用 Runtime；取消后不追加新的执行动作；拒绝审批不调用 executor；approve 续行同一 proposal；快照可重建 Main 中仍存活的 Run。此阶段不宣称应用退出后的恢复。

## 2. 受限 Coding 流程（Runtime 核心已完成，#9）

目标链路：inspect → read → proposal → policy/approval → edit → test → diff → verification。

确定性 fixture 已覆盖 read → approval → edit/patch → test → diff → verification；工具已注册 schema、采用 workspace 路径守卫、受控测试命令和可替换 sandbox；新增可选 Docker backend，network/privilege/image/daemon 不满足时拒绝执行。禁止将工作区目录或 Git worktree 当作执行隔离。Runtime 的同一 Run/Artifact/Approval/Verification projection 已接入 CLI JSON、`export` 和 Desktop snapshot/export。目标环境 Docker image smoke 和 Renderer 的 Coding diff/test 细节面板仍待补。

核心完成条件已由 Runtime fixture 覆盖：一次小修改有可审阅 diff、测试退出码、Coding Artifact 和 Coding Verifier；越界路径、拒绝授权和 sandbox 缺失分别进入明确结果。CLI/Desktop 已读取同一事件投影并提供脱敏导出；Coding 入口调度和完整 UI 交付仍属于后续切片。

## 3. 真实 Provider 与凭据（#8 合同已完成）

Kimi Code 的 Keychain-backed 文本请求已完成首个真实连通性验证；Provider-neutral Context/Tool/ToolResult、request/attempt/trace、超时/取消、usage/cost、失败分类和 SSE 解析已有 fixture 合同。DeepSeek 和智谱真实凭据联调仍需在对应账户和环境中执行。凭据由主进程/CLI 通过 Keychain resolver 取得，数据库只存引用。

完成条件：每家至少一个可重复文本/工具任务通过；配置与事件不含密钥；中止和失败不会把未知执行结果当成成功。测试 fixture 通过和真实厂商调用成功要分别记录。

## 4. SQLite 持久化与恢复（核心已完成，#7）

原生 Node SQLite adapter 已提供版本化迁移、WAL/事务、append-only sequence、durable projections、checkpoint、pending approval/receipt 恢复、未知工具对账和 JSONL 脱敏导出。CLI 通过 `HELM_STATE_DB` 接入，Desktop 主进程默认使用用户数据目录数据库。

原生 SQLite contract tests 已覆盖迁移、事务、序列、projection 和恢复核心；Runtime owner/lease、stale owner 控制拒绝、shutdown 安全暂停，以及独立 Node 进程的 owner arbitration、Approval reconnect 和 reconciliation smoke 已由 T9/#14 覆盖。Electron 打包重启回归仍需目标环境执行。

## 5. Office Worker Runtime 与交付已接线

受限 JSONL worker 已提供 DOCX package/content 与可选有界 `soffice`/`libreoffice` PDF 转换检查、XLSX 指定单元格/范围读写与 bounded workbook fingerprint、target/scope checks、PDF text-layer 分页来源与 coverage，并在 `pdftoppm`/`tesseract` 可用时提供带页码和 confidence 的 OCR。所有路径均返回 hash、source Run、worker Receipt、checks 与 limitations；缺渲染、OCR、覆盖率或未授权范围证据时返回 UNKNOWN 并暂停交付。

真实 worker 进程管理、Runtime E2E 和 CLI/Desktop 的同一 Artifact/Verification projection 已接入；目标环境仍需确认 OCR 工具链。当前 DOCX 检查验证有界转换和可打开的 PDF 页数，不做像素级视觉对比；缺少渲染器或 OCR 命令时保持 UNKNOWN。

剩余工作集中在 Docker image/daemon 的现场 smoke、DeepSeek/智谱真实联调、目标环境 Office/OCR 依赖、Electron 打包重启回归，以及 Experience Candidate review UI；UsageLedger、Episode、release gate、独立 Runtime reconnect 和成对 Context compaction 核心已建立。证据不全返回 UNKNOWN。多 Agent、网络 A2A、外部系统写入、GUI 自动化等独立能力已完成 ticket 拆分，但仍需在 ActionGateway 前置完成后按依赖实现。

## 6. Runtime 硬化与对账入口（#17：已完成）

预算使用量由持久 `usage.recorded` 事件累计，涵盖步骤、Run 存续时间、token、费用、延迟、重试、cache miss 和 reviewer rounds；Runtime 重连或暂停不会清零。未知副作用仍进入 `needs_reconciliation`，并可通过 `RuntimeFacade.recordReconciliation` 写入带类型、摘要、URI/hash 的证据包；缺证据的 `known/failed` 记录会被拒绝。`helm reconcile <run-id>` 和 `run-reconciliation` IPC 共用这些接口，支持只读查看预算与对账候选以及显式记录结果。release gate 仅在未知回执被证据标记为 `known/failed` 后移除对应 UNKNOWN 阻断；这不替代真实外部系统的写后验证。

## 7. 统一 ActionGateway（#24：已完成）

`ActionGateway` 已把 ActionRequest、版本化 Profile、scope/capability/network、参数 hash、幂等键、dry-run 和 deadline 固定为共享契约；默认拒绝，允许或审批后才调用适配器。请求、审批、批准、拒绝和回执事件写入同一事件账本，适配器断连或副作用未知返回 UNKNOWN 并进入对账路径；幂等键命中已有回执时只回放，不重复执行。现有 `ToolExecutor` 通过 `createToolActionAdapter` 进入 Gateway，Runtime 的 CLI 与 Desktop 入口因此共享同一策略和回执语义。事件只保存脱敏摘要、profile 和 args hash，原始凭据仍留在适配器边界。

真实 Connector、浏览器、子 Agent 和 A2A 适配器仍按各自独立 issue 接入；Gateway 本身不把远端 ACK、模型文字或文件存在当作完成证据。

## 8. Multi-Agent 身份与父子关系（#29：已完成）

`AgentRunCoordinator` 通过 ActionGateway 创建有界 child AgentRun，事件账本保存 agent identity、角色、能力、scope、目标、预算、状态及 parent/root lineage。创建前执行 capability 与 scope 子集检查，并限制嵌套深度；结果必须是 typed success/failure/UNKNOWN，success 至少携带 Evidence 或 Artifact。child 的动作不自授权，也不会把原始凭据或完整对话写入事件。

child 的实际执行、父结果聚合和 CLI/Desktop 操作入口在 #30 继续完成；当前切片只交付身份、授权边界和可回放关系。

## 9. 受限子 Agent 执行与聚合（#30：已完成）

`AgentRunCoordinator.executeChildAction` 会先检查 child 已授予的 capability/scope，再将动作交给 ActionGateway；适配器返回的输出只能形成 typed `AgentResult`，缺 Evidence/Artifact 的成功声明会降级为 UNKNOWN。`aggregate(parentRunId)` 在缺结果、UNKNOWN、失败和证据冲突时分别返回可观察状态，不把模型文字当作完成事实。CLI 提供 `helm agent list/create`，Desktop 提供 `agent-list/agent-create`，两者都从同一事件账本回放 parent/child 关系。

累计预算、并发、取消和重启恢复在 #31 继续加固；本切片不放宽 child 的能力或 scope。

## 10. Multi-Agent 预算、并发、取消与恢复（#31：已完成）

父 Run 的 durable usage ledger 累计 child action 的 steps/time/latency/retry/cache 记录；AgentRunCoordinator 限制 fan-out 和并发，child action 使用幂等键，父树支持级联取消。重启恢复时，处于 running 但没有 durable typed result 的 child 会转为 UNKNOWN，不能继续交付；CLI 与 Desktop 提供 cancel/recover 控制。release gate 同时检查 action receipt 和 child AgentRun 的 UNKNOWN 状态，必须先写证据对账。

## 11. Connector Registry 与 dry-run preview（#32：已完成）

`ConnectorRegistry` 记录版本化 target/action profile、目标 allowlist、字段 allowlist 和 scope；未注册 profile、目标、动作、字段或记录范围在进入 Gateway 前拒绝。preview 会生成 before/after、版本条件、影响、回退计划和写后对账计划，并以 `dryRun:true` 经 ActionGateway 审计，适配器只返回 preview，不执行外部写入。CLI 与 Desktop 共用注册、列表和 preview 入口，真实幂等写入在 #33 实现。

## 与原架构阶段的关系

架构基线 Phase 0–3 是能力分组；本计划把桌面对话接线提前作为可观察的纵向切片。SQLite 持久恢复、执行隔离、固定评测和候选审核核心已落地；真实依赖与打包集成仍是后续验收边界。此顺序不表示这些门禁可以跳过，也不改变 ADR-0001 至 ADR-0005。
