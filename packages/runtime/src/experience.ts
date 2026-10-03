import type { ID } from './types.js';

export type CandidateValidationState = 'unvalidated' | 'validated' | 'rejected';
export type CandidateApprovalState = 'pending' | 'approved' | 'rejected';

export interface ExperienceCandidate {
  id: ID;
  sourceEpisodeId: ID;
  summary: string;
  applicability: string[];
  validationState: CandidateValidationState;
  approvalState: CandidateApprovalState;
  costChecks: { tokenBudgetOk: boolean; costBudgetOk: boolean };
  createdAt: string;
}

export function createExperienceCandidate(input: Omit<ExperienceCandidate, 'validationState' | 'approvalState'>): ExperienceCandidate {
  return { ...input, validationState: 'unvalidated', approvalState: 'pending' };
}

export function reviewExperienceCandidate(candidate: ExperienceCandidate, review: { validation: Exclude<CandidateValidationState, 'unvalidated'>; approval: CandidateApprovalState; tokenBudgetOk?: boolean; costBudgetOk?: boolean }): ExperienceCandidate {
  return {
    ...candidate,
    validationState: review.validation,
    approvalState: review.approval,
    costChecks: {
      tokenBudgetOk: review.tokenBudgetOk ?? candidate.costChecks.tokenBudgetOk,
      costBudgetOk: review.costBudgetOk ?? candidate.costChecks.costBudgetOk,
    },
  };
}

/** A candidate is review material only; this function never mutates production policy or skills. */
export function canPromoteExperienceCandidate(candidate: ExperienceCandidate): boolean {
  return candidate.validationState === 'validated'
    && candidate.approvalState === 'approved'
    && candidate.costChecks.tokenBudgetOk
    && candidate.costChecks.costBudgetOk;
}
