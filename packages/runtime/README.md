# `@helm/runtime`

The local-first runtime shared by Helm's desktop and CLI surfaces. It owns the
Task → Session → Run loop, append-only event ledger, bounded state transitions,
provider-neutral model seam, fail-closed ToolPolicy/ToolExecutor seams, and verification result.

```ts
const runtime = new RuntimeFacade({
  store: new InMemoryEventStore(),
  provider: new MockProvider([{ kind: 'final', content: 'done' }]),
});
const task = await runtime.createTask({ goal: 'inspect the project', workspaceId: 'ws-1' });
const session = await runtime.createSession({ taskId: task.id });
const run = await runtime.startRun({ taskId: task.id, sessionId: session.id });
const result = await runtime.run(run.id);
```

`SqliteEventStore` receives an injected `SqliteDatabase` binding. Node hosts can
use `@helm/runtime/sqlite-node` to open the built-in Node 22 `node:sqlite`
adapter. The adapter applies a versioned migration, WAL/transaction settings,
append-only sequences, durable projections, restart recovery, and redacted
JSONL export. Renderer bundles must keep using the browser-safe root export;
the SQLite adapter is Node-only.

Provider credentials are not created by this package; provider adapters should
resolve credential references at request time. Runtime builds a bounded,
redacted Context envelope with Tool schemas and structured ToolResults. Runtime
payloads may contain task input, tool output, or receipts, so hosts must use
the redacted export path before sharing event logs.

Tool proposals are denied unless the host injects a `ToolPolicy` that returns `allow`; an unknown tool side effect is recorded as `needs_reconciliation`. The coding fixture exports versioned `workspace.read`, `workspace.edit`, `workspace.patch`, `workspace.test`, and `workspace.diff` profiles. File mutation and test execution require an injected sandbox; `CodingVerifier` only passes when read, edit/patch, passing test, diff, and artifact receipts are all present.
