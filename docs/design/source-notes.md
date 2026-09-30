# Helm 设计依据与证据边界

核查日期：2026-09-30（Asia/Shanghai）。来源均只读查阅；以下区分当前文件事实、历史方案、知识库观点与待验证建议。

## z-ai-doc

| 来源 | 核查内容与用途 | 边界 |
|---|---|---|
| [本地助手路线](/Users/zhangkuo/Documents/z-ai-doc/raw/articles/local-multi-agent-assistant-roadmap.md) | Session/Task runtime、单 Agent 起步、Artifact 交接、权限与恢复。 | 知识库设计建议，不是 Helm 当前实现。 |
| `/Users/zhangkuo/Documents/z-ai-doc/raw/articles/originals/helm/helm-agent-capability-knowledge-map.md:18-26,95-111,149-165,263-332` | 任务所有者、队列、取消、恢复、工具/Skill、UI 工作台与 P0/P1/P2 路线。 | 引用 Helm 旧快照 `267c3eb`；不能将旧状态当作当前代码事实。 |
| `/Users/zhangkuo/Documents/z-ai-doc/raw/articles/originals/helm/helm-kimi-multi-agent-capability-map.md:11-17,48-69` | 九层工程能力图，可用作需求覆盖检查。 | 明确基于 helm-kimi `a0118a5`，2026-07-09；不代表本仓库已有这些能力。 |
| `/Users/zhangkuo/Documents/z-ai-doc/raw/articles/harness-loop-graph-engineering.md:106-139,151-205,207-242` | Harness 管环境和治理，Loop 管反馈与停止，Graph 管已知控制流；根据失败模式选择结构。 | 教学分层，不是必须采用三套框架或行业标准。 |
| `/Users/zhangkuo/Documents/z-ai-doc/raw/articles/evidence/ai-sandbox-boundaries-evidence.md:15-29,39-45` | worktree 与安全沙箱、文件快照与运行状态/外部副作用分别判断。 | 2026-09 的厂商资料快照，未提供 Helm 部署或隔离实测。 |

## llm-wiki

| 来源 | 核查内容与用途 | 边界 |
|---|---|---|
| `/Users/zhangkuo/项目/大观/llm-wiki/concepts/model-harness-boundary.md:20-35,54-56` | 以模型 + Harness + 任务 + 预算 + 环境作评测单位；模型接入与自身产品资产分开。 | 含研究归纳和大观产品判断，迁移到个人 Helm 是设计推断。 |
| `/Users/zhangkuo/项目/大观/llm-wiki/concepts/harness-as-experience-infrastructure.md:17-26,28-38,44-52` | 上下文、工具、权限、执行、验证、经验；经验按范围与阶段选择；更新可审计。 | 五层及经验字段明确标为 Candidate，不直接固化为已验证实现。 |
| `/Users/zhangkuo/项目/大观/llm-wiki/concepts/executable-feedback.md:20-34,36-54` | 编码、文档、表格、PPT 采用不同验证信号；证据不足不当作成功。 | 是验收方法输入；具体 Helm 验证器须由真实任务定义并测试。 |

## 本地 DeepSeek Harness 实现参考

已直接查阅 `/Users/zhangkuo/Lab/deepseek-harness/docs/architecture.md`：

- 第 9–27 行：Cordis 插件组成、profile/bundle 分层。
- 第 39–61 行：session、agent、tools、LLM 及三类事件。
- 第 63–96 行：Turn/Step 流程与 model-visible 输入可由日志重建的原则。
- 第 98–128 行：可替换的能力接口；provider、工具、文件、进程、sandbox、UI 等接入方式。

本次参考源码 HEAD：`47f943859bef60e4160492346772ded9b24f765a`，查阅时工作区干净。

可参考这些接口和生命周期。Helm 已选择“自有 TypeScript Runtime 核心 + 可插拔外围”，不采用 Cordis 或复用 DSH 核心；这是 Helm 的已确认设计决策，不是参考项目已验证的实现事实。

## 官方在线参照

- [Codex 官方产品介绍](https://openai.com/index/introducing-the-codex-app/)：项目/任务线程、并行工作、差异评审、worktree、Skills 与办公产物作为交互参考。该文是 2026-02 发布的产品介绍，不能代替当前产品完整功能规格。
- [DeepSeek Harness 官方仓库](https://github.com/deepseek-ai/deepseek-harness)：确认公开仓库的插件化定位、Web 入口与 developer preview 状态。上游明确会有不兼容变化；若复用，应固定版本并验证。

## 已确认术语与后续验收

项目专用术语见根目录 CONTEXT.md，已覆盖 Task、Session、Run、Turn、Step、Agent、Tool、Artifact、Verification、Checkpoint、Approval、needs_reconciliation 和 Experience Candidate。

后续要验证的是实现行为：任务与会话是否正确分离；执行与授权是否可审计；状态恢复与外部副作用是否分开；文件生成是否达到交付标准；本地执行与本地推理是否保持边界。它们属于测试和验收问题，不是尚未确认的产品决策。
