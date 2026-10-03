import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  InMemoryEventStore,
  MockProvider,
  OfficeVerifier,
  PythonDocumentWorkerClient,
  createOfficeRuntime,
  type OfficeWorkerClient,
  type OfficeWorkerRequest,
  type OfficeWorkerResponse,
} from '../src/index.js';

const HASH = 'a'.repeat(64);

function workerFor(responseFor: (request: OfficeWorkerRequest) => OfficeWorkerResponse): OfficeWorkerClient & { requests: OfficeWorkerRequest[] } {
  const requests: OfficeWorkerRequest[] = [];
  return {
    requests,
    execute: async (request) => {
      requests.push(request);
      return responseFor(request);
    },
  };
}

function passedArtifact(request: OfficeWorkerRequest) {
  return {
    type: request.operation === 'pdf_extract' ? 'pdf' : request.operation.startsWith('xlsx') ? 'xlsx' : 'docx',
    path: request.path,
    hash: HASH,
    bytes: 128,
    sourceRunId: request.runId,
    workerVersion: '0.2.0',
  };
}

async function approveLatest(runtime: Awaited<ReturnType<typeof createOfficeRuntime>>, runId: string) {
  const events = await runtime.getEvents(runId);
  const requested = [...events].reverse().find((event) => event.type === 'approval.requested');
  assert.ok(requested);
  return runtime.resolveApproval(runId, String(requested.payload.approvalId), 'approve');
}

test('DOCX worker delivery uses Runtime policy, approval, artifact receipt, and verifier evidence', async () => {
  const worker = workerFor((request) => ({
    id: request.id,
    ok: true,
    result: { paragraphs: 2 },
    receipt: {
      worker: 'document-worker',
      workerVersion: '0.2.0',
      sideEffect: 'known',
      artifact: passedArtifact(request),
      checks: { structure: 'passed', content: 'passed', rendering: 'passed' },
    },
  }));
  const runtime = createOfficeRuntime({
    store: new InMemoryEventStore(),
    provider: new MockProvider([
      { kind: 'tool_call', name: 'office.docx.create', arguments: { path: 'reports/result.docx', paragraphs: ['one', 'two'] } },
      { kind: 'final', content: 'DOCX report is ready.' },
    ]),
    worker,
    workspaceId: 'office-workspace',
    root: '/tmp/helm-office',
  });
  const task = await runtime.createTask({ goal: 'create a DOCX report', workspaceId: 'office-workspace' });
  const session = await runtime.createSession({ taskId: task.id });
  const started = await runtime.startRun({ taskId: task.id, sessionId: session.id });
  const paused = await runtime.run(started.id);
  assert.equal(paused.state, 'paused');
  const result = await approveLatest(runtime, paused.id);
  assert.equal(result.state, 'completed');
  assert.equal(result.verification?.result, 'passed');
  assert.equal(result.verification?.verifier, 'office-v1');
  assert.equal(worker.requests[0]?.operation, 'docx_create');
  const receipt = (await runtime.getEvents(result.id)).find((event) => event.type === 'tool.receipt');
  assert.equal((receipt?.payload.receipt as { artifact?: { uri?: string } }).artifact?.uri, 'workspace://office-workspace/reports/result.docx');
});

test('scanned PDF evidence is converted to UNKNOWN and never delivered as success', async () => {
  const worker = workerFor((request) => ({
    id: request.id,
    ok: false,
    error: 'unknown_text_layer',
    receipt: {
      worker: 'document-worker',
      sideEffect: 'none',
      artifact: passedArtifact(request),
      checks: { coverage: 'unknown', sources: 'unknown' },
      limitations: ['OCR is not enabled.'],
    },
  }));
  const runtime = createOfficeRuntime({
    store: new InMemoryEventStore(),
    provider: new MockProvider([
      { kind: 'tool_call', name: 'office.pdf.extract', arguments: { path: 'input/scanned.pdf' } },
      { kind: 'final', content: 'PDF summary candidate.' },
    ]),
    worker,
    workspaceId: 'office-workspace',
    root: '/tmp/helm-office',
  });
  const task = await runtime.createTask({ goal: 'summarize a PDF', workspaceId: 'office-workspace' });
  const session = await runtime.createSession({ taskId: task.id });
  const started = await runtime.startRun({ taskId: task.id, sessionId: session.id });
  const result = await runtime.run(started.id);
  assert.equal(result.state, 'paused');
  assert.equal(result.verification?.result, 'unknown');
  assert.match(result.verification?.message ?? '', /incomplete|coverage|unknown/i);
  assert.equal(worker.requests[0]?.operation, 'pdf_extract');
});

test('XLSX writes require approval and all target/scope checks before delivery', async () => {
  const worker = workerFor((request) => ({
    id: request.id,
    ok: true,
    result: { sheet: request.sheet, range: request.range, verified: true },
    receipt: {
      worker: 'document-worker',
      sideEffect: 'known',
      artifact: passedArtifact(request),
      checks: { target: 'passed', scope: 'passed' },
    },
  }));
  const runtime = createOfficeRuntime({
    store: new InMemoryEventStore(),
    provider: new MockProvider([
      { kind: 'tool_call', name: 'office.xlsx.write_range', arguments: { path: 'book.xlsx', sheet: 'Sheet1', range: 'A1:B1', values: [['new-a', 'new-b']] } },
      { kind: 'final', content: 'Workbook update verified.' },
    ]),
    worker,
    workspaceId: 'office-workspace',
    root: '/tmp/helm-office',
  });
  const task = await runtime.createTask({ goal: 'update a workbook', workspaceId: 'office-workspace' });
  const session = await runtime.createSession({ taskId: task.id });
  const started = await runtime.startRun({ taskId: task.id, sessionId: session.id });
  const paused = await runtime.run(started.id);
  assert.equal(paused.state, 'paused');
  const result = await approveLatest(runtime, paused.id);
  assert.equal(result.state, 'completed');
  assert.equal(result.verification?.result, 'passed');
  assert.equal((await runtime.getEvents(result.id)).filter((event) => event.type === 'approval.requested').length, 1);
});

test('Office policy rejects workspace traversal and unsupported XLSX selectors before worker dispatch', async () => {
  const worker = workerFor((request) => ({ id: request.id, ok: true, result: {}, receipt: { artifact: passedArtifact(request) } }));
  const runtime = createOfficeRuntime({
    store: new InMemoryEventStore(),
    provider: new MockProvider([{ kind: 'tool_call', name: 'office.xlsx.read_range', arguments: { path: '../outside.xlsx', sheet: 'Sheet1' } }]),
    worker,
    workspaceId: 'office-workspace',
    root: '/tmp/helm-office',
  });
  const task = await runtime.createTask({ goal: 'read a workbook', workspaceId: 'office-workspace' });
  const session = await runtime.createSession({ taskId: task.id });
  const started = await runtime.startRun({ taskId: task.id, sessionId: session.id });
  const result = await runtime.run(started.id);
  assert.equal(result.state, 'failed');
  assert.equal(worker.requests.length, 0);
  assert.match(result.lastError ?? '', /workspace|path|outside/i);
});

test('Office executor rejects a symlink escape immediately before worker dispatch', async () => {
  const root = await mkdtemp('/tmp/helm-office-root-');
  const outside = await mkdtemp('/tmp/helm-office-outside-');
  try {
    await writeFile(`${outside}/secret.xlsx`, 'private');
    await symlink(`${outside}/secret.xlsx`, `${root}/escape.xlsx`);
    const worker = workerFor((request) => ({ id: request.id, ok: true, result: {}, receipt: { artifact: passedArtifact(request) } }));
    const runtime = createOfficeRuntime({
      store: new InMemoryEventStore(),
      provider: new MockProvider([{ kind: 'tool_call', name: 'office.xlsx.read_range', arguments: { path: 'escape.xlsx', sheet: 'Sheet1', cell: 'A1' } }]),
      worker,
      workspaceId: 'office-workspace',
      root,
    });
    const task = await runtime.createTask({ goal: 'read a workbook', workspaceId: 'office-workspace' });
    const session = await runtime.createSession({ taskId: task.id });
    const started = await runtime.startRun({ taskId: task.id, sessionId: session.id });
    const result = await runtime.run(started.id);
    assert.equal(result.state, 'failed');
    assert.equal(worker.requests.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('OfficeVerifier remains fail-closed when artifact evidence is absent', async () => {
  const verification = await new OfficeVerifier().verify({
    task: {} as never,
    run: { id: 'run-1' } as never,
    output: 'candidate',
    context: [],
  });
  assert.equal(verification.result, 'unknown');
});

test('PythonDocumentWorkerClient enforces the JSONL process boundary and preserves worker evidence', async () => {
  const root = await mkdtemp('/tmp/helm-office-client-');
  try {
    const scriptPath = resolve(fileURLToPath(new URL('../../../workers/document-worker/worker.py', import.meta.url)));
    const client = new PythonDocumentWorkerClient({ scriptPath, workspaceRoot: root, timeoutMs: 10_000 });
    const response = await client.execute({
      id: 'worker-request-1',
      runId: 'run-client-1',
      operation: 'docx_create',
      path: 'report.docx',
      paragraphs: ['client boundary'],
    });
    assert.equal(response.ok, true);
    assert.equal(response.receipt?.artifact && (response.receipt.artifact as { sourceRunId?: string }).sourceRunId, 'run-client-1');
    assert.equal((response.receipt?.checks as { structure?: string }).structure, 'passed');
    assert.equal((response.receipt?.checks as { rendering?: string }).rendering, 'unknown');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
