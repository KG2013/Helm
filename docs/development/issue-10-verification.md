# Issue #10 验收证据

Issue：T5 DOCX artifact delivery

## 代码边界

- Python Document Worker 只处理受限 JSONL 请求，不拥有 Agent Loop、Provider credential 或 Approval authority；Runtime Policy/Approval 决定是否执行。
- DOCX receipt 记录 worker version、source Run、artifact path/hash/bytes、structure/content/rendering checks 和 limitations。
- 缺少 `soffice`/`libreoffice` 时 rendering 明确为 UNKNOWN，OfficeVerifier 阻止 Delivery；当前 rendering 证明有界 PDF 转换与可打开页数，不宣称像素级视觉一致。
- Desktop IPC 与 CLI 共享 Runtime Office projection；Desktop snapshot/export 暴露同一 artifact 与 verification 结果。
- Worker `health` 现在提供 renderer、Python dependency 和 OCR tool preflight，便于目标环境在任务前识别能力缺口。

## 验证

```text
python3 -m unittest discover -s workers/document-worker/tests -v
pnpm --filter @helm/runtime exec tsx --test test/office.test.ts
pnpm --filter @helm/desktop test
```

结果：Document Worker 8/8、Desktop IPC 7/7 通过；Runtime Office fixture 与 CLI/Desktop build 已通过。目标环境缺少 renderer 时仍按 UNKNOWN 阻断，不把文本非空当作 DOCX 交付证据。
