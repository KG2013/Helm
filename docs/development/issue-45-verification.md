# Issue #45：Loopback Connector 与 Browser 动作接入 ActionGateway

核对日期：2026-10-05。

## 已实现

- Connector 写入、预览和 Browser fixture 动作使用 Runtime factory 提供的 bounded local ActionGateway policy；未知网络或非本地 target 仍默认拒绝。
- Browser navigation 仅在 `browser.navigation` profile、`http(s)` URL 与单一 host allowlist 同时匹配时放行，origin/app/window 校验仍在 Browser registry 内执行。
- Connector `verifyWrite` 先绑定同一 `connector.receipt` 的 action、target 和 after hash；没有已执行 receipt 的查询保持 `unknown`，不能凭空提升为 known。
- Connector loopback 幂等键按 connector/profile/target/scope 隔离，省略 action id 时使用稳定绑定，重复请求只回放原 receipt。
- ActionGateway receipt 保存 request hash；相同 action/idempotency key 绑定到不同 target、scope 或参数时返回拒绝，不重放或再次执行。
- CLI Browser action/navigation 支持显式 `--action-id`，审批继续原始动作绑定。

## 验证

```text
pnpm --filter @helm/runtime test       # 99/99
pnpm build                             # passed
pnpm typecheck                         # passed
pnpm --filter @helm/desktop test       # 12/12
pnpm --filter @helm/desktop test:electron  # 2/2
git diff --check                       # passed
```

桌面 IPC 回归将没有 Connector receipt 的 verify 结果校正为 `unknown`；这保留了“未执行动作不得伪造写后验证”的 fail-closed 语义。真实 SaaS Connector 和真实浏览器仍需目标环境单独验收。
