import { createHash } from 'node:crypto';
import { ActionGateway } from './action-gateway.js';
import type { ActionExecutionResult, ConnectorActionProfile, ConnectorPreview, ConnectorRegistryOptions, EventStore, ID, RuntimeClock, RuntimeIdFactory } from './types.js';

const defaultClock: RuntimeClock = { now: () => new Date() };
const defaultIds: RuntimeIdFactory = { next: (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` };

export interface ConnectorPreviewInput {
  runId: ID;
  taskId: ID;
  sessionId: ID;
  connectorId: string;
  profileId: string;
  profileVersion: string;
  actionId?: ID;
  action: string;
  target: string;
  scope: Record<string, unknown>;
  before: unknown;
  after: unknown;
  versionCondition?: string;
  impact: string[];
  rollbackPlan: string;
  reconciliationPlan: string;
}

export interface ConnectorPreviewResult {
  preview: ConnectorPreview;
  action: ActionExecutionResult;
}

/** Versioned allowlist for external targets. This registry only previews; it never writes. */
export class ConnectorRegistry {
  private readonly store: EventStore;
  private readonly gateway: ActionGateway;
  private readonly clock: RuntimeClock;
  private readonly ids: RuntimeIdFactory;
  private readonly profiles = new Map<string, ConnectorActionProfile>();

  constructor(options: ConnectorRegistryOptions) {
    this.store = options.store;
    this.gateway = options.gateway;
    this.clock = options.clock ?? defaultClock;
    this.ids = options.ids ?? defaultIds;
  }

  async register(profile: ConnectorActionProfile): Promise<ConnectorActionProfile> {
    validateProfile(profile);
    const key = `${profile.id}@${profile.version}`;
    if (this.profiles.has(key)) return this.profiles.get(key)!;
    this.profiles.set(key, { ...profile, actions: [...profile.actions], allowedTargets: [...profile.allowedTargets], allowedFields: [...profile.allowedFields] });
    await this.store.append({ type: 'connector.registered', payload: profile as unknown as Record<string, unknown> });
    return this.profiles.get(key)!;
  }

  get(id: string, version: string): ConnectorActionProfile | undefined {
    return this.profiles.get(`${id}@${version}`);
  }

  list(): ConnectorActionProfile[] {
    return [...this.profiles.values()];
  }

  async preview(input: ConnectorPreviewInput): Promise<ConnectorPreviewResult> {
    const profile = this.get(input.profileId, input.profileVersion);
    if (!profile || profile.connectorId !== input.connectorId) throw new Error('Connector Action Profile is not registered.');
    if (!profile.actions.includes(input.action)) throw new Error(`Connector action ${input.action} is not allowed by the profile.`);
    if (!profile.allowedTargets.some((target) => input.target === target || input.target.startsWith(`${target}/`))) throw new Error('Connector target is outside the allowlist.');
    if (!scopeWithin(input.scope, profile.scope)) throw new Error('Connector scope is outside the profile grant.');
    if (input.after && typeof input.after === 'object' && !Array.isArray(input.after)) {
      const fields = Object.keys(input.after as Record<string, unknown>);
      if (fields.some((field) => !profile.allowedFields.includes(field))) throw new Error('Connector field is outside the profile grant.');
    }
    const preview: ConnectorPreview = {
      previewId: this.ids.next('connector-preview'),
      actionId: input.actionId ?? this.ids.next('action-connector'),
      connectorId: input.connectorId,
      profile: { id: profile.id, version: profile.version },
      target: input.target,
      action: input.action,
      before: bounded(input.before),
      after: bounded(input.after),
      versionCondition: input.versionCondition,
      impact: input.impact.slice(0, 32).map((item) => item.slice(0, 300)),
      rollbackPlan: input.rollbackPlan.slice(0, 1_000),
      reconciliationPlan: input.reconciliationPlan.slice(0, 1_000),
      dryRun: true,
    };
    const parentAction = await this.gateway.execute({
      request: {
        actionId: preview.actionId,
        runId: input.runId,
        taskId: input.taskId,
        sessionId: input.sessionId,
        profile: { id: profile.id, version: profile.version },
        target: input.target,
        scope: input.scope,
        capabilities: [`connector:${input.connectorId}`, input.action],
        network: { mode: 'none' },
        argsHash: hash({ action: input.action, target: input.target, scope: input.scope, after: preview.after }),
        argsSummary: `preview:${input.action};target:${input.target}`,
        idempotencyKey: preview.actionId,
        dryRun: true,
        deadline: new Date(this.clock.now().getTime() + 60_000).toISOString(),
      },
      adapter: { id: `connector-preview:${input.connectorId}`, execute: async () => ({ ok: true, output: preview, receipt: { sideEffect: 'none', dryRun: true }, evidence: [{ type: 'connector.preview', summary: `Dry-run preview for ${input.action} on ${input.target}` }] }) },
      markRunNeedsReconciliation: false,
    });
    await this.store.append({ type: 'connector.preview', taskId: input.taskId, sessionId: input.sessionId, runId: input.runId, payload: preview as unknown as Record<string, unknown> });
    return { preview, action: parentAction };
  }
}

function validateProfile(profile: ConnectorActionProfile): void {
  if (!profile.id || !profile.version || !profile.connectorId) throw new Error('Connector profile identity is required.');
  if (!profile.actions.length || !profile.allowedTargets.length) throw new Error('Connector profile must declare actions and targets.');
}

function scopeWithin(requested: Record<string, unknown>, allowed: Record<string, unknown>): boolean {
  return Object.entries(requested).every(([key, value]) => {
    const grant = allowed[key];
    if (Array.isArray(value)) return Array.isArray(grant) && value.every((item) => grant.includes(item));
    if (value && typeof value === 'object') return Boolean(grant && typeof grant === 'object' && scopeWithin(value as Record<string, unknown>, grant as Record<string, unknown>));
    return grant === value;
  });
}

function bounded(value: unknown): unknown {
  if (typeof value === 'string') return value.slice(0, 4_000);
  if (!value || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value).slice(0, 8_000));
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
