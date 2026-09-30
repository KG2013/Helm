# Helm

Helm 是个人本地 LLM Harness，目标是连接 DeepSeek、智谱、Kimi，完成本地编码与 DOCX、XLSX、PDF 任务。首发平台为 macOS Apple Silicon，提供 Electron 桌面端和 CLI，由同一个 TypeScript Runtime 管理任务、权限、执行和验收。

**当前阶段：架构已确认，可运行骨架已建立，正在等待桌面端与 Runtime 接线。** 当前 CLI 运行 Mock Provider；桌面端是可预览的交互骨架。尚不能通过界面调用真实模型完成编码或办公任务。

## 快速开始

以下命令在仓库根目录执行。本轮验证环境为 Node.js 22.23.1、pnpm 10.34.5、Python 3.9.6；这些是已验证版本，不代表完整兼容范围。Python 仅用于文档 worker。

```bash
pnpm install --frozen-lockfile
pnpm build
```

启动桌面端开发预览：

```bash
pnpm dev:desktop
```

该命令构建 Electron main/preload，启动 Vite 和 Electron。默认端口为 `5173`，开发进程运行时可访问 [浏览器预览](http://localhost:5173/)；浏览器没有 Electron preload，因此只能查看界面。端口被占用时，先关闭已有预览进程。

也可以运行已构建的桌面应用：

```bash
pnpm --filter @helm/desktop start
```

运行 CLI 演示：

```bash
pnpm --filter @helm/cli dev -- run "检查 Helm 工作区"
pnpm --filter @helm/cli start -- run "生成报告演示"
```

CLI 输出 Task、Session、Run、Verification 和事件数量的 JSON 汇总。Mock Provider 返回固定模板文本，不会实际检查文件或生成报告。当前 `passed` 仅表示最终文本非空。CLI 用进程工作目录作为 workspace；通过 pnpm filter 启动时通常是 `apps/cli`，若需要以根目录启动，可在构建后执行：

```bash
node apps/cli/dist/main.js run "骨架冒烟检查"
```

## 界面与前后端分工

- 左栏：工作区和会话列表。
- 中栏：对话消息流、嵌入消息中的执行卡片、底部输入框；详细轨迹按需展开。
- 右栏：工件、审批、验收证据；终端和长日志规划为可展开面板。

逻辑上前后端分离，部署上本地一体化：React Renderer 是前端，Electron 主进程承载本地后端和 Runtime，双方通过 preload/IPC 通信。CLI 直接调用 Runtime，不需要独立 HTTP 后端。远程模型 API 负责推理；本地任务不等于离线推理。

目前中栏消息和执行进度是演示数据，发送按钮仅清空输入框；审批按钮只切换界面状态。完整职责、通信图和接线目标见 [桌面端、CLI 与 Runtime 分工](docs/design/desktop-runtime-boundary.md)。

## 仓库结构

| 路径 | 职责与当前状态 |
|---|---|
| `apps/desktop` | Electron + React + Vite 界面与 preload；尚未接入 Runtime |
| `apps/cli` | 调用 Runtime 的 Mock 演示命令 |
| `packages/runtime` | Task/Session/Run、状态机、内存事件账本、Policy/Executor/Verifier 接口；含待绑定的 SQLite 实现 |
| `packages/providers` | 通用非流式 OpenAI-compatible HTTP 适配器与三家厂商 id；真实 API 尚未联调 |
| `workers/document-worker` | JSONL 协议骨架，仅实现 health 和文件元数据 inspect |
| `docs/design`、`docs/adr` | 已确认架构、决策记录、来源归属 |
| `docs/development` | 实现状态、验证记录和后续任务 |

## 验证

```bash
pnpm build
pnpm test
pnpm typecheck
printf '{"id":"health-1","operation":"health"}\n' | python3 workers/document-worker/worker.py
```

首次检查先 build，使依赖包的声明与构建产物可用。桌面端类型检查在 build 中执行；当前没有独立 desktop typecheck 脚本。测试和已知限制详见 [当前实现状态](docs/development/implementation-status.md)。

## 接下来开发什么

先打通“输入任务 → IPC → Runtime → Mock Provider → 事件 → 对话与验收展示”，再推进受限 Coding 工具、DeepSeek/Keychain、智谱/Kimi、SQLite 重启恢复和 Office worker。真实副作用接入前必须完成路径、策略和执行边界。

分阶段交付条件见 [下一步实施计划](docs/development/next-steps.md)。

## 文档入口

- [AGENTS.md](AGENTS.md)：开发 Agent 的仓库工作指引。
- [CONTEXT.md](CONTEXT.md)：Task、Session、Run、Approval、Verification 等术语。
- [架构基线](docs/design/architecture-v0.md)：已确认的目标架构与 P0 范围。
- [设计访谈](docs/design/interview.md)：Q1–Q29 及后续界面确认。
- [架构决策记录](docs/adr)：技术栈、状态、执行隔离、验收与范围。
- [来源归属](docs/design/provenance.md)：z-ai-doc、llm-wiki、参考实现与本项目决策的对应关系。
- [设计依据](docs/design/source-notes.md)：资料性质与证据边界；本地知识库路径只在原开发环境可用。
- [公共测试接口](docs/design/test-seams.md)：测试规划与当前覆盖情况。
