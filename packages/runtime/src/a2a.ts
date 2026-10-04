import { createHmac, timingSafeEqual, createHash } from 'node:crypto';
import type {
  A2ADeliveryRecord,
  A2ADeliveryState,
  A2AEnvelope,
  A2AEnvelopeInput,
  A2AIdentity,
  A2AReconciliationRecord,
  A2ATransportOptions,
  ArtifactReference,
  DomainEvent,
  EventStore,
  ID,
  RuntimeClock,
  RuntimeIdFactory,
} from './types.js';

type RegisteredIdentity = { identity: A2AIdentity; fixtureKey: string };
type EnvelopeInput = Omit<A2AEnvelopeInput, 'signature'> & { messageId?: ID };

const defaultClock: RuntimeClock = { now: () => new Date() };
const defaultIds: RuntimeIdFactory = { next: (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` };
const SENSITIVE = /api[-_ ]?key|authorization|cookie|password|secret|token/i;

export function signA2AEnvelope(input: EnvelopeInput, fixtureKey: string): string {
  if (!fixtureKey) throw new Error('A2A fixture signing key is required.');
  return createHmac('sha256', fixtureKey).update(canonicalEnvelope(input)).digest('hex');
}

/** Local-only authenticated A2A transport. It never grants shell, workspace, or Keychain access. */
export class A2ALoopbackTransport {
  private readonly store: EventStore;
  private readonly clock: RuntimeClock;
  private readonly ids: RuntimeIdFactory;
  private readonly identities = new Map<ID, RegisteredIdentity>();

  constructor(options: A2ATransportOptions) {
    this.store = options.store;
    this.clock = options.clock ?? defaultClock;
    this.ids = options.ids ?? defaultIds;
  }

  registerIdentity(identity: A2AIdentity, fixtureKey: string): A2AIdentity {
    validateIdentity(identity);
    if (!fixtureKey || fixtureKey.length > 200) throw new Error('A2A fixture signing key is required.');
    this.identities.set(identity.id, { identity: cloneIdentity(identity), fixtureKey });
    return cloneIdentity(identity);
  }

  listIdentities(): A2AIdentity[] { return [...this.identities.values()].map((item) => cloneIdentity(item.identity)); }

  sign(input: EnvelopeInput): string {
    const registration = this.identities.get(input.sender.id);
    if (!registration) throw new Error('A2A sender identity is not registered.');
    return signA2AEnvelope(input, registration.fixtureKey);
  }

  createEnvelope(input: EnvelopeInput): A2AEnvelope {
    const messageId = input.messageId ?? this.ids.next('a2a-message');
    const unsigned = { ...input, messageId };
    return { ...unsigned, signature: this.sign(unsigned) } as A2AEnvelope;
  }

  async send(input: A2AEnvelopeInput | A2AEnvelope): Promise<A2ADeliveryRecord> {
    const envelope = this.normalizeEnvelope(input);
    try {
      validateEnvelope(envelope, this.identities, this.clock.now());
    } catch (error) {
      await this.reject(envelope, safeError(error));
      throw error;
    }
    const prior = await this.findByIdempotency(envelope.sender.id, envelope.recipient.id, envelope.idempotencyKey);
    if (prior) {
      const reason = `A2A idempotency key has already been used: ${envelope.idempotencyKey}`;
      await this.reject(envelope, reason);
      throw new Error(reason);
    }
    const now = this.clock.now().toISOString();
    await this.store.append({ type: 'a2a.envelope', taskId: envelope.taskId, runId: envelope.runId, payload: { envelope: sanitizeEnvelope(envelope), envelopeHash: hashEnvelope(envelope) } });
    const delivery = this.delivery(envelope, 'queued', now, 0);
    await this.appendDelivery(delivery);
    return cloneDelivery(delivery);
  }

  async dispatch(messageId: ID): Promise<A2ADeliveryRecord> {
    const record = await this.get(messageId);
    if (!record) throw new Error(`Unknown A2A message: ${messageId}`);
    if (record.delivery.state === 'ack') return cloneDelivery(record.delivery);
    if (record.delivery.state === 'sent') return cloneDelivery(record.delivery);
    if (Date.parse(record.envelope.deadline) <= this.clock.now().getTime()) return this.markUnknown(messageId, 'A2A deadline expired before dispatch.');
    const next = this.delivery(record.envelope, 'sent', record.delivery.queuedAt, record.delivery.attempt + 1, record.delivery);
    await this.appendDelivery(next);
    return cloneDelivery(next);
  }

  async retry(messageId: ID): Promise<A2ADeliveryRecord> {
    const record = await this.get(messageId);
    if (!record) throw new Error(`Unknown A2A message: ${messageId}`);
    if (record.delivery.state === 'ack') return cloneDelivery(record.delivery);
    return this.dispatch(messageId);
  }

  async ack(messageId: ID, receiptHash: string): Promise<A2ADeliveryRecord> {
    const record = await this.get(messageId);
    if (!record) throw new Error(`Unknown A2A message: ${messageId}`);
    if (record.delivery.state === 'ack') return cloneDelivery(record.delivery);
    if (!/^[a-f0-9]{64}$/i.test(receiptHash)) throw new Error('A2A receipt hash must be sha256.');
    if (record.delivery.state === 'failed' || record.delivery.state === 'unknown') {
      const next = this.delivery(record.envelope, 'unknown', record.delivery.queuedAt, record.delivery.attempt, record.delivery, { receiptHash, error: 'Late A2A ACK requires local reconciliation.' });
      await this.appendDelivery(next);
      return cloneDelivery(next);
    }
    if (record.delivery.state !== 'sent') throw new Error(`A2A message ${messageId} is not awaiting ACK.`);
    const next = this.delivery(record.envelope, 'ack', record.delivery.queuedAt, record.delivery.attempt, record.delivery, { receiptHash });
    await this.appendDelivery(next);
    return cloneDelivery(next);
  }

  async fail(messageId: ID, reason: string): Promise<A2ADeliveryRecord> {
    const record = await this.get(messageId);
    if (!record) throw new Error(`Unknown A2A message: ${messageId}`);
    if (record.delivery.state === 'failed') return cloneDelivery(record.delivery);
    if (record.delivery.state === 'ack') throw new Error(`A2A message ${messageId} is already acknowledged.`);
    const next = this.delivery(record.envelope, 'failed', record.delivery.queuedAt, record.delivery.attempt, record.delivery, { error: safeError(reason) });
    await this.appendDelivery(next);
    return cloneDelivery(next);
  }

  async markUnknown(messageId: ID, reason: string): Promise<A2ADeliveryRecord> {
    const record = await this.get(messageId);
    if (!record) throw new Error(`Unknown A2A message: ${messageId}`);
    if (record.delivery.state === 'ack') return cloneDelivery(record.delivery);
    if (record.delivery.state === 'unknown') return cloneDelivery(record.delivery);
    const next = this.delivery(record.envelope, 'unknown', record.delivery.queuedAt, record.delivery.attempt, record.delivery, { error: safeError(reason) });
    await this.appendDelivery(next);
    return cloneDelivery(next);
  }

  async reconcile(messageId: ID, outcome: A2AReconciliationRecord['outcome'], evidence: A2AReconciliationRecord['evidence'] = [], reason?: string): Promise<A2ADeliveryRecord> {
    const record = await this.get(messageId);
    if (!record) throw new Error(`Unknown A2A message: ${messageId}`);
    if ((outcome === 'known' || outcome === 'failed') && evidence.length === 0) throw new Error('A2A reconciliation requires evidence for a known or failed outcome.');
    validateReconciliationEvidence(evidence);
    const reconciliation: A2AReconciliationRecord = { id: this.ids.next('a2a-reconcile'), messageId, runId: record.envelope.runId, outcome, evidence: evidence.map(cloneEvidence), reason: reason ? safeError(reason) : undefined, recordedAt: this.clock.now().toISOString() };
    await this.store.append({ type: 'a2a.reconciliation', taskId: record.envelope.taskId, runId: record.envelope.runId, payload: reconciliation as unknown as Record<string, unknown> });
    const state: A2ADeliveryState = outcome === 'known' ? 'ack' : outcome === 'failed' ? 'failed' : 'unknown';
    const next = this.delivery(record.envelope, state, record.delivery.queuedAt, record.delivery.attempt, record.delivery, { reconciliationId: reconciliation.id, error: outcome === 'unknown' ? reconciliation.reason : undefined });
    await this.appendDelivery(next);
    return cloneDelivery(next);
  }

  async get(messageId: ID): Promise<{ envelope: A2AEnvelope; delivery: A2ADeliveryRecord } | undefined> {
    const events = await this.store.listAll();
    const envelopeEvent = [...events].reverse().find((event) => event.type === 'a2a.envelope' && (event.payload.envelope as Record<string, unknown> | undefined)?.messageId === messageId);
    if (!envelopeEvent) return undefined;
    const deliveryEvents = events.filter((event) => event.type === 'a2a.delivery' && event.payload.messageId === messageId);
    const latest = deliveryEvents.at(-1);
    if (!latest) return undefined;
    return { envelope: envelopeEvent.payload.envelope as unknown as A2AEnvelope, delivery: latest.payload as unknown as A2ADeliveryRecord };
  }

  async list(runId?: ID): Promise<A2ADeliveryRecord[]> {
    const events = await this.store.listAll();
    const messageIds = [...new Set(events.filter((event) => event.type === 'a2a.envelope').map((event) => String((event.payload.envelope as Record<string, unknown> | undefined)?.messageId)).filter(Boolean))];
    const records: A2ADeliveryRecord[] = [];
    for (const messageId of messageIds) {
      const record = await this.get(messageId);
      if (record && (!runId || record.delivery.runId === runId)) records.push(cloneDelivery(record.delivery));
    }
    return records;
  }

  async replay(): Promise<A2ADeliveryRecord[]> { return this.list(); }
  async replayPending(): Promise<A2ADeliveryRecord[]> { return (await this.list()).filter((record) => record.state === 'queued' || record.state === 'sent' || record.state === 'unknown'); }

  async findDelivery(senderId: ID, recipientId: ID, idempotencyKey: string): Promise<A2ADeliveryRecord | undefined> { return this.findByIdempotency(senderId, recipientId, idempotencyKey); }

  private normalizeEnvelope(input: A2AEnvelopeInput | A2AEnvelope): A2AEnvelope {
    const messageId = 'messageId' in input && input.messageId ? input.messageId : this.ids.next('a2a-message');
    return { ...input, messageId, sender: cloneIdentity(input.sender), recipient: cloneIdentity(input.recipient), capabilityGrant: { ...input.capabilityGrant, capabilities: [...input.capabilityGrant.capabilities], scope: { ...input.capabilityGrant.scope } }, scope: { ...input.scope }, context: cloneContext(input.context), artifactRefs: input.artifactRefs?.map(cloneArtifact) };
  }

  private delivery(envelope: A2AEnvelope, state: A2ADeliveryState, queuedAt: string, attempt: number, prior?: A2ADeliveryRecord, extra: Partial<A2ADeliveryRecord> = {}): A2ADeliveryRecord {
    return { messageId: envelope.messageId, taskId: envelope.taskId, runId: envelope.runId, correlationId: envelope.correlationId, senderId: envelope.sender.id, recipientId: envelope.recipient.id, idempotencyKey: envelope.idempotencyKey, state, attempt, queuedAt, updatedAt: this.clock.now().toISOString(), deadline: envelope.deadline, ...(prior?.receiptHash ? { receiptHash: prior.receiptHash } : {}), ...extra };
  }

  private async appendDelivery(delivery: A2ADeliveryRecord): Promise<void> { await this.store.append({ type: 'a2a.delivery', taskId: delivery.taskId, runId: delivery.runId, payload: delivery as unknown as Record<string, unknown> }); }

  private async findByIdempotency(senderId: ID, recipientId: ID, idempotencyKey: string): Promise<A2ADeliveryRecord | undefined> {
    const records = await this.list();
    return records.find((record) => record.senderId === senderId && record.recipientId === recipientId && record.idempotencyKey === idempotencyKey);
  }

  private async reject(input: Partial<A2AEnvelope>, reason: string): Promise<void> {
    await this.store.append({ type: 'a2a.rejected', taskId: input.taskId, runId: input.runId, payload: { messageId: input.messageId, senderId: input.sender?.id, recipientId: input.recipient?.id, correlationId: input.correlationId, idempotencyKey: input.idempotencyKey, reason: safeError(reason) } });
  }
}

function validateEnvelope(envelope: A2AEnvelope, identities: Map<ID, RegisteredIdentity>, now: Date): void {
  const sender = identities.get(envelope.sender.id);
  const recipient = identities.get(envelope.recipient.id);
  if (!sender || !recipient) throw new Error('A2A sender or recipient identity is not registered.');
  if (!sameIdentity(envelope.sender, sender.identity) || !sameIdentity(envelope.recipient, recipient.identity)) throw new Error('A2A identity does not match the registered identity.');
  if (!envelope.taskId || !envelope.runId || !envelope.correlationId || !envelope.idempotencyKey) throw new Error('A2A envelope identity and idempotency fields are required.');
  const deadline = Date.parse(envelope.deadline);
  if (!Number.isFinite(deadline) || deadline <= now.getTime()) throw new Error('A2A deadline has expired or is invalid.');
  if (!scopeWithin(envelope.scope, sender.identity.scope) || !scopeWithin(envelope.scope, recipient.identity.scope)) throw new Error('A2A envelope scope exceeds an identity scope.');
  if (!envelope.capabilityGrant.capabilities.length || envelope.capabilityGrant.capabilities.some((capability) => !sender.identity.capabilities.includes(capability) || !recipient.identity.capabilities.includes(capability))) throw new Error('A2A capability grant is not authorized by both identities.');
  if (!scopeWithin(envelope.capabilityGrant.scope, envelope.scope)) throw new Error('A2A capability grant scope exceeds the envelope scope.');
  validateContext(envelope.context);
  for (const artifact of envelope.artifactRefs ?? []) validateArtifact(artifact, envelope.runId);
  const expected = signA2AEnvelope(envelope, sender.fixtureKey);
  if (!constantTimeEqual(envelope.signature, expected)) throw new Error('A2A envelope signature is invalid.');
}

function validateIdentity(identity: A2AIdentity): void { if (!identity.id || !identity.principal || !identity.role || !Array.isArray(identity.capabilities) || !identity.scope) throw new Error('A2A identity is incomplete.'); }
function validateContext(context: A2AEnvelope['context']): void {
  if (!context.goalSummary || context.goalSummary.length > 2_000 || SENSITIVE.test(context.goalSummary)) throw new Error('A2A context must be bounded and free of credential-like content.');
  const entries = [...(context.constraints ?? []), ...(context.summaries ?? [])];
  if (entries.length > 32 || entries.some((entry) => !entry || entry.length > 1_000 || SENSITIVE.test(entry) || /\/(?:Users|private|tmp)\//.test(entry))) throw new Error('A2A context must be bounded and free of credential-like content.');
}
function validateArtifact(artifact: ArtifactReference, runId: ID): void { if (!artifact.uri.startsWith('artifact://') || artifact.sourceRunId !== runId || !/^[a-f0-9]{64}$/i.test(artifact.hash) || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0) throw new Error('A2A Artifact reference is unauthorized or malformed.'); }
function scopeWithin(requested: Record<string, unknown>, allowed: Record<string, unknown>): boolean { return Object.entries(requested).every(([key, value]) => allowed[key] === value); }
function sameIdentity(left: A2AIdentity, right: A2AIdentity): boolean { return left.id === right.id && left.principal === right.principal && left.role === right.role && stableJson([...left.capabilities].sort()) === stableJson([...right.capabilities].sort()) && stableJson(left.scope) === stableJson(right.scope); }
function canonicalEnvelope(input: EnvelopeInput): string { const { signature: _signature, messageId: _messageId, ...unsigned } = input as EnvelopeInput & { signature?: string; messageId?: string }; return stableJson(unsigned); }
function hashEnvelope(input: EnvelopeInput): string { return createHash('sha256').update(canonicalEnvelope(input)).digest('hex'); }
function stableJson(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`; if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`; return JSON.stringify(value); }
function constantTimeEqual(left: string, right: string): boolean { const a = Buffer.from(left, 'hex'); const b = Buffer.from(right, 'hex'); return a.length === b.length && a.length > 0 && timingSafeEqual(a, b); }
function cloneIdentity(identity: A2AIdentity): A2AIdentity { return { ...identity, capabilities: [...identity.capabilities], scope: { ...identity.scope } }; }
function cloneContext(context: A2AEnvelopeInput['context']): A2AEnvelopeInput['context'] { return { ...context, constraints: context.constraints ? [...context.constraints] : undefined, summaries: context.summaries ? [...context.summaries] : undefined }; }
function cloneArtifact(artifact: ArtifactReference): ArtifactReference { return { ...artifact, limitations: artifact.limitations ? [...artifact.limitations] : undefined }; }
function sanitizeEnvelope(envelope: A2AEnvelope): A2AEnvelope { return { ...envelope, sender: cloneIdentity(envelope.sender), recipient: cloneIdentity(envelope.recipient), context: { goalSummary: envelope.context.goalSummary.slice(0, 600), constraints: envelope.context.constraints?.slice(0, 16).map((item) => item.slice(0, 300)), summaries: envelope.context.summaries?.slice(0, 16).map((item) => item.slice(0, 300)) }, artifactRefs: envelope.artifactRefs?.map(cloneArtifact) }; }
function cloneDelivery(delivery: A2ADeliveryRecord): A2ADeliveryRecord { return { ...delivery }; }
function cloneEvidence(evidence: A2AReconciliationRecord['evidence'][number]): A2AReconciliationRecord['evidence'][number] { return { ...evidence }; }
function validateReconciliationEvidence(evidence: A2AReconciliationRecord['evidence']): void {
  if (evidence.length > 32 || evidence.some((item) => !item || typeof item.type !== 'string' || typeof item.summary !== 'string' || item.type.length > 120 || item.summary.length > 1_000 || SENSITIVE.test(item.summary) || (item.uri !== undefined && (item.uri.length > 500 || SENSITIVE.test(item.uri))) || (item.hash !== undefined && !/^[a-f0-9]{64}$/i.test(item.hash)))) throw new Error('A2A reconciliation evidence is unbounded or sensitive.');
}
function safeError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).replace(/(?:api[-_ ]?key|authorization|cookie|password|secret|token)\s*[:=]\s*[^\s,;]+/gi, '[redacted]').slice(0, 500); }
