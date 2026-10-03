import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRunProjection } from '../src/projection.js'
import type { DomainEvent } from '../src/types.js'

function event(input: Partial<DomainEvent> & Pick<DomainEvent, 'type' | 'sequence' | 'payload'>): DomainEvent {
  return {
    id: `evt-${input.sequence}`,
    timestamp: '2026-10-03T00:00:00.000Z',
    runId: 'run-coding',
    taskId: 'task-coding',
    sessionId: 'session-coding',
    ...input,
  }
}

test('Run projection derives coding artifacts, approvals, and verification from one ledger', () => {
  const projection = buildRunProjection([
    event({ sequence: 1, type: 'run.created', payload: { id: 'run-coding', taskId: 'task-coding', sessionId: 'session-coding', state: 'ready', createdAt: 'now', updatedAt: 'now', steps: 1, reviewerRounds: 0, budget: { maxSteps: 30, maxDurationMs: 1000, maxReviewerRounds: 1 } } }),
    event({ sequence: 2, type: 'approval.requested', payload: { approvalId: 'tool-edit', reason: 'edit requires approval', workspaceId: 'workspace-coding', call: { name: 'workspace.edit', arguments: { path: 'src/app.ts' } } } }),
    event({ sequence: 3, type: 'approval.decided', payload: { approvalId: 'tool-edit', decision: 'approve' } }),
    event({ sequence: 4, type: 'tool.receipt', payload: { toolCallId: 'tool-edit', name: 'workspace.edit', ok: true, output: 'Updated src/app.ts.', receipt: { tool: 'workspace.edit', profile: 'workspace.edit@v1', sideEffect: 'known', artifact: { type: 'coding', sourceRunId: 'run-coding', path: 'src/app.ts', hash: 'a'.repeat(64), bytes: 42 } } } }),
    event({ sequence: 5, type: 'tool.receipt', payload: { toolCallId: 'tool-test', name: 'workspace.test', ok: true, output: 'passed', receipt: { tool: 'workspace.test', profile: 'workspace.test@v1', sideEffect: 'known', exitCode: 0, command: 'pnpm', args: ['test'], artifact: { type: 'coding-test', sourceRunId: 'run-coding', hash: 'b'.repeat(64), bytes: 6 } } } }),
    event({ sequence: 6, type: 'tool.receipt', payload: { toolCallId: 'tool-diff', name: 'workspace.diff', ok: true, output: 'diff -- src/app.ts\n+safe', receipt: { tool: 'workspace.diff', profile: 'workspace.diff@v1', sideEffect: 'known', artifact: { type: 'coding-diff', sourceRunId: 'run-coding', path: 'src/app.ts', hash: 'c'.repeat(64), bytes: 22 } } } }),
    event({ sequence: 7, type: 'verification.result', payload: { verification: { result: 'passed', verifier: 'coding-v1', evidence: [{ type: 'coding-artifact', summary: 'evidence' }] } } }),
  ])

  assert.equal(projection.run.id, 'run-coding')
  assert.equal(projection.artifacts.length, 3)
  assert.deepEqual(projection.artifacts.map((artifact) => artifact.tool), ['workspace.edit', 'workspace.test', 'workspace.diff'])
  assert.deepEqual(projection.artifacts[0]?.changedFiles, ['src/app.ts'])
  assert.equal(projection.artifacts[1]?.test?.exitCode, 0)
  assert.equal(projection.artifacts[1]?.test?.command, 'pnpm')
  assert.match(projection.artifacts[2]?.diff?.text ?? '', /diff -- src\/app\.ts/)
  assert.equal(projection.approvals[0]?.decision, 'approve')
  assert.equal(projection.verification?.result, 'passed')
})
