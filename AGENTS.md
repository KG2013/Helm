# Helm 仓库工作指引

## 开始任务

1. 读取 [README.md](README.md) 和 [当前实现状态](docs/development/implementation-status.md)，再检查 `git status --short`。架构已获用户确认，日常实现按当前任务授权推进。
2. 修改任务语义、模块职责或 P0 范围时，读取 [架构基线](docs/design/architecture-v0.md)、相关 `docs/adr/` 及 [CONTEXT.md](CONTEXT.md)。accepted ADR 表示设计获认可，不表示已实现。
3. 继续开发时从 [下一步实施计划](docs/development/next-steps.md) 选择当前切片，用该切片的可观察验收条件界定完成。

## 项目约束

- Runtime 拥有 Task/Session/Run、工具策略和验收语义；桌面和 CLI 复用这一层。Renderer 通过窄化 preload/IPC 请求操作，本地文件、shell、数据库和凭据访问留在主进程或受控执行层。
- 桌面交互以中栏对话为主，执行过程嵌入消息或折叠展示；右栏呈现工件、审批、证据。调整桌面或 IPC 时读取 [职责边界](docs/design/desktop-runtime-boundary.md)。
- 工具提案先过 ToolPolicy，再进入 ToolExecutor；保留默认拒绝。审批绑定具体动作和范围，未知副作用先对账。worktree 不能代替 sandbox。
- 真实 Provider 调用留在适配器。凭据目标是 Keychain；API Key、Authorization header 和用户私有文件内容不得进入仓库或诊断输出。
- 将 Mock 响应、静态 UI、内存恢复、文本非空检查与真实任务验收分别报告。新增真实功能时同步维护实现状态。
- P0 限个人本地、单 Agent、编码与 DOCX/XLSX/PDF；其他范围以基线和用户新指令为准。

## 开发与验证

- 使用 pnpm workspace 与根锁文件，具体命令从各 `package.json` 读取；安装、运行入口见 README。
- 首次使用或修改包导出后先 `pnpm build`。根 TypeScript 配置默认 `noEmit: true`，需要输出的包必须显式覆盖；构建成功后还要验证入口产物能启动。
- Runtime/Provider 行为改动测试公共接口及失败边界；桌面改动至少构建，并对相关交互做冒烟检查。采用 [测试规划](docs/design/test-seams.md)，报告实际执行的检查和未覆盖项。
- 当前桌面 TypeScript 检查包含在 build，根 `pnpm typecheck` 不单独检查桌面。浏览器预览没有 Electron IPC，不能替代桌面验证。
- 查来源时读 [provenance.md](docs/design/provenance.md)；个人知识库路径不可用时注明，依靠仓库已有决策继续可独立完成的工作。

## 交付

- 更新相关文档中的实现状态、运行步骤和限制；最终报告区分已测、未测与计划。
- 提交前检查 diff，保留用户已有工作；编译产物、依赖目录、临时文件和凭据按 `.gitignore` 排除。
- 用户要求提交时完成检查后直接 commit；push 需要用户授权。若新建分支，使用 `codex/` 前缀。
