import type { DomainEvent, EventType, NewDomainEvent, Run } from './types.js';

export function reduceRunEvents(events: readonly DomainEvent[], runId?: string): Run {
  const created = events.find((event) => event.type === 'run.created');
  if (!created) throw new Error(`No run.created event found${runId ? ` for ${runId}` : ''}`);
  const initial = created.payload as unknown as Run;
  const run: Run = {
    ...initial,
    state: initial.state ?? 'ready',
    steps: initial.steps ?? 0,
    reviewerRounds: initial.reviewerRounds ?? 0,
  };
  for (const event of events) {
    const payload = event.payload as Record<string, unknown>;
    switch (event.type) {
      case 'run.started':
      case 'run.resumed':
      case 'run.state_changed': {
        if (typeof payload.state === 'string') run.state = payload.state as Run['state'];
        run.updatedAt = event.timestamp;
        if (typeof payload.pauseReason === 'string') run.pauseReason = payload.pauseReason;
        break;
      }
      case 'run.paused':
        run.state = 'paused';
        run.pauseReason = typeof payload.reason === 'string' ? payload.reason : undefined;
        run.updatedAt = event.timestamp;
        break;
      case 'run.completed':
        run.state = 'completed';
        run.finalOutput = typeof payload.output === 'string' ? payload.output : run.finalOutput;
        if (payload.verification && typeof payload.verification === 'object') run.verification = payload.verification as Run['verification'];
        run.updatedAt = event.timestamp;
        break;
      case 'run.failed':
        run.state = 'failed';
        run.lastError = typeof payload.error === 'string' ? payload.error : run.lastError;
        run.updatedAt = event.timestamp;
        break;
      case 'run.cancelled':
        run.state = 'cancelled';
        run.updatedAt = event.timestamp;
        break;
      case 'run.needs_reconciliation':
        run.state = 'needs_reconciliation';
        run.lastError = typeof payload.reason === 'string' ? payload.reason : run.lastError;
        run.updatedAt = event.timestamp;
        break;
      case 'step.started':
        run.steps = Math.max(run.steps, Number(payload.index ?? run.steps + 1));
        run.updatedAt = event.timestamp;
        break;
      case 'step.completed':
        run.steps = Math.max(run.steps, Number(payload.index ?? run.steps));
        run.updatedAt = event.timestamp;
        break;
      case 'verification.result':
        if (payload.verification && typeof payload.verification === 'object') run.verification = payload.verification as Run['verification'];
        run.updatedAt = event.timestamp;
        break;
      case 'run.checkpoint':
        if (payload.checkpoint && typeof payload.checkpoint === 'object') run.checkpoint = payload.checkpoint as Run['checkpoint'];
        else run.checkpoint = {
          runId: run.id,
          stepId: typeof payload.stepId === 'string' ? payload.stepId : undefined,
          sequence: event.sequence,
          state: run.state,
          createdAt: event.timestamp,
        };
        run.updatedAt = event.timestamp;
        break;
      case 'usage.recorded':
        run.updatedAt = event.timestamp;
        break;
      case 'run.owner_acquired':
        run.ownerId = typeof payload.ownerId === 'string' ? payload.ownerId : run.ownerId;
        run.leaseExpiresAt = typeof payload.leaseExpiresAt === 'string' ? payload.leaseExpiresAt : run.leaseExpiresAt;
        run.updatedAt = event.timestamp;
        break;
      case 'run.owner_released':
        run.ownerId = undefined;
        run.leaseExpiresAt = undefined;
        run.updatedAt = event.timestamp;
        break;
      default:
        break;
    }
  }
  return run;
}

export function makeEvent<TPayload extends Record<string, unknown> = Record<string, unknown>>(
  id: string,
  sequence: number,
  input: NewDomainEvent<TPayload>,
  timestamp: string,
): DomainEvent<TPayload> {
  return {
    id,
    sequence,
    type: input.type as EventType,
    taskId: input.taskId,
    sessionId: input.sessionId,
    runId: input.runId,
    timestamp: input.timestamp ?? timestamp,
    payload: input.payload,
  };
}
