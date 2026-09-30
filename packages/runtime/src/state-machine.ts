import type { RunAction, RunState } from './types.js';

export class RunStateError extends Error {
  readonly state: RunState;
  readonly action: RunAction;

  constructor(state: RunState, action: RunAction) {
    super(`Illegal run transition: ${state} + ${action}`);
    this.name = 'RunStateError';
    this.state = state;
    this.action = action;
  }
}

const transitions: Record<RunState, Partial<Record<RunAction, RunState>>> = {
  ready: { start: 'deciding', cancel: 'cancelled' },
  deciding: {
    proposal_valid: 'validating',
    proposal_final: 'reducing',
    needs_input: 'paused',
    budget_exceeded: 'paused',
    fail: 'failed',
    cancel: 'cancelled',
  },
  validating: {
    policy_allow: 'executing',
    policy_deny: 'failed',
    proposal_final: 'reducing',
    needs_input: 'paused',
    fail: 'failed',
    cancel: 'cancelled',
  },
  executing: {
    observation: 'reducing',
    execution_failed: 'failed',
    side_effect_unknown: 'needs_reconciliation',
    needs_input: 'paused',
    cancel: 'cancelled',
  },
  reducing: {
    continue: 'deciding',
    goal_candidate: 'verifying',
    fail: 'failed',
    cancel: 'cancelled',
  },
  verifying: {
    verification_passed: 'completed',
    verification_failed: 'failed',
    verification_unknown: 'paused',
    reviewer_feedback: 'deciding',
    needs_input: 'paused',
    cancel: 'cancelled',
  },
  paused: { resume: 'recovering', cancel: 'cancelled' },
  recovering: { recovered: 'deciding', fail: 'failed', cancel: 'cancelled' },
  completed: {},
  failed: {},
  cancelled: {},
  needs_reconciliation: {},
};

export function transitionRunState(state: RunState, action: RunAction): RunState {
  const next = transitions[state][action];
  if (!next) throw new RunStateError(state, action);
  return next;
}

export function isTerminalRunState(state: RunState): state is Extract<RunState, 'completed' | 'failed' | 'cancelled' | 'needs_reconciliation'> {
  return state === 'completed' || state === 'failed' || state === 'cancelled' || state === 'needs_reconciliation';
}

export function canTransition(state: RunState, action: RunAction): boolean {
  return Boolean(transitions[state][action]);
}
