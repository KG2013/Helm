# Issue #13 验收证据

Issue：T8 Redacted Episode Trace and release gate

## 代码边界

- `buildEpisode` 通过事件账本生成脱敏、可回放 Episode，并索引 Task/Session、Step、Provider/Model、Tool Profile 及版本、Policy 版本、Approval、Artifact、Verifier、request/trace IDs。
- Provider、Tool 和 Worker UsageLedger 记录 request ID、token/cost、latency、retries、cache 和 failure class；Provider request 与 Tool call 都按 request ID 去重，重放或审批重试不会重复计费。
- 大输出继续通过 ArtifactStore 引用，导出的 JSONL 走脱敏投影；release gate 对未知副作用、未对账恢复、验证失败/未知和凭据标记硬阻断。
- `runFixedEvaluationMatrix` 固定 dev/holdout case，每个 critical case 至少连续三次并带显式 attempt；严格 gate 要求两种 split 都有三次 distinct attempts。确定性 Verifier 是硬门槛，未知结果保持阻断。

## 验证

```text
pnpm --filter @helm/runtime build
pnpm --filter @helm/runtime exec tsx --test test/runtime.test.ts
```

结果：Runtime build 通过；runtime 测试 22/22 通过，覆盖脱敏 trace 索引、Provider/Tool UsageLedger、三次 Coding/Office dev/holdout 固定矩阵、失败/未知/凭据泄漏阻断和重复请求去重。

## 限制

固定矩阵 runner 使用调用方提供的 Coding/Office case；本仓库测试验证矩阵契约和 gate 行为，真实供应商额度、真实 Office/OCR 工具链和目标工作区数据仍由目标环境运行时提供。LLM Judge 未参与放行，仍只能作为未来 advisory 层。
