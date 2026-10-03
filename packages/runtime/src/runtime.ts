import { createHash } from 'node:crypto';
import { transitionRunState, isTerminalRunState, RunStateError } from './state-machine.js';
import { TextOutputVerifier } from './verifier.js';
import { buildProviderContext, normalizeProviderContextProjection, toolProfileToSchema } from './context.js';
import { createExperienceCandidate as createCandidate, reviewExperienceCandidate as reviewCandidate, type ExperienceCandidate } from './experience.js';
import type {
  Budget,
  ApprovalBinding,
  DomainEvent,
  EventStore,
  ID,
  NewDomainEvent,
  Observation,
  Provider,
  ProviderRequest,
  Proposal,
  Run,
  RunResult,
  RuntimeClock,
  RuntimeIdFactory,
  RuntimeOptions,
  RuntimeEventListener,
  Session,
  Task,
  TaskInput,
  ToolCall,
  ToolExecutor,
  ToolPolicy,
  ToolRegistry,
  ContextAssembler,
  ArtifactStore,
  ToolExecutorResult,
  Verification,
  Verifier,
} from './types.js';

const DEFAULT_BUDGET: Budget = {
  maxSteps: 30,
  maxDurationMs: 15 * 60 * 1000,
  maxReviewerRounds: 1,
};
const DEFAULT_APPROVAL_TTL_MS = 15 * 60 * 1000;

class SystemClock implements RuntimeClock {
  now(): Date {
    return new Date();
  }
}

class DefaultIdFactory implements RuntimeIdFactory {
  private counter = 0;
  next(prefix: string): ID {
    this.counter += 1;
    return `${prefix}-${Date.now().toString(36)}-${this.counter.toString(36)}`;
  }
}

const defaultPolicy: ToolPolicy = {
  id: 'default-deny',
  version: 'v1',
  decide: () => ({ decision: 'deny', reason: 'No ToolPolicy is configured; tool execution is denied.' }),
};

const defaultExecutor: ToolExecutor = async () => ({
  ok: false,
  error: 'No ToolExecutor is configured; tool execution is fail-closed.',
  receipt: { executor: 'default', sideEffect: 'none' },
});

const emptyToolRegistry: ToolRegistry = { get: () => undefined };

function sanitizeDiagnostic(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return message
    .replace(/(?:api[-_ ]?key|authorization|cookie|secret|password|token)\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi, '[redacted]')
    .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .slice(0, 500);
}

type PendingApproval = {
  approvalId: ID;
  task: Task;
  session: Session;
  request: ProviderRequest;
  call: ToolCall;
  index: number;
  reason: string;
  binding: ApprovalBinding;
};

export class RuntimeFacade {
  private readonly store: EventStore;
  private readonly provider: Provider;
  private readonly executor: ToolExecutor;
  private readonly policy: ToolPolicy;
  private readonly toolRegistry: ToolRegistry;
  private readonly verifier: Verifier;
  private readonly contextAssembler: ContextAssembler;
  private readonly clock: RuntimeClock;
  private readonly ids: RuntimeIdFactory;
  private readonly defaultBudget: Budget;
  private readonly ownerId: ID;
  private readonly principalId: ID;
  private readonly leaseDurationMs: number;
  private readonly approvalTtlMs: number;
  private readonly artifactStore?: ArtifactStore;
  private readonly eventListeners = new Set<RuntimeEventListener>();
  private readonly tasks = new Map<ID, Task>();
  private readonly sessions = new Map<ID, Session>();
  private readonly pendingApprovals = new Map<ID, PendingApproval>();
  private readonly runControllers = new Map<ID, AbortController>();

  constructor(options: RuntimeOptions) {
    this.store = options.store;
    this.provider = options.provider;
    this.executor = options.executor ?? defaultExecutor;
    this.policy = options.policy ?? defaultPolicy;
    this.toolRegistry = options.toolRegistry ?? emptyToolRegistry;
    this.verifier = options.verifier ?? new TextOutputVerifier();
    this.contextAssembler = options.contextAssembler ?? { assemble: ({ task, events }) => buildProviderContext(task, events) };
    this.clock = options.clock ?? new SystemClock();
    this.ids = options.ids ?? new DefaultIdFactory();
    this.defaultBudget = { ...DEFAULT_BUDGET, ...options.defaultBudget };
    this.ownerId = options.ownerId ?? 'runtime-local';
    this.principalId = options.principalId ?? 'local-user';
    this.leaseDurationMs = options.leaseDurationMs ?? 5 * 60 * 1000;
    this.approvalTtlMs = options.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS;
    this.artifactStore = options.artifactStore;
  }

  async createTask(input: TaskInput): Promise<Task> {
    const task: Task = {
      ...input,
      id: this.ids.next('task'),
      createdAt: this.timestamp(),
      budget: { ...this.defaultBudget, ...input.budget },
    };
    this.tasks.set(task.id, task);
    await this.append({ type: 'task.created', taskId: task.id, payload: task as unknown as Record<string, unknown> });
    return task;
  }

  async createSession(input: { taskId: ID }): Promise<Session> {
    const task = await this.requireTask(input.taskId);
    const session: Session = {
      id: this.ids.next('session'),
      taskId: input.taskId,
      createdAt: this.timestamp(),
      status: 'active',
    };
    this.sessions.set(session.id, session);
    await this.append({ type: 'session.created', taskId: task.id, sessionId: session.id, payload: session as unknown as Record<string, unknown> });
    return session;
  }

  async startRun(input: { taskId: ID; sessionId: ID; budget?: Partial<Budget> }): Promise<Run> {
    const task = await this.requireTask(input.taskId);
    const session = await this.requireSession(input.sessionId);
    if (session.taskId !== input.taskId) throw new Error(`Unknown session: ${input.sessionId}`);
    const existing = await this.findActiveRun(input.sessionId);
    if (existing) throw new Error(`Session ${input.sessionId} already has active run ${existing.id}`);

    const now = this.timestamp();
    const run: Run = {
      id: this.ids.next('run'),
      taskId: input.taskId,
      sessionId: input.sessionId,
      state: 'ready',
      createdAt: now,
      updatedAt: now,
      steps: 0,
      reviewerRounds: 0,
      budget: { ...task.budget, ...input.budget },
      evaluationCase: task.evaluationCase,
      evaluationSplit: task.evaluationSplit,
      evaluationAttempt: task.evaluationAttempt,
    };
    await this.append({ type: 'run.created', taskId: task.id, sessionId: session.id, runId: run.id, payload: run as unknown as Record<string, unknown> });
    await this.transition(run.id, 'start');
    await this.acquireOwnership(run.id);
    return (await this.requireRun(run.id));
  }

  async run(runId: ID): Promise<RunResult> {
    let run = await this.recoverRun(runId);
    if (isTerminalRunState(run.state) || run.state === 'paused') return run;
    run = await this.ensureOwnership(runId, run);
    const task = await this.requireTask(run.taskId);
    const session = await this.requireSession(run.sessionId);
    // Use the durable Run creation time so a restart or pause cannot reset
    // the wall-clock budget by starting a fresh run() invocation.
    const createdAt = Date.parse(run.createdAt);
    const startedAt = Number.isFinite(createdAt) ? createdAt : this.clock.now().getTime();
    const controller = this.runControllers.get(run.id) ?? new AbortController();
    this.runControllers.set(run.id, controller);

    while (!isTerminalRunState(run.state) && run.state !== 'paused') {
      run = await this.ensureOwnership(run.id, run);
      if (run.steps >= run.budget.maxSteps || this.clock.now().getTime() - startedAt >= run.budget.maxDurationMs) {
        if (run.state === 'deciding') await this.transition(run.id, 'budget_exceeded', { reason: 'run budget exceeded' });
        else await this.failRun(run.id, 'Run budget exceeded outside a pausable state.');
        run = await this.requireRun(run.id);
        break;
      }

      const stepId = this.ids.next('step');
      const index = run.steps + 1;
      await this.append({ type: 'step.started', taskId: task.id, sessionId: session.id, runId: run.id, payload: { stepId, index } });
      const context = await this.store.list(run.id);
      let projected: ReturnType<ContextAssembler['assemble']>;
      try {
        projected = normalizeProviderContextProjection(this.contextAssembler.assemble({ task, session, run, events: context }));
      } catch (error) {
        await this.failRun(run.id, `Provider context rejected: ${sanitizeDiagnostic(error)}`);
        run = await this.requireRun(run.id);
        break;
      }
      const remainingMs = Math.max(1, run.budget.maxDurationMs - (this.clock.now().getTime() - startedAt));
      const request: ProviderRequest = {
        runId: run.id,
        stepId,
        task,
        session,
        run,
        context,
        contextEnvelope: projected.context,
        messages: projected.context.messages,
        tools: this.toolRegistry.list?.().map(toolProfileToSchema),
        toolResults: projected.toolResults,
        requestId: this.ids.next('request'),
        attemptId: this.ids.next('attempt'),
        traceId: run.id,
        signal: controller.signal,
        timeoutMs: remainingMs,
      };
      let response;
      const providerStartedAt = this.clock.now().getTime();
      try {
        response = await this.provider.complete(request);
      } catch (error) {
        run = await this.ensureOwnership(run.id, await this.requireRun(run.id));
        if (isTerminalRunState(run.state) || run.state === 'paused') break;
        await this.recordProviderFailure(run, request, error, Math.max(0, this.clock.now().getTime() - providerStartedAt));
        await this.failRun(run.id, `Provider error: ${sanitizeDiagnostic(error)}`);
        run = await this.requireRun(run.id);
        break;
      }
      // A provider may be in flight long enough for its lease to expire. Do
      // not apply a late proposal from a stale owner after another Runtime
      // has claimed the Run.
      run = await this.ensureOwnership(run.id, await this.requireRun(run.id));
      if (isTerminalRunState(run.state) || run.state === 'paused') break;
      await this.recordUsage(run, response, context);
      if (this.usageBudgetExceeded(run, context, response.usage)) {
        await this.transition(run.id, 'budget_exceeded', { reason: 'token or cost budget exceeded', usage: response.usage });
        run = await this.requireRun(run.id);
        break;
      }
      const proposal: Proposal = response.kind === 'tool_call'
        ? { kind: 'tool_call', name: response.name, arguments: response.arguments }
        : response.kind === 'wait_for_input'
          ? { kind: 'wait_for_input', reason: response.reason }
          : { kind: 'final', content: response.content };
      await this.append({
        type: 'step.proposal',
        taskId: task.id,
        sessionId: session.id,
        runId: run.id,
        payload: {
          stepId,
          index,
          proposal,
          provider: response.provider ?? this.provider.id,
          model: response.model ?? this.provider.model,
          usage: response.usage,
          requestId: response.requestId ?? request.requestId,
          attemptId: response.attemptId ?? request.attemptId,
          traceId: response.traceId ?? request.traceId,
        },
      });

      if (response.kind === 'wait_for_input') {
        if (run.state === 'deciding') await this.transition(run.id, 'needs_input', { reason: response.reason });
        run = await this.requireRun(run.id);
        break;
      }

      if (response.kind === 'tool_call') {
        await this.transition(run.id, 'proposal_valid', { stepId });
        const call: ToolCall = { id: this.ids.next('tool'), runId: run.id, stepId, name: response.name, arguments: response.arguments };
        const policy = await this.policy.decide({ task, session, run: await this.requireRun(run.id), call });
        const profile = this.toolRegistry.get(response.name);
        if (!profile) {
          const reason = `Tool ${response.name} is not registered.`;
          await this.append({ type: 'policy.decision', taskId: task.id, sessionId: session.id, runId: run.id, payload: { stepId, decision: 'deny', reason, policyDecision: policy.decision } });
          await this.transition(run.id, 'policy_deny', { stepId, error: reason });
          run = await this.requireRun(run.id);
          break;
        }
        await this.append({ type: 'policy.decision', taskId: task.id, sessionId: session.id, runId: run.id, payload: { stepId, decision: policy.decision, reason: policy.reason, toolProfile: profile } });
        if (policy.decision === 'deny') {
          await this.transition(run.id, 'policy_deny', { stepId, error: policy.reason });
          run = await this.requireRun(run.id);
          break;
        }
        if (policy.decision === 'ask') {
          const binding = this.createApprovalBinding(call.id, profile, call, task.workspaceId);
          const pending: PendingApproval = {
            approvalId: call.id,
            task,
            session,
            request,
            call,
            index,
            reason: policy.reason,
            binding,
          };
          this.pendingApprovals.set(call.id, pending);
          await this.append({
            type: 'approval.requested',
            taskId: task.id,
            sessionId: session.id,
            runId: run.id,
            payload: {
              approvalId: call.id,
              reason: policy.reason,
              workspaceId: task.workspaceId,
              call,
              binding,
            },
          });
          await this.transition(run.id, 'needs_input', { stepId, reason: policy.reason });
          run = await this.requireRun(run.id);
          break;
        }
        run = await this.requireRun(run.id);
        if (isTerminalRunState(run.state) || run.state === 'paused') break;
        const binding = this.createApprovalBinding(call.id, profile, call, task.workspaceId);
        run = await this.executeToolCall({ approvalId: call.id, task, session, request, call, index, reason: '', binding }, run.id);
        if (isTerminalRunState(run.state) || run.state === 'paused') break;
        continue;
      }

      await this.transition(run.id, 'proposal_final', { stepId });
      await this.transition(run.id, 'goal_candidate', { stepId });
      const verification = await this.verifier.verify({ task, run: await this.requireRun(run.id), output: response.content, context: await this.store.list(run.id) });
      await this.append({ type: 'verification.result', taskId: task.id, sessionId: session.id, runId: run.id, payload: { stepId, verification } });
      await this.append({ type: 'step.completed', taskId: task.id, sessionId: session.id, runId: run.id, payload: { stepId, index } });
      if (verification.result === 'passed') await this.transition(run.id, 'verification_passed', { output: response.content, verification });
      else if (verification.result === 'unknown') await this.transition(run.id, 'verification_unknown', { reason: verification.message ?? 'Verification is inconclusive', verification });
      else await this.transition(run.id, 'verification_failed', { reason: verification.message ?? 'Verification failed', verification });
      await this.appendCheckpoint(run.id, stepId);
      run = await this.requireRun(run.id);
    }
    return run;
  }

  async pauseRun(runId: ID, reason: string): Promise<Run> {
    const run = await this.requireRun(runId);
    await this.assertOwner(run);
    if (run.state === 'paused') return run;
    await this.transition(runId, 'needs_input', { reason });
    return this.requireRun(runId);
  }

  async resumeRun(runId: ID, options: { bypassApproval?: boolean } = {}): Promise<Run> {
    const run = await this.requireRun(runId);
    await this.assertOwner(run);
    if (run.state !== 'paused') throw new RunStateError(run.state, 'resume');
    if (!options.bypassApproval && await this.hasPendingApproval(runId)) {
      throw new Error('Run has a pending approval; resolve it explicitly before resuming.');
    }
    await this.transition(runId, 'resume');
    await this.append({ type: 'run.resumed', taskId: run.taskId, sessionId: run.sessionId, runId, payload: { state: 'recovering' } });
    await this.transition(runId, 'recovered');
    return this.requireRun(runId);
  }

  async cancelRun(runId: ID, reason = 'cancelled by user'): Promise<Run> {
    const run = await this.requireRun(runId);
    await this.assertOwner(run);
    if (isTerminalRunState(run.state)) return run;
    this.runControllers.get(runId)?.abort();
    for (const [approvalId, pending] of this.pendingApprovals) {
      if (pending.call.runId === runId) this.pendingApprovals.delete(approvalId);
    }
    await this.transition(runId, 'cancel', { reason });
    return this.requireRun(runId);
  }

  async resolveApproval(runId: ID, approvalId: ID, decision: 'approve' | 'deny', workspaceId?: ID): Promise<Run> {
    const run = await this.requireRun(runId);
    await this.assertOwner(run);
    let pending = this.pendingApprovals.get(approvalId);
    if (!pending) pending = await this.hydratePendingApproval(runId, approvalId);
    if (!pending) {
      const prior = (await this.store.list(runId)).reverse().find((event) => event.type === 'approval.decided' && event.payload.approvalId === approvalId);
      if (prior && prior.payload.decision === decision) return run;
      throw new Error(`Unknown or stale approval: ${approvalId}`);
    }
    if (pending.call.runId !== runId) throw new Error('Approval does not belong to this Run.');
    if (workspaceId !== undefined && pending.task.workspaceId !== workspaceId) throw new Error('Approval workspace mismatch.');
    this.assertApprovalBinding(pending);
    if (run.state !== 'paused') throw new RunStateError(run.state, 'resume');

    await this.append({
      type: 'approval.decided',
      taskId: pending.task.id,
      sessionId: pending.session.id,
      runId,
      payload: { approvalId, decision, call: pending.call, binding: pending.binding },
    });
    this.pendingApprovals.delete(approvalId);
    if (decision === 'deny') {
      await this.transition(runId, 'approval_deny', { approvalId, error: 'Tool execution denied by user.' });
      return this.requireRun(runId);
    }

    await this.resumeRun(runId, { bypassApproval: true });
    await this.transition(runId, 'proposal_valid', { stepId: pending.call.stepId, approvalId });
    const afterExecution = await this.executeToolCall(pending, runId);
    if (isTerminalRunState(afterExecution.state) || afterExecution.state === 'paused') return afterExecution;
    return this.run(runId);
  }

  /** Pause owned active Runs before the host process disconnects. */
  async shutdown(reason = 'Runtime owner shutting down'): Promise<void> {
    for (const event of await this.store.listAll()) {
      if (event.type !== 'run.created' || !event.runId) continue;
      const run = await this.store.getRun(event.runId);
      if (!run || isTerminalRunState(run.state)) continue;
      try {
        if (run.state !== 'paused') await this.pauseRun(run.id, reason);
        await this.append({ type: 'run.owner_released', taskId: run.taskId, sessionId: run.sessionId, runId: run.id, payload: { ownerId: this.ownerId, reason, state: 'paused' } });
      } catch {
        // A stale owner cannot pause a Run it no longer controls.
      }
    }
  }

  private async hydratePendingApproval(runId: ID, approvalId: ID): Promise<PendingApproval | undefined> {
    const events = await this.store.list(runId);
    const requested = [...events].reverse().find((event) => event.type === 'approval.requested' && event.payload.approvalId === approvalId);
    if (!requested) return undefined;
    const decided = events.find((event) => event.type === 'approval.decided' && event.payload.approvalId === approvalId);
    if (decided) return undefined;
    const run = await this.requireRun(runId);
    const task = await this.requireTask(run.taskId);
    const session = await this.requireSession(run.sessionId);
    const call = requested.payload.call as ToolCall | undefined;
    if (!call || call.runId !== runId) return undefined;
    const step = events.find((event) => event.type === 'step.started' && event.payload.stepId === call.stepId);
    const index = typeof step?.payload.index === 'number' ? step.payload.index : run.steps;
    const pending: PendingApproval = {
      approvalId,
      task,
      session,
      request: {
        runId,
        stepId: call.stepId,
        task,
        session,
        run,
        context: events,
      },
      call,
      index,
      reason: typeof requested.payload.reason === 'string' ? requested.payload.reason : 'approval required',
      binding: requested.payload.binding as ApprovalBinding,
    };
    if (!isApprovalBinding(pending.binding)) return undefined;
    this.pendingApprovals.set(approvalId, pending);
    return pending;
  }

  private async hasPendingApproval(runId: ID): Promise<boolean> {
    for (const pending of this.pendingApprovals.values()) if (pending.call.runId === runId) return true;
    const events = await this.store.list(runId);
    const requested = new Set(events.filter((event) => event.type === 'approval.requested').map((event) => String(event.payload.approvalId)));
    const decided = new Set(events.filter((event) => event.type === 'approval.decided').map((event) => String(event.payload.approvalId)));
    return [...requested].some((approvalId) => !decided.has(approvalId));
  }

  async getRun(runId: ID): Promise<Run | undefined> {
    return this.store.getRun(runId);
  }

  /** Renew the durable owner lease without changing Run execution state. */
  async renewOwnership(runId: ID): Promise<Run> {
    const run = await this.requireRun(runId);
    await this.assertOwner(run);
    return this.acquireOwnership(runId);
  }

  async createExperienceCandidate(input: Omit<ExperienceCandidate, 'validationState' | 'approvalState'>): Promise<ExperienceCandidate> {
    const candidate = createCandidate(input);
    await this.append({ type: 'experience.candidate_created', payload: candidate as unknown as Record<string, unknown> });
    return candidate;
  }

  async reviewExperienceCandidate(candidate: ExperienceCandidate, review: Parameters<typeof reviewCandidate>[1]): Promise<ExperienceCandidate> {
    const reviewed = reviewCandidate(candidate, review);
    await this.append({ type: 'experience.candidate_reviewed', payload: reviewed as unknown as Record<string, unknown> });
    return reviewed;
  }

  /** Reconcile a process restart before allowing a Run to request new work. */
  async recoverRun(runId: ID): Promise<Run> {
    let run = await this.requireRun(runId);
    if (isTerminalRunState(run.state)) return run;
    const events = await this.store.list(runId);
    const calls = new Map<string, DomainEvent>();
    const receipts = new Map<string, DomainEvent>();
    for (const event of events) {
      if (event.type === 'tool.call' && typeof event.payload.id === 'string') calls.set(event.payload.id, event);
      if (event.type === 'tool.receipt' && typeof event.payload.toolCallId === 'string') receipts.set(event.payload.toolCallId, event);
    }
    const latestCall = [...calls.values()].sort((a, b) => a.sequence - b.sequence).at(-1);
    if (latestCall) {
      const receipt = receipts.get(String(latestCall.payload.id));
      const completed = events.some((event) => event.type === 'step.completed'
        && event.payload.stepId === latestCall.payload.stepId
        && event.sequence > latestCall.sequence);
      if (receipt && !completed) {
        const receiptPayload = receipt.payload as Record<string, unknown>;
        const observation: Observation = {
          ok: receiptPayload.ok === true,
          output: receiptPayload.output,
          error: typeof receiptPayload.error === 'string' ? receiptPayload.error : undefined,
          receipt: receiptPayload.receipt as Record<string, unknown> | undefined,
        };
        if (!events.some((event) => event.type === 'step.observation' && event.payload.stepId === latestCall.payload.stepId && event.sequence > receipt.sequence)) {
          await this.append({ type: 'step.observation', taskId: run.taskId, sessionId: run.sessionId, runId, payload: { stepId: latestCall.payload.stepId, observation } });
        }
        run = await this.requireRun(runId);
        if (observation.receipt?.sideEffect === 'unknown') {
          if (run.state === 'executing') await this.transition(runId, 'side_effect_unknown', { reason: observation.error ?? 'Tool side effect is unknown' });
        } else if (observation.ok) {
          if (run.state === 'executing') await this.transition(runId, 'observation', { stepId: latestCall.payload.stepId });
          run = await this.requireRun(runId);
          if (run.state === 'reducing') await this.transition(runId, 'continue', { stepId: latestCall.payload.stepId });
        } else if (!isTerminalRunState(run.state)) {
          await this.failRun(runId, observation.error ?? 'Tool execution failed during recovery');
        }
        run = await this.requireRun(runId);
        if (!isTerminalRunState(run.state) && run.state !== 'paused') {
          await this.append({ type: 'step.completed', taskId: run.taskId, sessionId: run.sessionId, runId, payload: { stepId: latestCall.payload.stepId, index: run.steps } });
          await this.appendCheckpoint(runId, String(latestCall.payload.stepId));
        }
        return this.requireRun(runId);
      }
      if (!receipt) {
        const alreadyReconciled = events.some((event) => event.type === 'run.needs_reconciliation'
          && event.payload.toolCallId === latestCall.payload.id);
        if (alreadyReconciled) return this.requireRun(runId);
        const reason = 'Run recovered with an unresolved tool call; side effect requires reconciliation.';
        await this.append({
          type: 'run.needs_reconciliation',
          taskId: run.taskId,
          sessionId: run.sessionId,
          runId,
          payload: { state: 'needs_reconciliation', reason, toolCallId: latestCall.payload.id },
        });
        return this.requireRun(runId);
      }
    }

    const latestVerification = [...events].reverse().find((event) => event.type === 'verification.result');
    if (latestVerification && (run.state === 'verifying' || run.state === 'reducing')) {
      const verification = latestVerification.payload.verification as Verification | undefined;
      if (verification?.result === 'passed') await this.transition(runId, 'verification_passed', { verification });
      else if (verification?.result === 'unknown') await this.transition(runId, 'verification_unknown', { verification, reason: verification.message ?? 'Verification is inconclusive' });
      else if (verification) await this.transition(runId, 'verification_failed', { verification, reason: verification.message ?? 'Verification failed' });
    }
    return this.requireRun(runId);
  }

  async getEvents(runId: ID): Promise<DomainEvent[]> {
    return this.store.list(runId);
  }

  onEvent(listener: RuntimeEventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  getTask(taskId: ID): Task | undefined {
    return this.tasks.get(taskId);
  }

  /** Rehydrate metadata from the durable ledger for reconnecting surfaces. */
  async loadTask(taskId: ID): Promise<Task | undefined> {
    try { return await this.requireTask(taskId); } catch { return undefined; }
  }

  getSession(sessionId: ID): Session | undefined {
    return this.sessions.get(sessionId);
  }

  async loadSession(sessionId: ID): Promise<Session | undefined> {
    try { return await this.requireSession(sessionId); } catch { return undefined; }
  }

  private async requireRun(runId: ID): Promise<Run> {
    const run = await this.store.getRun(runId);
    if (!run) throw new Error(`Unknown run: ${runId}`);
    return run;
  }

  private async acquireOwnership(runId: ID): Promise<Run> {
    const run = await this.requireRun(runId);
    const leaseExpiresAt = new Date(this.clock.now().getTime() + this.leaseDurationMs).toISOString();
    const acquired = this.store.tryAcquireRunLease
      ? await this.store.tryAcquireRunLease({ runId, ownerId: this.ownerId, leaseExpiresAt, now: this.timestamp() })
      : (await this.append({ type: 'run.owner_acquired', taskId: run.taskId, sessionId: run.sessionId, runId, payload: { ownerId: this.ownerId, leaseExpiresAt, state: run.state } }), true);
    if (acquired === false) throw new Error(`Run ${runId} is owned by another active Runtime.`);
    if (typeof acquired === 'object') this.notifyEvent(acquired);
    return this.requireRun(runId);
  }

  private createApprovalBinding(approvalId: ID, profile: { id: string; version: string }, call: ToolCall, workspaceId: ID): ApprovalBinding {
    const policyVersion = `${this.policy.id ?? 'policy'}@${this.policy.version ?? 'v1'}`;
    const nonce = this.ids.next('approval-nonce');
    const expiresAt = new Date(this.clock.now().getTime() + this.approvalTtlMs).toISOString();
    return {
      approvalId,
      nonce,
      toolProfileId: profile.id,
      toolProfileVersion: profile.version,
      actionHash: hashAction({ name: call.name, arguments: call.arguments, workspaceId, profile: `${profile.id}@${profile.version}`, policyVersion }),
      workspaceId,
      policyVersion,
      principal: this.principalId,
      expiresAt,
    };
  }

  private assertApprovalBinding(pending: PendingApproval): void {
    const binding = pending.binding;
    if (!isApprovalBinding(binding)) throw new Error('Approval binding is missing or invalid.');
    if (binding.approvalId !== pending.approvalId || binding.workspaceId !== pending.task.workspaceId) throw new Error('Approval binding does not match the requested action.');
    if (binding.principal !== this.principalId) throw new Error('Approval principal changed; approval is invalid.');
    if (new Date(binding.expiresAt).getTime() <= this.clock.now().getTime()) throw new Error('Approval has expired.');
    const profile = this.toolRegistry.get(pending.call.name);
    if (!profile || profile.id !== binding.toolProfileId || profile.version !== binding.toolProfileVersion) throw new Error('Approval Tool Profile changed; approval is invalid.');
    const expectedPolicyVersion = `${this.policy.id ?? 'policy'}@${this.policy.version ?? 'v1'}`;
    if (binding.policyVersion !== expectedPolicyVersion) throw new Error('Approval Policy changed; approval is invalid.');
    const expectedHash = hashAction({ name: pending.call.name, arguments: pending.call.arguments, workspaceId: pending.task.workspaceId, profile: `${profile.id}@${profile.version}`, policyVersion: expectedPolicyVersion });
    if (binding.actionHash !== expectedHash) throw new Error('Approval action binding changed; approval is invalid.');
  }

  private async ensureOwnership(runId: ID, run: Run): Promise<Run> {
    if (run.ownerId === this.ownerId) {
      const expiry = run.leaseExpiresAt ? new Date(run.leaseExpiresAt).getTime() : 0;
      if (expiry - this.clock.now().getTime() > Math.max(1_000, this.leaseDurationMs / 3)) return run;
      return this.acquireOwnership(runId);
    }
    if (!run.ownerId || (run.leaseExpiresAt && new Date(run.leaseExpiresAt).getTime() <= this.clock.now().getTime())) return this.acquireOwnership(runId);
    throw new Error(`Run ${runId} is owned by another active Runtime.`);
  }

  private async assertOwner(run: Run): Promise<void> {
    if (!run.ownerId) {
      await this.acquireOwnership(run.id);
      return;
    }
    if (run.ownerId === this.ownerId) return;
    if (run.leaseExpiresAt && new Date(run.leaseExpiresAt).getTime() <= this.clock.now().getTime()) {
      await this.acquireOwnership(run.id);
      return;
    }
    throw new Error(`Run ${run.id} is owned by another active Runtime.`);
  }

  private async requireTask(taskId: ID): Promise<Task> {
    const cached = this.tasks.get(taskId);
    if (cached) return cached;
    const event = (await this.store.listAll()).find((candidate) => candidate.type === 'task.created' && candidate.taskId === taskId);
    if (!event) throw new Error(`Unknown task: ${taskId}`);
    const task = event.payload as unknown as Task;
    this.tasks.set(task.id, task);
    return task;
  }

  private async requireSession(sessionId: ID): Promise<Session> {
    const cached = this.sessions.get(sessionId);
    if (cached) return cached;
    const event = (await this.store.listAll()).find((candidate) => candidate.type === 'session.created' && candidate.sessionId === sessionId);
    if (!event) throw new Error(`Unknown session: ${sessionId}`);
    const session = event.payload as unknown as Session;
    this.sessions.set(session.id, session);
    return session;
  }

  private async findActiveRun(sessionId: ID): Promise<Run | undefined> {
    const events = await this.store.listAll();
    const runIds = new Set(events.filter((event) => event.type === 'run.created' && event.sessionId === sessionId).map((event) => event.runId).filter((id): id is ID => Boolean(id)));
    for (const id of runIds) {
      const run = await this.store.getRun(id);
      if (run && !isTerminalRunState(run.state)) return run;
    }
    return undefined;
  }

  private async executeToolCall(pending: PendingApproval, runId: ID): Promise<Run> {
    const run = await this.requireRun(runId);
    await this.assertOwner(run);
    await this.transition(run.id, 'policy_allow', { stepId: pending.call.stepId, approvalId: pending.approvalId });
    await this.append({ type: 'tool.call', taskId: pending.task.id, sessionId: pending.session.id, runId: run.id, payload: pending.call as unknown as Record<string, unknown> });
    const startedAt = this.clock.now().getTime();
    let observation: Observation;
    try {
      const latestRun = await this.requireRun(run.id);
      const latestContext = await this.store.list(run.id);
      const projected = normalizeProviderContextProjection(this.contextAssembler.assemble({ task: pending.task, session: pending.session, run: latestRun, events: latestContext }));
      let result = await this.executor(pending.call, {
        ...pending.request,
        run: latestRun,
        context: latestContext,
        contextEnvelope: projected.context,
        messages: projected.context.messages,
        tools: this.toolRegistry.list?.().map(toolProfileToSchema),
        toolResults: projected.toolResults,
      });
      result = await this.offloadLargeToolResult(result, pending, latestRun.id);
      observation = { ok: result.ok, output: result.output, error: result.error, receipt: result.receipt };
    } catch (error) {
      observation = { ok: false, error: sanitizeDiagnostic(error), receipt: { executorError: true } };
    }
    let current = await this.requireRun(run.id);
    // If the lease changed while the executor was in flight, leave the
    // durable tool call without a receipt. The next owner will reconcile it
    // instead of accepting a late receipt from a stale process.
    try {
      await this.assertOwner(current);
    } catch {
      return current;
    }
    await this.append({ type: 'tool.receipt', taskId: pending.task.id, sessionId: pending.session.id, runId: current.id, payload: { stepId: pending.call.stepId, toolCallId: pending.call.id, name: pending.call.name, ...observation } });
    await this.append({ type: 'step.observation', taskId: pending.task.id, sessionId: pending.session.id, runId: current.id, payload: { stepId: pending.call.stepId, observation } });
    current = await this.requireRun(run.id);
    await this.append({
      type: 'usage.recorded',
      taskId: pending.task.id,
      sessionId: pending.session.id,
      runId: current.id,
      payload: {
        kind: 'tool',
        requestId: pending.call.id,
        provider: 'tool-executor',
        model: pending.call.name,
        operation: pending.call.name,
        latencyMs: Math.max(0, this.clock.now().getTime() - startedAt),
        retries: 0,
        cacheHit: false,
        failureCode: observation.ok ? undefined : observation.receipt?.sideEffect === 'unknown' ? 'unknown' : 'unavailable',
      },
    });
    const usageEvents = await this.store.list(current.id);
    if (this.usageBudgetExceeded(current, usageEvents)) {
      await this.append({ type: 'step.completed', taskId: pending.task.id, sessionId: pending.session.id, runId: current.id, payload: { stepId: pending.call.stepId, index: pending.index } });
      await this.transition(current.id, 'needs_input', { reason: 'usage budget exceeded' });
      await this.appendCheckpoint(current.id, pending.call.stepId);
      return this.requireRun(current.id);
    }
    if (isTerminalRunState(current.state) || current.state === 'paused') return current;
      if (observation.receipt?.sideEffect === 'unknown') {
        await this.append({ type: 'step.completed', taskId: pending.task.id, sessionId: pending.session.id, runId: current.id, payload: { stepId: pending.call.stepId, index: pending.index } });
        await this.transition(current.id, 'side_effect_unknown', { reason: observation.error ?? 'Tool side effect is unknown' });
        await this.appendCheckpoint(current.id, pending.call.stepId);
        return this.requireRun(current.id);
      }
      if (!observation.ok) {
        await this.append({ type: 'step.completed', taskId: pending.task.id, sessionId: pending.session.id, runId: current.id, payload: { stepId: pending.call.stepId, index: pending.index } });
        await this.failRun(current.id, observation.error ?? 'Tool execution failed');
        await this.appendCheckpoint(current.id, pending.call.stepId);
        return this.requireRun(current.id);
    }
    await this.transition(current.id, 'observation', { stepId: pending.call.stepId });
    await this.transition(current.id, 'continue', { stepId: pending.call.stepId });
    await this.append({ type: 'step.completed', taskId: pending.task.id, sessionId: pending.session.id, runId: current.id, payload: { stepId: pending.call.stepId, index: pending.index } });
    await this.appendCheckpoint(current.id, pending.call.stepId);
    return this.requireRun(current.id);
  }

  private async appendCheckpoint(runId: ID, stepId: ID): Promise<void> {
    const run = await this.requireRun(runId);
    await this.append({
      type: 'run.checkpoint',
      taskId: run.taskId,
      sessionId: run.sessionId,
      runId,
      payload: { stepId, state: run.state },
    });
  }

  private async recordUsage(run: Run, response: { provider?: string; model?: string; usage?: import('./types.js').TokenUsage }, events: DomainEvent[]): Promise<void> {
    const usage = response.usage;
    if (!usage) return;
    const requestId = usage.requestId;
    if (requestId && events.some((event) => event.type === 'usage.recorded' && event.payload.requestId === requestId)) return;
    await this.append({
      type: 'usage.recorded',
      taskId: run.taskId,
      sessionId: run.sessionId,
      runId: run.id,
      payload: {
        kind: 'provider',
        requestId,
        provider: response.provider ?? this.provider.id,
        model: response.model ?? this.provider.model,
        retries: 0,
        cacheHit: false,
        ...usage,
      },
    });
  }

  private async recordProviderFailure(run: Run, request: ProviderRequest, error: unknown, latencyMs: number): Promise<void> {
    const failure = error && typeof error === 'object' && 'failure' in error
      ? (error as { failure?: { code?: string; requestId?: string; retryable?: boolean } }).failure
      : undefined;
    const failureCode = failure?.code;
    await this.append({
      type: 'usage.recorded',
      taskId: run.taskId,
      sessionId: run.sessionId,
      runId: run.id,
      payload: {
        kind: 'provider',
        requestId: failure?.requestId ?? request.requestId,
        provider: this.provider.id,
        model: this.provider.model,
        latencyMs,
        retries: 0,
        cacheHit: false,
        ...(typeof failureCode === 'string' ? { failureCode } : { failureCode: 'unknown' }),
      },
    });
  }

  private usageBudgetExceeded(run: Run, events: DomainEvent[], current?: import('./types.js').TokenUsage): boolean {
    const prior = events.filter((event) => event.type === 'usage.recorded').reduce((total, event) => {
      const usage = event.payload as { totalTokens?: number; inputTokens?: number; outputTokens?: number; costUsd?: number; latencyMs?: number; retries?: number; cacheHit?: boolean };
      return {
        tokens: total.tokens + (usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)),
        cost: total.cost + (usage.costUsd ?? 0),
        latency: total.latency + (usage.latencyMs ?? 0),
        retries: total.retries + (usage.retries ?? 0),
        cacheMisses: total.cacheMisses + (usage.cacheHit === false ? 1 : 0),
      };
    }, { tokens: 0, cost: 0, latency: 0, retries: 0, cacheMisses: 0 });
    const tokens = prior.tokens + (current ? current.totalTokens ?? (current.inputTokens ?? 0) + (current.outputTokens ?? 0) : 0);
    const cost = prior.cost + (current?.costUsd ?? 0);
    const latency = prior.latency + (current?.latencyMs ?? 0);
    const retries = prior.retries + (current?.retries ?? 0);
    const cacheMisses = prior.cacheMisses + (current?.cacheHit === false ? 1 : 0);
    return (run.budget.maxTokens !== undefined && tokens > run.budget.maxTokens)
      || (run.budget.maxCostUsd !== undefined && cost > run.budget.maxCostUsd)
      || (run.budget.maxLatencyMs !== undefined && latency > run.budget.maxLatencyMs)
      || (run.budget.maxRetries !== undefined && retries > run.budget.maxRetries)
      || (run.budget.maxCacheMisses !== undefined && cacheMisses > run.budget.maxCacheMisses);
  }

  private timestamp(): string {
    return this.clock.now().toISOString();
  }

  private async append(event: NewDomainEvent): Promise<DomainEvent> {
    const stored = await this.store.append({ ...event, timestamp: event.timestamp ?? this.timestamp() });
    this.notifyEvent(stored);
    return stored;
  }

  private notifyEvent(stored: DomainEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(stored);
      } catch {
        // Observers must not be able to break the Runtime write path.
      }
    }
  }

  private async transition(runId: ID, action: Parameters<typeof transitionRunState>[1], payload: Record<string, unknown> = {}): Promise<Run> {
    const run = await this.requireRun(runId);
    const next = transitionRunState(run.state, action);
    const base = { taskId: run.taskId, sessionId: run.sessionId, runId, payload: { ...payload, state: next } } as const;
    if (next === 'paused') await this.append({ type: 'run.paused', ...base, payload: { ...base.payload, reason: payload.reason ?? 'paused' } });
    else if (next === 'completed') await this.append({ type: 'run.completed', ...base, payload });
    else if (next === 'failed') await this.append({ type: 'run.failed', ...base, payload });
    else if (next === 'cancelled') await this.append({ type: 'run.cancelled', ...base, payload });
    else if (next === 'needs_reconciliation') await this.append({ type: 'run.needs_reconciliation', ...base, payload });
    else await this.append({ type: 'run.state_changed', ...base });
    return this.requireRun(runId);
  }

  private async failRun(runId: ID, error: string): Promise<Run> {
    const run = await this.requireRun(runId);
    if (isTerminalRunState(run.state)) return run;
    const action = run.state === 'executing' ? 'execution_failed' : run.state === 'paused' ? 'resume' : 'fail';
    return this.transition(runId, action, { error });
  }

  private async offloadLargeToolResult(result: ToolExecutorResult, pending: PendingApproval, runId: ID): Promise<ToolExecutorResult> {
    if (result.output === undefined) return result;
    const content = typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
    if (Buffer.byteLength(content, 'utf8') <= 8_000) return result;
    if (!this.artifactStore) {
      return {
        ...result,
        ok: false,
        output: undefined,
        error: 'ArtifactStore is unavailable for a large tool result; delivery is blocked.',
        receipt: { ...(result.receipt ?? {}), artifactStoreError: 'unavailable', sideEffect: result.receipt?.sideEffect ?? 'none' },
      };
    }
    try {
      const artifact = await this.artifactStore.put({
        runId,
        type: 'tool-output',
        content,
        path: typeof pending.call.arguments.path === 'string' ? pending.call.arguments.path : undefined,
        limitations: ['Large tool output is stored as an explicit Artifact; only a bounded preview is retained in the event ledger.'],
      });
      const preview = `${content.slice(0, 2_000)}…`;
      return {
        ...result,
        output: preview,
        receipt: { ...(result.receipt ?? {}), artifact },
      };
    } catch (error) {
      return { ...result, receipt: { ...(result.receipt ?? {}), artifactStoreError: sanitizeDiagnostic(error) } };
    }
  }
}

function hashAction(value: Record<string, unknown>): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function isApprovalBinding(value: unknown): value is ApprovalBinding {
  if (!value || typeof value !== 'object') return false;
  const binding = value as Partial<ApprovalBinding>;
  return typeof binding.approvalId === 'string'
    && typeof binding.nonce === 'string'
    && typeof binding.toolProfileId === 'string'
    && typeof binding.toolProfileVersion === 'string'
    && typeof binding.actionHash === 'string'
    && typeof binding.workspaceId === 'string'
    && typeof binding.policyVersion === 'string'
    && typeof binding.principal === 'string'
    && typeof binding.expiresAt === 'string';
}
