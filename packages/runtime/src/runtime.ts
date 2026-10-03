import { transitionRunState, isTerminalRunState, RunStateError } from './state-machine.js';
import { TextOutputVerifier } from './verifier.js';
import { buildProviderContext, normalizeProviderContextProjection, toolProfileToSchema } from './context.js';
import type {
  Budget,
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
  Verification,
  Verifier,
} from './types.js';

const DEFAULT_BUDGET: Budget = {
  maxSteps: 30,
  maxDurationMs: 15 * 60 * 1000,
  maxReviewerRounds: 1,
};

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
    };
    await this.append({ type: 'run.created', taskId: task.id, sessionId: session.id, runId: run.id, payload: run as unknown as Record<string, unknown> });
    await this.transition(run.id, 'start');
    return (await this.requireRun(run.id));
  }

  async run(runId: ID): Promise<RunResult> {
    let run = await this.recoverRun(runId);
    if (isTerminalRunState(run.state) || run.state === 'paused') return run;
    const task = await this.requireTask(run.taskId);
    const session = await this.requireSession(run.sessionId);
    const startedAt = this.clock.now().getTime();
    const controller = this.runControllers.get(run.id) ?? new AbortController();
    this.runControllers.set(run.id, controller);

    while (!isTerminalRunState(run.state) && run.state !== 'paused') {
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
      try {
        response = await this.provider.complete(request);
      } catch (error) {
        run = await this.requireRun(run.id);
        if (isTerminalRunState(run.state) || run.state === 'paused') break;
        await this.failRun(run.id, `Provider error: ${sanitizeDiagnostic(error)}`);
        run = await this.requireRun(run.id);
        break;
      }
      run = await this.requireRun(run.id);
      if (isTerminalRunState(run.state) || run.state === 'paused') break;
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
          const pending: PendingApproval = {
            approvalId: call.id,
            task,
            session,
            request,
            call,
            index,
            reason: policy.reason,
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
            },
          });
          await this.transition(run.id, 'needs_input', { stepId, reason: policy.reason });
          run = await this.requireRun(run.id);
          break;
        }
        run = await this.requireRun(run.id);
        if (isTerminalRunState(run.state) || run.state === 'paused') break;
        run = await this.executeToolCall({ approvalId: call.id, task, session, request, call, index, reason: '' }, run.id);
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
    if (run.state === 'paused') return run;
    await this.transition(runId, 'needs_input', { reason });
    return this.requireRun(runId);
  }

  async resumeRun(runId: ID): Promise<Run> {
    const run = await this.requireRun(runId);
    if (run.state !== 'paused') throw new RunStateError(run.state, 'resume');
    await this.transition(runId, 'resume');
    await this.append({ type: 'run.resumed', taskId: run.taskId, sessionId: run.sessionId, runId, payload: { state: 'recovering' } });
    await this.transition(runId, 'recovered');
    return this.requireRun(runId);
  }

  async cancelRun(runId: ID, reason = 'cancelled by user'): Promise<Run> {
    const run = await this.requireRun(runId);
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
    let pending = this.pendingApprovals.get(approvalId);
    if (!pending) pending = await this.hydratePendingApproval(runId, approvalId);
    if (!pending) {
      const prior = (await this.store.list(runId)).reverse().find((event) => event.type === 'approval.decided' && event.payload.approvalId === approvalId);
      if (prior && prior.payload.decision === decision) return run;
      throw new Error(`Unknown or stale approval: ${approvalId}`);
    }
    if (pending.call.runId !== runId) throw new Error('Approval does not belong to this Run.');
    if (workspaceId !== undefined && pending.task.workspaceId !== workspaceId) throw new Error('Approval workspace mismatch.');
    if (run.state !== 'paused') throw new RunStateError(run.state, 'resume');

    await this.append({
      type: 'approval.decided',
      taskId: pending.task.id,
      sessionId: pending.session.id,
      runId,
      payload: { approvalId, decision, call: pending.call },
    });
    this.pendingApprovals.delete(approvalId);
    if (decision === 'deny') {
      await this.transition(runId, 'approval_deny', { approvalId, error: 'Tool execution denied by user.' });
      return this.requireRun(runId);
    }

    await this.resumeRun(runId);
    await this.transition(runId, 'proposal_valid', { stepId: pending.call.stepId, approvalId });
    const afterExecution = await this.executeToolCall(pending, runId);
    if (isTerminalRunState(afterExecution.state) || afterExecution.state === 'paused') return afterExecution;
    return this.run(runId);
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
    };
    this.pendingApprovals.set(approvalId, pending);
    return pending;
  }

  async getRun(runId: ID): Promise<Run | undefined> {
    return this.store.getRun(runId);
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

  getSession(sessionId: ID): Session | undefined {
    return this.sessions.get(sessionId);
  }

  private async requireRun(runId: ID): Promise<Run> {
    const run = await this.store.getRun(runId);
    if (!run) throw new Error(`Unknown run: ${runId}`);
    return run;
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
    await this.transition(run.id, 'policy_allow', { stepId: pending.call.stepId, approvalId: pending.approvalId });
    await this.append({ type: 'tool.call', taskId: pending.task.id, sessionId: pending.session.id, runId: run.id, payload: pending.call as unknown as Record<string, unknown> });
    let observation: Observation;
    try {
      const latestRun = await this.requireRun(run.id);
      const latestContext = await this.store.list(run.id);
      const projected = normalizeProviderContextProjection(this.contextAssembler.assemble({ task: pending.task, session: pending.session, run: latestRun, events: latestContext }));
      const result = await this.executor(pending.call, {
        ...pending.request,
        run: latestRun,
        context: latestContext,
        contextEnvelope: projected.context,
        messages: projected.context.messages,
        tools: this.toolRegistry.list?.().map(toolProfileToSchema),
        toolResults: projected.toolResults,
      });
      observation = { ok: result.ok, output: result.output, error: result.error, receipt: result.receipt };
    } catch (error) {
      observation = { ok: false, error: sanitizeDiagnostic(error), receipt: { executorError: true } };
    }
    let current = await this.requireRun(run.id);
    await this.append({ type: 'tool.receipt', taskId: pending.task.id, sessionId: pending.session.id, runId: current.id, payload: { stepId: pending.call.stepId, toolCallId: pending.call.id, name: pending.call.name, ...observation } });
    await this.append({ type: 'step.observation', taskId: pending.task.id, sessionId: pending.session.id, runId: current.id, payload: { stepId: pending.call.stepId, observation } });
    current = await this.requireRun(run.id);
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

  private timestamp(): string {
    return this.clock.now().toISOString();
  }

  private async append(event: NewDomainEvent): Promise<DomainEvent> {
    const stored = await this.store.append({ ...event, timestamp: event.timestamp ?? this.timestamp() });
    for (const listener of this.eventListeners) {
      try {
        listener(stored);
      } catch {
        // Observers must not be able to break the Runtime write path.
      }
    }
    return stored;
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
}
