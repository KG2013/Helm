import { createHash } from 'node:crypto';
import { ActionGateway } from './action-gateway.js';
import { AgentRunCoordinator } from './agent.js';
import { A2ALoopbackTransport } from './a2a.js';
import type {
  A2AEnvelope,
  A2AIdentity,
  A2AMinimalContext,
  ActionAdapter,
  ActionExecutionResult,
  ActionRequest,
  AgentAggregateResult,
  AgentResult,
  AgentRunRecord,
  ArtifactReference,
  ArtifactStore,
  Budget,
  EventStore,
  Evidence,
  ID,
  RuntimeClock,
  RuntimeIdFactory,
} from './types.js';

export interface RemoteAgentDelegateInput {
  parentRunId: ID;
  parentAgentId?: ID;
  role: string;
  principal: ID;
  goal: string;
  capabilities: string[];
  scope: Record<string, unknown>;
  allowedCapabilities: readonly string[];
  allowedScope: Record<string, unknown>;
  budget?: Partial<Budget>;
  sender: A2AIdentity;
  recipient: A2AIdentity;
  context: A2AMinimalContext;
  artifactRefs?: readonly ArtifactReference[];
  idempotencyKey: string;
  deadline: string;
}

export interface RemoteAgentWorkerResult {
  status: AgentResult['status'];
  output?: unknown;
  evidence: Evidence[];
  artifacts: ArtifactReference[];
  /** A locally re-read Artifact that proves the requested postcondition. */
  postcondition?: ArtifactReference;
  conflict?: string;
}

export interface RemoteAgentExecutionResult {
  child: AgentRunRecord;
  envelope: A2AEnvelope;
  delivery: Awaited<ReturnType<A2ALoopbackTransport['send']>>;
  result?: AgentResult;
  aggregate?: AgentAggregateResult;
}

export interface RemoteAgentCoordinatorOptions {
  store: EventStore;
  gateway: ActionGateway;
  agents: AgentRunCoordinator;
  transport: A2ALoopbackTransport;
  clock?: RuntimeClock;
  ids?: RuntimeIdFactory;
  artifactStore?: ArtifactStore;
  networkAllowlist?: readonly string[];
}

export class RemoteAgentCoordinator {
  private readonly store: EventStore;
  private readonly gateway: ActionGateway;
  private readonly agents: AgentRunCoordinator;
  private readonly transport: A2ALoopbackTransport;
  private readonly clock: RuntimeClock;
  private readonly ids: RuntimeIdFactory;
  private readonly artifactStore?: ArtifactStore;
  private readonly networkAllowlist: readonly string[];

  constructor(options: RemoteAgentCoordinatorOptions) {
    this.store = options.store;
    this.gateway = options.gateway;
    this.agents = options.agents;
    this.transport = options.transport;
    this.clock = options.clock ?? { now: () => new Date() };
    this.ids = options.ids ?? { next: (prefix) => `${prefix}-${Date.now().toString(36)}` };
    this.artifactStore = options.artifactStore;
    this.networkAllowlist = options.networkAllowlist ?? [];
  }

  async delegate(input: RemoteAgentDelegateInput): Promise<RemoteAgentExecutionResult> {
    const parent = await this.store.getRun(input.parentRunId);
    if (!parent) throw new Error(`Unknown parent Run: ${input.parentRunId}`);
    if (input.role !== input.recipient.role || input.principal !== input.recipient.principal) throw new Error('Remote Agent identity does not match the authenticated recipient.');
    if (input.capabilities.some((capability) => !input.recipient.capabilities.includes(capability))) throw new Error('Remote Agent capability is outside the authenticated recipient grant.');
    if (input.capabilities.some(isLocalCapability)) throw new Error('Remote Agent cannot request local workspace, shell, Keychain, or tool capabilities.');
    if (!scopeWithin(input.scope, input.recipient.scope)) throw new Error('Remote Agent scope is outside the authenticated recipient grant.');
    for (const artifact of input.artifactRefs ?? []) await this.verifyArtifact(artifact, input.parentRunId);
    const child = await this.agents.createChild({
      parentRunId: input.parentRunId,
      parentAgentId: input.parentAgentId,
      role: input.role,
      principal: input.principal,
      goal: input.goal,
      capabilities: input.capabilities,
      scope: input.scope,
      allowedCapabilities: input.allowedCapabilities,
      allowedScope: input.allowedScope,
      budget: input.budget,
    });
    let envelope: A2AEnvelope;
    let delivery: Awaited<ReturnType<A2ALoopbackTransport['send']>>;
    try {
      envelope = this.transport.createEnvelope({
        sender: input.sender,
        recipient: input.recipient,
        capabilityGrant: { capabilities: [...input.capabilities], scope: { ...input.scope } },
        taskId: parent.taskId,
        runId: input.parentRunId,
        correlationId: child.agentRunId,
        idempotencyKey: input.idempotencyKey,
        deadline: input.deadline,
        scope: { ...input.scope },
        context: input.context,
        artifactRefs: input.artifactRefs,
      });
      delivery = await this.transport.send(envelope);
    } catch (error) {
      await this.agents.setState(child.agentRunId, 'failed', `Remote envelope rejected: ${safeError(error)}`);
      throw error;
    }
    return { child, envelope, delivery };
  }

  async executeWorker(messageId: ID, worker: (input: { envelope: A2AEnvelope; child: AgentRunRecord }) => Promise<RemoteAgentWorkerResult>): Promise<RemoteAgentExecutionResult> {
    const record = await this.transport.get(messageId);
    if (!record) throw new Error(`Unknown remote Agent message: ${messageId}`);
    const child = await this.agents.get(record.envelope.correlationId);
    if (!child) throw new Error('Remote Agent child lineage is unavailable.');
    const existing = await this.latestResult(child.agentRunId);
    if (record.delivery.state === 'ack' || record.delivery.state === 'failed' || existing) {
      const delivery = record.delivery.state === 'sent' && existing
        ? await this.transport.ack(messageId, hash({ agentRunId: child.agentRunId, status: existing.status, evidence: existing.evidence, artifacts: existing.artifacts.map((artifact) => ({ uri: artifact.uri, hash: artifact.hash })) }))
        : record.delivery;
      return { child, envelope: record.envelope, delivery, result: existing, aggregate: await this.agents.aggregate(child.parentRunId) };
    }
    if (record.delivery.state === 'queued') await this.transport.dispatch(messageId);
    let result: AgentResult;
    try {
      const workerResult = await worker({ envelope: record.envelope, child });
      const safe = await validateWorkerResult(workerResult, record.envelope.runId, record.envelope.artifactRefs ?? [], this.artifactStore);
      result = await this.agents.recordResult({ agentRunId: child.agentRunId, status: safe.status, output: safe.output, evidence: safe.evidence, artifacts: safe.artifacts, conflict: safe.conflict });
    } catch (error) {
      result = await this.agents.recordResult({ agentRunId: child.agentRunId, status: 'unknown', evidence: [], artifacts: [], conflict: safeError(error) });
      await this.transport.fail(messageId, safeError(error));
      const aggregate = await this.agents.aggregate(child.parentRunId);
      await this.recordParentVerification(child.parentRunId, aggregate);
      return { child, envelope: record.envelope, delivery: (await this.transport.get(messageId))!.delivery, result, aggregate };
    }
    const receiptHash = hash({ agentRunId: child.agentRunId, status: result.status, evidence: result.evidence, artifacts: result.artifacts.map((artifact) => ({ uri: artifact.uri, hash: artifact.hash })) });
    const delivery = await this.transport.ack(messageId, receiptHash);
    const aggregate = await this.agents.aggregate(child.parentRunId);
    await this.recordParentVerification(child.parentRunId, aggregate);
    return { child, envelope: record.envelope, delivery, result, aggregate };
  }

  async proposeAction(input: { messageId: ID; actionId: ID; profile: { id: string; version: string }; target: string; capabilities: string[]; scope: Record<string, unknown>; network?: ActionRequest['network']; argsHash: string; argsSummary?: string; adapter: ActionAdapter }): Promise<ActionExecutionResult> {
    const record = await this.transport.get(input.messageId);
    if (!record) throw new Error(`Unknown remote Agent message: ${input.messageId}`);
    const child = await this.agents.get(record.envelope.correlationId);
    if (!child) throw new Error('Remote Agent child lineage is unavailable.');
    if (input.capabilities.some((capability) => !child.identity.capabilities.includes(capability))) return this.rejectAction(record, 'Remote Agent action capability is outside the child grant.');
    if (input.capabilities.some(isLocalCapability)) return this.rejectAction(record, 'Remote Agent cannot request local workspace, shell, Keychain, or tool capabilities.');
    if (!scopeWithin(input.scope, child.scope)) return this.rejectAction(record, 'Remote Agent action scope is outside the child grant.');
    const parent = await this.store.getRun(child.parentRunId);
    if (!parent) throw new Error('Parent Run is unavailable for remote action proposal.');
    const network = input.network ?? { mode: 'none' as const };
    const networkError = validateRemoteNetwork(network, input.target, this.networkAllowlist);
    if (networkError) return this.rejectAction(record, networkError);
    if (/^(?:file|workspace|shell|keychain):/i.test(input.target)) return this.rejectAction(record, 'Remote Agent target is outside the local action boundary.');
    const request: ActionRequest = {
      actionId: input.actionId,
      runId: child.parentRunId,
      taskId: child.taskId,
      sessionId: parent.sessionId,
      parentAgentId: child.identity.agentId,
      profile: input.profile,
      target: input.target,
      scope: input.scope,
      capabilities: input.capabilities,
      network: { mode: network.mode, hosts: network.hosts ? [...network.hosts] : undefined },
      argsHash: input.argsHash,
      argsSummary: input.argsSummary,
      idempotencyKey: `${child.agentRunId}:${input.actionId}`,
      dryRun: false,
      deadline: record.envelope.deadline,
    };
    return this.gateway.execute({ request, adapter: input.adapter, markRunNeedsReconciliation: true });
  }

  private async rejectAction(record: { envelope: A2AEnvelope }, reason: string): Promise<never> {
    await this.store.append({ type: 'a2a.rejected', taskId: record.envelope.taskId, runId: record.envelope.runId, payload: { messageId: record.envelope.messageId, correlationId: record.envelope.correlationId, reason: safeError(reason) } });
    throw new Error(reason);
  }

  private async verifyArtifact(artifact: ArtifactReference, parentRunId: ID): Promise<void> {
    if (artifact.sourceRunId !== parentRunId || !artifact.uri.startsWith('artifact://') || !/^[a-f0-9]{64}$/i.test(artifact.hash) || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0) throw new Error('Remote Agent Artifact is unauthorized or malformed.');
    if (!this.artifactStore) throw new Error('Remote Agent ArtifactStore is required for Artifact grants.');
    const bytes = await this.artifactStore.read(artifact.uri);
    const actualHash = createHash('sha256').update(bytes).digest('hex');
    if (actualHash !== artifact.hash.toLowerCase() || bytes.byteLength !== artifact.bytes) throw new Error('Remote Agent Artifact content does not match its grant.');
  }

  private async latestResult(agentRunId: ID): Promise<AgentResult | undefined> {
    const events = await this.store.listAll();
    const event = [...events].reverse().find((candidate) => candidate.type === 'agent.result' && candidate.payload.agentRunId === agentRunId);
    return event?.payload as unknown as AgentResult | undefined;
  }

  private async recordParentVerification(parentRunId: ID, aggregate: AgentAggregateResult): Promise<void> {
    const parent = await this.store.getRun(parentRunId);
    if (!parent) return;
    const evidence = aggregate.results.flatMap((item) => [
      ...item.evidence,
      ...item.artifacts.map((artifact) => ({ type: 'remote.artifact', summary: `Remote artifact ${artifact.uri}`, uri: artifact.uri, hash: artifact.hash })),
    ]).slice(0, 32);
    await this.store.append({
      type: 'verification.result',
      taskId: parent.taskId,
      sessionId: parent.sessionId,
      runId: parentRunId,
      payload: {
        verification: {
          result: aggregate.status === 'success' ? 'passed' : aggregate.status === 'unknown' ? 'unknown' : 'failed',
          verifier: 'remote-agent',
          evidence,
          message: aggregate.conflict,
        },
        remoteAggregate: aggregate.status,
      },
    });
  }
}

async function validateWorkerResult(result: RemoteAgentWorkerResult, parentRunId: ID, authorizedArtifacts: readonly ArtifactReference[], artifactStore?: ArtifactStore): Promise<RemoteAgentWorkerResult> {
  if (!['success', 'failure', 'unknown'].includes(result.status)) throw new Error('Remote Agent result status is invalid.');
  if (!Array.isArray(result.evidence) || result.evidence.length > 32 || !Array.isArray(result.artifacts) || result.artifacts.length > 32) throw new Error('Remote Agent result exceeds the evidence or Artifact bound.');
  const evidence = result.evidence.map((item) => sanitizeEvidence(item));
  if (result.status === 'success' && (evidence.length === 0 || result.artifacts.length === 0 || !result.postcondition)) throw new Error('Remote Agent success requires local Evidence, an Artifact, and a postcondition.');
  for (const artifact of result.artifacts) {
    const grant = authorizedArtifacts.find((candidate) => candidate.uri === artifact.uri && candidate.hash.toLowerCase() === artifact.hash.toLowerCase() && candidate.sourceRunId === artifact.sourceRunId);
    if (!grant || artifact.sourceRunId !== parentRunId || !artifact.uri.startsWith('artifact://') || !/^[a-f0-9]{64}$/i.test(artifact.hash) || artifact.bytes !== grant.bytes) throw new Error('Remote Agent Artifact is not authorized by the parent Run grant.');
    if (artifactStore) {
      const bytes = await artifactStore.read(artifact.uri);
      if (createHash('sha256').update(bytes).digest('hex') !== artifact.hash.toLowerCase() || bytes.byteLength !== artifact.bytes) throw new Error('Remote Agent Artifact content does not match its grant.');
    } else throw new Error('Remote Agent ArtifactStore is required for Artifact results.');
  }
  if (result.postcondition) {
    const matching = result.artifacts.find((artifact) => artifact.uri === result.postcondition?.uri && artifact.hash.toLowerCase() === result.postcondition?.hash.toLowerCase() && artifact.bytes === result.postcondition?.bytes && artifact.sourceRunId === result.postcondition?.sourceRunId);
    if (!matching) throw new Error('Remote Agent postcondition is not backed by an authorized Artifact.');
  }
  const serialized = JSON.stringify(result.output ?? null) ?? '';
  if (serialized.length > 8_000 || SENSITIVE.test(serialized)) throw new Error('Remote Agent output must be bounded and free of credential-like content.');
  return { ...result, output: typeof result.output === 'string' ? result.output.slice(0, 4_000) : result.output, evidence };
}

function scopeWithin(requested: Record<string, unknown>, allowed: Record<string, unknown>): boolean { return Object.entries(requested).every(([key, value]) => allowed[key] === value); }
function isLocalCapability(capability: string): boolean { return /^(?:workspace|shell|keychain|tool)(?::|$)/i.test(capability); }
function validateRemoteNetwork(network: ActionRequest['network'], target: string, allowlist: readonly string[]): string | undefined {
  if (network.mode === 'none') return /^https?:\/\//i.test(target) ? 'Remote network targets require an explicit allowlist.' : undefined;
  if (!network.hosts?.length || !allowlist.length || network.hosts.some((host) => !allowlist.includes(host))) return 'Remote network endpoint is not allowlisted.';
  let hostname: string;
  try { hostname = new URL(target).hostname; } catch { return 'Remote allowlisted actions require a valid URL target.'; }
  return network.hosts.includes(hostname) ? undefined : 'Remote target host is outside the allowlist.';
}
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
const SENSITIVE = /api[-_ ]?key|authorization|cookie|password|secret|token|private[_ -]?key/i;
function sanitizeEvidence(item: Evidence): Evidence {
  if (!item || typeof item.type !== 'string' || typeof item.summary !== 'string' || item.type.length > 120 || item.summary.length > 1_000 || SENSITIVE.test(item.summary) || /\/(?:Users|private|tmp)\//.test(item.summary)) throw new Error('Remote Agent evidence is unbounded or contains sensitive content.');
  if (item.uri !== undefined && (item.uri.length > 500 || SENSITIVE.test(item.uri) || /\/(?:Users|private|tmp)\//.test(item.uri))) throw new Error('Remote Agent evidence URI is unauthorized.');
  if (item.hash !== undefined && !/^[a-f0-9]{64}$/i.test(item.hash)) throw new Error('Remote Agent evidence hash is malformed.');
  return { type: item.type, summary: item.summary.slice(0, 1_000), ...(item.uri ? { uri: item.uri } : {}), ...(item.hash ? { hash: item.hash } : {}) };
}
function safeError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).replace(/(?:api[-_ ]?key|authorization|cookie|password|secret|token)\s*[:=]\s*[^\s,;]+/gi, '[redacted]').slice(0, 500); }
