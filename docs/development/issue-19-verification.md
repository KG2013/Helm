# Issue #19：Docker 真实隔离验收

核对日期：2026-10-04。

本切片把 Docker Coding backend 的可验证失败边界收紧，并把目标环境 smoke 与 fixture 明确分开。

## 已实现的安全合同

- 通过 `createDockerCodingSandboxFromEnv` 启用时，镜像必须是 `name@sha256:<64 位十六进制 digest>`；tag 或缺失镜像配置直接返回 `undefined`，Coding 入口继续按 sandbox unavailable 拒绝执行。
- 首次容器操作前可执行有界 preflight：`docker info` 必须返回 security options，`docker image inspect` 必须返回镜像 ID。daemon、镜像或安全元数据缺失会返回 `DockerSandboxError(unavailable=true)`，不会切换到宿主机执行。
- 容器参数固定包含 `--pull=never`、`--network=none`、`--cap-drop=ALL`、`--security-opt=no-new-privileges`、`--read-only`、`--tmpfs /tmp`、非 root `--user`、`--pids-limit`、`--memory`、`--cpus` 和仅挂载 workspace 的 `rprivate` bind mount。
- 内存、CPU、PID、超时和用户参数在构造时做有限值校验；用户必须是数值非 root UID[:GID]。workspace 根目录和 cwd 先 canonicalize，写入目标跟随现有父目录解析，符号链接逃逸在调用 Docker 前拒绝。
- 不使用 host shell。Docker command 的非零退出码原样返回；daemon/镜像失败、超时、取消和输出缓冲溢出保持明确分类。stdout/stderr 在返回前限制为 64 KiB，超时、取消、溢出使用 `sideEffect: unknown`，不会被当成成功。

## Fixture 验证

执行：

```text
pnpm --filter @helm/runtime typecheck
pnpm --filter @helm/runtime exec tsx --test test/sandbox.test.ts
```

结果：6/6 通过，覆盖固定容器参数、非零退出码、64 KiB 输出上限、timeout/取消与输出溢出 UNKNOWN、digest/security/image preflight、环境工厂 fail-closed，以及符号链接写入边界。fixture 使用替代的 `execFile`，不会启动 Docker，也不代表真实隔离已通过。

## 真实 Docker smoke 边界

本机未运行 Docker daemon：`docker info` 返回 `Cannot connect to the Docker daemon at unix:///Users/zhangkuo/.docker/run/docker.sock`；同时没有可供检查的固定 digest 镜像。因此本次不能宣称真实网络、权限、资源、工作区挂载、超时、输出限制、任务 diff/test 或 Verifier evidence 已通过。

目标环境应先准备固定 digest 镜像和运行中的 daemon，再以 `HELM_CODING_SANDBOX=docker`、`HELM_CODING_SANDBOX_IMAGE=<registry>/<image>@sha256:<digest>` 启动 Coding CLI/Desktop，记录：

1. `docker info` security options 与 `docker image inspect` 的 ID；
2. 一个受控编码任务的 read → edit/patch → test → diff → Coding Verifier evidence；
3. 网络访问、root/特权、PID/CPU/内存、只读根文件系统、workspace 写入、路径与符号链接/TOCTOU、超时和超大输出的失败结果；
4. daemon、镜像或安全约束缺失时的 `unavailable`/`unknown` 结果和清理记录。

真实 smoke 的日志只能保存 bounded、脱敏的状态、退出码、hash、Artifact URI 和限制说明，不应保存 API key、Authorization header、私有文件内容或完整请求/响应体。
