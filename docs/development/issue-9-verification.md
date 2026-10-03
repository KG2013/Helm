# Issue #9 验收证据

Issue：T4 Coding edit-test-diff Delivery

## 代码边界

- `workspace.read/edit/patch/test/diff@v1` 均来自注册 Tool Profile；路径守卫、Approval、Policy 和 CodingVerifier 在 Runtime Facade 内执行。
- `DockerCodingSandbox` 是可选的受限后端：只允许 canonical workspace bind mount，`network=none`、`cap-drop=ALL`、`no-new-privileges`、read-only root、tmpfs、PID/memory/CPU bounds；命令使用 argv 调用，不经过 host shell。
- 写文件使用容器内固定 Python helper，内容以 base64 参数传入；Docker daemon、镜像或后端不可用时返回 unavailable，CLI/Desktop 不回退宿主机执行。
- `HELM_CODING_SANDBOX=docker` 与 `HELM_CODING_SANDBOX_IMAGE` 启用同一后端；未配置时 Coding mutation/test 保持 fail-closed。
- Coding Artifact 记录 changed-file scope、diff/test 输出、exit code、sandbox metadata 和 hashes；缺少 read/edit/test/diff/Artifact 证据时 CodingVerifier 返回 UNKNOWN。

## 验证

```text
pnpm --filter @helm/runtime exec tsx --test test/sandbox.test.ts test/workspace-inspect.test.ts
pnpm --filter @helm/runtime build
pnpm --filter @helm/cli build
pnpm --filter @helm/desktop build
```

Runtime Coding/ sandbox 相关测试 11/11 通过。测试覆盖 registered profiles、exact approval continuation、path/symlink guards、sandbox unavailable fail-closed、Docker argv isolation、network/privilege limits 和 no-host-fallback。真实 Docker daemon/image smoke 需在配置了 Helm Coding image 的目标环境执行；本机未将 Docker daemon 可用性宣称为通过。
