import { createHash } from 'node:crypto';
import { ActionGateway } from './action-gateway.js';
import type { AgentIdentity, AgentResult, AgentRunRecord, AgentRunState, ActionRequest, ArtifactReference, Budget, EventStore, Evidence, ID, RuntimeClock, RuntimeIdFactory } from './types.js';

const clock: RuntimeClock = { now: () => new Date() };
const ids: RuntimeIdFactory = { next: (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` };

export interface AgentCoordinatorOptions {
  store: EventStore;
  gateway: ActionGateway;
  clock?: RuntimeClock;
  ids?: RuntimeIdFactory;
  maxDepth?: number;
}

export interface CreateChildAgentInput {
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
}

/** Durable identity and lineage boundary for bounded child AgentRuns. */
export class AgentRunCoordinator {
  private readonly store: EventStore;
  private readonly gateway: ActionGateway;
  private readonly clock: RuntimeClock;
  private readonly ids: RuntimeIdFactory;
  private readonly maxDepth: number;

  constructor(options: AgentCoordinatorOptions) {
    this.store = options.store;
    this.gateway = options.gateway;
    this.clock = options.clock ?? clock;
    this.ids = options.ids ?? ids;
    this.maxDepth = options.maxDepth ?? 3;
  }

  async createChild(input: CreateChildAgentInput): Promise<AgentRunRecord> {
    const parent = await this.store.getRun(input.parentRunId);
    if (!parent) throw new Error(`Unknown parent Run: ${input.parentRunId}`);
    if (!input.goal.trim() || input.goal.length > 4_000) throw new Error('Child Agent goal is empty or too large.');
    if (input.capabilities.some((capability) => !input.allowedCapabilities.includes(capability))) throw new Error('Child Agent requested a capability outside the granted set.');
    if (!scopeWithin(input.scope, input.allowedScope)) throw new Error('Child Agent requested scope outside the granted set.');
    const depth = await this.depth(input.parentAgentId);
    if (depth >= this.maxDepth) throw new Error(`Agent depth limit ${this.maxDepth} exceeded.`);
    const now = this.clock.now().toISOString();
    const agentRunId = this.ids.next('agent-run');
    const identity: AgentIdentity = {
      agentId: this.ids.next('agent'),
      role: input.role.slice(0, 120),
      capabilities: [...input.capabilities],
      principal: input.principal,
    };
    const record: AgentRunRecord = {
      agentRunId,
      rootRunId: input.parentAgentId ? (await this.requireAgent(input.parentAgentId)).rootRunId : input.parentRunId,
      parentRunId: input.parentRunId,
      parentAgentId: input.parentAgentId,
      taskId: parent.taskId,
      identity,
      goal: input.goal.trim(),
      scope: input.scope,
      budget: input.budget ?? {},
      state: 'created',
      createdAt: now,
      updatedAt: now,
    };
    const request: ActionRequest = {
      actionId: this.ids.next('action-agent-create'),
      runId: input.parentRunId,
      taskId: parent.taskId,
      sessionId: parent.sessionId,
      parentAgentId: input.parentAgentId,
      profile: { id: 'agent.create', version: 'v1' },
      target: `agent:${identity.agentId}`,
      scope: input.scope,
      capabilities: ['agent.create', ...input.capabilities],
      network: { mode: 'none' },
      argsHash: hash({ role: record.identity.role, goal: record.goal, capabilities: record.identity.capabilities, scope: record.scope }),
      argsSummary: `role:${record.identity.role};capabilities:${record.identity.capabilities.join(',')}`,
      idempotencyKey: agentRunId,
      dryRun: false,
      deadline: new Date(this.clock.now().getTime() + 60_000).toISOString(),
    };
    const action = await this.gateway.executeApproved({
      request,
      adapter: {
        id: 'agent-run-coordinator',
        execute: async () => ({ ok: true, receipt: { sideEffect: 'none' }, evidence: [{ type: 'agent.identity', summary: `Created ${identity.agentId} with bounded capabilities.` }] }),
      },
      markRunNeedsReconciliation: false,
    });
    if (!action.ok) throw new Error(action.error ?? 'Child Agent creation was denied.');
    await this.store.append({ type: 'agent.created', taskId: record.taskId, sessionId: parent.sessionId, runId: input.parentRunId, payload: record as unknown as Record<string, unknown> });
    return record;
  }

  async setState(agentRunId: ID, state: AgentRunState, reason?: string): Promise<AgentRunRecord> {
    const record = await this.requireAgent(agentRunId);
    const next = { ...record, state, updatedAt: this.clock.now().toISOString() };
    await this.store.append({ type: 'agent.state_changed', taskId: record.taskId, sessionId: undefined, runId: record.parentRunId, payload: { ...next, reason } });
    return next;
  }

  async recordResult(result: AgentResult): Promise<AgentResult> {
    const record = await this.requireAgent(result.agentRunId);
    if (result.status === 'success' && result.evidence.length === 0 && result.artifacts.length === 0) throw new Error('Successful child Agent results require evidence or an Artifact.');
    const safe = { ...result, output: result.output === undefined ? undefined : boundedOutput(result.output) };
    await this.store.append({ type: 'agent.result', taskId: record.taskId, runId: record.parentRunId, payload: safe as unknown as Record<string, unknown> });
    await this.setState(result.agentRunId, result.status === 'success' ? 'completed' : result.status === 'failure' ? 'failed' : 'unknown');
    return safe;
  }

  async get(agentRunId: ID): Promise<AgentRunRecord | undefined> {
    const events = await this.store.listAll();
    const event = [...events].reverse().find((candidate) => candidate.type === 'agent.created' && candidate.payload.agentRunId === agentRunId);
    if (!event) return undefined;
    const record = event.payload as unknown as AgentRunRecord;
    const state = [...events].reverse().find((candidate) => candidate.type === 'agent.state_changed' && candidate.payload.agentRunId === agentRunId);
    return state ? { ...record, ...(state.payload as Partial<AgentRunRecord>) } : record;
  }

  async list(parentRunId?: ID): Promise<AgentRunRecord[]> {
    const events = await this.store.listAll();
    const records = new Map<ID, AgentRunRecord>();
    for (const event of events) {
      if (event.type === 'agent.created') records.set(String(event.payload.agentRunId), event.payload as unknown as AgentRunRecord);
      if (event.type === 'agent.state_changed' && typeof event.payload.agentRunId === 'string' && records.has(event.payload.agentRunId)) records.set(event.payload.agentRunId, { ...records.get(event.payload.agentRunId)!, ...(event.payload as Partial<AgentRunRecord>) });
    }
    return [...records.values()].filter((record) => !parentRunId || record.parentRunId === parentRunId);
  }

  private async requireAgent(agentRunId: ID): Promise<AgentRunRecord> {
    const record = await this.get(agentRunId);
    if (!record) throw new Error(`Unknown AgentRun: ${agentRunId}`);
    return record;
  }

  private async depth(parentAgentId?: ID): Promise<number> {
    let depth = 0;
    let current = parentAgentId;
    while (current) {
      depth += 1;
      const record = await this.requireAgent(current);
      current = record.parentAgentId;
      if (depth > this.maxDepth) break;
    }
    return depth;
  }
}

function scopeWithin(requested: Record<string, unknown>, allowed: Record<string, unknown>): boolean {
  return Object.entries(requested).every(([key, value]) => {
    const grant = allowed[key];
    if (Array.isArray(value)) return Array.isArray(grant) && value.every((item) => grant.includes(item));
    if (value && typeof value === 'object') return Boolean(grant && typeof grant === 'object' && scopeWithin(value as Record<string, unknown>, grant as Record<string, unknown>));
    return grant === value;
  });
}

function boundedOutput(value: unknown): unknown {
  if (typeof value === 'string') return value.slice(0, 4_000);
  if (!value || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value).slice(0, 8_000));
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
