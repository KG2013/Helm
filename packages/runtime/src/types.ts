/** Provider-neutral and runtime domain types. */

export type ID = string;
export type RunState =
  | 'ready'
  | 'deciding'
  | 'validating'
  | 'executing'
  | 'reducing'
  | 'verifying'
  | 'paused'
  | 'recovering'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'needs_reconciliation';

export type RunAction =
  | 'start'
  | 'proposal_valid'
  | 'proposal_final'
  | 'policy_allow'
  | 'policy_deny'
  | 'observation'
  | 'goal_candidate'
  | 'continue'
  | 'verification_passed'
  | 'verification_failed'
  | 'verification_unknown'
  | 'reviewer_feedback'
  | 'needs_input'
  | 'budget_exceeded'
  | 'resume'
  | 'recovered'
  | 'execution_failed'
  | 'side_effect_unknown'
  | 'approval_deny'
  | 'fail'
  | 'cancel';

export type TerminalRunState = Extract<RunState, 'completed' | 'failed' | 'cancelled' | 'needs_reconciliation'>;

export interface Budget {
  maxSteps: number;
  maxDurationMs: number;
  maxTokens?: number;
  maxCostUsd?: number;
  maxLatencyMs?: number;
  maxRetries?: number;
  maxCacheMisses?: number;
  maxReviewerRounds: number;
}

export interface TaskInput {
  goal: string;
  workspaceId: ID;
  input?: unknown;
  budget?: Partial<Budget>;
  completionCriteria?: string[];
  /** Optional fixed evaluation metadata carried into the replayable Run/Episode. */
  evaluationCase?: string;
  evaluationSplit?: 'dev' | 'holdout';
  evaluationAttempt?: number;
}

export interface Task extends TaskInput {
  id: ID;
  createdAt: string;
  budget: Budget;
}

export interface Session {
  id: ID;
  taskId: ID;
  createdAt: string;
  status: 'active' | 'paused' | 'closed';
}

export interface Run {
  id: ID;
  taskId: ID;
  sessionId: ID;
  state: RunState;
  createdAt: string;
  updatedAt: string;
  steps: number;
  reviewerRounds: number;
  budget: Budget;
  lastError?: string;
  pauseReason?: string;
  verification?: Verification;
  finalOutput?: string;
  checkpoint?: Checkpoint;
  ownerId?: ID;
  leaseExpiresAt?: string;
  evaluationCase?: string;
  evaluationSplit?: 'dev' | 'holdout';
  evaluationAttempt?: number;
}

export interface Turn {
  id: ID;
  runId: ID;
  input: unknown;
  startedAt: string;
  endedAt?: string;
}

export interface Step {
  id: ID;
  runId: ID;
  index: number;
  startedAt: string;
  endedAt?: string;
  provider?: string;
  model?: string;
  proposal?: Proposal;
  observation?: Observation;
}

export interface Checkpoint {
  runId: ID;
  stepId?: ID;
  sequence: number;
  state: RunState;
  createdAt: string;
}

export type Proposal =
  | { kind: 'tool_call'; name: string; arguments: Record<string, unknown> }
  | { kind: 'final'; content: string }
  | { kind: 'wait_for_input'; reason: string };

export interface ToolCall {
  id: ID;
  runId: ID;
  stepId: ID;
  name: string;
  arguments: Record<string, unknown>;
}

export interface Observation {
  ok: boolean;
  output?: unknown;
  error?: string;
  receipt?: Record<string, unknown>;
}

export interface Verification {
  result: 'passed' | 'failed' | 'unknown';
  verifier: string;
  evidence: Evidence[];
  message?: string;
}

export type ReconciliationOutcome = 'known' | 'failed' | 'unknown';

export interface ReconciliationRecord {
  id: ID;
  runId: ID;
  toolCallId?: ID;
  actionId?: ID;
  outcome: ReconciliationOutcome;
  evidence: Evidence[];
  reason?: string;
  recordedAt: string;
}

export interface BudgetUsage {
  steps: number;
  durationMs: number;
  tokens: number;
  costUsd: number;
  latencyMs: number;
  retries: number;
  cacheMisses: number;
  reviewerRounds: number;
}

export interface Evidence {
  type: string;
  summary: string;
  uri?: string;
  hash?: string;
}

export interface ArtifactReference {
  uri: string;
  type: string;
  hash: string;
  bytes: number;
  sourceRunId: ID;
  path?: string;
  limitations?: string[];
}

export interface ArtifactStore {
  put(input: { runId: ID; type: string; content: string | Uint8Array; extension?: string; path?: string; limitations?: string[] }): Promise<ArtifactReference>;
  read(uri: string): Promise<Uint8Array>;
}

export interface ProviderCapabilities {
  streaming: boolean;
  toolCalls: boolean;
  structuredOutput: boolean;
  vision: boolean;
  reasoning: boolean;
  context?: boolean;
  toolResults?: boolean;
  cancellation?: boolean;
  timeout?: boolean;
  cost?: boolean;
}

export type ProviderMessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ProviderMessage {
  role: ProviderMessageRole;
  content: string;
  name?: string;
  toolCallId?: ID;
  toolCalls?: Array<{ id: ID; name: string; arguments: Record<string, unknown> }>;
}

export interface ContextItem {
  source: 'pinned' | 'recent' | 'cold';
  version: string;
  content: string;
  gap?: string;
}

export interface ProviderContext {
  version: string;
  items: ContextItem[];
  messages: ProviderMessage[];
  gaps: string[];
  bytes: number;
  truncated: boolean;
}

export interface ToolSchema {
  id: string;
  version: string;
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  scope: 'workspace';
}

export interface ToolResult {
  toolCallId: ID;
  name: string;
  ok: boolean;
  output?: unknown;
  error?: string;
  receipt?: Record<string, unknown>;
}

export type ProviderFailureCode =
  | 'timeout'
  | 'aborted'
  | 'auth'
  | 'rate_limit'
  | 'context_window'
  | 'invalid_request'
  | 'empty_response'
  | 'unavailable'
  | 'transport'
  | 'unknown';

export interface ProviderFailure {
  code: ProviderFailureCode;
  message: string;
  retryable: boolean;
  status?: number;
  retryAfterMs?: number;
  requestId?: ID;
}

export type ProviderChunk =
  | { kind: 'text_delta'; content: string }
  | { kind: 'tool_call_delta'; id: ID; name?: string; argumentsDelta?: string }
  | { kind: 'usage'; usage: TokenUsage }
  | { kind: 'done'; finishReason?: string }
  | { kind: 'error'; failure: ProviderFailure };

export interface ProviderRequest {
  runId: ID;
  stepId: ID;
  task: Task;
  session: Session;
  run: Run;
  context: Array<DomainEvent>;
  contextEnvelope?: ProviderContext;
  messages?: ProviderMessage[];
  tools?: ToolSchema[];
  toolResults?: ToolResult[];
  requestId?: ID;
  attemptId?: ID;
  traceId?: ID;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type ProviderResponse =
  | {
      kind: 'tool_call';
      name: string;
      arguments: Record<string, unknown>;
      provider?: string;
      model?: string;
      usage?: TokenUsage;
      requestId?: ID;
      attemptId?: ID;
      traceId?: ID;
    }
  | {
      kind: 'final';
      content: string;
      provider?: string;
      model?: string;
      usage?: TokenUsage;
      requestId?: ID;
      attemptId?: ID;
      traceId?: ID;
    }
  | {
      kind: 'wait_for_input';
      reason: string;
      provider?: string;
      model?: string;
      usage?: TokenUsage;
      requestId?: ID;
      attemptId?: ID;
      traceId?: ID;
    };

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  cachedInputTokens?: number;
  latencyMs?: number;
  retries?: number;
  cacheHit?: boolean;
  requestId?: ID;
}

export interface Provider {
  readonly id: string;
  readonly model: string;
  readonly capabilities: ProviderCapabilities;
  complete(request: ProviderRequest): Promise<ProviderResponse>;
  stream?(request: ProviderRequest): AsyncIterable<ProviderChunk>;
}

export type ToolPolicyDecision = 'allow' | 'deny' | 'ask';

export interface ToolPolicyInput {
  task: Task;
  session: Session;
  run: Run;
  call: ToolCall;
}

export interface ToolPolicyResult {
  decision: ToolPolicyDecision;
  reason: string;
}

export interface ToolPolicy {
  /** Stable policy identity/version used when binding approvals. */
  id?: string;
  version?: string;
  decide(input: ToolPolicyInput): Promise<ToolPolicyResult> | ToolPolicyResult;
}

export interface ApprovalBinding {
  approvalId: ID;
  nonce: ID;
  toolProfileId: string;
  toolProfileVersion: string;
  actionHash: string;
  workspaceId: ID;
  policyVersion: string;
  principal: ID;
  expiresAt: string;
}

export interface ToolProfile {
  id: string;
  version: string;
  allowedArguments?: readonly string[];
  readOnly: boolean;
  scope: 'workspace';
  network: 'none';
  maxOutputBytes: number;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface ToolRegistry {
  get(id: string): ToolProfile | undefined;
  list?(): ToolProfile[];
}

export interface ContextAssembler {
  assemble(input: { task: Task; session: Session; run: Run; events: DomainEvent[] }): {
    context: ProviderContext;
    toolResults: ToolResult[];
  };
}

export interface ToolExecutorResult {
  ok: boolean;
  output?: unknown;
  error?: string;
  receipt?: Record<string, unknown>;
}

export interface ToolExecutor {
  (call: ToolCall, request: ProviderRequest): Promise<ToolExecutorResult>;
}

export type ActionDecision = 'allow' | 'deny' | 'ask';
export type ActionEffect = 'known' | 'unknown' | 'none';

export interface ActionProfile {
  id: string;
  version: string;
  inputSchema?: Record<string, unknown>;
  capabilities: readonly string[];
  scope: Record<string, unknown>;
  network: { mode: 'none' | 'allowlist'; hosts?: readonly string[] };
}

export interface ActionRequest {
  actionId: ID;
  runId: ID;
  taskId: ID;
  sessionId: ID;
  parentAgentId?: ID;
  profile: Pick<ActionProfile, 'id' | 'version'>;
  target: string;
  scope: Record<string, unknown>;
  capabilities: string[];
  network: { mode: 'none' | 'allowlist'; hosts?: string[] };
  argsHash: string;
  /** Bounded, non-secret description; raw arguments never enter the ledger. */
  argsSummary?: string;
  idempotencyKey: string;
  dryRun: boolean;
  deadline: string;
}

export interface ActionReceipt {
  actionId: ID;
  runId: ID;
  ok: boolean;
  effect: ActionEffect;
  target: string;
  idempotencyKey: string;
  replayed: boolean;
  evidence: Evidence[];
  diagnostics?: string;
}

export interface ActionAdapterResult {
  ok: boolean;
  output?: unknown;
  error?: string;
  receipt?: Record<string, unknown>;
  evidence?: Evidence[];
}

export interface ActionAdapter {
  readonly id: string;
  execute(request: ActionRequest): Promise<ActionAdapterResult>;
}

export interface ActionPolicyResult {
  decision: ActionDecision;
  reason: string;
}

export interface ActionGatewayOptions {
  store: EventStore;
  policy?: (request: ActionRequest) => Promise<ActionPolicyResult> | ActionPolicyResult;
  clock?: RuntimeClock;
  ids?: RuntimeIdFactory;
}

export type ActionExecutionStatus = 'approval_required' | 'denied' | 'executed' | 'failed' | 'unknown';

export interface ActionExecutionResult {
  status: ActionExecutionStatus;
  actionId: ID;
  approvalId?: ID;
  ok: boolean;
  output?: unknown;
  error?: string;
  receipt?: Record<string, unknown>;
  evidence?: Evidence[];
  replayed?: boolean;
}

export type AgentRunState = 'created' | 'running' | 'paused' | 'completed' | 'failed' | 'unknown' | 'cancelled';

export interface AgentIdentity {
  agentId: ID;
  role: string;
  capabilities: string[];
  principal: ID;
}

export interface AgentRunRecord {
  agentRunId: ID;
  rootRunId: ID;
  parentRunId: ID;
  parentAgentId?: ID;
  taskId: ID;
  identity: AgentIdentity;
  goal: string;
  scope: Record<string, unknown>;
  budget: Partial<Budget>;
  state: AgentRunState;
  createdAt: string;
  updatedAt: string;
}

export interface AgentResult {
  agentRunId: ID;
  status: 'success' | 'failure' | 'unknown';
  output?: unknown;
  evidence: Evidence[];
  artifacts: ArtifactReference[];
  conflict?: string;
}

export interface VerifierInput {
  task: Task;
  run: Run;
  output: string;
  context: Array<DomainEvent>;
}

export interface Verifier {
  readonly id: string;
  verify(input: VerifierInput): Promise<Verification>;
}

export type EventType =
  | 'task.created'
  | 'session.created'
  | 'run.created'
  | 'run.started'
  | 'run.state_changed'
  | 'run.paused'
  | 'run.resumed'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled'
  | 'run.needs_reconciliation'
  | 'run.reconciled'
  | 'step.started'
  | 'step.proposal'
  | 'policy.decision'
  | 'approval.requested'
  | 'approval.decided'
  | 'action.requested'
  | 'action.approval_required'
  | 'action.approved'
  | 'action.denied'
  | 'action.receipt'
  | 'agent.created'
  | 'agent.state_changed'
  | 'agent.result'
  | 'tool.call'
  | 'tool.receipt'
  | 'step.observation'
  | 'step.completed'
  | 'verification.result'
  | 'run.checkpoint'
  | 'usage.recorded'
  | 'run.owner_acquired'
  | 'run.owner_released'
  | 'experience.candidate_created'
  | 'experience.candidate_reviewed';

export interface UsageRecord {
  kind?: 'provider' | 'tool' | 'worker';
  requestId?: ID;
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  latencyMs?: number;
  retries?: number;
  cacheHit?: boolean;
  failureCode?: ProviderFailureCode;
  operation?: string;
}

export interface Episode {
  runId: ID;
  taskId?: ID;
  sessionId?: ID;
  events: DomainEvent[];
  usage: UsageRecord[];
  redactedJsonl: string;
  trace: {
    taskId?: ID;
    sessionId?: ID;
    providerIds: string[];
    toolProfiles: string[];
    toolProfileVersions: string[];
    policyVersions: string[];
    stepIds: ID[];
    approvalIds: ID[];
    artifactUris: string[];
    verifierIds: string[];
    requestIds: ID[];
    traceIds: ID[];
  };
  evaluationCase?: string;
  evaluationSplit?: 'dev' | 'holdout';
  evaluationAttempt?: number;
}

export interface ReleaseGateResult {
  result: 'passed' | 'blocked';
  reasons: string[];
  runIds: ID[];
}

export interface DomainEvent<TPayload = Record<string, unknown>> {
  id: ID;
  sequence: number;
  type: EventType;
  taskId?: ID;
  sessionId?: ID;
  runId?: ID;
  timestamp: string;
  payload: TPayload;
}

export interface NewDomainEvent<TPayload = Record<string, unknown>> {
  type: EventType;
  taskId?: ID;
  sessionId?: ID;
  runId?: ID;
  timestamp?: string;
  payload: TPayload;
}

export interface RuntimeClock {
  now(): Date;
}

export interface RuntimeIdFactory {
  next(prefix: string): ID;
}

export interface EventStore {
  append(event: NewDomainEvent): Promise<DomainEvent>;
  appendMany(events: NewDomainEvent[]): Promise<DomainEvent[]>;
  list(runId: ID): Promise<DomainEvent[]>;
  listAll(): Promise<DomainEvent[]>;
  replayRun(runId: ID): Promise<Run>;
  replayRunAsync?(runId: ID): Promise<Run>;
  getRun(runId: ID): Promise<Run | undefined>;
  /** Atomically claim or renew a Run lease when the backing store supports it. */
  tryAcquireRunLease?(input: { runId: ID; ownerId: ID; leaseExpiresAt: string; now: string }): Promise<DomainEvent | boolean>;
  exportJsonl?(runId?: ID): Promise<string>;
  close?(): Promise<void> | void;
}

export interface RuntimeOptions {
  store: EventStore;
  provider: Provider;
  executor?: ToolExecutor;
  policy?: ToolPolicy;
  toolRegistry?: ToolRegistry;
  verifier?: Verifier;
  contextAssembler?: ContextAssembler;
  clock?: RuntimeClock;
  ids?: RuntimeIdFactory;
  defaultBudget?: Partial<Budget>;
  ownerId?: ID;
  /** Stable local principal used for approval binding across owner reconnects. */
  principalId?: ID;
  leaseDurationMs?: number;
  approvalTtlMs?: number;
  artifactStore?: ArtifactStore;
  actionGateway?: import('./action-gateway.js').ActionGateway;
}

export type RuntimeEventListener = (event: DomainEvent) => void;

export interface RunResult extends Run {
  verification?: Verification;
}
