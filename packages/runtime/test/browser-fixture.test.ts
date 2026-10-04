import test from 'node:test';
import assert from 'node:assert/strict';
import { ActionGateway, BrowserFixtureRegistry, InMemoryEventStore, MemoryArtifactStore } from '../src/index.js';

const profile = {
  id: 'browser.fixture',
  version: 'v1',
  allowedOrigins: ['https://fixture.example.test'],
  allowedApps: ['fixture-app'],
  allowedWindows: ['fixture-window'],
  downloadDirectory: 'artifact://downloads/fixture',
};

test('BrowserFixtureRegistry scopes context, navigation, DOM evidence, and lifecycle replay', async () => {
  const store = new InMemoryEventStore();
  const gateway = new ActionGateway({ store, policy: () => ({ decision: 'allow' as const, reason: 'fixture browser policy' }) });
  const registry = new BrowserFixtureRegistry({ store, gateway, artifactStore: new MemoryArtifactStore() });
  const context = await registry.createContext({ runId: 'run-browser', taskId: 'task-browser', sessionId: 'session-browser', profile, appId: 'fixture-app', windowId: 'fixture-window' });
  const navigation = await registry.navigate({ contextId: context.contextId, url: 'https://fixture.example.test/home', idempotencyKey: 'navigate-once' });
  assert.equal(navigation.action.status, 'executed');
  assert.equal(navigation.receipt.origin, 'https://fixture.example.test');
  assert.ok(navigation.receipt.domHash.length === 64);
  assert.ok(navigation.receipt.screenshot?.uri.startsWith('artifact://'));
  assert.ok(navigation.evidence.some((item) => item.type === 'browser.screenshot'));
  const assertion = await registry.assertDom({ contextId: context.contextId, expectedSelector: 'main', expectedText: 'Fixture page', idempotencyKey: 'assert-once' });
  assert.equal(assertion.passed, true);
  assert.ok(assertion.domHash);
  const closed = await registry.closeContext(context.contextId);
  assert.equal(closed.state, 'closed');
  assert.equal((await registry.reconnectContext(context.contextId)).state, 'active');
  assert.equal((await registry.cleanupContext(context.contextId)).state, 'cleaned');
  const events = await store.list(context.runId);
  assert.ok(events.some((event) => event.type === 'browser.context_created'));
  assert.ok(events.some((event) => event.type === 'browser.navigation'));
  assert.ok(events.some((event) => event.type === 'browser.observation'));
  assert.ok(events.some((event) => event.type === 'browser.context_cleaned'));
});

test('BrowserFixtureRegistry denies origins and unconfigured policies before fixture navigation', async () => {
  const store = new InMemoryEventStore();
  const registry = new BrowserFixtureRegistry({ store, gateway: new ActionGateway({ store }) });
  const context = await registry.createContext({ runId: 'run-browser-deny', taskId: 'task-browser-deny', sessionId: 'session-browser-deny', profile, appId: 'fixture-app', windowId: 'fixture-window' });
  await assert.rejects(() => registry.navigate({ contextId: context.contextId, url: 'https://not-allowed.example.test/', idempotencyKey: 'deny-origin' }), /origin/i);
  const denied = await registry.navigate({ contextId: context.contextId, url: 'https://fixture.example.test/home', idempotencyKey: 'deny-policy' });
  assert.equal(denied.action.status, 'denied');
  assert.equal((await store.list(context.runId)).some((event) => event.type === 'browser.navigation'), false);
});

test('BrowserFixtureRegistry exposes one navigation proposal for approval and executes only after approval', async () => {
  const store = new InMemoryEventStore();
  const gateway = new ActionGateway({ store, policy: () => ({ decision: 'ask' as const, reason: 'navigation requires approval' }) });
  const registry = new BrowserFixtureRegistry({ store, gateway });
  const context = await registry.createContext({ runId: 'run-browser-approval', taskId: 'task-browser-approval', sessionId: 'session-browser-approval', profile, appId: 'fixture-app', windowId: 'fixture-window' });
  const request = { contextId: context.contextId, actionId: 'browser-action-approval', url: 'https://fixture.example.test/submit', idempotencyKey: 'browser-approval-once' } as const;
  const proposal = await registry.navigate(request);
  assert.equal(proposal.action.status, 'approval_required');
  const approved = await registry.approveNavigation(request);
  assert.equal(approved.action.status, 'executed');
  assert.ok((await store.list(context.runId)).some((event) => event.type === 'action.approval_required'));
  assert.ok((await store.list(context.runId)).some((event) => event.type === 'browser.navigation'));
});
