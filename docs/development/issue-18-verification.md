# Issue #18 验证记录：Coding 证据面板与补丁冲突 Artifact

核对日期：2026-10-04。

## 已实现

- `workspace.patch@v1` 支持可选 `baseHash`，在写入前复核工作区文件哈希。
- base hash 过期、文本上下文不存在或匹配不唯一时，Runtime 返回 `ok:false`、`sideEffect:none`，不调用 sandbox 写入，并生成 `coding-conflict` Artifact。
- 冲突 Artifact 只保存有界路径、哈希、候选偏移/行号、上下文哈希、匹配数量和人工处理原因；原文件文本不写入事件账本。
- CLI 继续输出 `RunProjection`，因此能看到冲突 Artifact、Coding delivery 状态、测试和 diff；Desktop 右栏展示同一 projection 的 Coding diff、测试命令/结果、冲突状态和 Verification evidence。
- `CodingVerifier` 遇到冲突 Artifact 返回 UNKNOWN，不能仅凭模型文字、文件存在或非空输出放行。

## 验证

- Runtime 定向测试覆盖 base hash stale、context mismatch、non-unique match 三种冲突，确认文件内容未变化、写入次数为 0、Artifact 含 hash/bytes/候选和人工处理原因。
- Projection 测试确认冲突 Artifact 被投影为 `codingDelivery.conflicts`，并将 `ready` 置为 false。
- Desktop IPC 仍通过既有快照/导出 projection；本轮完成生产 Electron UI build，未把真实任务执行或像素级 UI 对比计入通过条件。
- 真实 Docker daemon/image、真实工作区编码任务和像素级 UI 对比不在本记录中宣称已通过。
