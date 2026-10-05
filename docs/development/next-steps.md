# 下一步实施计划

更新日期：2026-10-05。架构已确认；#1–#4、T1/#6 至 T10/#15 的 Runtime 核心、Office worker、Episode/release gate、ownership/reconnect 和 Experience Candidate 已接入，#23 已补齐 CLI、Desktop IPC 与候选审核面板，#19 已补齐 digest/non-root Docker sandbox 合同与 fixture，#42 已补齐统一 G0 acceptance preflight 与 release gate 输出，#43 已补齐显式 opt-in smoke 证据收集和 Electron packaged smoke 接线，#44 已补齐桌面扩展动作的窗口 Run 授权，#45 已补齐 Loopback Connector 与 Browser 动作的 ActionGateway 策略、receipt 绑定和幂等隔离，#46 已补齐 Connector/Browser registry 的事件回放和 Runtime 启动恢复闸门，#47 已把 Docker、Keychain-backed Provider、Office/OCR 和 Electron 接入真实 smoke runner，#48 已补齐未知事件回放兼容和横向 Release Gate 门禁。当前 macOS 目标环境的 Docker、DeepSeek、Office/OCR 和 Electron real smoke 均已通过；后续只剩真实浏览器/跨平台长任务等独立环境回归，SaaS/外部系统写入与跨机 A2A 已退出范围。当前能力参见 [实现状态](implementation-status.md)。

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

确定性 fixture 已覆盖 read → approval → edit/patch → test → diff → verification；工具已注册 schema、采用 workspace 路径守卫、受控测试命令和可替换 sandbox；Docker backend 现在要求 digest 镜像、`--pull=never`、network/privilege/read-only/resource/rprivate mount 与 preflight，约束不满足时拒绝执行。禁止将工作区目录或 Git worktree 当作执行隔离。Runtime 的同一 Run/Artifact/Approval/Verification projection 已接入 CLI JSON、`export` 和 Desktop snapshot/export。目标环境 Docker image/daemon smoke 仍待补；Renderer 已通过共享 projection 展示 Coding diff、测试结果、冲突 Artifact 和证据引用。

核心完成条件已由 Runtime fixture 覆盖：一次小修改有可审阅 diff、测试退出码、Coding Artifact 和 Coding Verifier；越界路径、拒绝授权和 sandbox 缺失分别进入明确结果。CLI/Desktop 已读取同一事件投影并提供脱敏导出；Coding 入口调度和完整 UI 交付仍属于后续切片。

## 3. 真实 Provider 与凭据（#8 合同已完成）

Kimi Code 的 Keychain-backed 文本请求已完成首个真实连通性验证；Provider-neutral Context/Tool/ToolResult、request/attempt/trace、超时/取消、usage/cost、失败分类和 SSE 解析已有 fixture 合同。DeepSeek 和智谱的 Provider 已默认接入 Runtime SSE stream seam；Keychain resolver 缺失时会 fail-closed 并给出不含凭据的认证诊断，不发起 HTTP 请求。两家真实凭据、文本/工具调用、SSE、限流和认证 smoke 仍需在对应账户和环境中执行。凭据由主进程/CLI 通过 Keychain resolver 取得，数据库只存引用；`providerTrace.requestSummary` 只记录有界计数/长度和传输模式。

完成条件：每家至少一个可重复文本/工具任务通过；配置与事件不含密钥；中止和失败不会把未知执行结果当成成功。测试 fixture 通过和真实厂商调用成功要分别记录。

## 4. SQLite 持久化与恢复（核心已完成，#7）

原生 Node SQLite adapter 已提供版本化迁移、WAL/事务、append-only sequence、durable projections、checkpoint、pending approval/receipt 恢复、未知工具对账和 JSONL 脱敏导出。CLI 通过 `HELM_STATE_DB` 接入，Desktop 主进程默认使用用户数据目录数据库。

原生 SQLite contract tests 已覆盖迁移、事务、序列、projection 和恢复核心；Runtime owner/lease、stale owner 控制拒绝、shutdown 安全暂停，以及独立 Node 进程的 owner arbitration、Approval reconnect 和 reconciliation smoke 已由 T9/#14 覆盖。Electron 已增加 packaged restart/multi-window registry smoke；目标环境仍需真实长任务和跨平台安装包回归。

## 5. Office Worker Runtime 与交付已接线

受限 JSONL worker 已提供 DOCX package/content 与可选有界 `soffice`/`libreoffice` PDF 转换检查、XLSX 指定单元格/范围读写与 bounded workbook fingerprint、target/scope checks、PDF text-layer 分页来源与 coverage，并在 `pdftoppm`/`tesseract` 可用时提供带页码和 confidence 的 OCR。所有路径均返回 hash、source Run、worker Receipt、checks 与 limitations；缺渲染、OCR、覆盖率或未授权范围证据时返回 UNKNOWN 并暂停交付。

真实 worker 进程管理、Runtime E2E、任务前 health preflight 和 CLI/Desktop 的同一 Artifact/Verification projection 已接入；`helm office health` 会报告依赖版本、路径和缺失项。当前环境已安装并验证 `tesseract` 5.5.3（含 `chi_sim`），Office/OCR real smoke 通过；DOCX 检查验证有界转换和可打开的 PDF 页数，不做像素级视觉对比；缺少渲染器或 OCR 命令时保持 UNKNOWN。

当前 acceptance smoke 已覆盖 Docker、DeepSeek Provider、Office/OCR 和 Electron packaged runner，并在本机 macOS 通过 release gate。Experience Candidate 仍需真实候选来源与生产数据验收；跨平台安装包、真实长任务重启和真实浏览器仍需独立环境回归。UsageLedger、Episode、release gate、独立 Runtime reconnect 和成对 Context compaction 核心已建立。证据不全返回 UNKNOWN。多 Agent、本机 Loopback A2A、本地 ActionGateway fixture 和 GUI fixture 已完成；SaaS/外部系统写入与跨机 A2A 不再进入验收。

## 6. Runtime 硬化与对账入口（#17：已完成）

预算使用量由持久 `usage.recorded` 事件累计，涵盖步骤、Run 存续时间、token、费用、延迟、重试、cache miss 和 reviewer rounds；Runtime 重连或暂停不会清零。未知副作用仍进入 `needs_reconciliation`，并可通过 `RuntimeFacade.recordReconciliation` 写入带类型、摘要、URI/hash 的证据包；缺证据的 `known/failed` 记录会被拒绝。`helm reconcile <run-id>` 和 `run-reconciliation` IPC 共用这些接口，支持只读查看预算与对账候选以及显式记录结果。release gate 仅在未知回执被证据标记为 `known/failed` 后移除对应 UNKNOWN 阻断；这只覆盖本机 fixture 的证据对账，不扩展到外部系统写入。

## 7. 统一 ActionGateway（#24：已完成）

`ActionGateway` 已把 ActionRequest、版本化 Profile、scope/capability/network、参数 hash、幂等键、dry-run 和 deadline 固定为共享契约；默认拒绝，允许或审批后才调用适配器。请求、审批、批准、拒绝和回执事件写入同一事件账本，适配器断连或副作用未知返回 UNKNOWN 并进入对账路径；幂等键命中已有回执时只回放，不重复执行。现有 `ToolExecutor` 通过 `createToolActionAdapter` 进入 Gateway，Runtime 的 CLI 与 Desktop 入口因此共享同一策略和回执语义。事件只保存脱敏摘要、profile 和 args hash，原始凭据仍留在适配器边界。

本地 Connector、浏览器、子 Agent 和本机 A2A fixture 通过各自 issue 接入；SaaS/外部系统写入与跨机 A2A 不属于当前产品范围。Gateway 不把模型文字或文件存在当作完成证据。

## 8. Multi-Agent 身份与父子关系（#29：已完成）

`AgentRunCoordinator` 通过 ActionGateway 创建有界 child AgentRun，事件账本保存 agent identity、角色、能力、scope、目标、预算、状态及 parent/root lineage。创建前执行 capability 与 scope 子集检查，并限制嵌套深度；结果必须是 typed success/failure/UNKNOWN，success 至少携带 Evidence 或 Artifact。child 的动作不自授权，也不会把原始凭据或完整对话写入事件。

child 的实际执行、父结果聚合和 CLI/Desktop 操作入口在 #30 继续完成；当前切片只交付身份、授权边界和可回放关系。

## 9. 受限子 Agent 执行与聚合（#30：已完成）

`AgentRunCoordinator.executeChildAction` 会先检查 child 已授予的 capability/scope，再将动作交给 ActionGateway；适配器返回的输出只能形成 typed `AgentResult`，缺 Evidence/Artifact 的成功声明会降级为 UNKNOWN。`aggregate(parentRunId)` 在缺结果、UNKNOWN、失败和证据冲突时分别返回可观察状态，不把模型文字当作完成事实。CLI 提供 `helm agent list/create`，Desktop 提供 `agent-list/agent-create`，两者都从同一事件账本回放 parent/child 关系。

累计预算、并发、取消和重启恢复在 #31 继续加固；本切片不放宽 child 的能力或 scope。

## 10. Multi-Agent 预算、并发、取消与恢复（#31：已完成）

父 Run 的 durable usage ledger 累计 child action 的 steps/time/latency/retry/cache 记录；AgentRunCoordinator 限制 fan-out 和并发，child action 使用幂等键，父树支持级联取消。重启恢复时，处于 running 但没有 durable typed result 的 child 会转为 UNKNOWN，不能继续交付；CLI 与 Desktop 提供 cancel/recover 控制。release gate 同时检查 action receipt 和 child AgentRun 的 UNKNOWN 状态，必须先写证据对账。

## 11. 本地 Action Registry 与 dry-run preview（#32：已完成）

`ConnectorRegistry` 记录版本化 target/action profile、目标 allowlist、字段 allowlist 和 scope；未注册 profile、目标、动作、字段或记录范围在进入 Gateway 前拒绝。preview 会生成 before/after、版本条件、影响、回退计划和写后对账计划，并以 `dryRun:true` 经 ActionGateway 审计，适配器只返回 preview，不执行外部写入；profile 与 loopback hash/version state 可从事件账本恢复，注册 scope 事件脱敏。CLI 与 Desktop 共用注册、列表和 preview 入口，仅用于本机 fixture；不连接 SaaS 或其他外部系统。

## 12. 本机 Loopback Action 与脱敏 Receipt（#33：已完成）

`LoopbackConnector` 以 `expectedVersion` 做乐观并发检查，以 `idempotencyKey` 保证重复请求不重复改变记录；写入仍先经过 ActionGateway 的默认拒绝/审批策略。事件账本只保留 target、版本、幂等键和 before/after hash，不保留记录字段内容；CLI 与 Desktop 暴露 write 入口。Loopback 只作为本机可测试适配器；不保存或使用 SaaS 凭据。

## 13. 本机 Loopback 写后验证与 UNKNOWN 对账（#34：已完成）

成功的 Loopback 写入自动执行 read-after-write，比较 after hash 与 version 条件，并在可用时写入只含哈希/版本元数据的受限 Artifact。断连、超时、部分成功和异步结果由 Loopback failure injection 统一映射为 UNKNOWN 与 `run.needs_reconciliation`；读取到不匹配状态则为 failed，不能依据 HTTP 状态或模型文字放行。CLI `connector verify`、Desktop `connector-verify` 支持查询验证，`reconcile --action-id` 支持携证据标记 known/failed；重复 write 使用原幂等键安全重试，不会重复改变记录。

## 14. 受控浏览器 Context、Origin 与导航观测（#35：已完成）

`BrowserFixtureRegistry` 为每个 context 固定 app/window/origin/download/artifact scope；未在 profile allowlist 中的 origin、app 或 window 在 ActionGateway 前拒绝。导航、DOM assertion 和 fixture screenshot 都通过 typed action 事件产生 URL/origin/context/DOM hash/screenshot Artifact evidence；导航可返回 approval_required，`approveNavigation` 继续同一个 action。close/reconnect/cleanup 写入可回放生命周期事件；CLI 与 Desktop 共用 context、navigate、approve、assert、control 入口。fixture 不获得 shell、Keychain 或原生桌面权限，真实浏览器 smoke 单独验收。

## 15. 浏览器动作 Profile、Artifact I/O 与高风险审批（#36：已完成）

浏览器动作 Profile 版本化声明 action、locator、上传 Artifact allowlist 和受控下载目录；click/type/select/upload/download 进入统一 Gateway，上传只读授权 Artifact，下载只写 ArtifactStore，不暴露宿主路径。submit/send/delete/publish 即使全局策略允许也先产生 `approval_required`，只能用同一 action 绑定继续执行。Receipt 保存 context/profile/locator、前后 DOM hash、截图和 Artifact 引用；CLI 与 Desktop 暴露 profile 与 action proposal/approval，fixture 不模拟真实浏览器权限。

## 16. GUI 后置条件、故障恢复与 UNKNOWN 对账（#37：已完成）

每个已执行的 Browser Action 都必须回读受控页面 DOM hash，并将后置条件状态记录为 known、failed 或 unknown；只有带 DOM/screenshot/Artifact evidence 的 known 或 failed 结果可进入 `run.reconciled`。页面变化、窗口/页面丢失、浏览器重启、网络断开、重复响应和提交结果不明可通过故障注入进入 UNKNOWN 与 `run.needs_reconciliation`；相同幂等键会回放 UNKNOWN receipt，不会重新执行动作。CLI `browser verify` 与 Desktop `browser-verify` 暴露证据查询；原生任意桌面自动化和真实浏览器像素 smoke 仍在范围之外。

## 17. 本机 A2A Envelope、身份与 Loopback Transport（#38：已完成）

`A2ALoopbackTransport` 只在同一 Runtime/EventStore 内运行，定义 sender/recipient identity、capability grant、task/run/correlation/idempotency/deadline、scope、最小 goal/summaries context 和授权 Artifact refs 的 envelope。注册身份绑定仅用于本机 fixture 的 HMAC 签名，签名密钥不会写入事件；能力与 scope 必须同时满足本机 allowlist，deadline、凭据样文本、未授权 Artifact、非法身份和重复幂等键在持久账本中记录 `a2a.rejected` 后拒绝。投递状态通过 `a2a.envelope` 与 `a2a.delivery` 记录 queued→sent→ack/failed，新的本机 transport 实例可从 EventStore 重放。

## 18. 跨机 A2A Remote Agent（#39：已退出范围）

跨机 worker、远端 proposal、网络 endpoint allowlist 和远端凭据/工具隔离不再属于产品需求；`RemoteAgentCoordinator`、远端 worker 测试与 Runtime 远程方法已删除。历史 issue 保留为已关闭记录。

## 19. 跨机 A2A 安全门禁（#40：已退出范围）

跨网络 ActionGateway、远程 Receipt 和跨机器迁移不再进入实现或验收；本机 ActionGateway 仍负责所有本地动作的 schema、scope、policy、approval、evidence 与 postcondition 门禁。

## 20. 本机 A2A 投递幂等、迟到响应与重启对账（#41：已完成）

`A2ALoopbackTransport` 持久化 `queued/sent/ack/failed/unknown`、correlation、deadline、attempt、receipt hash 和 reconciliation ID。相同 envelope 的重复幂等键会被拒绝；重试复用同一 message 与幂等键，不创建跨机委派。断连、过期 deadline 或迟到 ACK 进入 UNKNOWN；`a2a.reconciliation` 只有带有界本机 evidence 才能将状态 mark-known/failed，未对账 UNKNOWN 会阻断 release gate。CLI 提供 `a2a retry` 与 `a2a reconcile`，Desktop 通过 `a2a-control` 使用同一 Runtime 对账入口。

## 与原架构阶段的关系

架构基线 Phase 0–3 是能力分组；本计划把桌面对话接线提前作为可观察的纵向切片。SQLite 持久恢复、执行隔离、固定评测和候选审核核心已落地；真实依赖与打包集成仍是后续验收边界。此顺序不表示这些门禁可以跳过，也不改变 ADR-0001 至 ADR-0005。
