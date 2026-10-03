# Issue #6 验收证据

Issue：T1 Safe workspace inspection through Runtime Facade

## 代码边界

- `workspace.inspect@v1` 通过 `StaticToolRegistry` 注册；未注册 Tool 在 Runtime Policy 阶段拒绝。
- `createReadOnlyWorkspacePolicy` 只允许 workspace 范围、只读、无网络的 Profile，并默认拒绝未配置 Policy 的调用。
- `createWorkspaceInspectionExecutor` 在受信 workspace root 内执行元数据检查，拒绝绝对路径、遍历、符号链接逃逸和路径替换；读取前后比较 canonical path 与文件身份。
- Receipt 只包含 bounded metadata、`workspace://` Artifact URI 和 SHA-256，不读取文件正文，不写入文件，不访问凭据。
- CLI 与 Desktop 都通过 `createWorkspaceInspectionRuntime` 使用同一 Runtime Facade。

## 验证

```text
pnpm test
pnpm build
pnpm typecheck
pnpm --filter @helm/desktop test:electron
```

覆盖范围包括：结构化 Observation/Receipt/Artifact/Verification、未知 Tool、默认拒绝、显式允许、路径遍历、符号链接逃逸、TOCTOU 身份复核、越界参数和 Desktop IPC 投影。

结果：Runtime 47/47、Provider 7/7、Desktop IPC 6/6、Electron smoke 1/1；构建和类型检查通过。
