# Helm CLI

CLI 与桌面端共用 `@helm/runtime`。默认命令使用 `MockProvider` 验证 Task → Session → Run → Event Ledger → Verification；设置 `HELM_STATE_DB=/absolute/path/state.sqlite` 可启用原生 SQLite 重启账本。设置 `HELM_PROVIDER=deepseek|zhipu|kimi` 后会从 macOS Keychain 读取对应凭据，并通过 `OpenAICompatibleProvider` 发起真实请求；DeepSeek/智谱默认走 Runtime SSE stream seam。Keychain 凭据缺失时请求会 fail-closed 并返回脱敏认证诊断，不会发起 HTTP 请求。

运行 G0 环境验收矩阵：

```bash
node apps/cli/dist/main.js acceptance preflight
node apps/cli/dist/main.js acceptance preflight --json
node apps/cli/dist/main.js acceptance smoke --json
node apps/cli/dist/main.js acceptance smoke --run-real --json
```

`acceptance smoke` 默认不会启动真实任务；只有显式传入 `--run-real` 才会执行当前已接入的 Electron packaged restart/multi-window smoke。子进程输出只保留字节数和 hash，真实 Docker、Provider、Office/OCR smoke 在目标环境接入前保持 `unverified`/`unknown`，不会读取或打印 Keychain 凭据。

该命令只执行 Docker/Provider/Office/OCR/Electron 的 bounded preflight，不发起真实 Provider 请求或编码任务。默认输出人类摘要，`--json` 输出同一份机器可读矩阵；任何 `unknown`、`unverified` 或 `failed` 都以非零退出码阻断 release gate。API Key、Authorization header 和私有文件内容不会进入输出。

```bash
pnpm --filter @helm/cli dev -- run "inspect the Helm workspace"
pnpm --filter @helm/cli build
pnpm --filter @helm/cli start -- run "produce a local report"
pnpm --filter @helm/cli start -- inspect README.md

# Kimi Code（Keychain service: com.helm.provider.kimi-code, account: helm）
HELM_PROVIDER=kimi pnpm --filter @helm/cli start -- run "summarize the Helm runtime"
```

当前 Kimi Code 默认使用 `https://api.kimi.com/coding/v1` 与 `kimi-for-coding`；可用 `HELM_KIMI_BASE_URL` 和 `HELM_KIMI_MODEL` 覆盖。Key 只从 Keychain 读取，不写入事件账本。
