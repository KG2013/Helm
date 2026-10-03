# 下一步实施计划

更新日期：2026-10-03。架构已确认；#1–#4、T1/#6、T2/#7 的 SQLite 核心与 T3/#8 的 Provider 合同已完成，跨客户端 ownership、真实流式和执行能力仍按后续切片推进。当前能力参见 [实现状态](implementation-status.md)。

## 1. 对话界面接入 Runtime：已完成（#1–#4）

目标：用户在中栏提交任务后，能够看到真实 Mock Run 的事件与结果，并能控制 Run、处理审批和识别失败/未知结果。

- 定义 typed IPC 的输入、响应、错误和事件类型，并在主进程校验请求。
- Main 组装 RuntimeFacade + 本地 SQLite 账本 + MockProvider，Renderer 仅通过 preload 调用；内存账本仍用于纯 Runtime fixture。
- 输入框追加真实用户消息；任务响应和执行卡片由 Runtime 事件驱动，移除定时器模拟进度。
- 提供 Run 查询、事件转发和重连补齐；用 Run id/sequence 防止消息串到其他会话或重复展示。
- 接通暂停/恢复/取消，处理重复启动与调用在途时的竞争。
- 审批绑定待执行动作，持有提案并记录决定；ask → approve 后继续原动作，而非重新向模型索取另一个提案。

完成条件已由 #1–#4 验证：桌面提交可追踪到 Task/Session/Run；运行状态、验收与 CLI 复用 Runtime；取消后不追加新的执行动作；拒绝审批不调用 executor；approve 续行同一 proposal；快照可重建 Main 中仍存活的 Run。此阶段不宣称应用退出后的恢复。

## 2. 受限 Coding 流程（核心已完成，#9）

目标链路：inspect → read → proposal → policy/approval → edit → test → diff → verification。

确定性 fixture 已覆盖 read → approval → edit/patch → test → diff → verification；工具已注册 schema、采用 workspace 路径守卫、受控测试命令和可替换 sandbox；sandbox 不可用时拒绝执行。禁止将工作区目录或 Git worktree 当作执行隔离。CLI/Desktop 的同一 Artifact 投影仍待接线。

核心完成条件已由 Runtime fixture 覆盖：一次小修改有可审阅 diff、测试退出码、Coding Artifact 和 Coding Verifier；越界路径、拒绝授权和 sandbox 缺失分别进入明确结果。CLI/Desktop 的同一 Run/Artifact/Verification 结果仍属于后续切片。

## 3. 真实 Provider 与凭据（#8 已完成合同，真实联调待补）

Kimi Code 的 Keychain-backed 文本请求已完成首个真实连通性验证；Provider-neutral Context/Tool/ToolResult、request/attempt/trace、超时/取消、usage/cost 和错误分类已有 fixture 合同。下一步联调 DeepSeek 和智谱，并补真实流式协议。凭据由主进程/CLI 通过 Keychain resolver 取得，数据库只存引用。

完成条件：每家至少一个可重复文本/工具任务通过；配置与事件不含密钥；中止和失败不会把未知执行结果当成成功。测试 fixture 通过和真实厂商调用成功要分别记录。

## 4. SQLite 持久化与恢复（核心已完成，#7）

原生 Node SQLite adapter 已提供版本化迁移、WAL/事务、append-only sequence、durable projections、checkpoint、pending approval/receipt 恢复、未知工具对账和 JSONL 脱敏导出。CLI 通过 `HELM_STATE_DB` 接入，Desktop 主进程默认使用用户数据目录数据库。

原生 SQLite contract tests 已覆盖迁移、事务、序列、projection 和恢复核心；跨客户端 Runtime ownership、lease、stale client 拒绝和同一 Run 的显式互斥仍属于后续 T9/#14，因此 #7 的跨客户端部分暂不宣称完成。

## 5. Office Worker 核心已建立，Runtime 交付仍待接线

受限 JSONL worker 已提供 DOCX 最小生成、XLSX 指定单元格读写和 PDF text-layer 提取，并返回 hash、source Run、worker Receipt 与 limitations。Runtime 仍需为这些操作注册 Tool Profile、Policy/Approval、Artifact ownership 和 Office Verifier；扫描 PDF 需接入 OCR 后才可交付页码/置信度证据。

随后补跨恢复预算、重试/限流分类、诊断导出、故障注入与 Experience Candidate。证据不全返回 UNKNOWN。多 Agent、网络 A2A、外部系统写入、GUI 自动化等维持 P0 范围约束。

## 与原架构阶段的关系

架构基线 Phase 0–3 是能力分组；本计划把桌面对话接线提前作为可观察的纵向切片。SQLite 仍是持久恢复前提，执行隔离仍是真实副作用前提。此顺序不表示这些门禁可以跳过，也不改变 ADR-0001 至 ADR-0005。
