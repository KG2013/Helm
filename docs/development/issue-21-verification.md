# Issue #21 验证记录：Office/OCR 真实依赖与证据验收

核对日期：2026-10-04。

## 已实现

- Document Worker `health` 预检现在报告 worker 版本、`soffice`/`libreoffice`、`pdftoppm`、`tesseract` 路径与版本，及 `openpyxl`/`pypdf` 版本；缺失项进入 `missing`，渲染/OCR checks 缺失时保持 `unknown`。
- `PythonDocumentWorkerClient` 提供 health 调用。Office Runtime 在首个 Office action 前执行一次预检，并把预检、操作 checks、target、OCR 和 limitations 汇总到受限 Artifact evidence 元数据中。
- CLI 增加 `helm office health`，Office `run` 摘要包含 `officePreflight`；Desktop runtime info 和右上角连接状态报告 Office worker 版本与缺失依赖。
- DOCX、XLSX、PDF/OCR 仍以 source Run、SHA-256、页/表范围、解析/OCR checks 和 limitations 作为证据；缺失依赖、解析失败、低 confidence 或覆盖不完整返回 UNKNOWN。

## 验证

- `python3 -m unittest discover -s workers/document-worker/tests -v`：12/12 通过。
- `pnpm --filter @helm/runtime exec tsx --test test/office.test.ts`：10/10 通过，覆盖 health JSONL、Runtime preflight、Artifact evidence、解析失败和缺失渲染/OCR 的 UNKNOWN 边界。
- `node apps/cli/dist/main.js office health`：真实预检报告 `soffice`、`pdftoppm`、`openpyxl`、`pypdf` 版本，当前 `tesseract` 缺失且 `pdfOcr=unknown`。
- `pnpm build`、`pnpm test`、`pnpm typecheck` 和 Desktop build 通过；fixture、真实 Office/OCR smoke、像素级比较分别记录。

## Smoke 边界

| 场景 | 当前结果 | 证据边界 |
|---|---|---|
| DOCX 创建与有界渲染 | 真实 Document Worker E2E 已通过 | 生成、SHA-256、package/content checks 和可打开 PDF 页数；未做像素比较 |
| XLSX 读写 | Worker fixture 与 Runtime 合同测试已通过 | 覆盖 target/scope fingerprint；真实业务工作簿 smoke 尚未执行 |
| PDF text-layer 提取 | Worker fixture 已通过 | 逐页 source/page/textHash；真实用户 PDF smoke 尚未执行 |
| PDF OCR | 未通过/未验证 | 当前环境缺少 `tesseract`，扫描 PDF 保持 UNKNOWN |
| 像素级 DOCX 比较 | 未实现 | 仅保留渲染和页数证据，不把转换成功当作视觉一致 |

## 当前环境限制

本机的 `soffice`/`pdftoppm` 可用，`tesseract` 缺失，因此没有把真实扫描 PDF OCR 成功宣称为通过。DOCX rendering 只证明有界转换和页数/可打开性，不代表像素级视觉一致。
