# Issue #11 验收证据

Issue：T6 XLSX bounded-range delivery

## 代码边界

- Document Worker 只接受 workspace 内的受限 JSONL 请求；Runtime 负责 Tool Profile、Policy、Approval 和未知结果的交付闸门。
- XLSX 写入只允许单个单元格或有界矩形范围，并在保存后重新打开工作簿验证目标值/公式。
- 保存前后的 bounded workbook fingerprint 比较 sheet 列表、defined names、sheet state、merged ranges，以及所有有内容或非默认样式的单元格值、公式类型、样式、数字格式、批注和超链接。
- `Receipt.target` 记录 sheet、selector、目标单元格、before/after 和 `scopeChanges`；artifact receipt 继续记录 hash、source Run、worker version 和 limitations。
- 任意授权范围外的变化都会把 `checks.scope` 置为 `conflict`，因此不能被报告为范围通过；快照超过 worker 上限时保持 UNKNOWN。

## 验证

```text
python3 -m unittest discover -s workers/document-worker/tests -v
```

结果：Document Worker 9/9 通过，包含正常单元格读写和注入未授权单元格修改的负向测试。负向测试确认目标值可以正确写入，但 scope 检查会阻止误报为安全交付。

## 限制

当前 worker 对 workbook fingerprint 采用 1,000 个单元格的有界检查；超出上限或无法完整重开时不宣称范围已验证。Runtime/CLI/Desktop 仍复用同一 Office Artifact/Verification projection，真实 Office 文档交付还受父 Issue #10 的渲染器和环境依赖限制。
