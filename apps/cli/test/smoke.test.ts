import test from 'node:test'
import assert from 'node:assert/strict'
import { collectAcceptanceReport } from '../src/acceptance.js'
import { collectAcceptanceSmokeReport } from '../src/smoke.js'

const healthyOffice = async () => ({
  worker: 'document-worker', version: '1.0.0',
  tools: { tesseract: { status: 'available' as const, version: '5' } },
  python: {}, checks: { pdfOcr: 'passed' as const }, limitations: [],
})

async function preflight() {
  return collectAcceptanceReport({
    env: { HELM_WORKSPACE_ROOT: '/tmp/helm-smoke' },
    officeHealth: healthyOffice,
    fileProbe: () => ({ exists: true, bytes: 1 }),
    electronAvailable: true,
  })
}

test('acceptance smoke defaults to blocked without invoking a real runner', async () => {
  let calls = 0
  const report = await collectAcceptanceSmokeReport({ preflight: await preflight(), electronRunner: async () => { calls += 1; return { command: 'fixture', exitCode: 0, durationMs: 1, stdoutBytes: 0, stderrBytes: 0, stdoutHash: 'a', stderrHash: 'b' } } })

  assert.equal(calls, 0)
  assert.equal(report.releaseGate.eligible, false)
  assert.ok(report.checks.every((check) => check.mode === 'smoke' && check.status === 'unverified'))
})

test('acceptance smoke records bounded Electron success evidence', async () => {
  const report = await collectAcceptanceSmokeReport({
    preflight: await preflight(),
    runReal: true,
    electronRunner: async () => ({ command: 'pnpm --filter @helm/desktop test:electron', exitCode: 0, durationMs: 42, stdoutBytes: 100, stderrBytes: 0, stdoutHash: 'out-hash', stderrHash: 'err-hash' }),
  })

  const electron = report.checks.find((check) => check.id === 'electron.preflight')
  assert.equal(electron?.status, 'passed')
  assert.equal(electron?.mode, 'smoke')
  assert.equal(electron?.details.smoke?.stdoutHash, 'out-hash')
  assert.equal(report.releaseGate.eligible, false)
})

test('acceptance smoke maps a failed Electron runner to a failed gate', async () => {
  const report = await collectAcceptanceSmokeReport({
    preflight: await preflight(),
    runReal: true,
    electronRunner: async () => ({ command: 'fixture', exitCode: 1, durationMs: 7, stdoutBytes: 12, stderrBytes: 8, stdoutHash: 'out', stderrHash: 'err' }),
  })

  assert.equal(report.checks.find((check) => check.id === 'electron.preflight')?.status, 'failed')
  assert.equal(report.releaseGate.result, 'blocked')
})

test('acceptance smoke does not run Electron when its preflight is failed', async () => {
  let calls = 0
  const blockedPreflight = await collectAcceptanceReport({
    env: { HELM_WORKSPACE_ROOT: '/tmp/helm-smoke' },
    officeHealth: healthyOffice,
    fileProbe: () => ({ exists: false, bytes: 0 }),
    electronAvailable: false,
  })
  const report = await collectAcceptanceSmokeReport({
    preflight: blockedPreflight,
    runReal: true,
    electronRunner: async () => { calls += 1; return { command: 'fixture', exitCode: 0, durationMs: 1, stdoutBytes: 0, stderrBytes: 0, stdoutHash: 'a', stderrHash: 'b' } },
  })

  assert.equal(calls, 0)
  assert.equal(report.checks.find((check) => check.id === 'electron.preflight')?.status, 'failed')
})

test('acceptance smoke never serializes child output', async () => {
  const report = await collectAcceptanceSmokeReport({
    preflight: await preflight(),
    runReal: true,
    electronRunner: async () => ({ command: 'fixture', exitCode: 0, durationMs: 7, stdoutBytes: 30, stderrBytes: 0, stdoutHash: 'hash-only', stderrHash: 'empty', }),
  })

  const serialized = JSON.stringify(report)
  assert.equal(serialized.includes('secret-value'), false)
  assert.equal(serialized.includes('hash-only'), true)
})
