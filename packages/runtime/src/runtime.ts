import { transitionRunState, isTerminalRunState, RunStateError } from './state-machine.js';
import { TextOutputVerifier } from './verifier.js';
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
  Session,
  Task,
  TaskInput,
  ToolCall,
  ToolExecutor,
  ToolPolicy,
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

export class RuntimeFacade {
  private readonly store: EventStore;
  private readonly provider: Provider;
  private readonly executor: ToolExecutor;
  private readonly policy: ToolPolicy;
  private readonly verifier: Verifier;
  private readonly clock: RuntimeClock;
  private readonly ids: RuntimeIdFactory;
  private readonly defaultBudget: Budget;
  private readonly tasks = new Map<ID, Task>();
  private readonly sessions = new Map<ID, Session>();

  constructor(options: RuntimeOptions) {
    this.store = options.store;
    this.provider = options.provider;
    this.executor = options.executor ?? defaultExecutor;
    this.policy = options.policy ?? defaultPolicy;
    this.verifier = options.verifier ?? new TextOutputVerifier();
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
    let run = await this.requireRun(runId);
    if (isTerminalRunState(run.state) || run.state === 'paused') return run;
    const task = await this.requireTask(run.taskId);
    const session = await this.requireSession(run.sessionId);
    const startedAt = this.clock.now().getTime();

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
      const request: ProviderRequest = { runId: run.id, stepId, task, session, run, context };
      let response;
      try {
        response = await this.provider.complete(request);
      } catch (error) {
        await this.failRun(run.id, `Provider error: ${error instanceof Error ? error.message : String(error)}`);
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
        payload: { stepId, index, proposal, provider: response.provider ?? this.provider.id, model: response.model ?? this.provider.model, usage: response.usage },
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
        await this.append({ type: 'policy.decision', taskId: task.id, sessionId: session.id, runId: run.id, payload: { stepId, decision: policy.decision, reason: policy.reason } });
        if (policy.decision === 'deny') {
          await this.transition(run.id, 'policy_deny', { stepId, error: policy.reason });
          run = await this.requireRun(run.id);
          break;
        }
        if (policy.decision === 'ask') {
          await this.transition(run.id, 'needs_input', { stepId, reason: policy.reason });
          run = await this.requireRun(run.id);
          break;
        }
        await this.transition(run.id, 'policy_allow', { stepId });
        await this.append({ type: 'tool.call', taskId: task.id, sessionId: session.id, runId: run.id, payload: call as unknown as Record<string, unknown> });
        let observation: Observation;
        try {
          const result = await this.executor(call, request);
          observation = { ok: result.ok, output: result.output, error: result.error, receipt: result.receipt };
        } catch (error) {
          observation = { ok: false, error: error instanceof Error ? error.message : String(error), receipt: { executorError: true } };
        }
        await this.append({ type: 'tool.receipt', taskId: task.id, sessionId: session.id, runId: run.id, payload: { stepId, toolCallId: call.id, ...observation } });
        await this.append({ type: 'step.observation', taskId: task.id, sessionId: session.id, runId: run.id, payload: { stepId, observation } });
        if (!observation.ok) {
          await this.append({ type: 'step.completed', taskId: task.id, sessionId: session.id, runId: run.id, payload: { stepId, index } });
          const sideEffectUnknown = observation.receipt?.sideEffect === 'unknown';
          if (sideEffectUnknown) {
            await this.transition(run.id, 'side_effect_unknown', { reason: observation.error ?? 'Tool side effect is unknown' });
          } else {
            await this.failRun(run.id, observation.error ?? 'Tool execution failed');
          }
          run = await this.requireRun(run.id);
          break;
        }
        await this.transition(run.id, 'observation', { stepId });
        await this.transition(run.id, 'continue', { stepId });
        await this.append({ type: 'step.completed', taskId: task.id, sessionId: session.id, runId: run.id, payload: { stepId, index } });
        run = await this.requireRun(run.id);
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
    await this.transition(runId, 'cancel', { reason });
    return this.requireRun(runId);
  }

  async getRun(runId: ID): Promise<Run | undefined> {
    return this.store.getRun(runId);
  }

  async getEvents(runId: ID): Promise<DomainEvent[]> {
    return this.store.list(runId);
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

  private timestamp(): string {
    return this.clock.now().toISOString();
  }

  private async append(event: NewDomainEvent): Promise<DomainEvent> {
    return this.store.append({ ...event, timestamp: event.timestamp ?? this.timestamp() });
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
