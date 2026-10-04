# Issue #43：显式 opt-in 真实 smoke 证据收集入口

核对日期：2026-10-04。

## 已实现

- CLI 新增 `helm acceptance smoke [--run-real] [--json]`。
- 未传 `--run-real` 时不启动任何真实任务，所有 smoke 检查返回 `unverified` 并阻断 release gate。
- `--run-real` 复用既有 Electron packaged restart/multi-window smoke；子进程固定使用 MockProvider，过滤凭据类环境变量，避免读取 Keychain secret。
- Docker、Provider、Office/OCR 的目标环境 runner 保持独立边界；未接入 runner 时返回 `unverified`，preflight 已知缺失继续返回 `unknown`。
- smoke 报告与 preflight 报告分离，记录 `mode: smoke`、命令引用、退出码、耗时、stdout/stderr 字节数和 hash；不记录完整输出。

## 验证

```text
pnpm --filter @helm/cli test
pnpm build
pnpm typecheck
pnpm --filter @helm/desktop test:electron
node apps/cli/dist/main.js acceptance smoke --json
node apps/cli/dist/main.js acceptance smoke --run-real --json
```

CLI smoke fixture 5/5 通过。当前机器的 real smoke 结果：

| 检查 | 结果 | 说明 |
|---|---|---|
| Docker | `unverified` | 本切片未配置真实 coding runner |
| Provider | `unverified` | 本切片未执行真实厂商请求 |
| Office/OCR | `unknown` | `tesseract` 缺失，沿用 preflight UNKNOWN |
| Electron | `passed` | packaged restart/multi-window smoke 退出码 0，输出仅保存 hash |
| Release gate | `blocked` | 其他目标环境证据未满足 |

默认模式的 CLI 退出码为 2；`--run-real` 当前机器的 CLI 退出码也为 2，因为 Docker/Provider 未接入 runner 且 Office/OCR 为 UNKNOWN。两次输出均未发现 API key、Authorization、password 等敏感 marker。

后续应分别为 Docker、DeepSeek/智谱和 Office/OCR 接入目标环境 runner；这些工作不在本 issue 内完成。
