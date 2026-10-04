# Issue #42：G0 真实环境验收矩阵与发布闸门

核对日期：2026-10-04。

## 已实现

- CLI 新增 `helm acceptance preflight`，默认输出人类摘要，`--json` 输出同一份 `helm.acceptance/v1` 机器可读矩阵。
- 矩阵包含环境指纹、采集时间、Docker/Provider/Office/OCR/Electron 四项 bounded preflight、证据引用、限制和 release gate。
- Docker 复用 `createDockerCodingSandboxFromEnv().preflight()`，检查 digest image、daemon/security metadata 和既有隔离合同；不启动编码容器，不退回宿主机。
- Provider 只解析 catalog/model/base URL/keychain service 引用，不读取 Keychain secret、不发起 HTTP；真实文本、工具、SSE、取消、超时、限流和认证仍保持 `unverified`。
- Office/OCR 复用 Document Worker `health()`；缺少 `tesseract`、渲染器或其他依赖时返回 `unknown`。
- Electron 只检查构建产物和 executable 前置条件；构建产物存在不等于 packaged restart/multi-window smoke 通过。
- 任一 `failed`、`unknown` 或 `unverified` 都阻断 release gate，并以非零退出码结束；输出不包含 API Key、Authorization header、私有文件内容或完整请求/响应体。

## 验证

```text
pnpm --filter @helm/cli test
pnpm --filter @helm/cli build
node apps/cli/dist/main.js acceptance preflight --json
```

CLI acceptance fixture 5/5 通过。当前机器的真实 preflight 结果为：

| 检查 | 结果 | 说明 |
|---|---|---|
| Docker | `unverified` | 未启用 digest image；未启动 Docker task |
| Provider | `unverified` | 未选择真实 Provider；未读取凭据、未发请求 |
| Office/OCR | `unknown` | `tesseract` 缺失，`pdfOcr` 保持 UNKNOWN |
| Electron | `unverified` | 构建产物存在，packaged smoke 未执行 |
| Release gate | `blocked` | 环境 preflight 未全部满足 |

真实 smoke 仍需在目标环境分别记录：固定 Docker 镜像的编码 diff/test/Verifier evidence、DeepSeek/智谱真实请求与错误路径、Office/OCR 真实工件和 Electron packaged restart/multi-window 行为。fixture 或 preflight 通过都不能替代这些证据。
