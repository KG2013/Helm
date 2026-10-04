import { createHash } from 'node:crypto';
import { ActionGateway } from './action-gateway.js';
import type {
  ActionAdapter,
  ActionExecutionResult,
  ArtifactReference,
  BrowserContextCreateInput,
  BrowserContextProfile,
  BrowserContextRecord,
  BrowserDomAssertionInput,
  BrowserNavigationInput,
  BrowserNavigationReceipt,
  BrowserNavigationResult,
  BrowserObservationResult,
  BrowserRegistryOptions,
  Evidence,
  EventStore,
  ID,
  RuntimeClock,
  RuntimeIdFactory,
} from './types.js';

const defaultClock: RuntimeClock = { now: () => new Date() };
const defaultIds: RuntimeIdFactory = { next: (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` };

type Page = { url: string; origin: string; dom: string };

/** Deterministic browser seam. It models a restricted browser context without granting OS or shell access. */
export class BrowserFixtureRegistry {
  private readonly store: EventStore;
  private readonly gateway: ActionGateway;
  private readonly artifactStore?: BrowserRegistryOptions['artifactStore'];
  private readonly clock: RuntimeClock;
  private readonly ids: RuntimeIdFactory;
  private readonly contexts = new Map<ID, BrowserContextRecord>();
  private readonly profiles = new Map<ID, BrowserContextProfile>();
  private readonly pages = new Map<ID, Page>();
  private readonly screenshots = new Map<ID, ArtifactReference>();

  constructor(options: BrowserRegistryOptions) {
    this.store = options.store;
    this.gateway = options.gateway;
    this.artifactStore = options.artifactStore;
    this.clock = options.clock ?? defaultClock;
    this.ids = options.ids ?? defaultIds;
  }

  async createContext(input: BrowserContextCreateInput): Promise<BrowserContextRecord> {
    validateProfile(input.profile);
    if (!input.profile.allowedApps.includes(input.appId)) throw new Error('Browser app is outside the profile allowlist.');
    if (!input.profile.allowedWindows.includes(input.windowId)) throw new Error('Browser window is outside the profile allowlist.');
    const now = this.clock.now().toISOString();
    const record: BrowserContextRecord = {
      contextId: this.ids.next('browser-context'),
      runId: input.runId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      profile: { id: input.profile.id, version: input.profile.version },
      appId: input.appId,
      windowId: input.windowId,
      state: 'active',
      createdAt: now,
      updatedAt: now,
    };
    this.contexts.set(record.contextId, record);
    this.profiles.set(record.contextId, { ...input.profile, allowedOrigins: [...input.profile.allowedOrigins], allowedApps: [...input.profile.allowedApps], allowedWindows: [...input.profile.allowedWindows], allowedArtifactUris: input.profile.allowedArtifactUris ? [...input.profile.allowedArtifactUris] : undefined });
    await this.store.append({ type: 'browser.context_created', taskId: record.taskId, sessionId: record.sessionId, runId: record.runId, payload: { ...record, profile: input.profile } });
    return record;
  }

  listContexts(runId?: ID): BrowserContextRecord[] {
    return [...this.contexts.values()].filter((context) => !runId || context.runId === runId).map((context) => ({ ...context, profile: { ...context.profile } }));
  }

  async closeContext(contextId: ID, reason = 'closed by user'): Promise<BrowserContextRecord> {
    const context = this.requireContext(contextId);
    const next = { ...context, state: 'closed' as const, updatedAt: this.clock.now().toISOString() };
    this.contexts.set(contextId, next);
    await this.store.append({ type: 'browser.context_closed', taskId: context.taskId, sessionId: context.sessionId, runId: context.runId, payload: { contextId, state: next.state, reason } });
    return next;
  }

  async reconnectContext(contextId: ID): Promise<BrowserContextRecord> {
    const context = this.requireContext(contextId);
    if (context.state === 'cleaned') throw new Error('Browser context has been cleaned and cannot reconnect.');
    const next = { ...context, state: 'active' as const, updatedAt: this.clock.now().toISOString() };
    this.contexts.set(contextId, next);
    await this.store.append({ type: 'browser.context_reconnected', taskId: context.taskId, sessionId: context.sessionId, runId: context.runId, payload: { contextId, state: next.state } });
    return next;
  }

  async cleanupContext(contextId: ID): Promise<BrowserContextRecord> {
    const context = this.requireContext(contextId);
    const next = { ...context, state: 'cleaned' as const, updatedAt: this.clock.now().toISOString() };
    this.contexts.set(contextId, next);
    this.pages.delete(contextId);
    this.screenshots.delete(contextId);
    this.profiles.delete(contextId);
    await this.store.append({ type: 'browser.context_cleaned', taskId: context.taskId, sessionId: context.sessionId, runId: context.runId, payload: { contextId, state: next.state } });
    return next;
  }

  async navigate(input: BrowserNavigationInput, approved = false): Promise<BrowserNavigationResult> {
    const context = this.requireContext(input.contextId);
    if (context.state !== 'active') throw new Error('Browser context is not active.');
    const url = parseAllowedUrl(input.url, this.profileFor(context));
    const actionId = input.actionId ?? this.ids.next('action-browser-navigation');
    const request = {
      actionId,
      runId: context.runId,
      taskId: context.taskId,
      sessionId: context.sessionId,
      profile: { id: 'browser.navigation', version: context.profile.version },
      target: url.href,
      scope: { contextId: context.contextId, origin: url.origin, appId: context.appId, windowId: context.windowId },
      capabilities: ['browser.navigate'],
      network: { mode: 'allowlist' as const, hosts: [url.host] },
      argsHash: hash({ contextId: context.contextId, url: url.href }),
      argsSummary: `navigate:${url.origin};context:${context.contextId}`,
      idempotencyKey: input.idempotencyKey,
      dryRun: false,
      deadline: new Date(this.clock.now().getTime() + 60_000).toISOString(),
    };
    const adapter: ActionAdapter = {
      id: 'browser-fixture:navigate',
      execute: async () => {
        const dom = `<html data-origin="${url.origin}"><body data-context="${context.contextId}"><main data-url="${url.href}">Fixture page</main></body></html>`;
        const page = { url: url.href, origin: url.origin, dom };
        this.pages.set(context.contextId, page);
        const domHash = hash(dom);
        const screenshotHash = hash(`screenshot:${url.href}:${domHash}`);
        const screenshot = await this.putScreenshot(context.runId, context.contextId, screenshotHash);
        if (screenshot) this.screenshots.set(context.contextId, screenshot);
        const evidence = this.navigationEvidence(context, page, domHash, screenshotHash, screenshot);
        const receipt = { sideEffect: 'known', contextId: context.contextId, url: page.url, origin: page.origin, windowId: context.windowId, appId: context.appId, domHash, screenshotHash, idempotencyKey: input.idempotencyKey, replayed: false };
        await this.store.append({ type: 'browser.navigation', taskId: context.taskId, sessionId: context.sessionId, runId: context.runId, payload: { actionId, ...receipt, ...(screenshot ? { screenshot } : {}), evidence } });
        const current = this.contexts.get(context.contextId)!;
        this.contexts.set(context.contextId, { ...current, url: page.url, origin: page.origin, updatedAt: this.clock.now().toISOString() });
        return { ok: true, output: { contextId: context.contextId, url: page.url, origin: page.origin, domHash, screenshotHash }, receipt, evidence };
      },
    };
    const action = approved ? await this.gateway.approve({ runId: request.runId, actionId, adapter, markRunNeedsReconciliation: false }) : await this.gateway.execute({ request, adapter, markRunNeedsReconciliation: false });
    const page = this.pages.get(context.contextId);
    const evidence = page ? this.navigationEvidence(context, page, hash(page.dom), hash(`screenshot:${page.url}:${hash(page.dom)}`), undefined) : [];
    const receipt: BrowserNavigationReceipt = {
      contextId: context.contextId,
      url: page?.url ?? url.href,
      origin: page?.origin ?? url.origin,
      windowId: context.windowId,
      appId: context.appId,
      domHash: page ? hash(page.dom) : hash(''),
      screenshotHash: page ? hash(`screenshot:${page.url}:${hash(page.dom)}`) : hash(''),
      idempotencyKey: input.idempotencyKey,
      replayed: Boolean(action.replayed),
      ...(this.screenshots.get(context.contextId) ? { screenshot: this.screenshots.get(context.contextId) } : {}),
    };
    return { action, receipt, evidence };
  }

  async approveNavigation(input: BrowserNavigationInput): Promise<BrowserNavigationResult> {
    return this.navigate(input, true);
  }

  async assertDom(input: BrowserDomAssertionInput): Promise<BrowserObservationResult> {
    const context = this.requireContext(input.contextId);
    const page = this.pages.get(context.contextId);
    const actionId = input.actionId ?? this.ids.next('action-browser-assert');
    const domHash = page ? hash(page.dom) : undefined;
    const passed = Boolean(page && ((!input.expectedText || page.dom.includes(input.expectedText)) && (!input.expectedSelector || page.dom.includes(input.expectedSelector))));
    const request = this.observationRequest(context, actionId, 'browser.dom-assertion', input.idempotencyKey, { expectedText: input.expectedText, expectedSelector: input.expectedSelector });
    const evidence: Evidence[] = page ? [{ type: 'browser.dom', summary: passed ? 'DOM assertion passed in the controlled fixture.' : 'DOM assertion failed in the controlled fixture.', uri: `browser://${context.contextId}/dom`, hash: domHash }] : [];
    const action = await this.gateway.execute({ request, adapter: { id: 'browser-fixture:dom-assertion', execute: async () => ({ ok: passed, output: { passed, domHash }, receipt: { sideEffect: 'none', domHash }, evidence }) }, markRunNeedsReconciliation: false });
    await this.store.append({ type: 'browser.observation', taskId: context.taskId, sessionId: context.sessionId, runId: context.runId, payload: { actionId, contextId: context.contextId, kind: 'dom-assertion', passed: action.status === 'executed' && passed, domHash, evidence } });
    return { action, contextId: context.contextId, url: page?.url, domHash, passed: action.status === 'executed' && passed, evidence };
  }

  private observationRequest(context: BrowserContextRecord, actionId: ID, profileId: string, idempotencyKey: string, args: Record<string, unknown>) {
    return {
      actionId,
      runId: context.runId,
      taskId: context.taskId,
      sessionId: context.sessionId,
      profile: { id: profileId, version: context.profile.version },
      target: `browser:${context.contextId}`,
      scope: { contextId: context.contextId, appId: context.appId, windowId: context.windowId },
      capabilities: ['browser.observe'],
      network: { mode: 'none' as const },
      argsHash: hash(args),
      argsSummary: `${profileId}:${context.contextId}`,
      idempotencyKey,
      dryRun: true,
      deadline: new Date(this.clock.now().getTime() + 60_000).toISOString(),
    };
  }

  private navigationEvidence(context: BrowserContextRecord, page: Page, domHash: string, screenshotHash: string, screenshot?: unknown): Evidence[] {
    return [
      { type: 'browser.navigation', summary: `Navigated controlled context ${context.contextId} to ${page.origin}.`, uri: `browser://${context.contextId}/navigation`, hash: domHash },
      { type: 'browser.screenshot', summary: 'Controlled fixture screenshot hash.', uri: typeof screenshot === 'object' && screenshot && 'uri' in screenshot ? String((screenshot as { uri: string }).uri) : `browser://${context.contextId}/screenshot`, hash: screenshotHash },
    ];
  }

  private async putScreenshot(runId: ID, contextId: ID, screenshotHash: string) {
    if (!this.artifactStore) return undefined;
    return this.artifactStore.put({ runId, type: 'browser-screenshot', extension: 'txt', content: `fixture-screenshot:${contextId}:${screenshotHash}`, limitations: ['Controlled fixture screenshot representation; not a real browser pixel capture.'] });
  }

  private profileFor(context: BrowserContextRecord): BrowserContextProfile {
    const profile = this.profiles.get(context.contextId);
    if (!profile) throw new Error('Browser context profile is unavailable after cleanup.');
    return profile;
  }

  private requireContext(contextId: ID): BrowserContextRecord {
    const context = this.contexts.get(contextId);
    if (!context) throw new Error(`Unknown browser context: ${contextId}`);
    return context;
  }
}

function validateProfile(profile: BrowserContextProfile): void {
  if (!profile.id || !profile.version || !profile.allowedOrigins.length || !profile.allowedApps.length || !profile.allowedWindows.length) throw new Error('Browser profile must declare versioned origin, app, and window allowlists.');
  for (const origin of profile.allowedOrigins) {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('Browser profile origins must be exact HTTP(S) origins.');
  }
}

function parseAllowedUrl(raw: string, profile: BrowserContextProfile): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('Browser navigation URL is invalid.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !profile.allowedOrigins.includes(url.origin)) throw new Error('Browser navigation origin is outside the profile allowlist.');
  return url;
}

function hash(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}
