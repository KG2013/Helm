import type { ID } from './types.js';

export type CandidateValidationState = 'unvalidated' | 'validated' | 'rejected';
export type CandidateApprovalState = 'pending' | 'approved' | 'rejected';
export type CandidateReviewAction = 'approve' | 'reject' | 'revalidate';
export type CandidateRisk = 'low' | 'medium' | 'high' | 'unknown';

export interface ExperienceEvidenceRef {
  uri: string;
  hash?: string;
  summary?: string;
}

export interface ExperienceCandidate {
  id: ID;
  sourceEpisodeId: ID;
  sourceTraceId?: ID;
  candidateType?: 'skill' | 'memory' | 'rule' | 'harness';
  summary: string;
  applicability: string[];
  risk?: CandidateRisk;
  validationState: CandidateValidationState;
  approvalState: CandidateApprovalState;
  costChecks: { tokenBudgetOk: boolean; costBudgetOk: boolean };
  validationEvidence?: string[];
  evidence?: ExperienceEvidenceRef[];
  reviewVersion?: number;
  lastReviewAction?: CandidateReviewAction;
  reviewerId?: ID;
  reviewedAt?: string;
  createdAt: string;
}

const SENSITIVE = /api[-_ ]?key|authorization|cookie|password|secret|token|private[_ -]?key/i;
const URI = /^[a-z][a-z0-9+.-]{1,31}:/i;

function assertBoundedCandidate(candidate: ExperienceCandidate): void {
  const boundedId = (value: unknown, label: string) => {
    if (typeof value !== 'string' || value.trim().length === 0 || value.length > 200 || SENSITIVE.test(value) || /\/(?:Users|private|tmp)\//.test(value)) throw new Error(`Experience Candidate ${label} is invalid or sensitive.`);
  };
  boundedId(candidate.id, 'id');
  boundedId(candidate.sourceEpisodeId, 'source Episode');
  if (candidate.sourceTraceId !== undefined) boundedId(candidate.sourceTraceId, 'source trace');
  if (typeof candidate.summary !== 'string' || candidate.summary.trim().length === 0 || candidate.summary.length > 2_000 || SENSITIVE.test(candidate.summary)) throw new Error('Experience Candidate summary is unbounded or sensitive.');
  if (!Array.isArray(candidate.applicability) || candidate.applicability.length > 32 || candidate.applicability.some((item) => typeof item !== 'string' || item.length === 0 || item.length > 300 || SENSITIVE.test(item))) throw new Error('Experience Candidate applicability is unbounded or sensitive.');
  if (candidate.risk !== undefined && !['low', 'medium', 'high', 'unknown'].includes(candidate.risk)) throw new Error('Experience Candidate risk is invalid.');
  if (!candidate.costChecks || typeof candidate.costChecks.tokenBudgetOk !== 'boolean' || typeof candidate.costChecks.costBudgetOk !== 'boolean') throw new Error('Experience Candidate cost checks are invalid.');
  if (candidate.validationEvidence !== undefined && (!Array.isArray(candidate.validationEvidence) || candidate.validationEvidence.length > 32 || candidate.validationEvidence.some((item) => typeof item !== 'string' || item.length === 0 || item.length > 1_000 || !URI.test(item) || SENSITIVE.test(item) || /\/(?:Users|private|tmp)\//.test(item)))) throw new Error('Experience Candidate validation evidence must be bounded, URI-like, and non-sensitive.');
  if (candidate.evidence !== undefined && (!Array.isArray(candidate.evidence) || candidate.evidence.length > 32 || candidate.evidence.some((item) => !item || typeof item.uri !== 'string' || item.uri.length > 500 || !URI.test(item.uri) || SENSITIVE.test(item.uri) || (item.hash !== undefined && !/^[a-f0-9]{64}$/i.test(item.hash)) || (item.summary !== undefined && (item.summary.length > 1_000 || SENSITIVE.test(item.summary)))))) throw new Error('Experience Candidate evidence is invalid, unbounded, or sensitive.');
  if (candidate.reviewVersion !== undefined && (!Number.isInteger(candidate.reviewVersion) || candidate.reviewVersion < 0 || candidate.reviewVersion > 10_000)) throw new Error('Experience Candidate review version is invalid.');
}

export function createExperienceCandidate(input: Omit<ExperienceCandidate, 'validationState' | 'approvalState'>): ExperienceCandidate {
  const candidate: ExperienceCandidate = {
    ...input,
    sourceTraceId: input.sourceTraceId ?? input.sourceEpisodeId,
    risk: input.risk ?? 'unknown',
    evidence: input.evidence ?? [],
    reviewVersion: input.reviewVersion ?? 0,
    validationState: 'unvalidated',
    approvalState: 'pending',
  };
  assertBoundedCandidate(candidate);
  return candidate;
}

export function reviewExperienceCandidate(candidate: ExperienceCandidate, review: { action?: CandidateReviewAction; validation: CandidateValidationState; approval: CandidateApprovalState; risk?: CandidateRisk; tokenBudgetOk?: boolean; costBudgetOk?: boolean; validationEvidence?: string[]; evidence?: ExperienceEvidenceRef[]; reviewerId?: ID; reviewedAt?: string }): ExperienceCandidate {
  const action = review.action;
  const validation = action === 'revalidate' ? 'unvalidated' : action === 'reject' ? 'rejected' : review.validation;
  const approval = action === 'revalidate' ? 'pending' : action === 'reject' ? 'rejected' : review.approval;
  const reviewed: ExperienceCandidate = {
    ...candidate,
    validationState: validation,
    approvalState: approval,
    risk: review.risk ?? candidate.risk ?? 'unknown',
    costChecks: {
      tokenBudgetOk: review.tokenBudgetOk ?? candidate.costChecks.tokenBudgetOk,
      costBudgetOk: review.costBudgetOk ?? candidate.costChecks.costBudgetOk,
    },
    validationEvidence: action === 'revalidate' ? review.validationEvidence ?? [] : review.validationEvidence ?? candidate.validationEvidence,
    evidence: review.evidence ?? candidate.evidence ?? [],
    reviewVersion: (candidate.reviewVersion ?? 0) + 1,
    lastReviewAction: action,
    reviewerId: review.reviewerId ?? candidate.reviewerId,
    reviewedAt: review.reviewedAt ?? candidate.reviewedAt,
  };
  assertBoundedCandidate(reviewed);
  return reviewed;
}

/** A candidate is review material only; this function never mutates production policy or skills. */
export function canPromoteExperienceCandidate(candidate: ExperienceCandidate): boolean {
  return Boolean(candidate.sourceEpisodeId && candidate.sourceTraceId && (candidate.validationEvidence?.length ?? 0) > 0)
    && candidate.validationState === 'validated'
    && candidate.approvalState === 'approved'
    && candidate.costChecks.tokenBudgetOk
    && candidate.costChecks.costBudgetOk;
}
