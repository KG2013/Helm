# Issue #47 验证记录

核对日期：2026-10-05。

`acceptance smoke --run-real` 现在会在统一的 bounded evidence 结构中执行四类 runner：Docker coding sandbox、Keychain-backed Provider、Document Worker 的 DOCX/OCR 检查和 Electron packaged smoke。runner 只保存命令引用、退出状态、耗时、输出字节数和 SHA-256 摘要；标准输出、标准错误和 Provider 凭据不会进入报告。没有目标配置、凭据、daemon 或工具依赖时，结果为 `UNKNOWN`，release gate 保持 blocked。

本机执行：

```bash
pnpm --filter @helm/cli build
node apps/cli/dist/main.js acceptance smoke --run-real --json
```

结果为：

| Runner | 结果 | 证据边界 |
|---|---|---|
| Docker coding | `UNKNOWN` | Docker CLI 存在，但 daemon 不可用，且没有固定 digest 镜像配置；没有回退到宿主机执行 |
| Provider | `UNKNOWN` | 当前命令未选择真实 Provider，未读取 Keychain、未发起网络请求；配置 `HELM_PROVIDER=kimi` 后才会进入 Keychain-backed 请求路径 |
| Office/DOCX/OCR | `UNKNOWN` | DOCX worker 与 LibreOffice/pdftoppm 可用，但 `tesseract` 缺失，PDF OCR 不能放行；DOCX runner 的执行结果仍保留在有界 receipt 中 |
| Electron packaged | `PASSED` | `pnpm --filter @helm/desktop test:electron` 通过，验证构建后的 Main/Preload/Renderer 生产链路 |

因此本机 release gate 仍为 `blocked`。这表示 runner 已经真实执行并正确报告外部条件，不表示 Docker、厂商 Provider 或 OCR 已验收通过。关闭父 Issue #16 前，仍需在具备固定 digest 镜像、可用 Docker daemon、目标 Provider Keychain 凭据和 `tesseract` 的环境重新执行同一命令，并保留每个 check 的状态与 evidence hash。

自动化覆盖包括：所有四类 runner 的成功路径、目标不可用到 `UNKNOWN` 的 fail-closed 映射、Electron 失败门禁、未启用 `--run-real` 时不调用真实 runner，以及报告不序列化子进程输出。
