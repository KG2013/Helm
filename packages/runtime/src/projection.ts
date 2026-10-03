import type { DomainEvent, ID, Run, Verification } from './types.js';
import { reduceRunEvents } from './events.js';

/**
 * The evidence projection is the read model shared by CLI and Desktop.
 *
 * It intentionally derives every field from the append-only Run events. A
 * surface may choose how to render the projection, but it must not invent a
 * second Artifact or Verification model of its own.
 */
export interface ProjectedArtifact {
  id: ID;
  runId: ID;
  sequence: number;
  type: string;
  tool: string;
  ok: boolean;
  sideEffect?: string;
  sourceRunId?: ID;
  path?: string;
  changedFiles: string[];
  hash?: string;
  bytes?: number;
  diff?: {
    text?: string;
    hash?: string;
  };
  test?: {
    command?: string;
    args?: string[];
    exitCode?: number;
    output?: string;
    outputHash?: string;
  };
  receipt: Record<string, unknown>;
}

export interface ProjectedApproval {
  id: ID;
  runId: ID;
  sequence: number;
  approvalId: ID;
  decision?: 'approve' | 'deny';
  reason?: string;
  workspaceId?: ID;
  call?: Record<string, unknown>;
}

export interface CodingDeliveryProjection {
  sourceRunId: ID;
  changedFiles: string[];
  diff?: ProjectedArtifact['diff'];
  tests: NonNullable<ProjectedArtifact['test']>[];
  hashes: string[];
  hasRead: boolean;
  hasEdit: boolean;
  hasPassingTest: boolean;
  hasDiff: boolean;
  ready: boolean;
}

export interface RunProjection {
  run: Run;
  artifacts: ProjectedArtifact[];
  approvals: ProjectedApproval[];
  verification?: Verification;
  codingDelivery?: CodingDeliveryProjection;
}

/** Serialize a Run's public ledger without leaking credentials or private file contents. */
export function redactRunJsonl(events: readonly DomainEvent[]): string {
  return events.map((event) => JSON.stringify(redactRunEvent(event))).join('\n');
}

export function redactRunEvent(event: DomainEvent): DomainEvent {
  return { ...event, payload: redactRunValue(event.payload) as Record<string, unknown> };
}

/** Build the same Run/Artifact/Approval/Verification read model for all surfaces. */
export function buildRunProjection(events: readonly DomainEvent[], run?: Run): RunProjection {
  const projectedRun = run ?? reduceRunEvents(events);
  const artifacts = events
    .filter((event) => event.type === 'tool.receipt')
    .map((event) => projectReceipt(event))
    .filter((artifact): artifact is ProjectedArtifact => Boolean(artifact));

  const approvals = new Map<ID, ProjectedApproval>();
  for (const event of events) {
    if (event.type === 'approval.requested') {
      const payload = event.payload as Record<string, unknown>;
      if (typeof payload.approvalId !== 'string') continue;
      approvals.set(payload.approvalId, {
        id: event.id,
        runId: event.runId ?? projectedRun.id,
        sequence: event.sequence,
        approvalId: payload.approvalId,
        reason: typeof payload.reason === 'string' ? payload.reason : undefined,
        workspaceId: typeof payload.workspaceId === 'string' ? payload.workspaceId : undefined,
        call: asRecord(payload.call),
      });
    }
    if (event.type === 'approval.decided') {
      const payload = event.payload as Record<string, unknown>;
      const approvalId = typeof payload.approvalId === 'string' ? payload.approvalId : undefined;
      if (!approvalId) continue;
      const prior = approvals.get(approvalId);
      approvals.set(approvalId, {
        ...(prior ?? { id: event.id, runId: event.runId ?? projectedRun.id, sequence: event.sequence, approvalId }),
        decision: payload.decision === 'approve' || payload.decision === 'deny' ? payload.decision : undefined,
        sequence: event.sequence,
      });
    }
  }

  const latestVerification = [...events].reverse().find((event) => event.type === 'verification.result');
  const verification = asRecord(latestVerification?.payload)?.verification;
  const codingDelivery = buildCodingDelivery(projectedRun.id, artifacts);
  return {
    run: projectedRun,
    artifacts,
    approvals: [...approvals.values()],
    verification: isVerification(verification) ? verification : projectedRun.verification,
    codingDelivery,
  };
}

function buildCodingDelivery(runId: ID, artifacts: readonly ProjectedArtifact[]): CodingDeliveryProjection | undefined {
  const coding = artifacts.filter((artifact) => artifact.tool.startsWith('workspace.') && (
    artifact.tool === 'workspace.read'
    || artifact.tool === 'workspace.edit'
    || artifact.tool === 'workspace.patch'
    || artifact.tool === 'workspace.test'
    || artifact.tool === 'workspace.diff'
  ));
  if (!coding.length) return undefined;
  const changedFiles = [...new Set(coding.flatMap((artifact) => artifact.changedFiles))];
  const tests = coding.flatMap((artifact) => artifact.test ? [artifact.test] : []);
  const diff = [...coding].reverse().find((artifact) => artifact.tool === 'workspace.diff')?.diff;
  const hasRead = coding.some((artifact) => artifact.ok && artifact.tool === 'workspace.read');
  const hasEdit = coding.some((artifact) => artifact.ok && (artifact.tool === 'workspace.edit' || artifact.tool === 'workspace.patch'));
  const hasPassingTest = tests.some((test) => test.exitCode === 0);
  const hasDiff = coding.some((artifact) => artifact.ok && artifact.tool === 'workspace.diff' && Boolean(artifact.diff));
  return {
    sourceRunId: runId,
    changedFiles,
    diff,
    tests,
    hashes: [...new Set(coding.flatMap((artifact) => artifact.hash ? [artifact.hash] : []))],
    hasRead,
    hasEdit,
    hasPassingTest,
    hasDiff,
    ready: hasRead && hasEdit && hasPassingTest && hasDiff,
  };
}

function projectReceipt(event: DomainEvent): ProjectedArtifact | undefined {
  const payload = event.payload as Record<string, unknown>;
  const receipt = asRecord(payload.receipt);
  if (!receipt) return undefined;
  const artifact = asRecord(receipt.artifact);
  const tool = typeof payload.name === 'string'
    ? payload.name
    : typeof receipt.tool === 'string' ? receipt.tool : 'unknown';
  const type = typeof artifact?.type === 'string'
    ? artifact.type
    : typeof receipt.profile === 'string' ? receipt.profile.split('@')[0] : tool;
  const path = typeof artifact?.path === 'string'
    ? artifact.path
    : typeof receipt.path === 'string' ? receipt.path : undefined;
  const changedFiles = Array.isArray(artifact?.changedFiles)
    ? artifact.changedFiles.filter((value): value is string => typeof value === 'string')
    : path && (tool === 'workspace.edit' || tool === 'workspace.patch' || tool === 'workspace.diff') ? [path] : [];
  const output = typeof payload.output === 'string' ? payload.output : undefined;
  const hash = typeof artifact?.hash === 'string' ? artifact.hash : undefined;
  const test = tool === 'workspace.test'
    ? {
        command: typeof receipt.command === 'string' ? receipt.command : undefined,
        args: Array.isArray(receipt.args) ? receipt.args.filter((value): value is string => typeof value === 'string') : undefined,
        exitCode: typeof receipt.exitCode === 'number' ? receipt.exitCode : undefined,
        output,
        outputHash: hash,
      }
    : undefined;
  const diff = tool === 'workspace.diff' ? { text: output, hash } : undefined;
  return {
    id: event.id,
    runId: event.runId ?? String(artifact?.sourceRunId ?? ''),
    sequence: event.sequence,
    type,
    tool,
    ok: payload.ok === true,
    sideEffect: typeof receipt.sideEffect === 'string' ? receipt.sideEffect : undefined,
    sourceRunId: typeof artifact?.sourceRunId === 'string' ? artifact.sourceRunId : event.runId,
    path,
    changedFiles,
    hash,
    bytes: typeof artifact?.bytes === 'number' ? artifact.bytes : undefined,
    diff,
    test,
    receipt,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function isVerification(value: unknown): value is Verification {
  const record = asRecord(value);
  return (record?.result === 'passed' || record?.result === 'failed' || record?.result === 'unknown')
    && typeof record.verifier === 'string'
    && Array.isArray(record.evidence);
}

const REDACTED_KEY = /api[-_]?key|authorization|cookie|secret|password|token/i;
const PRIVATE_VALUE_KEY = /^(content|output|body|diff|fileContent|privateFile|oldText|newText)$/i;

function redactRunValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactRunValue(item, depth + 1));
  if (typeof value === 'string') return redactRunText(value).slice(0, 2_000);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [
    key,
    REDACTED_KEY.test(key) || PRIVATE_VALUE_KEY.test(key) ? '[redacted]' : redactRunValue(item, depth + 1),
  ]));
}

function redactRunText(value: string): string {
  return value
    .replace(/(?:api[-_ ]?key|authorization|cookie|secret|password|token)\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi, '[redacted]')
    .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/\/(?:Users|private|tmp)\/[^\s]+/g, '[workspace-path]');
}
