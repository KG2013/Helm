# Helm 设计访谈与决策树

更新日期：2026-09-30（Asia/Shanghai）。阶段：四轮产品、技术栈、权限、验收和 P0 范围决策已确认，已进入骨架实现与验收。本文记录决策来源，不是实现状态报告。

## 已确认的目标

- 开发属于自己的 Harness，连接不同厂商的 LLM，完成本地编码与办公任务。
- 界面参考 Codex、DeepSeek Harness 的交互与任务组织方式。
- 技术栈、架构与功能设计参考 z-ai-doc 和 llm-wiki。
- 使用 grill-with-docs：通过逐轮访谈形成共享理解，随决策更新术语和必要的 ADR。

## 已核实的环境

- 当前工作区为 /Users/zhangkuo/Lab/Helm，初始只有 README.md，无应用代码或依赖配置；Git HEAD 为 0937282（Initial commit）。
- 本次新增文档前，唯一未跟踪文件为 .DS_Store。
- z-ai-doc 位于 /Users/zhangkuo/Documents/z-ai-doc。
- llm-wiki 位于 /Users/zhangkuo/项目/大观/llm-wiki。
- /Users/zhangkuo/Lab/deepseek-harness 有可查阅的实现与架构文档。
- 知识库内既有 Helm 资料引用了 2026-07-09 的旧仓库快照，其能力状态不适用于当前工作区。

## 决策树状态

所有产品前置问题 Q1–Q29 已回答。架构基线已确认；剩余事项属于实现验收和迭代决策，不再阻塞骨架实现。

## 第 1 轮：产品方向（已确认）

| 编号 | 用户决策 | 结果 |
|---|---|---|
| Q1 | 产品首先服务个人，还是可分发/多用户平台？ | **个人、单机优先；账号与租户后置。** |
| Q2 | 首版平台范围？ | **macOS Apple Silicon 优先，保留跨平台扩展。** |
| Q3 | 必接厂商/协议，以及原生能力要求？ | **云 API/自定义端点优先，本地推理可选；核心采用规范化 Provider 接口。** |
| Q4 | 首版最重要的编码任务与样例？ | **仓库修改、实现小功能、失败调试。** |
| Q5 | 首版最重要的办公任务与样例？ | **DOCX、XLSX、PDF。** |
| Q6 | 本地文件、shell、网络和外部写入的自主程度？ | **工作区范围授权；高风险动作有可审阅的权限门禁。** |
| Q7 | 首版入口？ | **桌面端 + CLI，共用一个本地运行时。** |
| Q8 | 是否必须首版多 Agent？ | **单 Agent + 有界 reviewer；多 Agent 后置。** |
| Q9 | 是否要求完成必须有外部证据？ | **是；分类型定义证据。** |
| Q10 | “自己的 Harness”要拥有哪些部分，是否接受复用已有核心？ | **自己掌握任务循环、状态与策略；SDK、MCP、文档库等外围能力优先复用，DSH 作为对照实现。** |

## 第 2 轮：运行时与技术栈（已确认）

| 编号 | 用户决策 | 结果 |
|---|---|---|
| Q11 | Provider 首批名单 | **DeepSeek、智谱、Kimi；其他 Provider 通过统一接口后续接入。** |
| Q12 | 桌面技术栈 | **Electron + React + TypeScript + Vite。** |
| Q13 | 核心运行时形态 | **先做可嵌入 TypeScript package，接口按独立本地 Runtime 演进。** |
| Q14 | 状态真源 | **SQLite 查询与恢复真源 + append-only 事件表；JSONL/文件用于导出与大产物。** |
| Q15 | 办公文件处理边界 | **P0 只处理本地 DOCX/XLSX/PDF，不控制外部系统或桌面 GUI。** |
| Q16 | Python 文档处理 worker | **接受受控 Python worker；不拥有 Agent 循环、Provider 凭据或审批权。** |

## 第 3 轮：权限、状态机与验收（已确认）

| 编号 | 用户决策 | 结果 |
|---|---|---|
| Q17 | Provider 凭据存储 | **API Key 使用 macOS Keychain；SQLite 只保存引用和元数据。** |
| Q18 | P0 执行隔离 | **分层执行；文件/文档 worker 受限运行，代码与 shell 走可替换 sandbox，失败 fail-closed。** |
| Q19 | Task、Session、Run、Turn、Step 关系 | **Task 是目标，Session 是交互上下文，Run 是执行，Turn/Step 是执行层级。** |
| Q20 | 并发与恢复 | **每 Session 一个 active Run；有限跨 Session 并发；支持重启恢复；未知副作用进入 needs_reconciliation。** |
| Q21 | 桌面工作台布局 | **三栏工作台；终端和长日志为可展开面板。** |
| Q22 | 验收与预算原则 | **coding/office 分型 verifier；UNKNOWN 不算成功；Run 有步骤、时间、费用和 reviewer 上限。** |
| Q23 | Memory、Skill 与经验更新 | **P0 只记录 Experience Candidate，不自动改变生产 Harness。** |

## 第 4 轮：P0 验收与范围（已确认）

| 编号 | 用户决策 | 结果 |
|---|---|---|
| Q24 | Coding 主验收样例 | **以 Helm 自身仓库为可重复样例，覆盖读取、修改、lint/test、diff 和证据报告。** |
| Q25 | Office 验收样例 | **DOCX 报告、XLSX 定点修改与校验、PDF 文本/OCR 摘要。** |
| Q26 | Provider 统一能力 | **P0 统一文本、流式、结构化工具调用和错误分类；原生差异用 capability flags。** |
| Q27 | Run 默认预算 | **默认最多 30 Step、15 分钟、可配置 Token/费用上限、最多 1 次 reviewer。** |
| Q28 | P0 不做范围 | **不做多用户、远程执行、飞书/邮件写入、GUI 自动化、marketplace、自动经验更新、网络 A2A。** |
| Q29 | 下一步交付形式 | **先产出完整架构、技术栈、数据模型和验收计划，再搭建骨架。** |

## 已形成的 ADR

- ADR-0001：TypeScript Runtime + Electron + CLI
- ADR-0002：SQLite 事件账本 + 受控文档 worker
- ADR-0003：Keychain 与分层执行策略
- ADR-0004：证据验收、恢复与经验候选
- ADR-0005：P0 范围与 Run 预算

## 共享理解确认

用户已确认架构基线，进入可运行骨架实现阶段。后续实现若改变基线，先新增或更新 ADR，再修改代码。
