# Issue #12 验收证据

Issue：T7 PDF extraction and OCR delivery

## 代码边界

- 有文本层的页面走 `pypdf` text-layer 路径；没有文本层的页面才进入受限 `pdftoppm` + `tesseract` OCR 路径。
- 每页结果保留页码、workspace 相对路径、提取方式、内容 `textHash` 和 worker version；OCR 页另外保留引擎和 confidence。
- Receipt 记录 artifact hash、source Run、worker version、逐页 coverage/sources checks、OCR 状态和 limitations。
- OCR 缺少依赖、命令失败、低 confidence、空结果或 PDF 超过 100 页时返回 UNKNOWN/阻断交付，不把非空文本当作确定性证据。

## 验证

```text
python3 -m unittest discover -s workers/document-worker/tests -v
```

结果：Document Worker 9/9 通过，覆盖 OCR 依赖缺失、OCR 命令失败、工具成功 fixture、页码/引擎/confidence/textHash 来源字段和超过页数上限的 UNKNOWN 分支。

## 限制

当前机器未安装真实 `tesseract`，成功 OCR 采用注入的工具 fixture；健康检查会在目标环境缺少 `pdftoppm` 或 `tesseract` 时返回 UNKNOWN。Runtime、CLI 和 Desktop 继续消费同一 Office Artifact/Verification projection。
