# Helm 架构基线的来源拆分

核查日期：2026-09-30（Asia/Shanghai）。

本文回答“架构基线 v0 哪些内容来自 z-ai-doc”。“来自”分为三种：直接借鉴的原则或结构、来自其他本地参考而非 z-ai-doc、以及在访谈中由用户确认后形成的 Helm 决策。z-ai-doc 中标注为历史快照、Candidate 或研究归纳的内容，不等于 Helm 已经实现。

## 一、直接来自 z-ai-doc 的内容

| 架构基线内容 | z-ai-doc 来源 | 在 Helm 中的落点 |
|---|---|---|
| Harness 不是模型或聊天 UI，而是组织任务、上下文、工具、权限、状态、验证和恢复的运行约束层 | [Agent Harness](/Users/zhangkuo/Documents/z-ai-doc/wiki/Agent%20Harness.md:71) | architecture-v0 的目标、组件职责、Model/Harness/Environment 边界 |
| Model 只提出建议，Harness 负责 schema、授权、执行、观察、验收和生命周期 | [Agent Loop](/Users/zhangkuo/Documents/z-ai-doc/wiki/Agent%20Loop.md:40) | Proposal → PolicyDecision → ToolCall → Observation/Receipt → Verification |
| Event 是事实，State 是归约结果；不能把自然语言摘要当权威状态 | [Agent Loop](/Users/zhangkuo/Documents/z-ai-doc/wiki/Agent%20Loop.md:83) | SQLite append-only events、projection、replay 和 recovery |
| 状态机包含 deciding、validating、executing、reducing、verifying、paused、failed、cancelled 等语义 | [Agent Loop](/Users/zhangkuo/Documents/z-ai-doc/wiki/Agent%20Loop.md:57) | Run 状态机与终态定义 |
| 完成必须有验收证据；done proposal 只触发验收；未知副作用先对账 | [Agent Loop](/Users/zhangkuo/Documents/z-ai-doc/wiki/Agent%20Loop.md:123)、[终止与取消](/Users/zhangkuo/Documents/z-ai-doc/wiki/Agent%20Loop.md:164) | completed、UNKNOWN、needs_reconciliation、Verifier |
| Checkpoint、暂停、恢复、取消、幂等、预算和 doom-loop 检测是一等运行时语义 | [Agent Loop](/Users/zhangkuo/Documents/z-ai-doc/wiki/Agent%20Loop.md:192)、[Context 与观测](/Users/zhangkuo/Documents/z-ai-doc/wiki/Agent%20Loop.md:217) | Run budget、checkpoint、recovery、repeat detection |
| Agent 是 Profile + runtime state + tools + memory + permissions + traces，不等于 prompt | [Helm 能力地图](/Users/zhangkuo/Documents/z-ai-doc/raw/articles/originals/helm/helm-agent-capability-knowledge-map.md:78) | Agent/Model/Session/Workspace 的概念区分 |
| Session owner、Task、Event log、Checkpoint/resume、Cancellation、Backpressure | [Helm 能力地图](/Users/zhangkuo/Documents/z-ai-doc/raw/articles/originals/helm/helm-agent-capability-knowledge-map.md:95) | 一个 Session 一个 active Run、SQLite 事件和有限并发 |
| MCP 是 Agent 到工具/数据源，A2A 是 Agent 到 Agent；Artifact 不传完整对话 | [Helm 能力地图](/Users/zhangkuo/Documents/z-ai-doc/raw/articles/originals/helm/helm-agent-capability-knowledge-map.md:134)、[本地助手路线](/Users/zhangkuo/Documents/z-ai-doc/raw/articles/local-multi-agent-assistant-roadmap.md:120) | MCP 后置、网络 A2A 不进 P0、产物独立保存 |
| Tool Registry、Tool Executor、Skill、Office tools 的分工 | [Helm 能力地图](/Users/zhangkuo/Documents/z-ai-doc/raw/articles/originals/helm/helm-agent-capability-knowledge-map.md:149) | Tool/Office/Provider/Verifier 接口分层 |
| Path Guard、Permission Engine、Dry-run、Audit、Sandbox、Secrets hygiene 和 fail-closed | [Helm 能力地图](/Users/zhangkuo/Documents/z-ai-doc/raw/articles/originals/helm/helm-agent-capability-knowledge-map.md:167)、[本地助手路线](/Users/zhangkuo/Documents/z-ai-doc/raw/articles/local-multi-agent-assistant-roadmap.md:174) | Keychain、路径守卫、审批、sandbox adapter、失败拒绝 |
| Runtime 是本地副作用的唯一入口，PermissionEngine 在 ToolExecutor 前，Trace/Audit append-only | [Helm 能力地图](/Users/zhangkuo/Documents/z-ai-doc/raw/articles/originals/helm/helm-agent-capability-knowledge-map.md:295) | Runtime Facade、Policy/Approval、Tool Executor 边界 |
| UI 应是 Chat + Task Workbench，显示 Artifact、Trace、审批、验证证据，而非只有聊天气泡 | [Helm 能力地图](/Users/zhangkuo/Documents/z-ai-doc/raw/articles/originals/helm/helm-agent-capability-knowledge-map.md:241) | 三栏工作台的产品方向 |
| 九层能力图：Runtime、Agent、Tools、Context/Memory、Orchestration、Multi-Agent、Safety、Surface、Governance/Eval | [Helm-kimi 能力图谱](/Users/zhangkuo/Documents/z-ai-doc/raw/articles/originals/helm/helm-kimi-multi-agent-capability-map.md:48) | architecture-v0 的组件分层与 P0/P1 取舍 |
| P0 先单 Agent、Coding inspect→edit→test→diff→report、Office skill、rule grader；多 Agent 后置 | [Helm-kimi 能力图谱](/Users/zhangkuo/Documents/z-ai-doc/raw/articles/originals/helm/helm-kimi-multi-agent-capability-map.md:235) | P0 任务闭环和单 Agent + reviewer |
| Harness、Loop、Graph 的职责区别，以及“证据驱动的有界返工” | [Harness、Loop 与 Graph](/Users/zhangkuo/Documents/z-ai-doc/raw/articles/harness-loop-graph-engineering.md:42) | Agent Loop、Verifier、预算和停止条件 |
| 上下文、行动、状态、治理、观测、编排六个 Harness 能力面 | [Harness、Loop 与 Graph](/Users/zhangkuo/Documents/z-ai-doc/raw/articles/harness-loop-graph-engineering.md:106) | 高层架构图和组件职责 |
| 预算、Stop/Escalation、独立验证、防止无限重试 | [Harness、Loop 与 Graph](/Users/zhangkuo/Documents/z-ai-doc/raw/articles/harness-loop-graph-engineering.md:151) | 30 Step、15 分钟、1 reviewer 的 P0 预算设计依据 |
| worktree 不等于安全隔离；文件快照、运行态快照和外部副作用要分开判断 | [沙箱边界证据](/Users/zhangkuo/Documents/z-ai-doc/raw/articles/evidence/ai-sandbox-boundaries-evidence.md:15) | ADR-0003 和“不把 Git worktree 当沙箱” |

## 二、不是直接来自 z-ai-doc 的内容

这些内容主要来自本地参考实现、官方产品页面或本次对源码的直接查阅：

| 内容 | 主要来源 |
|---|---|
| DeepSeek Harness 的 Cordis 全插件架构、profile/bundle、SessionEvent、Turn/Step、capability seams | [本地 DeepSeek Harness architecture.md](/Users/zhangkuo/Lab/deepseek-harness/docs/architecture.md:9) |
| DeepSeek Harness 的具体 provider-neutral message/stream 类型、credentials resolver 和工具流水线 | /Users/zhangkuo/Lab/deepseek-harness/packages 与 docs 的直接源码查阅 |
| Codex 的任务线程、并行 Agent、Diff/worktree、Skills 和桌面工作台形态 | [Codex 官方产品介绍](https://openai.com/index/introducing-the-codex-app/) |
| 评测单位是 Model + Harness + Task + Budget + Environment，经验候选需要版本/范围/验证/回滚 | [llm-wiki：模型与 Harness 的系统边界](/Users/zhangkuo/项目/大观/llm-wiki/concepts/model-harness-boundary.md:20)、[Harness 作为经验基础设施](/Users/zhangkuo/项目/大观/llm-wiki/concepts/harness-as-experience-infrastructure.md:17)、[可执行反馈](/Users/zhangkuo/项目/大观/llm-wiki/concepts/executable-feedback.md:20) |
| “证据不完整为 UNKNOWN，不算成功”作为 office 交付验收口径 | llm-wiki 的可执行反馈原则，并结合 z-ai-doc Agent Loop 的 completed gate |
| macOS Keychain、Electron + React + Vite、SQLite、Python worker | 本轮访谈中用户接受的推荐；技术实现选型，不是 z-ai-doc 已验证事实 |

## 三、由用户确认后形成的 Helm 决策

以下不是从资料中直接复制，而是将参考原则应用到你的项目后，经你确认的产品决策：

- P0 Provider 具体选 DeepSeek、智谱、Kimi。
- 首发平台为 macOS Apple Silicon。
- 桌面端采用 Electron + React + TypeScript + Vite，另有 CLI。
- P0 只处理本地 DOCX、XLSX、PDF，不写飞书、邮件，不做 GUI 自动化。
- 每个 Session 一个 active Run；默认 30 Step、15 分钟、1 reviewer。
- Provider API Key 放 macOS Keychain。
- P0 采用分层执行和可替换 sandbox；sandbox 不可用时 fail-closed。
- P0 只记录 Experience Candidate，不自动修改 Skill、Memory 或 Harness。
- P0 明确排除多用户、远程执行、网络 A2A、marketplace 和外部系统写入。

## 四、当前架构中属于综合推断的内容

这些是根据多份材料和你的选择综合出来的工程设计，不应标注为某一来源的原句：

- Workspace → Task → Session → Run → Turn → Step → Proposal → PolicyDecision → ToolCall → Observation/Receipt → Artifact → Verification → Delivery 主链。
- Desktop/CLI → Runtime Facade → Orchestrator → Agent Loop → Provider/Tool/Policy/Verifier 的组件图。
- SQLite 逻辑表拆分：workspaces、tasks、sessions、runs、turns、steps、events、approvals、artifacts、verifications 等。
- 三栏 UI 的具体左右栏/中栏/右栏布局。
- TypeScript package 先嵌入、未来独立 Runtime 进程化。
- 将 DeepSeek、智谱、Kimi wire format 差异限制在 Provider Adapter 内。
- Phase 0–3 的实现顺序和风险表。

这些综合设计可以被实现、测试和后续 ADR 重新修订，但不能反向声称它们已经由 z-ai-doc 或参考项目验证。
