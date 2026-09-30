# Helm 架构基线 v0

状态：已确认，进入实现
日期：2026-09-30（Asia/Shanghai）
适用范围：P0 个人本地 Harness，不是已实现功能清单

## 1. 目标与边界

Helm 是一个个人本地 Harness，用统一的运行时连接 DeepSeek、智谱、Kimi 等模型提供方，完成本地 coding 和 office 任务。它自己的核心资产是任务循环、持久状态、权限策略、验证器、恢复和交付协议；模型、文档处理库和外围工具都是可替换适配器。

P0 的真实闭环是：

- Coding：阅读仓库、修改代码、运行 lint/test、生成 diff、提供证据报告。
- DOCX：根据 Markdown 或结构化输入生成格式稳定的报告。
- XLSX：读取工作簿、修改指定区域、重新计算或校验并生成结果文件。
- PDF：提取文本；无文本层时使用 OCR；生成带来源和页码的摘要。

P0 明确不做：

- 多用户账号、团队租户和 marketplace。
- 远程执行、网络 A2A 和跨机器任务迁移。
- 飞书、邮件等外部系统写入。
- GUI 自动化和桌面办公软件控制。
- 自动修改生产 Skill、Memory 或 Harness。

## 2. 已接受的产品决策

| 领域 | 决策 |
|---|---|
| 用户 | 个人单机优先，macOS Apple Silicon 首发 |
| 入口 | Electron 桌面端 + CLI，共用一个 Runtime |
| 核心 | 自己拥有 Task loop、状态、策略和交付协议；外围能力复用 |
| Provider | P0 为 DeepSeek、智谱、Kimi；统一 Provider 接口 |
| Provider 能力 | 文本、流式、结构化工具调用、错误分类；原生差异用 capability flags |
| 办公范围 | P0 只处理本地 DOCX/XLSX/PDF |
| 持久化 | SQLite 查询与恢复真源，append-only 事件表，JSONL 导出 |
| 凭据 | macOS Keychain；数据库只存引用与元数据 |
| 执行 | 工作区路径守卫 + 受限文档 worker + 可替换 code/shell sandbox；sandbox 不可用时 fail-closed |
| 协作 | 单 Agent + 最多一轮 reviewer；多 Agent 后置 |
| 预算 | 默认 30 Step、15 分钟、可配置 Token/费用上限、最多 1 次 reviewer |
| 验收 | coding 与 office 使用不同 verifier；证据不完整为 UNKNOWN，不算成功 |
| 经验 | P0 只记录 Experience Candidate，不自动改变生产行为 |

完整决策来源见设计访谈和 ADR 0001–0005。

## 3. 高层架构

~~~mermaid
flowchart TB
    Desktop["Electron Desktop<br/>React Renderer + secure IPC"]
    CLI["CLI<br/>human and JSON output"]
    Facade["Runtime Facade<br/>one task/session contract"]
    Orchestrator["Task Orchestrator<br/>budgeted single-agent run"]
    Loop["Agent Loop<br/>context → proposal → policy → execute → observe → verify"]
    Context["Context Projector<br/>session events + workspace notes + skills"]
    Providers["Provider Adapters<br/>DeepSeek / Zhipu / Kimi"]
    Tools["Tool Registry and Executor<br/>fs / shell / git / office"]
    Policy["Policy and Approval<br/>path guard / approval / budget"]
    Sandbox["Sandbox Adapter<br/>macOS restricted backend / container later"]
    DocWorker["Python Document Worker<br/>DOCX / XLSX / PDF / OCR"]
    Verify["Verifier Registry<br/>coding / docx / xlsx / pdf"]
    Store["SQLite<br/>state + append-only events"]
    Artifacts["Artifact Store<br/>files, diff, evidence, reports"]
    Keychain["macOS Keychain<br/>credential values"]

    Desktop --> Facade
    CLI --> Facade
    Facade --> Orchestrator
    Orchestrator --> Loop
    Loop --> Context
    Loop --> Providers
    Loop --> Tools
    Tools --> Policy
    Policy --> Sandbox
    Tools --> DocWorker
    Loop --> Verify
    Orchestrator --> Store
    Tools --> Artifacts
    Verify --> Artifacts
    Providers --> Keychain
~~~

### 3.1 组件职责

| 组件 | 拥有的事实或行为 | 不拥有 |
|---|---|---|
| Desktop | 展示会话、任务、事件、Diff、产物、审批和验收 | 不直接读任意文件、执行 shell 或读取密钥 |
| CLI | 调用同一 Runtime，提供人类输出和 JSON 输出 | 不复制一套任务语义 |
| Runtime Facade | 统一启动、暂停、恢复、取消、查询和订阅接口 | 不决定具体 UI |
| Task Orchestrator | Task/Run 生命周期、预算、取消、恢复、reviewer 编排 | 不绕过 Policy 执行副作用 |
| Agent Loop | 组装上下文、请求模型、解释 proposal、接收 observation | 不自行授予权限，不自证完成 |
| Provider Adapter | 厂商协议、流式增量、工具调用和错误映射 | 不拥有 Task 状态和本地权限 |
| Tool Executor | Schema 校验、Policy 检查、执行、receipt 和 trace | 不自行定义任务完成 |
| Policy/Approval | allow/ask/deny、作用范围、审批事件和预算门禁 | 不接受模型伪造的授权字段 |
| Sandbox Adapter | 约束代码/shell 子进程的文件、进程和资源能力 | 不保存模型上下文 |
| Document Worker | DOCX/XLSX/PDF 的结构处理、转换和 OCR | 不拥有 Agent loop、凭据或审批权 |
| Verifier | 依据任务类型提供可追溯验收证据 | 不修改被验收对象来制造通过 |
| Store | 持久事件、投影状态、checkpoint 和查询索引 | 不把未经验证的模型文本当事实 |
| Artifact Store | 保存独立产物、diff、日志引用和证据文件 | 不把文件存在当作任务成功 |

## 4. 领域模型

主链：

Workspace → Task → Session → Run → Turn → Step → Proposal → PolicyDecision → ToolCall → Observation/Receipt → Artifact → Verification → Delivery

- Workspace：授权的项目或文件目录及其执行范围。
- Task：用户目标、输入、预算、期望产物和完成条件。
- Session：持续交互上下文，可查询、暂停和恢复。
- Run：Task 的一次执行实例，有明确生命周期和终态。
- Turn：一次用户输入被领取并处理的过程。
- Step：一次模型请求以及该请求触发的工具调用。
- Proposal：模型提出的结构化下一步动作或回答。
- PolicyDecision：Harness 对 Proposal 的允许、询问或拒绝决定。
- ToolCall：通过注册工具执行的具体动作。
- Observation：工具或环境返回的结构化观察。
- Receipt：对副作用、退出码、输出摘要、文件哈希或未知状态的记录。
- Artifact：可独立引用、验证和交付的文件、diff、报告或结构化结果。
- Verification：对 Artifact 或运行结果的验收及其证据。
- Delivery：将通过验收的 Artifact 呈现给用户并标记交付状态。

概念边界：

- Agent 不等于 Model。
- Task 不等于 Session。
- 日志不等于 Memory。
- 生成文件不等于已交付。
- 模型声明完成不等于验收通过。
- Git worktree 不等于安全沙箱。
- 本地执行不等于本地推理。

## 5. Run 状态机

~~~mermaid
stateDiagram-v2
    [*] --> ready
    ready --> deciding
    deciding --> validating
    validating --> executing
    executing --> reducing
    reducing --> deciding: more work
    reducing --> verifying: goal candidate
    verifying --> completed: evidence passes
    verifying --> deciding: bounded reviewer feedback
    verifying --> paused: UNKNOWN or approval needed
    deciding --> paused: budget or user input
    executing --> needs_reconciliation: side effect unknown
    paused --> recovering
    recovering --> deciding
    ready --> cancelled
    deciding --> cancelled
    executing --> failed
    verifying --> failed
    paused --> cancelled
    completed --> [*]
    failed --> [*]
    cancelled --> [*]
    needs_reconciliation --> [*]
~~~

终态语义：

- completed：独立验收证据满足完成条件。
- failed：确定性失败且无法在预算内继续。
- cancelled：用户或系统取消，取消动作和已知副作用已记录。
- needs_reconciliation：副作用是否发生不确定，必须对账后才能决定后续。
- paused：等待用户输入、审批、预算恢复或外部资源。

同一个 Session P0 只允许一个 active Run；不同 Session 可有限并发。

## 6. 事件与持久化

SQLite 中至少需要以下逻辑表：

| 表 | 作用 |
|---|---|
| workspaces | 路径、授权范围、默认 policy、sandbox preset |
| tasks | 目标、输入摘要、交付契约、预算、完成条件 |
| sessions | 会话元数据、当前状态、默认 workspace、lineage |
| runs | Run 状态、owner、预算使用、终态、checkpoint 引用 |
| turns | 输入领取、起止时间、step 数 |
| steps | model request、proposal、tool call 关联、结果 |
| events | append-only 事实流、版本、关联 ID、时间戳 |
| approvals | 动作摘要、路径/参数哈希、主体、有效期、消费状态 |
| artifacts | URI、类型、哈希、来源 Run、验证状态 |
| verifications | verifier 版本、输入哈希、结果、证据引用 |
| provider_configs | provider、model、capabilities、credential reference；不存密钥 |
| experience_candidates | 来源轨迹、候选类型、适用范围、验证状态、批准状态 |

事件必须能重建模型可见上下文、运行状态和审批事实。写入数据库的事件不可静默覆盖；未知版本应拒绝读取并报告。大工具输出落到 Artifact Store，事件只保存摘要、哈希和引用。

## 7. Provider 接口

统一接口至少包含：

- provider id、model id、capability flags
- text content、reasoning content、image content、tool call、tool result
- 流式 chunk 与最终 message
- token usage、费用估计和请求耗时
- provider-neutral failure code：timeout、rate_limit、context_window、auth、invalid_request、empty_response、unavailable
- request id、attempt id、trace id
- credential reference 的按请求解析

DeepSeek、智谱、Kimi 的 wire format 差异只出现在 adapter 内。Provider adapter 不写本地状态，不调用审批服务，不自行重试到超出 Run 预算。模型切换必须记录 provider、model、adapter 版本和 capability snapshot。

## 8. 工具、权限和沙箱

P0 工具分组：

- 文件：read、list、search、write、patch、hash
- Coding：shell/test、git diff、git status
- Office：DOCX/XLSX/PDF 处理和检查
- Runtime：pause、resume、cancel、inspect、approve
- 可选 MCP：只接入经过显式配置的工具，不把任意 MCP 当作默认可信

每次 ToolCall 顺序固定为：

1. Schema 校验
2. canonical path 和 workspace 范围检查
3. Policy 判定：allow、ask、deny
4. 必要时创建 Approval 请求
5. sandbox/worker 执行
6. 记录 stdout/stderr、退出码、文件哈希、网络和资源摘要
7. 生成 Observation 与 Receipt
8. 将摘要和 Artifact 引用投影给模型

P0 默认策略：

- 读取工作区内文件：可自动。
- 修改工作区内文件：按 Workspace policy 自动或询问。
- shell/test：询问或只允许受控命令 profile。
- 删除、安装依赖、联网、上传、发送、Git commit：逐次审批。
- Keychain 值不进入模型上下文。
- sandbox 不可用时拒绝执行，不回退到宿主机全权限。

## 9. 桌面端与 CLI

桌面端采用三栏工作台：

- 左栏：Workspace、Session、Task、Run 状态和过滤器。
- 中栏：对话、计划、当前 Step、工具调用、暂停/恢复/取消。
- 右栏：文件树、Diff、Artifact、Verification、Approval、Token/费用和 Trace。
- 底部抽屉：终端输出、结构化事件、错误详情和导出。

CLI 与桌面端使用同一 Runtime Facade：

- 人类模式显示进度、审批和结果摘要。
- JSON 模式逐行输出事件，适合脚本和调试。
- inspect 命令读取状态和证据。
- resume、pause、cancel、approve、export 是显式运行控制，不依赖自然语言。

Electron 安全基线：

- Renderer 开启 context isolation。
- 文件、shell、Keychain 和 SQLite 只由主进程/Runtime 访问。
- Preload 暴露最小 typed IPC。
- UI 只订阅事件和请求操作，不执行副作用。
- 桌面端重启后从 SQLite 投影恢复，而不是从前端内存恢复。

## 10. 技术栈建议

| 层 | P0 建议 |
|---|---|
| 仓库 | pnpm workspace + TypeScript monorepo |
| Runtime | Node.js/TypeScript，独立 package 设计 |
| Desktop | Electron + React + Vite |
| CLI | Node.js/TypeScript，支持人类和 JSON 输出 |
| Schema | TypeScript 类型 + runtime schema validation |
| State | SQLite；事件表与投影查询分离 |
| Artifacts | 本地文件系统，SQLite 保存元数据、哈希和引用 |
| Credentials | macOS Keychain adapter |
| Provider | 自有 provider-neutral interface，厂商 adapter |
| Office worker | Python stdio worker，输入输出结构化、无凭据 |
| Sandbox | macOS 受限后端；容器作为后续 adapter |
| Tests | Runtime 状态机/事件回放、Policy、Provider contract、Verifier fixtures、桌面 IPC smoke |
| Observability | append-only event、structured trace、cost/token metrics、exportable diagnostics |

版本号和具体 ORM/组件库在实现前通过小型 spike 冻结，避免把参考项目的版本当成长期约束。

## 11. P0 验收计划

### Coding

固定 Helm 仓库样例任务：

1. 用户提供需求和完成条件。
2. Agent 读取项目规则和相关文件。
3. Agent 生成 proposal 并通过工具策略。
4. Agent 修改工作区。
5. Runtime 执行 lint/test。
6. Verifier 检查退出码、测试结果、diff、目标文件和禁止修改范围。
7. UI/CLI 展示 Artifact、证据和最终状态。

成功条件：目标行为通过、测试证据存在、diff 可审阅、无越权修改、Run 未超预算。

### DOCX

输入结构化内容，生成报告；检查文件可打开、标题/表格/段落结构、引用和输出路径；必要时渲染预览。

### XLSX

输入工作簿和修改契约；检查指定单元格、公式/数值、工作表结构、输出文件可打开和未授权区域未改变。

### PDF

优先提取文本层；无文本层时显式标记 OCR；检查页码来源、摘要与原文引用、不可读页和 OCR 失败。

证据不足、渲染失败、输入损坏或 verifier 无法运行时，结果为 UNKNOWN/不可评。

## 12. 实施顺序

### Phase 0：可回放核心

- 建立 pnpm monorepo、Runtime package、CLI package、共享 schema。
- 实现 SQLite event ledger、投影、Run 状态机、checkpoint 和 event replay。
- 实现单个 mock Provider、mock Tool、rule verifier 和 JSONL export。
- 用状态机测试证明 pause/resume/cancel/recovery。

### Phase 1：真实 Provider 与 Coding

- 接入 DeepSeek、智谱、Kimi adapter。
- 接入 Keychain credential resolver。
- 实现 read/search/patch/write、shell/test、git diff 工具。
- 实现 workspace path guard、approval、sandbox seam。
- 完成 Helm coding 验收样例。

### Phase 2：Office 与桌面端

- 接入 Python document worker。
- 实现 DOCX/XLSX/PDF tool 与 verifier。
- 实现 Electron 三栏工作台、安全 IPC、审批和 Artifact 预览。
- CLI 与桌面端对同一个 Run 做 resume/inspect/export 回归。

### Phase 3：稳定性和可观测性

- 预算、限流、重试分类、未知副作用对账。
- Provider contract tests、Verifier fixtures、故障注入。
- 诊断导出、trace viewer、Experience Candidate 记录。
- 冻结 P0 非目标，评估是否需要独立 Runtime 进程。

多 Agent、网络 A2A、GUI 自动化、外部系统写入和自动经验更新不进入上述 Phase 0–3。

## 13. 主要风险

| 风险 | 缓解 |
|---|---|
| Provider 工具调用语义不一致 | adapter contract、capability flags、provider fixtures |
| Electron 与 Runtime 状态分裂 | 单一 Runtime Facade，UI 只订阅事件 |
| shell 越权或 sandbox 失效 | path guard、逐次审批、fail-closed、故障注入 |
| “文件生成了”被误判为完成 | 独立 verifier、UNKNOWN 状态、Artifact hash |
| 长任务无限循环 | Step/时间/费用/reviewer 上限、doom-loop 检查 |
| Python worker 扩大权限面 | stdio 协议、无 Provider/Approval、受限环境 |
| 经验污染或策略漂移 | Experience Candidate、离线回归、人工批准、回滚 |
| 过早扩展范围 | P0 非目标和 ADR-0005 |

## 14. 实现状态

架构基线已确认并进入实现。本文描述目标架构与 P0 范围，不等于当前功能已经全部落地；当前代码事实、验证结果和未完成项见 [实现状态](../development/implementation-status.md)。
