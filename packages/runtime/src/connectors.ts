import { createHash } from 'node:crypto';
import { ActionGateway } from './action-gateway.js';
import type { ActionExecutionResult, ConnectorActionProfile, ConnectorPreview, ConnectorRegistryOptions, ConnectorVerificationResult, ConnectorWriteInput, ConnectorWriteResult, EventStore, ID, RuntimeClock, RuntimeIdFactory } from './types.js';

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

export interface LoopbackReadResult {
  value: Record<string, unknown>;
  version: string;
}

export interface LoopbackWriteResult extends LoopbackReadResult {
  ok: boolean;
  before: Record<string, unknown>;
  beforeVersion: string;
  replayed: boolean;
  remoteRequestId: string;
  error?: string;
}

/** A deterministic local connector used by tests and the first external-write slice. */
export class LoopbackConnector {
  private readonly records = new Map<string, { value: Record<string, unknown>; version: string }>();
  private readonly idempotency = new Map<string, LoopbackWriteResult>();
  private readonly readFailures = new Map<string, string>();
  private version = 0;

  async read(target: string): Promise<LoopbackReadResult> {
    const failure = this.readFailures.get(target);
    if (failure) throw new Error(`Loopback read ${failure}.`);
    const record = this.records.get(target);
    return record ? { value: { ...record.value }, version: record.version } : { value: {}, version: 'v0' };
  }

  injectReadFailure(target: string, reason: 'timeout' | 'disconnect' | 'partial' | 'async'): void {
    this.readFailures.set(target, reason);
  }

  clearReadFailure(target: string): void {
    this.readFailures.delete(target);
  }

  async write(input: { target: string; after: Record<string, unknown>; expectedVersion?: string; idempotencyKey: string; idempotencyScope: string; remoteRequestId: string }): Promise<LoopbackWriteResult> {
    const scopedKey = `${input.idempotencyScope}:${input.idempotencyKey}`;
    const prior = this.idempotency.get(scopedKey);
    if (prior) return { ...prior, before: { ...prior.before }, value: { ...prior.value }, replayed: true };
    const current = await this.read(input.target);
    if (input.expectedVersion && input.expectedVersion !== current.version) {
      const failed: LoopbackWriteResult = {
        ok: false,
        before: current.value,
        beforeVersion: current.version,
        value: current.value,
        version: current.version,
        replayed: false,
        remoteRequestId: input.remoteRequestId,
        error: `Connector version conflict: expected ${input.expectedVersion}, found ${current.version}.`,
      };
      this.idempotency.set(scopedKey, failed);
      return { ...failed, before: { ...failed.before }, value: { ...failed.value } };
    }
    const next = `v${++this.version}`;
    const result: LoopbackWriteResult = {
      ok: true,
      before: current.value,
      beforeVersion: current.version,
      value: { ...input.after },
      version: next,
      replayed: false,
      remoteRequestId: input.remoteRequestId,
    };
    this.records.set(input.target, { value: { ...result.value }, version: result.version });
    this.idempotency.set(scopedKey, result);
    return { ...result, before: { ...result.before }, value: { ...result.value } };
  }
}

/** Versioned allowlist for external targets and bounded write adapters. */
export class ConnectorRegistry {
  private readonly store: EventStore;
  private readonly gateway: ActionGateway;
  private readonly clock: RuntimeClock;
  private readonly ids: RuntimeIdFactory;
  private readonly profiles = new Map<string, ConnectorActionProfile>();
  private readonly loopback: LoopbackConnector;
  private readonly artifactStore?: ConnectorRegistryOptions['artifactStore'];

  constructor(options: ConnectorRegistryOptions) {
    this.store = options.store;
    this.gateway = options.gateway;
    this.clock = options.clock ?? defaultClock;
    this.ids = options.ids ?? defaultIds;
    this.loopback = new LoopbackConnector();
    this.artifactStore = options.artifactStore;
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
    const profile = validateAction(this.get(input.profileId, input.profileVersion), input.connectorId, input.action, input.target, input.scope, input.after);
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

  async write(input: ConnectorWriteInput): Promise<ConnectorWriteResult> {
    const profile = validateAction(this.get(input.profileId, input.profileVersion), input.connectorId, input.action, input.target, input.scope, input.after, true);
    const actionId = input.actionId ?? `action-connector-write-${hash({ connectorId: input.connectorId, profileId: input.profileId, profileVersion: input.profileVersion, target: input.target, scope: input.scope, idempotencyKey: input.idempotencyKey }).slice(0, 24)}`;
    const idempotencyScope = hash({ connectorId: input.connectorId, profileId: input.profileId, profileVersion: input.profileVersion, target: input.target, scope: input.scope });
    const remoteRequestId = input.remoteRequestId ?? `loopback-${hash({ idempotencyScope, idempotencyKey: input.idempotencyKey }).slice(0, 16)}`;
    const postcondition = input.postcondition?.slice(0, 500) || 'read-back version matches the receipt version';
    const traceRef = input.traceRef?.slice(0, 300) || `run:${input.runId}:action:${actionId}`;
    let adapterResult: LoopbackWriteResult | undefined;
    const action = await this.gateway.execute({
      request: {
        actionId,
        runId: input.runId,
        taskId: input.taskId,
        sessionId: input.sessionId,
        profile: { id: profile!.id, version: profile!.version },
        target: input.target,
        scope: input.scope,
        capabilities: [`connector:${input.connectorId}`, input.action],
        network: { mode: 'none' },
        argsHash: hash({ action: input.action, target: input.target, scope: input.scope, after: input.after, expectedVersion: input.expectedVersion }),
        argsSummary: `write:${input.action};target:${input.target};fields:${Object.keys(input.after).sort().join(',') || 'none'}`,
        idempotencyKey: input.idempotencyKey,
        dryRun: false,
        deadline: new Date(this.clock.now().getTime() + 60_000).toISOString(),
      },
      adapter: {
        id: `connector-write:${input.connectorId}`,
        execute: async () => {
          adapterResult = await this.loopback.write({ target: input.target, after: input.after, expectedVersion: input.expectedVersion, idempotencyKey: input.idempotencyKey, idempotencyScope, remoteRequestId });
          return {
            ok: adapterResult.ok,
            output: { version: adapterResult.version },
            error: adapterResult.error,
            receipt: { sideEffect: adapterResult.ok ? 'known' : 'none', version: adapterResult.version, beforeHash: hash(adapterResult.before), afterHash: hash(adapterResult.value), replayed: adapterResult.replayed, remoteRequestId: adapterResult.remoteRequestId },
            evidence: [
              { type: 'connector.before', summary: `Loopback target ${input.target} before write.`, hash: hash(adapterResult.before) },
              { type: 'connector.after', summary: `Loopback target ${input.target} after write.`, hash: hash(adapterResult.value) },
            ],
          };
        },
      },
      markRunNeedsReconciliation: false,
    });
    const current: LoopbackWriteResult = adapterResult ?? await this.loopback.read(input.target).then((read) => ({
      ok: action.ok,
      before: read.value,
      beforeVersion: read.version,
      value: read.value,
      version: read.version,
      replayed: Boolean(action.replayed),
      remoteRequestId,
    } satisfies LoopbackWriteResult)).catch(() => ({
      ok: action.ok,
      before: {},
      beforeVersion: 'unknown',
      value: {},
      version: 'unknown',
      replayed: Boolean(action.replayed),
      remoteRequestId,
    } satisfies LoopbackWriteResult));
    const priorReceipt = action.replayed
      ? [...await this.store.list(input.runId)].reverse().find((event) => event.type === 'connector.receipt' && event.payload.actionId === actionId && event.payload.target === input.target && event.payload.idempotencyKey === input.idempotencyKey)
      : undefined;
    const receipt = priorReceipt
      ? {
          target: String(priorReceipt.payload.target ?? input.target),
          scope: safeScope(priorReceipt.payload.scope ?? input.scope),
          beforeHash: String(priorReceipt.payload.beforeHash ?? hash(current.before)),
          afterHash: String(priorReceipt.payload.afterHash ?? hash(current.value)),
          version: String(priorReceipt.payload.version ?? current.version),
          idempotencyKey: input.idempotencyKey,
          remoteRequestId: String(priorReceipt.payload.remoteRequestId ?? remoteRequestId),
          postcondition: String(priorReceipt.payload.postcondition ?? postcondition),
          ...(priorReceipt.payload.artifactRef ? { artifactRef: String(priorReceipt.payload.artifactRef) } : input.artifactRef ? { artifactRef: input.artifactRef.slice(0, 300) } : {}),
          traceRef: String(priorReceipt.payload.traceRef ?? traceRef),
          replayed: true,
        }
      : {
          target: input.target,
          scope: safeScope(input.scope),
          beforeHash: hash(current.before),
          afterHash: hash(current.value),
          version: current.version,
          idempotencyKey: input.idempotencyKey,
          remoteRequestId,
          postcondition,
          ...(input.artifactRef ? { artifactRef: input.artifactRef.slice(0, 300) } : {}),
          traceRef,
          replayed: Boolean(current.replayed || action.replayed),
        };
    if (action.status !== 'denied' && action.status !== 'approval_required') {
      await this.store.append({
        type: 'connector.receipt',
        taskId: input.taskId,
        sessionId: input.sessionId,
        runId: input.runId,
        payload: { actionId, connectorId: input.connectorId, profile: { id: profile.id, version: profile.version }, ...receipt },
      });
    }
    const verification = action.status === 'executed'
      ? await this.verifyWrite({ runId: input.runId, taskId: input.taskId, sessionId: input.sessionId, actionId, target: input.target, expectedAfterHash: receipt.afterHash, expectedVersion: receipt.version, postcondition })
      : undefined;
    return { action, receipt, verification };
  }

  async verifyWrite(input: { runId: ID; taskId: ID; sessionId: ID; actionId: ID; target: string; expectedAfterHash: string; expectedVersion?: string; postcondition?: string }): Promise<ConnectorVerificationResult> {
    const postcondition = input.postcondition?.slice(0, 500) || 'read-back version matches the receipt version';
    let observedAfterHash: string | undefined;
    let observedVersion: string | undefined;
    let status: ConnectorVerificationResult['status'] | undefined;
    let reason: string | undefined;
    const receiptEvent = [...await this.store.list(input.runId)].reverse().find((event) => event.type === 'connector.receipt' && event.payload.actionId === input.actionId && event.payload.target === input.target);
    const recordedAfterHash = typeof receiptEvent?.payload.afterHash === 'string' ? receiptEvent.payload.afterHash : undefined;
    if (!receiptEvent) {
      status = 'unknown';
      reason = 'Connector write receipt is unavailable; verification cannot promote an unexecuted action.';
    } else if (recordedAfterHash && recordedAfterHash !== input.expectedAfterHash) {
      status = 'failed';
      reason = 'Requested postcondition is not bound to the recorded connector write receipt.';
    }
    try {
      if (status !== undefined) throw new Error('__verification_already_classified__');
      const observed = await this.loopback.read(input.target);
      observedAfterHash = hash(observed.value);
      observedVersion = observed.version;
      status = observedAfterHash === input.expectedAfterHash && (!input.expectedVersion || observed.version === input.expectedVersion) ? 'known' : 'failed';
      if (status === 'failed') reason = 'Read-after-write state does not satisfy the expected hash/version postcondition.';
    } catch (error) {
      if (error instanceof Error && error.message === '__verification_already_classified__') {
        // The receipt binding check above intentionally avoids reading state for
        // an unexecuted or mismatched action.
      } else {
      status = 'unknown';
      reason = error instanceof Error ? error.message.slice(0, 500) : 'Connector read-after-write failed.';
      }
    }
    const evidence: Array<{ type: string; summary: string; uri?: string; hash?: string }> = [{
      type: 'connector.read-after-write',
      summary: status === 'known' ? `Read-after-write verified ${input.target}.` : status === 'failed' ? `Read-after-write detected a postcondition mismatch for ${input.target}.` : `Read-after-write is unavailable for ${input.target}.`,
      uri: `connector://${encodeURIComponent(input.target)}/read-after-write`,
      ...(observedAfterHash ? { hash: observedAfterHash } : {}),
    }];
    let artifact;
    if (this.artifactStore && observedVersion) {
      try {
        artifact = await this.artifactStore.put({
          runId: input.runId,
          type: 'connector-read-after-write',
          extension: 'json',
          content: JSON.stringify({ target: input.target, status, expectedAfterHash: input.expectedAfterHash, observedAfterHash, expectedVersion: input.expectedVersion, observedVersion, postcondition }),
          limitations: ['Snapshot contains hashes and version metadata only; connector field values are excluded.'],
        });
        evidence.push({ type: 'connector.read-after-write-artifact', summary: 'Restricted read-after-write evidence artifact.', uri: artifact.uri, hash: artifact.hash });
      } catch (error) {
        reason = `${reason ? `${reason} ` : ''}Evidence artifact unavailable: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown error'}`;
      }
    }
    const finalStatus = status ?? 'unknown';
    const result: ConnectorVerificationResult = { actionId: input.actionId, target: input.target, status: finalStatus, expectedAfterHash: input.expectedAfterHash, observedAfterHash, expectedVersion: input.expectedVersion, observedVersion, postcondition, evidence, artifact, reason };
    await this.store.append({ type: 'connector.reconciliation', taskId: input.taskId, sessionId: input.sessionId, runId: input.runId, payload: result as unknown as Record<string, unknown> });
    if (finalStatus === 'unknown') {
      await this.store.append({ type: 'run.needs_reconciliation', taskId: input.taskId, sessionId: input.sessionId, runId: input.runId, payload: { state: 'needs_reconciliation', reason: reason ?? 'Connector read-after-write is unknown.', actionId: input.actionId } });
    } else {
      await this.store.append({ type: 'run.reconciled', taskId: input.taskId, sessionId: input.sessionId, runId: input.runId, payload: { id: this.ids.next('reconciliation'), runId: input.runId, actionId: input.actionId, outcome: finalStatus, evidence, reason } });
    }
    return result;
  }

  injectLoopbackReadFailure(target: string, reason: 'timeout' | 'disconnect' | 'partial' | 'async'): void {
    this.loopback.injectReadFailure(target, reason);
  }

  clearLoopbackReadFailure(target: string): void {
    this.loopback.clearReadFailure(target);
  }

  async readLoopback(target: string): Promise<LoopbackReadResult> {
    return this.loopback.read(target);
  }
}

function validateAction(profile: ConnectorActionProfile | undefined, connectorId: string, action: string, target: string, scope: Record<string, unknown>, after: unknown, requireObject = false): ConnectorActionProfile {
  if (!profile || profile.connectorId !== connectorId) throw new Error('Connector Action Profile is not registered.');
  if (!profile.actions.includes(action)) throw new Error(`Connector action ${action} is not allowed by the profile.`);
  if (!profile.allowedTargets.some((allowedTarget) => target === allowedTarget || target.startsWith(`${allowedTarget}/`))) throw new Error('Connector target is outside the allowlist.');
  if (!scopeWithin(scope, profile.scope)) throw new Error('Connector scope is outside the profile grant.');
  if (!after || typeof after !== 'object' || Array.isArray(after)) {
    if (requireObject) throw new Error('Connector write fields must be an object.');
    return profile;
  }
  const fields = Object.keys(after as Record<string, unknown>);
  if (fields.some((field) => !profile.allowedFields.includes(field))) throw new Error('Connector field is outside the profile grant.');
  return profile;
}

function validateProfile(profile: ConnectorActionProfile): void {
  if (!profile.id || !profile.version || !profile.connectorId) throw new Error('Connector profile identity is required.');
  if (!profile.actions.length || !profile.allowedTargets.length) throw new Error('Connector profile must declare actions and targets.');
}

function safeScope(value: unknown, depth = 0): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 3) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 32).map(([key, entry]) => {
    if (/api[-_]?key|authorization|cookie|secret|password|token/i.test(key)) return [key, '[redacted]'];
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) return [key, safeScope(entry, depth + 1)];
    if (Array.isArray(entry)) return [key, entry.slice(0, 32).map((item) => typeof item === 'string' ? item.slice(0, 200) : item)];
    return [key, typeof entry === 'string' ? entry.slice(0, 300) : entry];
  }));
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
