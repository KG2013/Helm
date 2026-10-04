# Issue #23 验证记录：Experience Candidate 审核 UI

核对日期：2026-10-04。

## 交付范围

- Runtime 的 `ExperienceCandidate` 保留 source Episode、source trace、风险、验证证据和递增的 `reviewVersion`。
- `approve` 必须同时满足 source Episode/trace、验证证据、validated、approved 和成本门禁；缺任一项都拒绝并保持事件账本不变。
- `reject` 和 `revalidate` 都写入新的 `experience.candidate_reviewed` 事件；`revalidate` 会回到 `unvalidated/pending` 并递增版本。
- CLI 提供 `helm experience list` 和 `helm experience review <candidate-id> <approve|reject|revalidate>`，证据通过 `--evidence` 传入。
- Desktop preload/Main IPC 提供候选列表和审核接口；Renderer 右栏显示候选详情、来源、风险、验证/批准状态、版本和证据数。没有来源或证据时 Approve 按钮禁用。
- 候选审核不会直接修改 Skill、Memory、Policy、Prompt、Tool Profile 或 Harness；它只追加可回放的审核事件。
- Candidate ID、摘要、适用范围、验证 URI、Evidence URI/hash 和 review version 都有长度、URI、hash 与敏感值门禁；`approve` 不接受裸文本证据。

## 验证

- Runtime 候选测试覆盖 pending 初始状态、证据门禁、reviewer round budget 和 revalidate version。
- Desktop IPC 测试覆盖列表、缺证据批准拒绝和带证据批准。
- CLI 构建通过；空 SQLite ledger 上 `HELM_STATE_DB=... node apps/cli/dist/main.js experience list` 返回 `[]`。
- Desktop TypeScript/Vite/Electron build 通过；完整桌面测试覆盖 IPC handler。

## 边界

当前候选仍需由上游 Episode/Trace 生产流程写入；本 issue 提供审核和可观察性，不宣称已有生产候选自动生成、跨设备同步或实际 Promotion 到 Skill/Policy。Runtime 当前校验受限 URI/hash 格式，但不在本 issue 内读取远端或归档存储验证来源存在性；真实生产候选的来源完整性和人工审核流程仍需现场验收。
