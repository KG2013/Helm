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
  maxReviewerRounds: number;
}

export interface TaskInput {
  goal: string;
  workspaceId: ID;
  input?: unknown;
  budget?: Partial<Budget>;
  completionCriteria?: string[];
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

export interface Evidence {
  type: string;
  summary: string;
  uri?: string;
  hash?: string;
}

export interface ProviderCapabilities {
  streaming: boolean;
  toolCalls: boolean;
  structuredOutput: boolean;
  vision: boolean;
  reasoning: boolean;
}

export interface ProviderRequest {
  runId: ID;
  stepId: ID;
  task: Task;
  session: Session;
  run: Run;
  context: Array<DomainEvent>;
}

export type ProviderResponse =
  | {
      kind: 'tool_call';
      name: string;
      arguments: Record<string, unknown>;
      provider?: string;
      model?: string;
      usage?: TokenUsage;
    }
  | {
      kind: 'final';
      content: string;
      provider?: string;
      model?: string;
      usage?: TokenUsage;
    }
  | {
      kind: 'wait_for_input';
      reason: string;
      provider?: string;
      model?: string;
      usage?: TokenUsage;
    };

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

export interface Provider {
  readonly id: string;
  readonly model: string;
  readonly capabilities: ProviderCapabilities;
  complete(request: ProviderRequest): Promise<ProviderResponse>;
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
  decide(input: ToolPolicyInput): Promise<ToolPolicyResult> | ToolPolicyResult;
}

export interface ToolProfile {
  id: string;
  version: string;
  allowedArguments?: readonly string[];
  readOnly: boolean;
  scope: 'workspace';
  network: 'none';
  maxOutputBytes: number;
}

export interface ToolRegistry {
  get(id: string): ToolProfile | undefined;
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
  | 'step.started'
  | 'step.proposal'
  | 'policy.decision'
  | 'approval.requested'
  | 'approval.decided'
  | 'tool.call'
  | 'tool.receipt'
  | 'step.observation'
  | 'step.completed'
  | 'verification.result'
  | 'run.checkpoint';

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
  replayRun(runId: ID): Run;
  getRun(runId: ID): Promise<Run | undefined>;
}

export interface RuntimeOptions {
  store: EventStore;
  provider: Provider;
  executor?: ToolExecutor;
  policy?: ToolPolicy;
  toolRegistry?: ToolRegistry;
  verifier?: Verifier;
  clock?: RuntimeClock;
  ids?: RuntimeIdFactory;
  defaultBudget?: Partial<Budget>;
}

export type RuntimeEventListener = (event: DomainEvent) => void;

export interface RunResult extends Run {
  verification?: Verification;
}
