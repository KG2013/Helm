# 下一步实施计划

更新日期：2026-09-30。架构已确认；以下是骨架完成后的工作拆分，均尚未完成。当前能力参见 [实现状态](implementation-status.md)。

## 1. 对话界面接入 Runtime：下一切片

目标：用户在中栏提交任务后，能够看到真实 Mock Run 的事件与结果。

- 定义 typed IPC 的输入、响应、错误和事件类型，并在主进程校验请求。
- Main 组装 RuntimeFacade + InMemoryEventStore + MockProvider，Renderer 仅通过 preload 调用。
- 输入框追加真实用户消息；任务响应和执行卡片由 Runtime 事件驱动，移除定时器模拟进度。
- 提供 Run 查询、事件转发和重连补齐；用 Run id/sequence 防止消息串到其他会话或重复展示。
- 接通暂停/恢复/取消，处理重复启动与调用在途时的竞争。
- 审批绑定待执行动作，持有提案并记录决定；ask → approve 后继续原动作，而非重新向模型索取另一个提案。

完成条件：桌面提交一次任务可追踪到 Task/Session/Run；运行状态、验收与 CLI 语义一致；取消后不追加新的执行动作；拒绝审批不调用 executor；刷新视图可从 Main 中仍存活的 Run 重建展示。此阶段不宣称应用退出后的恢复。

## 2. 受限 Coding 流程

目标链路：inspect → read → proposal → policy/approval → edit → test → diff → verification。

先在临时工作区用确定性 Mock 提案验证，再接真实模型。新增工作区路径守卫、工具 schema、有限读写/patch/search 工具、受控测试命令和可替换 sandbox；sandbox 不可用时拒绝执行。禁止将工作区目录或 Git worktree 当作执行隔离。

完成条件：一次小修改有可审阅 diff、测试退出码、目标行为证据；越界路径、拒绝授权和未知副作用分别进入明确结果。Coding verifier 不能以非空文本替代代码与测试验收。

## 3. 真实 Provider 与凭据

先联调 DeepSeek，再接智谱和 Kimi。验证各厂商当前 endpoint、模型、工具/流式协议，补上下文与工具结果回传、schema 校验、超时/取消、usage 和错误分类。凭据由主进程/CLI 通过 Keychain resolver 取得，数据库只存引用。

完成条件：每家至少一个可重复文本/工具任务通过；配置与事件不含密钥；中止和失败不会把未知执行结果当成成功。测试 fixture 通过和真实厂商调用成功要分别记录。

## 4. SQLite 持久化与恢复

补原生 SQLite adapter、迁移、事务、事件序号与写入所有权，再实现 checkpoint、pending approval/receipt 恢复和 JSONL 导出。这是架构 Phase 0 的未完成部分，可以与界面接线并行推进。

完成条件：进程退出后重新打开能重建 Task/Session/Run；有回执的副作用不重复执行，未知结果进入对账；CLI/桌面访问同一数据时有明确互斥协议。仅复用同一个内存 store 不算通过。

## 5. Office 与稳定性

在受限 worker 中接入 DOCX 报告、XLSX 指定范围修改与校验、PDF 文本提取/OCR；Runtime 持有审批、产物元数据和验收权。分别验证文件能打开、目标内容/区域、页码来源与未授权区域。

随后补跨恢复预算、重试/限流分类、诊断导出、故障注入与 Experience Candidate。证据不全返回 UNKNOWN。多 Agent、网络 A2A、外部系统写入、GUI 自动化等维持 P0 范围约束。

## 与原架构阶段的关系

架构基线 Phase 0–3 是能力分组；本计划把桌面对话接线提前作为可观察的纵向切片。SQLite 仍是持久恢复前提，执行隔离仍是真实副作用前提。此顺序不表示这些门禁可以跳过，也不改变 ADR-0001 至 ADR-0005。
