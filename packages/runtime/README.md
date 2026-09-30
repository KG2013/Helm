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

`SqliteEventStore` receives a small injected `SqliteDatabase` binding. This
keeps native SQLite selection in the host process and means the runtime package
can be tested without native dependencies. Provider credentials are not created by this package; provider adapters should resolve credential references at request time. Runtime payloads may contain task input, tool output, or receipts, so hosts must redact sensitive values before exporting diagnostics or sharing event logs.

Tool proposals are denied unless the host injects a `ToolPolicy` that returns `allow`; an unknown tool side effect is recorded as `needs_reconciliation`.
