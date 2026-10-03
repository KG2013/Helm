import { openSqliteEventStore } from '../../src/sqlite-node.js';
import { MockProvider, RuntimeFacade, type ToolRegistry } from '../../src/index.js';

const [filename, runId, approvalId] = process.argv.slice(2);
if (!filename || !runId || !approvalId) throw new Error('filename, runId and approvalId are required');

const registry: ToolRegistry = {
  get: (id) => ({ id, version: 'test-v1', readOnly: false, scope: 'workspace', network: 'none', maxOutputBytes: 32_000 }),
};
const { store } = openSqliteEventStore(filename);
const runtime = new RuntimeFacade({
  store,
  ownerId: 'reconnected-process',
  provider: new MockProvider([{ kind: 'final', content: 'approved after reconnect' }]),
  toolRegistry: registry,
  policy: { decide: () => ({ decision: 'allow' as const, reason: 'reconnected approval' }) },
  executor: async () => ({ ok: true, output: 'written after reconnect', receipt: { sideEffect: 'known' } }),
});
const result = await runtime.resolveApproval(runId, approvalId, 'approve', 'workspace-1');
const events = await store.list(runId);
console.log(JSON.stringify({ state: result.state, ownerId: result.ownerId, hasDecision: events.some((event) => event.type === 'approval.decided'), hasReceipt: events.some((event) => event.type === 'tool.receipt'), hasCheckpoint: events.some((event) => event.type === 'run.checkpoint') }));
await store.close();
